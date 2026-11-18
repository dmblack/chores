/**
 * SQLite adapter retaining the original users, sessions, actions and append-only
 * events tables. Projection tables and session versions are additive upgrades.
 * @module storage/sqlite
 */
import { openDb } from '../db.js';
import { apply, createState } from '../projection.js';
import { projectionRecords, StorageConflict, StorageUnavailable } from './records.js';

/**
 * Translate an existing event row into the shared event representation.
 * @param {object} row - SQLite event row.
 * @returns {object} Domain event.
 */
function eventFromRow(row) {
  return { seq: row.seq, actionId: row.action_id, type: row.type, actorId: row.actor_id,
    deviceId: row.device_id, at: row.at, recordedAt: row.recorded_at, payload: JSON.parse(row.payload) };
}

/**
 * Open the SQLite implementation of the asynchronous adapter contract.
 * @param {{dbPath?: string}} options - Existing database path or :memory:.
 * @returns {object} Adapter with lifecycle, reads and conditional atomic commit.
 */
export function createSqliteStorage({ dbPath = ':memory:' } = {}) {
  const db = openDb(dbPath);
  /**
   * Keep database failures retryable without hiding optimistic conflicts.
   * @param {function(): any} operation - Synchronous SQLite operation.
   * @returns {any} Operation result, or a translated infrastructure failure.
   */
  function sql(operation) {
    try { return operation(); }
    catch (error) {
      if (error.code?.startsWith('SQLITE_')) throw new StorageUnavailable(undefined, error);
      throw error;
    }
  }
  const q = {
    meta: db.prepare('SELECT revision, seq FROM storage_meta WHERE id = 1'),
    projections: db.prepare('SELECT key, value FROM storage_projection ORDER BY key'),
    users: db.prepare('SELECT * FROM users'),
    sessions: db.prepare('SELECT * FROM sessions'),
    action: db.prepare('SELECT * FROM actions WHERE id = ?'),
    session: db.prepare('SELECT * FROM sessions WHERE token_hash = ?'),
    throttle: db.prepare('SELECT * FROM login_throttle WHERE key = ?'),
    putProjection: db.prepare('INSERT INTO storage_projection (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
    deleteProjection: db.prepare('DELETE FROM storage_projection WHERE key = ?'),
    putUser: db.prepare(`INSERT INTO users (id, username, nickname, role, birth_date, password_hash, pin_hash, active, created_at, auth_version)
      VALUES (@id, @username, @nickname, @role, @birth_date, @password_hash, @pin_hash, @active, @created_at, @auth_version)
      ON CONFLICT(id) DO UPDATE SET username=excluded.username, nickname=excluded.nickname, role=excluded.role,
      birth_date=excluded.birth_date, password_hash=excluded.password_hash, pin_hash=excluded.pin_hash,
      active=excluded.active, auth_version=excluded.auth_version`),
    putSession: db.prepare(`INSERT INTO sessions (token_hash, user_id, device_id, created_at, refreshed_at, expires_at, user_version)
      VALUES (@token_hash, @user_id, @device_id, @created_at, @refreshed_at, @expires_at, @user_version)
      ON CONFLICT(token_hash) DO UPDATE SET refreshed_at=excluded.refreshed_at, expires_at=excluded.expires_at`),
    deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
    putThrottle: db.prepare(`INSERT INTO login_throttle (key, misses, last_miss, locked_until)
      VALUES (@key, @misses, @last_miss, @locked_until)
      ON CONFLICT(key) DO UPDATE SET misses=excluded.misses, last_miss=excluded.last_miss, locked_until=excluded.locked_until`),
    deleteThrottle: db.prepare('DELETE FROM login_throttle WHERE key = ?'),
    putAction: db.prepare(`INSERT INTO actions (id, actor_id, type, status, error_code, error, recorded_at)
      VALUES (@id, @actor_id, @type, @status, @error_code, @error, @recorded_at)`),
    putEvent: db.prepare(`INSERT INTO events (seq, action_id, type, actor_id, device_id, at, recorded_at, payload)
      VALUES (@seq, @actionId, @type, @actorId, @deviceId, @at, @recordedAt, @payload)`),
    advance: db.prepare('UPDATE storage_meta SET revision = revision + 1, seq = ? WHERE id = 1 AND revision = ? AND seq = ?'),
  };

  /** Build persistent projections once when upgrading an existing SQLite file. */
  const initialize = db.transaction(() => {
    if (q.meta.get()) return;
    const state = createState();
    for (const row of db.prepare('SELECT * FROM events ORDER BY seq').iterate()) apply(state, eventFromRow(row));
    for (const [key, value] of projectionRecords(state)) q.putProjection.run(key, JSON.stringify(value));
    db.prepare('INSERT INTO storage_meta (id, revision, seq) VALUES (1, 0, ?)').run(state.seq);
  });

  /** Commit every changed record and event within one SQLite transaction. */
  const commit = db.transaction((change) => {
    if (q.advance.run(change.seq, change.expectedRevision, change.expectedSeq).changes !== 1) throw new StorageConflict();
    for (const [key, value] of change.projections) {
      if (value === null) q.deleteProjection.run(key);
      else q.putProjection.run(key, JSON.stringify(value));
    }
    for (const value of change.users.values()) q.putUser.run(value);
    for (const [key, value] of change.sessions) {
      if (value === null) q.deleteSession.run(key);
      else q.putSession.run(value);
    }
    for (const [key, value] of change.throttles) {
      if (value === null) q.deleteThrottle.run(key);
      else q.putThrottle.run(value);
    }
    for (const value of change.actions.values()) q.putAction.run(value);
    for (const event of change.events) q.putEvent.run({ ...event, payload: JSON.stringify(event.payload) });
  });

  return {
    backend: 'sqlite',
    db,
    /** @returns {Promise<void>} Complete additive initialization. */
    async initialize() { sql(() => initialize.immediate()); },
    /** @returns {Promise<object>} Global write revision and event sequence. */
    async metadata() {
      const meta = sql(() => q.meta.get());
      if (!meta) throw new StorageUnavailable('Storage metadata is missing.');
      return meta;
    },
    /** @returns {Promise<Map<string, object>>} Individual projection records. */
    async projections() { return sql(() => new Map(q.projections.all().map((row) => [row.key, JSON.parse(row.value)]))); },
    /** @returns {Promise<Map<string, object>>} Accounts including credentials. */
    async users() { return sql(() => new Map(q.users.all().map((row) => [row.id, row]))); },
    /** @param {string} id - Action identity. @returns {Promise<object|undefined>} Stored outcome. */
    async action(id) { return sql(() => q.action.get(id)); },
    /** @param {string} token - Hashed token. @returns {Promise<object|undefined>} Session row. */
    async session(token) { return sql(() => q.session.get(token)); },
    /** @returns {Promise<object[]>} Sessions for console revocation reporting. */
    async sessions() { return sql(() => q.sessions.all()); },
    /** @param {string} key - Throttle identity. @returns {Promise<object|undefined>} Throttle row. */
    async throttle(key) { return sql(() => q.throttle.get(key)); },
    /** @param {object} change - Expected revision and atomic changes. @returns {Promise<void>} */
    async commit(change) { sql(() => commit(change)); },
    /** @returns {Promise<object[]>} Complete audit log, for inspection and tests. */
    async events() { return sql(() => db.prepare('SELECT * FROM events ORDER BY seq').all().map(eventFromRow)); },
    /** @returns {Promise<void>} Release the database connection. */
    async close() { db.close(); },
  };
}

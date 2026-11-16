// The event store: replays the log into memory on start, and applies each
// accepted action exactly once (by its stable action id) in one transaction.
//
// Everything here is synchronous (better-sqlite3), so actions from different
// iPads are processed strictly one after another: two people approving the
// same task at the same moment are checked in turn against the rules.

import { randomUUID } from 'node:crypto';
import { apply, createState } from './projection.js';
import { decide, RuleError } from './commands.js';
import { localDate } from '../shared/dates.js';

const MAX_FUTURE_MS = 5 * 60_000;
const MAX_PAST_MS = 14 * 86_400_000;

export function createStore(db, { clock = () => new Date(), onChange = () => {} } = {}) {
  const state = createState();
  for (const row of db.prepare('SELECT * FROM events ORDER BY seq').iterate()) {
    apply(state, rowToEvent(row));
  }

  const findAction = db.prepare('SELECT * FROM actions WHERE id = ?');
  const insertAction = db.prepare(
    'INSERT INTO actions (id, actor_id, type, status, error_code, error, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  const insertEvent = db.prepare(
    'INSERT INTO events (action_id, type, actor_id, device_id, at, recorded_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  const usersStmt = db.prepare('SELECT id, username, nickname, role, birth_date, active FROM users');

  function loadUsers() {
    const users = new Map();
    for (const u of usersStmt.all()) users.set(u.id, publicUser(u));
    return users;
  }

  /** Write events for one action and fold them into state. Returns the new events. */
  const writeEvents = db.transaction((actionId, actorId, deviceId, type, at, events, recordedAt) => {
    insertAction.run(actionId, actorId, type, 'accepted', null, null, recordedAt);
    return events.map((ev) => {
      const info = insertEvent.run(actionId, ev.type, actorId, deviceId, at, recordedAt, JSON.stringify(ev.payload));
      return { seq: Number(info.lastInsertRowid), actionId, type: ev.type, actorId, deviceId, at, recordedAt, payload: ev.payload };
    });
  });

  function commit(actionId, actorId, deviceId, type, at, events) {
    const written = writeEvents(actionId, actorId, deviceId, type, at, events, clock().toISOString());
    for (const ev of written) apply(state, ev);
    onChange(state.seq);
    return written;
  }

  /** The time an action happened: the iPad's clock unless it is implausible. */
  function happenedAt(clientTime) {
    const now = clock();
    const t = typeof clientTime === 'string' ? new Date(clientTime) : null;
    if (!t || Number.isNaN(t.getTime())) return now;
    const delta = t.getTime() - now.getTime();
    return delta > MAX_FUTURE_MS || delta < -MAX_PAST_MS ? now : t;
  }

  /**
   * Process one action from an iPad. Resending an action that was already
   * received returns the original outcome and changes nothing.
   */
  function submit(actor, deviceId, action) {
    const { id, type, payload, clientTime } = action;
    const existing = findAction.get(id);
    if (existing) {
      if (existing.actor_id !== actor.id) {
        return { id, status: 'rejected', error: { code: 'conflict', message: 'Action id already used' } };
      }
      return existing.status === 'accepted'
        ? { id, status: 'accepted', duplicate: true }
        : { id, status: 'rejected', duplicate: true, error: { code: existing.error_code, message: existing.error } };
    }

    const at = happenedAt(clientTime);
    const users = loadUsers();
    const ctx = {
      actor: users.get(actor.id),
      users,
      date: localDate(at),
      approvalPoints: state.settings.approvalPoints,
    };
    try {
      const events = decide(state, ctx, type, payload);
      commit(id, actor.id, deviceId, type, at.toISOString(), events);
      return { id, status: 'accepted' };
    } catch (err) {
      if (!(err instanceof RuleError)) throw err;
      insertAction.run(id, actor.id, String(type).slice(0, 64), 'rejected', err.code, err.message, clock().toISOString());
      return { id, status: 'rejected', error: { code: err.code, message: err.message } };
    }
  }

  /** Audit events raised by the server itself (account changes). */
  function record(actorId, type, payload) {
    commit(randomUUID(), actorId, null, type, clock().toISOString(), [{ type, payload }]);
  }

  return { state, db, clock, submit, record, loadUsers };
}

export function publicUser(u) {
  return { id: u.id, username: u.username, nickname: u.nickname, role: u.role, birthDate: u.birth_date, active: !!u.active };
}

function rowToEvent(row) {
  return {
    seq: row.seq,
    actionId: row.action_id,
    type: row.type,
    actorId: row.actor_id,
    deviceId: row.device_id,
    at: row.at,
    recordedAt: row.recorded_at,
    payload: JSON.parse(row.payload),
  };
}

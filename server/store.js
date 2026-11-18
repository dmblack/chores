/**
 * Backend-independent unit of work for domain rules, credentials and sessions.
 * Mutations are serialized locally and conditionally committed across processes.
 * @module store
 */
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { apply } from './projection.js';
import { decide, RuleError } from './commands.js';
import { localDate } from '../shared/dates.js';
import { changedRecords, projectionFromRecords, projectionRecords, StorageConflict, StorageUnavailable } from './storage/records.js';

/** @type {number} Offline client timestamps may be five minutes ahead. */
const MAX_FUTURE_MS = 5 * 60_000;
/** @type {number} Offline client timestamps may be fourteen days behind. */
const MAX_PAST_MS = 14 * 86_400_000;
/** @type {number} Bounded optimistic-concurrency attempts before a retryable refusal. */
const MAX_ATTEMPTS = 12;

/**
 * Remove credential fields from an account row.
 * @param {object} user - Stored account.
 * @returns {object} Public account representation.
 */
export function publicUser(user) {
  return { id: user.id, username: user.username, nickname: user.nickname, role: user.role,
    birthDate: user.birth_date, active: !!user.active };
}

/**
 * Create a portable transactional store. Reader/writer callbacks may be retried
 * and must not perform external side effects such as sending replies or emails.
 * @param {object} storage - Persistence adapter.
 * @param {object} [options] - Clock and committed-event callback.
 * @param {function(): Date} [options.clock] - Injectable clock.
 * @param {function(number): void} [options.onChange] - Event sequence notification.
 * @returns {object} Lifecycle, snapshot reads, transactional writes and commands.
 */
export function createStore(storage, { clock = () => new Date(), onChange = () => {} } = {}) {
  let cached = null;
  let notifiedSeq = 0;
  let writes = Promise.resolve();

  /**
   * Load a coherent projection, reusing memory only after checking its revision.
   * @returns {Promise<object>} Metadata, projection records and credential rows.
   */
  async function snapshot() {
    const meta = await storage.metadata();
    if (cached?.revision === meta.revision) return { ...meta, records: cached.records, users: cached.users };
    const [records, users] = await Promise.all([storage.projections(), storage.users()]);
    const after = await storage.metadata();
    if (after.revision !== meta.revision || after.seq !== meta.seq) throw new StorageConflict();
    cached = { revision: meta.revision, seq: meta.seq, records, users };
    return { ...meta, records, users };
  }

  /**
   * Broadcast a newly observed local or remote event sequence once.
   * @param {number} seq - Committed event sequence.
   * @returns {void}
   */
  function announce(seq) {
    if (seq > notifiedSeq) {
      notifiedSeq = seq;
      onChange(seq);
    }
  }

  /**
   * Construct an isolated transaction view and lazily read session/throttle rows.
   * @param {object} before - Coherent snapshot before the callback.
   * @returns {object} Mutable unit of work; credentials never reach client views.
   */
  function unit(before) {
    const tx = {
      state: projectionFromRecords(structuredClone(before.records), before.seq),
      users: structuredClone(before.users),
      sessions: new Map(), throttles: new Map(), actions: new Map(), events: [],
      /** @returns {Map<string, object>} Credential-free accounts for domain rules. */
      publicUsers() { return new Map([...tx.users].map(([id, user]) => [id, publicUser(user)])); },
      /** @param {string} name - Username. @returns {object|undefined} Case-insensitive match. */
      userByName(name) { return typeof name === 'string' ? [...tx.users.values()].find((user) => user.username.toLowerCase() === name.toLowerCase()) : undefined; },
      /** @param {string} token - Hashed token. @returns {Promise<object|undefined>} Session. */
      async session(token) { return tx.sessions.has(token) ? tx.sessions.get(token) : storage.session(token); },
      /** @param {string} key - Throttle identity. @returns {Promise<object|undefined>} Throttle. */
      async throttle(key) { return tx.throttles.has(key) ? tx.throttles.get(key) : storage.throttle(key); },
      /** @returns {Promise<object[]>} Persisted sessions for explicit console revocation. */
      async allSessions() { return storage.sessions(); },
      /**
       * Append audited events and apply their projections inside this transaction.
       * @param {string|null} actorId - Actor, or console/system.
       * @param {string} type - Audit type.
       * @param {object} payload - Credential-free audit data.
       * @returns {void}
       */
      record(actorId, type, payload) {
        tx.append(randomUUID(), actorId, null, clock().toISOString(), [{ type, payload }]);
      },
      /**
       * Append all events belonging to one stable action identity.
       * @param {string} actionId - Idempotency identity.
       * @param {string|null} actorId - Account identity.
       * @param {string|null} deviceId - Device identity.
       * @param {string} at - Effective timestamp.
       * @param {object[]} events - Decided event definitions.
       * @returns {void}
       */
      append(actionId, actorId, deviceId, at, events) {
        const recordedAt = clock().toISOString();
        for (const definition of events) {
          const event = { ...definition, seq: tx.state.seq + 1, actionId, actorId, deviceId, at, recordedAt };
          tx.events.push(event);
          apply(tx.state, event);
        }
      },
    };
    return tx;
  }

  /**
   * Run a callback against one consistent revision, retrying conflicts safely.
   * @param {function(object): any} callback - Side-effect-free transactional work.
   * @param {boolean} writing - Whether changes should be committed.
   * @returns {Promise<any>} Callback result after a successful read or commit.
   */
  async function run(callback, writing) {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        const before = await snapshot();
        const tx = unit(before);
        const result = await callback(tx);
        const records = projectionRecords(tx.state);
        const change = { expectedRevision: before.revision, expectedSeq: before.seq, seq: tx.state.seq,
          projections: changedRecords(before.records, records), users: changedRecords(before.users, tx.users),
          sessions: tx.sessions, throttles: tx.throttles, actions: tx.actions, events: tx.events };
        const dirty = writing && (change.events.length > 0 || [change.projections, change.users, change.sessions, change.throttles, change.actions]
          .some((changes) => changes.size > 0));
        if (dirty) {
          await storage.commit(change);
          cached = { revision: before.revision + 1, seq: tx.state.seq, records, users: tx.users };
          announce(tx.state.seq);
        } else {
          const after = await storage.metadata();
          if (after.revision !== before.revision) throw new StorageConflict();
          announce(before.seq);
        }
        return result;
      } catch (error) {
        if (!(error instanceof StorageConflict)) throw error;
        cached = null;
        if (attempt + 1 < MAX_ATTEMPTS) await delay(Math.min(5 * 2 ** attempt, 100) + Math.floor(Math.random() * 10));
      }
    }
    throw new StorageUnavailable('Storage is busy. Your change can be retried safely.');
  }

  /**
   * Serialize local writers without holding a database lock across awaits.
   * @param {function(object): any} callback - Transaction callback.
   * @returns {Promise<any>} Committed callback result.
   */
  function write(callback) {
    const next = writes.then(() => run(callback, true));
    writes = next.catch(() => {});
    return next;
  }

  /**
   * Resolve the effective timestamp without trusting implausible client clocks.
   * @param {string|undefined} clientTime - Offline action timestamp.
   * @returns {Date} Effective action time.
   */
  function happenedAt(clientTime) {
    const now = clock();
    const date = typeof clientTime === 'string' ? new Date(clientTime) : null;
    if (!date || Number.isNaN(date.getTime())) return now;
    const delta = date.getTime() - now.getTime();
    return delta > MAX_FUTURE_MS || delta < -MAX_PAST_MS ? now : date;
  }

  return {
    storage, clock, write,
    /** @returns {Promise<void>} Open storage before Fastify accepts requests. */
    async initialize() {
      await storage.initialize();
      await run(() => undefined, false);
    },
    /** @param {function(object): any} callback - Consistent reader. @returns {Promise<any>} */
    async read(callback) { return run(callback, false); },
    /** @returns {Promise<number>} Refresh and return the committed event sequence. */
    async refresh() { return run((tx) => tx.state.seq, false); },
    /**
     * Decide and atomically apply one action, preserving outcomes across retries.
     * @param {object} actor - Authenticated public user.
     * @param {string|null} deviceId - Device identity.
     * @param {object} action - Stable identity, type, payload and timestamp.
     * @returns {Promise<object>} Accepted or rejected action result.
     */
    async submit(actor, deviceId, action) {
      return write(async (tx) => {
        const { id, type, payload, clientTime } = action;
        const existing = await storage.action(id);
        if (existing) {
          if (existing.actor_id !== actor.id) return { id, status: 'rejected', error: { code: 'conflict', message: 'Action id already used' } };
          return existing.status === 'accepted' ? { id, status: 'accepted', duplicate: true }
            : { id, status: 'rejected', duplicate: true, error: { code: existing.error_code, message: existing.error } };
        }
        const at = happenedAt(clientTime);
        const users = tx.publicUsers();
        const current = users.get(actor.id);
        const row = { id, actor_id: actor.id, type: String(type).slice(0, 64), status: 'accepted',
          error_code: null, error: null, recorded_at: clock().toISOString() };
        try {
          if (!current?.active) throw new RuleError('forbidden', 'This account is switched off');
          if (actor.authVersion !== undefined && actor.authVersion !== (tx.users.get(actor.id).auth_version ?? 0)) {
            throw new RuleError('signed_out', 'Please sign in');
          }
          const events = decide(tx.state, { actor: current, users, date: localDate(at), approvalPoints: tx.state.settings.approvalPoints }, type, payload);
          tx.append(id, actor.id, deviceId, at.toISOString(), events);
          tx.actions.set(id, row);
          return { id, status: 'accepted' };
        } catch (error) {
          if (!(error instanceof RuleError)) throw error;
          tx.actions.set(id, { ...row, status: 'rejected', error_code: error.code, error: error.message });
          return { id, status: 'rejected', error: { code: error.code, message: error.message } };
        }
      });
    },
    /** @returns {Promise<object[]>} Complete immutable history for diagnostics/tests. */
    async events() { return storage.events(); },
    /** @returns {Promise<void>} Drain local writes and close storage. */
    async close() { await writes; await storage.close(); },
  };
}

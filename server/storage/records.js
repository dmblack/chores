/**
 * Portable, individually stored projection records. Audit events remain separate
 * so growing history never has to fit inside a single DynamoDB item.
 * @module storage/records
 */
import { createState } from '../projection.js';

/** @type {ReadonlyArray<string>} Map-valued members of the domain projection. */
const MAPS = ['tasks', 'completions', 'latestByOccurrence', 'rewards', 'redemptions', 'balances'];

/**
 * Convert a projection into stable records; retain the sixty ledger entries per
 * person that the UI displays. The complete ledger remains in the event log.
 * @param {object} state - Domain projection.
 * @returns {Map<string, object>} Records keyed independently of the database.
 */
export function projectionRecords(state) {
  const records = new Map([['settings', state.settings]]);
  for (const name of MAPS) {
    for (const [key, value] of state[name]) records.set(`${name}/${key}`, { value });
  }
  const ledgers = new Map();
  for (const entry of state.ledger) {
    const entries = ledgers.get(entry.userId) ?? [];
    entries.push(entry);
    ledgers.set(entry.userId, entries);
  }
  for (const [userId, entries] of ledgers) records.set(`ledger/${userId}`, { value: entries.slice(-60) });
  return records;
}

/**
 * Restore a projection without replaying its audit log.
 * @param {Map<string, object>} records - Persisted projection records.
 * @param {number} seq - Last committed event sequence.
 * @returns {object} Hydrated domain projection.
 */
export function projectionFromRecords(records, seq) {
  const state = createState();
  state.seq = seq;
  for (const [key, record] of records) {
    if (key === 'settings') state.settings = record;
    else {
      const slash = key.indexOf('/');
      const name = key.slice(0, slash);
      const id = key.slice(slash + 1);
      if (name === 'ledger') state.ledger.push(...record.value);
      else if (MAPS.includes(name)) state[name].set(id, record.value);
    }
  }
  state.ledger.sort((a, b) => a.seq - b.seq);
  return state;
}

/**
 * Identify changed or removed records for an atomic commit.
 * @param {Map<string, object>} before - Original records.
 * @param {Map<string, object>} after - Candidate records.
 * @returns {Map<string, object|null>} Changes, with null representing deletion.
 */
export function changedRecords(before, after) {
  const changes = new Map();
  for (const [key, value] of after) {
    if (JSON.stringify(before.get(key)) !== JSON.stringify(value)) changes.set(key, value);
  }
  for (const key of before.keys()) if (!after.has(key)) changes.set(key, null);
  return changes;
}

/**
 * Signal a retryable optimistic concurrency conflict.
 * @extends Error
 */
export class StorageConflict extends Error {}

/**
 * Expose storage outages as retryable HTTP errors, preserving offline queues.
 * @extends Error
 */
export class StorageUnavailable extends Error {
  /** @param {string} message - Safe client message. @param {Error} [cause] - Internal cause. */
  constructor(message = 'Storage is temporarily unavailable. Please try again.', cause) {
    super(message, { cause });
    this.statusCode = 503;
    this.code = 'storage_unavailable';
  }
}

/**
 * Reject writes exceeding an adapter's atomic-write limits before changing data.
 * @extends Error
 */
export class StorageLimit extends Error {
  /** @param {string} message - Limit and corrective action. */
  constructor(message) {
    super(message);
    this.statusCode = 413;
    this.code = 'storage_limit';
  }
}

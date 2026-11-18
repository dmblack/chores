/**
 * Explicit startup configuration and factory for interchangeable persistence.
 * SQLite remains the default; backend failures never trigger a silent fallback.
 * @module storage
 */
import { resolve } from 'node:path';
import { createSqliteStorage } from './sqlite.js';
import { createDynamoStorage } from './dynamodb.js';

/**
 * A coherent household revision, including writes with no domain events.
 * @typedef {object} StorageMetadata
 * @property {number} revision - Advances on every committed mutation.
 * @property {number} seq - Last committed domain event sequence.
 */

/**
 * Changes committed together, conditional on the expected metadata revision.
 * Null projection, session and throttle values delete records. Accounts are kept
 * for household history; events and action receipts are insert-only.
 * @typedef {object} StorageChange
 * @property {number} expectedRevision - Revision used to decide the change.
 * @property {number} expectedSeq - Event sequence used to decide the change.
 * @property {number} seq - Event sequence after applying the change.
 * @property {Map<string, object|null>} projections - Changed domain projections.
 * @property {Map<string, object>} users - Changed account rows.
 * @property {Map<string, object|null>} sessions - Changed hashed-token sessions.
 * @property {Map<string, object|null>} throttles - Changed login counters.
 * @property {Map<string, object>} actions - New durable action outcomes.
 * @property {object[]} events - New audit events in sequence order.
 */

/**
 * Asynchronous adapter contract. Reads are strongly consistent; the store checks
 * the household revision around multi-record reads to detect concurrent writes.
 * @typedef {object} StorageAdapter
 * @property {string} backend - Selected backend identity.
 * @property {function(): Promise<void>} initialize - Validate and initialize storage.
 * @property {function(): Promise<StorageMetadata>} metadata - Read household metadata.
 * @property {function(): Promise<Map<string, object>>} projections - Read all current projection records.
 * @property {function(): Promise<Map<string, object>>} users - Read credential-bearing accounts.
 * @property {function(string): Promise<object|undefined>} action - Read an action outcome.
 * @property {function(string): Promise<object|undefined>} session - Read a hashed-token session.
 * @property {function(): Promise<object[]>} sessions - Read sessions for console reporting.
 * @property {function(string): Promise<object|undefined>} throttle - Read a throttle counter.
 * @property {function(StorageChange): Promise<void>} commit - Atomically apply a conditional change.
 * @property {function(): Promise<object[]>} events - Read the complete ordered audit log.
 * @property {function(): Promise<void>} close - Release storage resources.
 */

/**
 * Read environment-only backend configuration.
 * @param {NodeJS.ProcessEnv|object} [env] - Environment variables.
 * @param {string} [defaultPath] - Default SQLite file.
 * @returns {object} Validated adapter options.
 */
export function storageConfigFromEnv(env = process.env, defaultPath = './data/chores.db') {
  const backend = env.STORAGE_BACKEND ?? 'sqlite';
  if (backend === 'sqlite') {
    const file = env.DB_PATH ?? defaultPath;
    return { backend, dbPath: file === ':memory:' ? file : resolve(file) };
  }
  if (backend !== 'dynamodb') throw new Error('STORAGE_BACKEND must be sqlite or dynamodb.');
  if (!env.DYNAMODB_TABLE?.trim()) throw new Error('DYNAMODB_TABLE is required for DynamoDB storage.');
  const region = env.AWS_REGION ?? env.AWS_DEFAULT_REGION;
  if (!region?.trim()) throw new Error('AWS_REGION is required for DynamoDB storage.');
  if (env.DYNAMODB_ENDPOINT) {
    const endpoint = new URL(env.DYNAMODB_ENDPOINT);
    if (!['http:', 'https:'].includes(endpoint.protocol)) throw new Error('DYNAMODB_ENDPOINT must be an HTTP or HTTPS URL.');
  }
  return { backend, table: env.DYNAMODB_TABLE, region, endpoint: env.DYNAMODB_ENDPOINT,
    namespace: env.DYNAMODB_NAMESPACE || 'household' };
}

/**
 * Select a storage adapter without changing application or domain code.
 * @param {object} [options] - SQLite or DynamoDB configuration.
 * @returns {StorageAdapter} Persistence adapter.
 */
export function createStorage(options = { backend: 'sqlite', dbPath: ':memory:' }) {
  if (options.backend === 'sqlite') return createSqliteStorage(options);
  if (options.backend === 'dynamodb') return createDynamoStorage(options);
  throw new Error('Storage backend must be sqlite or dynamodb.');
}

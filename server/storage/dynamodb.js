/**
 * DynamoDB single-table adapter. A household revision serializes commits across
 * processes; separate items hold projections, credentials, sessions and history.
 * @module storage/dynamodb
 */
import { DynamoDBClient, DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import { randomUUID } from 'node:crypto';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { StorageConflict, StorageLimit, StorageUnavailable } from './records.js';

/** @type {number} Conservative per-item ceiling allowing room for key attributes. */
const MAX_ITEM_BYTES = 380 * 1024;

/**
 * Open a DynamoDB adapter using the standard AWS SDK credential provider chain.
 * @param {object} options - Explicit table, region, optional endpoint and namespace.
 * @param {string} options.table - Existing table with string pk/sk keys.
 * @param {string} options.region - AWS region.
 * @param {string} [options.endpoint] - DynamoDB Local endpoint.
 * @param {string} [options.namespace] - Isolated household partition.
 * @returns {object} Asynchronous persistence adapter.
 */
export function createDynamoStorage({ table, region, endpoint, namespace = 'household' }) {
  const client = new DynamoDBClient({ region, ...(endpoint ? { endpoint } : {}), maxAttempts: 3 });
  const document = DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });
  /** @param {string} sk - Record identity. @returns {object} Partition-scoped key. */
  const key = (sk) => ({ pk: namespace, sk });

  /**
   * Send a command while translating infrastructure failures into retryable errors.
   * @param {object} command - AWS SDK command.
   * @returns {Promise<object>} AWS response.
   */
  async function send(command) {
    try { return await document.send(command); }
    catch (error) {
      if (error.name === 'ConditionalCheckFailedException' ||
          (error.name === 'TransactionCanceledException' && error.CancellationReasons?.some((reason) =>
            reason.Code === 'ConditionalCheckFailed' || reason.Code === 'TransactionConflict'))) throw new StorageConflict();
      if (error.name === 'TransactionConflictException') throw new StorageConflict();
      throw new StorageUnavailable(undefined, error);
    }
  }

  /**
   * Read one record with strong consistency.
   * @param {string} sk - Record sort key.
   * @returns {Promise<object|undefined>} Record value.
   */
  async function get(sk) {
    const response = await send(new GetCommand({ TableName: table, Key: key(sk), ConsistentRead: true }));
    return response.Item?.value;
  }

  /**
   * Read every page in a record family without scanning unrelated partitions.
   * Snapshot coherence is checked by the shared store's revision protocol.
   * @param {string} prefix - Sort-key prefix.
   * @returns {Promise<Map<string, object>>} Family records with stripped prefixes.
   */
  async function query(prefix) {
    const records = new Map();
    let cursor;
    do {
      const response = await send(new QueryCommand({ TableName: table,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: { ':pk': namespace, ':prefix': prefix },
        ConsistentRead: true, ...(cursor ? { ExclusiveStartKey: cursor } : {}) }));
      for (const item of response.Items ?? []) records.set(item.sk.slice(prefix.length), item.value);
      cursor = response.LastEvaluatedKey;
    } while (cursor);
    return records;
  }

  /**
   * Build a bounded DynamoDB Put operation for one independent record.
   * @param {string} sk - Sort key.
   * @param {object} value - Record value.
   * @returns {object} Transaction Put operation.
   */
  function put(sk, value) {
    const item = { ...key(sk), value };
    if (sk.startsWith('S#')) item.ttl = Math.ceil(value.expires_at / 1000);
    if (Buffer.byteLength(JSON.stringify(item)) > MAX_ITEM_BYTES) {
      throw new StorageLimit('A storage record is too large for DynamoDB. No changes were saved.');
    }
    return { Put: { TableName: table, Item: item } };
  }

  return {
    backend: 'dynamodb',
    /** @returns {Promise<void>} Validate the table and initialize this namespace. */
    async initialize() {
      let description;
      try { description = await client.send(new DescribeTableCommand({ TableName: table })); }
      catch (error) { client.destroy(); throw new Error(`Cannot open DynamoDB table "${table}". Provision it with npm run storage:setup.`, { cause: error }); }
      const schema = description.Table?.KeySchema ?? [];
      const attributes = description.Table?.AttributeDefinitions ?? [];
      if (schema.length !== 2 || !schema.some((entry) => entry.AttributeName === 'pk' && entry.KeyType === 'HASH') ||
          !schema.some((entry) => entry.AttributeName === 'sk' && entry.KeyType === 'RANGE') ||
          !['pk', 'sk'].every((name) => attributes.some((entry) => entry.AttributeName === name && entry.AttributeType === 'S'))) {
        throw new Error('DynamoDB storage requires string partition key pk and string sort key sk.');
      }
      try {
        await send(new PutCommand({ TableName: table, Item: { ...key('META'), value: { revision: 0, seq: 0, schemaVersion: 1 } },
          ConditionExpression: 'attribute_not_exists(pk)' }));
      } catch (error) { if (!(error instanceof StorageConflict)) throw error; }
      const meta = await get('META');
      if (meta?.schemaVersion !== 1) throw new Error('Unsupported DynamoDB storage schema version.');
    },
    /** @returns {Promise<object>} Global write revision and event sequence. */
    async metadata() {
      const value = await get('META');
      if (!value || value.schemaVersion !== 1) throw new StorageUnavailable('Storage metadata is missing or incompatible.');
      return value;
    },
    /** @returns {Promise<Map<string, object>>} Current projection records. */
    async projections() { return query('P#'); },
    /** @returns {Promise<Map<string, object>>} Accounts including credentials. */
    async users() { return query('U#'); },
    /** @param {string} id - Action identity. @returns {Promise<object|undefined>} Stored result. */
    async action(id) { return get(`A#${id}`); },
    /** @param {string} token - Hashed token. @returns {Promise<object|undefined>} Session. */
    async session(token) { return get(`S#${token}`); },
    /** @returns {Promise<object[]>} Sessions for console revocation reporting. */
    async sessions() { return [...(await query('S#')).values()]; },
    /** @param {string} identity - Throttle key. @returns {Promise<object|undefined>} Throttle. */
    async throttle(identity) { return get(`T#${identity}`); },
    /** @param {object} change - Conditional atomic changes. @returns {Promise<void>} */
    async commit(change) {
      const metadata = put('META', { revision: change.expectedRevision + 1, seq: change.seq, schemaVersion: 1 });
      metadata.Put.ConditionExpression = '#value.revision = :revision AND #value.seq = :seq';
      metadata.Put.ExpressionAttributeNames = { '#value': 'value' };
      metadata.Put.ExpressionAttributeValues = { ':revision': change.expectedRevision, ':seq': change.expectedSeq };
      const operations = [metadata];
      for (const [prefix, records] of [['P#', change.projections], ['U#', change.users], ['S#', change.sessions],
        ['T#', change.throttles], ['A#', change.actions]]) {
        for (const [id, value] of records) {
          const operation = value === null ? { Delete: { TableName: table, Key: key(`${prefix}${id}`) } } : put(`${prefix}${id}`, value);
          if (prefix === 'A#') operation.Put.ConditionExpression = 'attribute_not_exists(pk)';
          operations.push(operation);
        }
      }
      for (const event of change.events) {
        const operation = put(`E#${String(event.seq).padStart(16, '0')}`, event);
        operation.Put.ConditionExpression = 'attribute_not_exists(pk)';
        operations.push(operation);
      }
      if (operations.length > 100 || Buffer.byteLength(JSON.stringify(operations)) > 4 * 1024 * 1024) {
        throw new StorageLimit('This change exceeds DynamoDB atomic-write limits. No changes were saved.');
      }
      // SDK transport retries reuse this token for the exact same transaction.
      await send(new TransactWriteCommand({ TransactItems: operations, ClientRequestToken: randomUUID() }));
    },
    /** @returns {Promise<object[]>} Immutable audit events in sequence order. */
    async events() { return [...(await query('E#')).values()]; },
    /** @returns {Promise<void>} Release SDK network resources. */
    async close() { client.destroy(); },
  };
}

/**
 * Explicit DynamoDB provisioning utility. Normal application startup only opens
 * the configured table and never creates cloud infrastructure implicitly.
 * @module scripts/setup-storage
 */
import { DynamoDBClient, CreateTableCommand, DescribeTableCommand, UpdateTimeToLiveCommand, waitUntilTableExists } from '@aws-sdk/client-dynamodb';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { storageConfigFromEnv } from '../server/storage/index.js';

/**
 * Create or validate a pay-per-request table with delayed session TTL cleanup.
 * Expiry is always checked by authentication, independently of TTL deletion.
 * @param {object} config - Explicit DynamoDB environment configuration.
 * @returns {Promise<void>} Ready table.
 */
export async function setupDynamoTable(config) {
  if (config.backend !== 'dynamodb') throw new Error('Set STORAGE_BACKEND=dynamodb before provisioning a DynamoDB table.');
  const client = new DynamoDBClient({ region: config.region, ...(config.endpoint ? { endpoint: config.endpoint } : {}) });
  try {
    let table;
    try { table = (await client.send(new DescribeTableCommand({ TableName: config.table }))).Table; }
    catch (error) {
      if (error.name !== 'ResourceNotFoundException') throw error;
      await client.send(new CreateTableCommand({ TableName: config.table, BillingMode: 'PAY_PER_REQUEST',
        KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }, { AttributeName: 'sk', KeyType: 'RANGE' }],
        AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }, { AttributeName: 'sk', AttributeType: 'S' }] }));
      await waitUntilTableExists({ client, maxWaitTime: 60, minDelay: 1 }, { TableName: config.table });
      table = (await client.send(new DescribeTableCommand({ TableName: config.table }))).Table;
    }
    const schema = table?.KeySchema ?? [];
    if (schema.length !== 2 || !schema.some((entry) => entry.AttributeName === 'pk' && entry.KeyType === 'HASH') ||
        !schema.some((entry) => entry.AttributeName === 'sk' && entry.KeyType === 'RANGE') ||
        !['pk', 'sk'].every((name) => table.AttributeDefinitions.some((entry) => entry.AttributeName === name && entry.AttributeType === 'S'))) {
      throw new Error('Existing table is incompatible: expected string keys pk and sk.');
    }
    // Enabling TTL is idempotent in AWS only after checking its current status.
    const { DescribeTimeToLiveCommand } = await import('@aws-sdk/client-dynamodb');
    const ttl = await client.send(new DescribeTimeToLiveCommand({ TableName: config.table }));
    const status = ttl.TimeToLiveDescription?.TimeToLiveStatus;
    if (['ENABLED', 'ENABLING'].includes(status) && ttl.TimeToLiveDescription.AttributeName !== 'ttl') {
      throw new Error('Existing table has an incompatible TTL attribute; expected ttl.');
    }
    if (status === 'DISABLED') await client.send(new UpdateTimeToLiveCommand({ TableName: config.table,
      TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true } }));
  } finally { client.destroy(); }
}

// Importing this module for tests does not create tables or contact AWS.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const config = storageConfigFromEnv();
    await setupDynamoTable(config);
    console.log(`DynamoDB table ${config.table} is ready in ${config.region}.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

/**
 * Reproducible, local-only DynamoDB integration suite using an isolated Docker
 * container, temporary credentials and an automatically allocated loopback port.
 * @module scripts/test-dynamodb
 */
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { setupDynamoTable } from './setup-storage.js';

/** @type {function} Awaitable argument-safe process execution. */
const execute = promisify(execFile);
/** @type {string} Official DynamoDB Local 3.3.2 image pinned for repeatability. */
const IMAGE = 'amazon/dynamodb-local@sha256:6ada631ec7aa5fc83446855eb17233e3dad184fec47477e8140c6c569cfe0c86';
let container;
let tests;

/**
 * Stop only the container created by this invocation.
 * @returns {Promise<void>} Cleanup completion.
 */
async function cleanup() {
  if (!container) return;
  const id = container;
  container = null;
  await execute('docker', ['stop', '--time', '1', id]).catch(() => {});
}

// Signals also stop the child tests before releasing their disposable database.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => { tests?.kill(signal); await cleanup(); process.exit(130); });
}

try {
  const started = await execute('docker', ['run', '--detach', '--rm', '--publish', '127.0.0.1::8000',
    IMAGE, '-jar', 'DynamoDBLocal.jar', '-inMemory', '-sharedDb']);
  container = started.stdout.trim();
  const published = await execute('docker', ['port', container, '8000']);
  const address = published.stdout.trim();
  if (!/^127\.0\.0\.1:\d+$/.test(address)) throw new Error('DynamoDB test container must bind to loopback only.');
  const endpoint = `http://${address}`;
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    try { await fetch(endpoint, { signal: AbortSignal.timeout(500) }); ready = true; break; }
    catch { await delay(250); }
  }
  if (!ready) throw new Error('DynamoDB Local did not start within the test timeout.');
  const env = { ...process.env, TEST_STORAGE_BACKEND: 'dynamodb', STORAGE_BACKEND: 'dynamodb',
    DYNAMODB_TABLE: 'chores-integration', DYNAMODB_ENDPOINT: endpoint,
    AWS_REGION: 'us-east-1', AWS_ACCESS_KEY_ID: 'local', AWS_SECRET_ACCESS_KEY: 'local', AWS_EC2_METADATA_DISABLED: 'true' };
  // Setup uses these temporary credentials and can only reach the loopback service.
  Object.assign(process.env, { AWS_ACCESS_KEY_ID: 'local', AWS_SECRET_ACCESS_KEY: 'local', AWS_EC2_METADATA_DISABLED: 'true' });
  await setupDynamoTable({ backend: 'dynamodb', table: env.DYNAMODB_TABLE, region: env.AWS_REGION, endpoint });
  tests = spawn(process.execPath, ['--test', 'server/test/**/*.test.js', 'client/src/**/*.test.js'], { env, stdio: 'inherit' });
  const status = await new Promise((accept, reject) => {
    tests.once('error', reject);
    tests.once('exit', (code) => accept(code ?? 1));
  });
  process.exitCode = status;
} catch (error) {
  console.error(`DynamoDB integration tests failed: ${error.message}`);
  process.exitCode = 1;
} finally { await cleanup(); }

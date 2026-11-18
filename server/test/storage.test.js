/**
 * Shared storage contract and cross-instance integration tests. These exercise
 * the same public behaviour against SQLite and the real DynamoDB Local engine.
 * @module test/storage
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../app.js';
import { openDb } from '../db.js';
import { createStorage, storageConfigFromEnv } from '../storage/index.js';
import { StorageUnavailable, StorageLimit } from '../storage/records.js';
import { household, markDone, testStorage } from './helpers.js';

/**
 * Share one disposable database between independently initialized app instances.
 * @param {object} t - Node test context.
 * @returns {Promise<object>} Household and second app with cleanup registered.
 */
async function sharedHousehold(t) {
  const dir = mkdtempSync(join(tmpdir(), 'chores-storage-'));
  const storage = process.env.TEST_STORAGE_BACKEND === 'dynamodb' ? testStorage()
    : { backend: 'sqlite', dbPath: join(dir, 'shared.db') };
  const h = await household({ storage });
  const other = buildApp({ storage, clock: h.clock });
  await other.ready();
  t.after(async () => { await Promise.all([h.close(), other.close()]); rmSync(dir, { recursive: true, force: true }); });
  return { h, other };
}

/** @param {object} h - Household. @param {object} app - Other server. @param {string} name - Username. @returns {Promise<object>} Signed-in client. */
async function signedIn(h, app, name = 'dusty') {
  const client = h.client(app);
  assert.equal((await client.post('/api/auth/login', { username: name, password: `${name}-pass` })).status, 200);
  return client;
}

/** @param {object} adapter - Storage. @param {Map} projections - Record changes. @returns {Promise<void>} Test-only atomic commit. */
async function putProjections(adapter, projections) {
  const meta = await adapter.metadata();
  await adapter.commit({ expectedRevision: meta.revision, expectedSeq: meta.seq, seq: meta.seq,
    projections, users: new Map(), sessions: new Map(), throttles: new Map(), actions: new Map(), events: [] });
}

/**
 * Parse successive sequence notifications even when HTTP chunks combine frames.
 * @param {ReadableStreamDefaultReader<Uint8Array>} reader - Live response reader.
 * @returns {function(): Promise<number>} Next SSE sequence notification.
 */
function sequenceReader(reader) {
  const decoder = new TextDecoder();
  let pending = '';
  return async function nextSequence() {
    for (;;) {
      const end = pending.indexOf('\n\n');
      if (end >= 0) {
        const frame = pending.slice(0, end);
        pending = pending.slice(end + 2);
        const line = frame.split('\n').find((part) => part.startsWith('data: '));
        if (line) return JSON.parse(line.slice(6)).seq;
      } else {
        const chunk = await reader.read();
        assert.equal(chunk.done, false, 'Stream ended before the expected notification');
        pending += decoder.decode(chunk.value, { stream: true });
      }
    }
  };
}

/** Environment validation fails closed and never selects a surprise backend. */
test('storage configuration defaults to SQLite and validates DynamoDB settings', () => {
  assert.equal(storageConfigFromEnv({}).backend, 'sqlite');
  assert.equal(storageConfigFromEnv({ DB_PATH: ':memory:' }).dbPath, ':memory:');
  assert.throws(() => storageConfigFromEnv({ STORAGE_BACKEND: 'unknown' }), /STORAGE_BACKEND/);
  assert.throws(() => storageConfigFromEnv({ STORAGE_BACKEND: 'dynamodb' }), /DYNAMODB_TABLE/);
  assert.throws(() => storageConfigFromEnv({ STORAGE_BACKEND: 'dynamodb', DYNAMODB_TABLE: 'chores' }), /AWS_REGION/);
  assert.deepEqual(storageConfigFromEnv({ STORAGE_BACKEND: 'dynamodb', DYNAMODB_TABLE: 'chores', AWS_REGION: 'ap-southeast-2' }), {
    backend: 'dynamodb', table: 'chores', region: 'ap-southeast-2', endpoint: undefined, namespace: 'household',
  });
});

/** Concurrent parents must not award completion or approval points twice. */
test('independent servers serialize competing approvals without double points', async (t) => {
  const { h, other } = await sharedHousehold(t);
  const mia = await signedIn(h, other, 'mia');
  const taskId = await h.createTask({ name: 'Concurrent dishes' });
  const submission = await markDone(h.dana, taskId);
  const results = await Promise.all([
    h.dusty.act('completion.approve', { completionId: submission.completionId }),
    mia.act('completion.approve', { completionId: submission.completionId }),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), ['accepted', 'rejected']);
  assert.equal(results.find((result) => result.status === 'rejected').error.code, 'already_approved');
  assert.equal((await h.dana.state()).points.balance, 10);
  assert.equal((await h.dusty.state()).points.balance + (await mia.state()).points.balance, 1);
  assert.equal((await h.app.store.events()).filter((event) => event.type === 'completion.approved').length, 1);
});

/** Concurrent writes to different jobs must also preserve a shared balance. */
test('independent servers preserve both awards when approving different completions', async (t) => {
  const { h, other } = await sharedHousehold(t);
  const mia = await signedIn(h, other, 'mia');
  const first = await markDone(h.dana, await h.createTask({ name: 'First job', points: 7 }));
  const second = await markDone(h.dana, await h.createTask({ name: 'Second job', points: 11 }));
  const results = await Promise.all([
    h.dusty.act('completion.approve', { completionId: first.completionId }),
    mia.act('completion.approve', { completionId: second.completionId }),
  ]);
  assert.ok(results.every((result) => result.status === 'accepted'));
  assert.equal((await h.dana.state()).points.balance, 18);
});

/** Stable action identities remain effective across servers and restarts. */
test('duplicate actions remain idempotent after another server starts', async (t) => {
  const { h, other } = await sharedHousehold(t);
  const dusty = await signedIn(h, other);
  const submission = await markDone(h.dana, await h.createTask({ name: 'Retry job' }));
  const id = randomUUID();
  const results = await Promise.all([
    h.dusty.act('completion.approve', { completionId: submission.completionId }, { id }),
    dusty.act('completion.approve', { completionId: submission.completionId }, { id }),
  ]);
  assert.ok(results.every((result) => result.status === 'accepted'));
  assert.equal(results.filter((result) => result.duplicate).length, 1);
  const count = await h.eventCount();
  const restarted = buildApp({ storage: h.storage, clock: h.clock });
  await restarted.ready();
  t.after(() => restarted.close());
  const client = await signedIn(h, restarted);
  assert.equal((await client.act('completion.approve', { completionId: submission.completionId }, { id })).duplicate, true);
  assert.equal(await h.eventCount(), count);
  assert.equal((await h.dana.state()).points.balance, 10);
});

/** Live connections and first-subscriber races must observe another server's writes. */
test('live streams observe remote commits, subscription races and reconnects', { timeout: 12_000 }, async (t) => {
  const { h, other } = await sharedHousehold(t);
  const dusty = await signedIn(h, other);
  const address = await other.listen({ port: 0, host: '127.0.0.1' });
  const cookies = Object.entries(dusty.jar).map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join('; ');
  const initial = await other.store.refresh();
  let raced;
  const refresh = other.store.refresh.bind(other.store);
  // Commit after the route's first read, and announce before it subscribes. A
  // revision poll alone would miss this notification because it is already known.
  other.store.refresh = async () => {
    const seq = await refresh();
    if (raced === undefined) {
      raced = initial;
      await h.createTask({ name: 'Subscription race' });
      raced = await other.store.read((tx) => tx.state.seq);
    }
    return seq;
  };
  const response = await fetch(`${address}/api/stream`, { headers: { cookie: cookies }, signal: AbortSignal.timeout(10_000) });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  try {
    const next = sequenceReader(reader);
    assert.equal(await next(), initial);
    assert.equal(await next(), raced);
    other.store.refresh = refresh;
    await h.createTask({ name: 'Remote live update' });
    const expected = await h.app.store.refresh();
    let observed;
    do { observed = await next(); } while (observed < expected);
    assert.equal(observed, expected);
  } finally { other.store.refresh = refresh; await reader.cancel(); }
  // A new first subscriber must receive changes committed with no stream open.
  await h.createTask({ name: 'While disconnected' });
  const expected = await h.app.store.refresh();
  const reconnected = await fetch(`${address}/api/stream`, { headers: { cookie: cookies }, signal: AbortSignal.timeout(5_000) });
  const reconnectedReader = reconnected.body.getReader();
  try {
    const next = sequenceReader(reconnectedReader);
    assert.equal(await next(), expected);
    await h.createTask({ name: 'After reconnect' });
    const afterReconnect = await h.app.store.refresh();
    let observed;
    do { observed = await next(); } while (observed < afterReconnect);
    assert.equal(observed, afterReconnect);
  }
  finally { await reconnectedReader.cancel(); }
});

/** A failed transaction must not leave partial points, events or action receipts. */
test('storage failures return retryable errors and preserve action atomicity', async (t) => {
  const h = await household();
  t.after(h.close);
  const submission = await markDone(h.dana, await h.createTask({ name: 'Retryable job' }));
  const id = randomUUID();
  const before = await h.eventCount();
  const adapter = h.app.store.storage;
  const commit = adapter.commit.bind(adapter);
  adapter.commit = async () => { throw new StorageUnavailable('Injected test outage'); };
  const response = await h.dusty.post('/api/actions', { actions: [{ id, type: 'completion.approve', payload: { completionId: submission.completionId } }] });
  adapter.commit = commit;
  assert.equal(response.status, 503);
  assert.equal(await h.eventCount(), before);
  assert.equal((await h.dana.state()).points.balance, 0);
  assert.equal((await h.dusty.act('completion.approve', { completionId: submission.completionId }, { id })).status, 'accepted');
  assert.equal((await h.dana.state()).points.balance, 10);
});

/** A native error after projection writes must roll the entire SQLite transaction back. */
test('SQLite rolls back native database failures and returns a retryable error', {
  skip: process.env.TEST_STORAGE_BACKEND === 'dynamodb',
}, async (t) => {
  const h = await household();
  t.after(h.close);
  const submission = await markDone(h.dana, await h.createTask({ name: 'Rollback job' }));
  const id = randomUUID();
  const before = await h.eventCount();
  const adapter = h.app.store.storage;
  // Reject the event insertion after projections and the action receipt were written.
  adapter.db.exec(`CREATE TRIGGER injected_failure BEFORE INSERT ON events
    WHEN NEW.type = 'completion.approved' BEGIN SELECT RAISE(ABORT, 'Injected failure'); END;`);
  const response = await h.dusty.post('/api/actions', { actions: [{ id, type: 'completion.approve', payload: { completionId: submission.completionId } }] });
  adapter.db.exec('DROP TRIGGER injected_failure');
  assert.equal(response.status, 503);
  assert.equal(await h.eventCount(), before);
  assert.equal(await adapter.action(id), undefined);
  assert.equal((await h.dana.state()).points.balance, 0);
  assert.equal((await h.dusty.act('completion.approve', { completionId: submission.completionId }, { id })).status, 'accepted');
  assert.equal((await h.dana.state()).points.balance, 10);
});

/** A lost response after commit must reconcile through the same durable action ID. */
test('a committed action whose response is lost is not applied twice', async (t) => {
  const h = await household();
  t.after(h.close);
  const submission = await markDone(h.dana, await h.createTask({ name: 'Lost response job' }));
  const id = randomUUID();
  const adapter = h.app.store.storage;
  const commit = adapter.commit.bind(adapter);
  adapter.commit = async (change) => { await commit(change); throw new StorageUnavailable('Injected lost response'); };
  const response = await h.dusty.post('/api/actions', { actions: [{ id, type: 'completion.approve', payload: { completionId: submission.completionId } }] });
  adapter.commit = commit;
  assert.equal(response.status, 503);
  assert.equal((await h.dusty.act('completion.approve', { completionId: submission.completionId }, { id })).duplicate, true);
  assert.equal((await h.dana.state()).points.balance, 10);
});

/** Username and PIN uniqueness checks must be inside the cross-process commit. */
test('independent servers enforce case-insensitive username and PIN uniqueness', async (t) => {
  const { h, other } = await sharedHousehold(t);
  const dusty = await signedIn(h, other);
  const profile = { nickname: 'Twin', role: 'kid', birthDate: '2018-01-01', password: 'twin-pass' };
  const people = await Promise.all([
    h.dusty.post('/api/users', { ...profile, username: 'Twin' }),
    dusty.post('/api/users', { ...profile, username: 'twin' }),
  ]);
  assert.deepEqual(people.map((result) => result.status).sort(), [200, 409]);
  const harrison = await signedIn(h, other, 'harrison');
  const pins = await Promise.all([
    h.dana.post('/api/me/pin', { currentPassword: 'dana-pass', pin: '456789' }),
    harrison.post('/api/me/pin', { currentPassword: 'harrison-pass', pin: '456789' }),
  ]);
  assert.deepEqual(pins.map((result) => result.status).sort(), [200, 409]);
});

/** Wrong attempts cannot escape their shared network counter by changing server. */
test('login throttling is shared between independent servers', async (t) => {
  const { h, other } = await sharedHousehold(t);
  const first = h.client();
  const second = h.client(other);
  assert.equal((await first.post('/api/auth/pin', { pin: '000000' })).status, 401);
  assert.equal((await second.post('/api/auth/pin', { pin: '000000' })).status, 401);
  assert.equal((await first.post('/api/auth/pin', { pin: '000000' })).body.error.retryAfterMs, 1000);
  assert.equal((await second.post('/api/auth/pin', { pin: '000000' })).status, 429);
});

/** Revocation must remain effective after reactivation and across cached processes. */
test('deactivated accounts cannot reuse old sessions after reactivation', async (t) => {
  const { h, other } = await sharedHousehold(t);
  const dana = await signedIn(h, other, 'dana');
  assert.equal((await h.dusty.patch(`/api/users/${h.dana.id}`, { active: false })).status, 200);
  assert.equal((await h.dusty.patch(`/api/users/${h.dana.id}`, { active: true })).status, 200);
  assert.equal((await dana.get('/api/state')).status, 401);
  assert.equal((await dana.post('/api/auth/login', { username: 'dana', password: 'dana-pass' })).status, 200);
});

/** A second process must never remove the final adult based on stale account state. */
test('competing account changes retain at least one active grown-up', async (t) => {
  const { h, other } = await sharedHousehold(t);
  const dusty = await signedIn(h, other);
  const parent = await h.dusty.post('/api/users', { username: 'parent', nickname: 'Parent', role: 'grownup', birthDate: '1980-01-01', password: 'parent-pass' });
  const changes = await Promise.all([
    h.dusty.patch(`/api/users/${h.dusty.id}`, { active: false }),
    dusty.patch(`/api/users/${parent.body.id}`, { active: false }),
  ]);
  assert.equal(changes.filter((result) => result.status === 200).length, 1);
  assert.equal(await h.app.store.read((tx) => [...tx.users.values()].filter((user) => user.active && user.role === 'grownup').length), 1);
});

/** Split records must survive crossing DynamoDB's one-megabyte query page boundary. */
test('projection queries retain every record across large paginated results', async (t) => {
  const adapter = createStorage(testStorage());
  await adapter.initialize();
  t.after(() => adapter.close());
  for (let batch = 0; batch < 2; batch++) {
    const records = new Map();
    for (let i = 0; i < 25; i++) records.set(`tasks/${batch * 25 + i}`, { value: { name: `Large record ${i}`, data: 'x'.repeat(25_000) } });
    await putProjections(adapter, records);
  }
  const records = await adapter.projections();
  assert.equal([...records.keys()].filter((key) => key.startsWith('tasks/')).length, 50);
  assert.equal(records.get('tasks/49').value.data.length, 25_000);
});

/** DynamoDB limits must reject the entire write without advancing its revision. */
test('DynamoDB rejects oversized records and transactions without partial writes', {
  skip: process.env.TEST_STORAGE_BACKEND !== 'dynamodb',
}, async (t) => {
  const adapter = createStorage(testStorage());
  await adapter.initialize();
  t.after(() => adapter.close());
  await assert.rejects(putProjections(adapter, new Map([['tasks/huge', { value: 'x'.repeat(400 * 1024) }]])), StorageLimit);
  await assert.rejects(putProjections(adapter, new Map(Array.from({ length: 100 }, (_, i) => [`tasks/${i}`, { value: i }]))), StorageLimit);
  assert.equal((await adapter.metadata()).revision, 0);
  assert.equal((await adapter.projections()).size, 0);
});

/** A missing cloud table must stop startup without silently opening SQLite. */
test('DynamoDB startup fails closed when the configured table is missing', {
  skip: process.env.TEST_STORAGE_BACKEND !== 'dynamodb',
}, async (t) => {
  const app = buildApp({ storage: { ...testStorage(), table: `missing-${randomUUID()}` } });
  t.after(() => app.close());
  await assert.rejects(app.ready(), /Cannot open DynamoDB table/);
  assert.equal(app.store.storage.backend, 'dynamodb');
});

/** Existing SQLite files are upgraded additively, preserving credentials and history. */
test('legacy SQLite databases rebuild projections without losing existing data', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'chores-legacy-'));
  const storage = { backend: 'sqlite', dbPath: join(dir, 'legacy.db') };
  const h = await household({ storage });
  const submission = await markDone(h.dana, await h.createTask({ name: 'Preserved job' }));
  await h.dusty.act('completion.approve', { completionId: submission.completionId });
  const events = await h.eventCount();
  await h.close();
  // Remove only the new schema pieces from this disposable fixture to emulate an old installation.
  const db = openDb(storage.dbPath);
  db.exec('DROP TABLE storage_meta; DROP TABLE storage_projection; ALTER TABLE users DROP COLUMN auth_version; ALTER TABLE sessions DROP COLUMN user_version;');
  db.close();
  const upgraded = buildApp({ storage, clock: h.clock });
  await upgraded.ready();
  t.after(async () => { await upgraded.close(); rmSync(dir, { recursive: true, force: true }); });
  const dana = h.client(upgraded);
  Object.assign(dana.jar, h.dana.jar);
  assert.equal((await dana.state()).points.balance, 10);
  assert.equal((await upgraded.store.events()).length, events);
  assert.equal((await dana.post('/api/auth/login', { username: 'dana', password: 'dana-pass' })).status, 200);
});

/** The console command must use DynamoDB configuration and revoke cached sessions. */
test('password-reset console command supports DynamoDB and cross-process revocation', {
  skip: process.env.TEST_STORAGE_BACKEND !== 'dynamodb',
}, async (t) => {
  const { h, other } = await sharedHousehold(t);
  const dusty = await signedIn(h, other);
  const script = fileURLToPath(new URL('../../scripts/reset-password.js', import.meta.url));
  const reset = spawnSync(process.execPath, [script, 'dusty', '--sign-out'], { input: 'new-console-pass\nnew-console-pass\n', encoding: 'utf8',
    env: { ...process.env, STORAGE_BACKEND: 'dynamodb', DYNAMODB_NAMESPACE: h.storage.namespace } });
  assert.equal(reset.status, 0, reset.stderr);
  assert.match(reset.stdout, /Signed out of 2 session/);
  assert.equal((await dusty.get('/api/state')).status, 401);
  assert.equal((await dusty.post('/api/auth/login', { username: 'dusty', password: 'new-console-pass' })).status, 200);
  assert.equal((await h.app.store.events()).filter((event) => event.payload.changes?.via === 'console').length, 1);
});

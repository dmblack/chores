/**
 * Smoke-test the actual deployment ZIP on the official Amazon Linux Node.js 24
 * image with disposable DynamoDB Local storage. All published ports are bound
 * to loopback; a dedicated Docker network and explicit local endpoints keep
 * test storage separate from other applications and production credentials.
 * Requires Docker, unzip, and an artifact produced by the AWS packaging script.
 * @module scripts/test-aws-package
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setupDynamoTable } from './setup-storage.js';

/** @type {function} Argument-safe subprocess execution without a shell. */
const execute = promisify(execFile);
/** @type {string} Verified official Node.js 24.22.3 image for Amazon Linux 2023. */
const NODE_IMAGE = 'public.ecr.aws/lambda/nodejs@sha256:1ed0bf9d7eb128b77d567a15b58053c66b3c5b57eee23d77ba6734d5176cb1f3';
/** @type {string} Official DynamoDB Local 3.3.2 image used by the integration suite. */
const DYNAMODB_IMAGE = 'amazon/dynamodb-local@sha256:6ada631ec7aa5fc83446855eb17233e3dad184fec47477e8140c6c569cfe0c86';
/** @type {string} Repository root, independent of the caller's working directory. */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** @type {string} Non-production origin credential, never included in command arguments. */
const ORIGIN_SECRET = 'a'.repeat(64);
/** @type {string} Non-production first-account credential. */
const BOOTSTRAP_TOKEN = 'b'.repeat(64);
/** @type {string} Disposable account password used only inside the isolated network. */
const PASSWORD = `Package-${randomUUID()}`;
/** @type {string[]} Names of this invocation's containers, including incomplete starts. */
const containers = [];
/** @type {string|null} Name of this invocation's dedicated Docker network. */
let network = null;
/** @type {string|null} Directory containing the extracted ZIP. */
let extracted = null;
/** @type {Promise<void>|null} Shared cleanup operation for normal exit and signals. */
let cleaning = null;
/** @type {Set<Promise<object>>} Pending Docker launches that cleanup must let settle. */
const launches = new Set();

/**
 * Remove test credentials and cookie values from diagnostic output.
 * @param {unknown} value - Docker or application diagnostic text.
 * @returns {string} Bounded, redacted text safe to display.
 */
function safeMessage(value) {
  return String(value).replaceAll(ORIGIN_SECRET, '[origin redacted]')
    .replaceAll(BOOTSTRAP_TOKEN, '[bootstrap redacted]').replaceAll(PASSWORD, '[password redacted]')
    .replace(/\b(sid|did)=[^;\s"',}]+/gi, '$1=[cookie redacted]').slice(-8_000);
}

/**
 * Run Docker without printing arguments or secret-bearing environment values.
 * @param {string[]} args - Individual Docker arguments.
 * @param {object} [options] - Optional subprocess environment.
 * @returns {Promise<string>} Standard output, including stderr for container logs.
 */
async function docker(args, options = {}) {
  const launching = args[0] === 'run' || (args[0] === 'network' && args[1] === 'create');
  if (launching && cleaning) throw new Error('The package smoke test is shutting down.');
  let operation;
  try {
    operation = execute('docker', args, { timeout: 180_000, maxBuffer: 8 * 1024 * 1024, ...options });
    if (launching) launches.add(operation);
    const result = await operation;
    return (args[0] === 'logs' ? `${result.stdout}\n${result.stderr}` : result.stdout).trim();
  } catch (error) {
    throw new Error(`Docker ${args[0]} failed: ${safeMessage(error.stderr || error.message)}`);
  } finally { if (launching) launches.delete(operation); }
}

/**
 * Release only this invocation's containers, network and temporary extraction.
 * @returns {Promise<void>} Completion of idempotent best-effort cleanup.
 */
function cleanup() {
  cleaning ??= (async () => {
    await Promise.allSettled([...launches]);
    for (const name of containers.toReversed()) await docker(['rm', '--force', name]).catch(() => {});
    if (network) await docker(['network', 'rm', network]).catch(() => {});
    if (extracted) await rm(extracted, { recursive: true, force: true });
  })();
  return cleaning;
}

/**
 * Return a container's automatically allocated loopback HTTP endpoint.
 * @param {string} container - Name of an owned container.
 * @param {number} port - Its internal HTTP port.
 * @returns {Promise<string>} Loopback-only endpoint.
 */
async function endpoint(container, port) {
  const address = await docker(['port', container, String(port)]);
  if (!/^127\.0\.0\.1:\d+$/.test(address)) throw new Error('Test ports must be published on loopback only.');
  return `http://${address}`;
}

/**
 * Wait for a container's HTTP listener without leaving readiness unbounded.
 * @param {string} url - Loopback URL to probe.
 * @param {string} label - Safe service name for errors.
 * @returns {Promise<void>} Completion when an HTTP response is available.
 */
async function waitForHttp(url, label) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      await response.body?.cancel();
      if (response.status < 500) return;
    } catch {
      // Connection errors are expected until the isolated service starts.
    }
    await delay(250);
  }
  throw new Error(`${label} did not become ready within 45 seconds.`);
}

/**
 * Exercise authentication, persistence and PWA files through the packaged server.
 * @param {string} base - Loopback address of the packaged HTTP application.
 * @param {function(): Promise<string>} restart - Restart the server and return its current loopback endpoint.
 * @returns {Promise<void>} Completion after all application assertions pass.
 */
async function smoke(base, restart) {
  const cookies = new Map();
  /**
   * Send one bounded HTTP request and retain cookies without printing secrets.
   * @param {string} method - HTTP method.
   * @param {string} path - Relative application route.
   * @param {object} [options] - JSON body, additional headers and origin-gate toggle.
   * @returns {Promise<object>} Response plus parsed JSON or text body.
   */
  async function request(method, path, { body, headers = {}, origin = true } = {}) {
    const response = await fetch(`${base}${path}`, {
      method, redirect: 'manual', signal: AbortSignal.timeout(15_000),
      headers: { ...(origin ? { 'x-app-origin-secret': ORIGIN_SECRET } : {}),
        Origin: 'https://tasks.fortheherd.net',
        ...(cookies.size ? { Cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; ') } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';', 1)[0];
      const separator = pair.indexOf('=');
      if (separator > 0) cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
    const text = await response.text();
    let data = text;
    try { data = JSON.parse(text); } catch { /* Static HTML and service workers are text. */ }
    return { response, data };
  }

  /** @type {object} A direct origin request must fail before device-cookie creation. */
  const denied = await request('GET', '/api/auth/status', { origin: false });
  assert.equal(denied.response.status, 403, 'Direct requests must require the origin header.');
  assert.equal(denied.response.headers.getSetCookie().length, 0, 'Blocked origin requests must not set cookies.');
  const initial = await request('GET', '/api/auth/status');
  assert.equal(initial.response.status, 200);
  assert.equal(initial.data.needsSetup, true);

  /** @type {object} The first account requires an independent bootstrap token. */
  const profile = { username: 'package-parent', nickname: 'Package parent', birthDate: '1990-01-01', password: PASSWORD };
  assert.equal((await request('POST', '/api/auth/setup', { body: profile })).response.status, 403);
  const created = await request('POST', '/api/auth/setup', { body: profile, headers: { 'x-bootstrap-token': BOOTSTRAP_TOKEN } });
  assert.equal(created.response.status, 200, 'The bootstrap token should create the first grown-up.');
  const sessionCookie = created.response.headers.getSetCookie().find((value) => value.startsWith('sid='));
  assert.ok(sessionCookie, 'Setup must return a session cookie.');
  assert.match(sessionCookie, /;\s*Secure(?:;|$)/i);
  assert.match(sessionCookie, /;\s*HttpOnly(?:;|$)/i);
  assert.match(sessionCookie, /;\s*SameSite=Lax(?:;|$)/i);
  assert.ok(cookies.has('did') && cookies.has('sid'), 'The client must preserve both device and session cookies.');

  /** @type {object} Authenticated reads and writes must persist through DynamoDB. */
  const signedIn = await request('GET', '/api/state');
  assert.equal(signedIn.response.status, 200);
  assert.equal(signedIn.data.me.role, 'grownup');
  assert.equal(signedIn.data.today, new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Melbourne',
    year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()), 'Household calendar dates must use the configured timezone.');
  assert.equal((await request('PATCH', '/api/me', { body: { nickname: 'Deployed parent' } })).response.status, 200);
  assert.equal((await request('GET', '/api/state')).data.me.nickname, 'Deployed parent');
  const taskId = randomUUID();
  const action = { id: randomUUID(), type: 'task.create', payload: { taskId,
    def: { name: 'Deployment smoke task', criterion: 'Done properly', points: 10,
      list: 'evening', repeat: { type: 'daily' } } } };
  const changed = await request('POST', '/api/actions', { body: { actions: [action] } });
  assert.equal(changed.response.status, 200);
  assert.equal(changed.data.results[0].status, 'accepted');
  base = await restart();
  const saved = await request('GET', '/api/state');
  assert.equal(saved.response.status, 200, 'The session must survive a fresh server process.');
  assert.equal(saved.data.me.nickname, 'Deployed parent', 'Profile changes must survive a fresh server process.');
  assert.ok(saved.data.tasks.some((task) => task.id === taskId), 'The created task must survive a fresh state read.');

  // Verify actual assets rather than accepting the SPA fallback for missing files.
  const index = await request('GET', '/');
  assert.equal(index.response.status, 200);
  assert.match(index.data, /<div\s+id="root"/);
  const worker = await request('GET', '/sw.js');
  assert.equal(worker.response.status, 200);
  assert.match(worker.response.headers.get('content-type'), /javascript|ecmascript/i);
  const manifest = await request('GET', '/manifest.webmanifest');
  assert.equal(manifest.response.status, 200);
  assert.equal(manifest.data.display, 'standalone');
  const watch = await request('GET', '/watch');
  assert.equal(watch.response.status, 200);
  assert.match(watch.response.headers.get('content-type'), /text\/html/i);
  assert.equal(watch.response.headers.get('cache-control'), 'no-store');
}

/**
 * Extract the ZIP and run it with disposable, explicitly local storage services.
 * @returns {Promise<void>} Completion after runtime and HTTP checks pass.
 */
async function main() {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('The package smoke test requires Node.js 24 or newer.');
  const archive = join(ROOT, '.deploy', 'chores-aws.zip');
  await access(archive).catch(() => { throw new Error('Build .deploy/chores-aws.zip before running the package smoke test.'); });
  extracted = await mkdtemp(join(tmpdir(), 'chores-aws-package-'));
  await execute('unzip', ['-q', archive, '-d', extracted]);
  await access(join(extracted, 'server', 'index.js'));
  await access(join(extracted, 'client', 'dist', 'sw.js'));
  await docker(['version', '--format', '{{.Server.Version}}']);
  const id = randomUUID();
  network = `chores-package-${id}`;
  await docker(['network', 'create', network]);
  const database = `chores-package-db-${id}`;
  containers.push(database);
  await docker(['run', '--detach', '--name', database, '--network', network, '--network-alias', 'dynamodb',
    '--publish', '127.0.0.1::8000', DYNAMODB_IMAGE, '-jar', 'DynamoDBLocal.jar', '-inMemory', '-sharedDb']);
  const databaseEndpoint = await endpoint(database, 8000);
  await waitForHttp(databaseEndpoint, 'DynamoDB Local');

  // The provisioning helper sees temporary credentials and only the loopback endpoint.
  const temporaryCredentials = { AWS_ACCESS_KEY_ID: 'local', AWS_SECRET_ACCESS_KEY: 'local',
    AWS_SESSION_TOKEN: 'local-session', AWS_EC2_METADATA_DISABLED: 'true' };
  const previous = Object.fromEntries(Object.keys(temporaryCredentials).map((key) => [key, process.env[key]]));
  try {
    Object.assign(process.env, temporaryCredentials);
    await setupDynamoTable({ backend: 'dynamodb', table: 'chores-package-test', region: 'us-west-2', endpoint: databaseEndpoint });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  const application = `chores-package-app-${id}`;
  containers.push(application);
  const environment = { ...temporaryCredentials, AWS_LAMBDA_HTTP_ENDPOINT: '0.0.0.0:8080',
    AWS_LAMBDA_NODEJS_ENTRYPOINT: 'server/index.js', STORAGE_BACKEND: 'dynamodb', DYNAMODB_TABLE: 'chores-package-test',
    AWS_REGION: 'us-west-2', DYNAMODB_ENDPOINT: 'http://dynamodb:8000', APP_ORIGIN_SECRET: ORIGIN_SECRET,
    BOOTSTRAP_TOKEN, PUBLIC_ORIGIN: 'https://tasks.fortheherd.net', COOKIE_SECURE: 'true', TRUST_PROXY: 'true', TZ: 'Australia/Melbourne' };
  await docker(['run', '--detach', '--name', application, '--network', network,
    '--publish', '127.0.0.1::8080', '--read-only', '--tmpfs', '/tmp:rw,nosuid,nodev,size=64m',
    '--mount', `type=bind,source=${extracted},target=/var/task,readonly`, '--workdir', '/var/task',
    '--entrypoint', '/var/lang/bin/node', ...Object.keys(environment).flatMap((key) => ['--env', key]),
    NODE_IMAGE, 'server/index.js'], { env: { ...process.env, ...environment } });
  const applicationEndpoint = await endpoint(application, 8080);
  await waitForHttp(`${applicationEndpoint}/api/auth/status`, 'The packaged application');
  const runtime = JSON.parse(await docker(['exec', application, '/var/lang/bin/node', '--eval',
    'process.stdout.write(JSON.stringify({node:process.versions.node,arch:process.arch}))']));
  assert.equal(runtime.node.split('.')[0], '24', 'The artifact must execute on the deployment Node.js major version.');
  /** @returns {Promise<string>} Fresh process endpoint; Docker may reallocate its random published port. */
  async function restartApplication() {
    await docker(['restart', '--time', '1', application]);
    const restartedEndpoint = await endpoint(application, 8080);
    await waitForHttp(`${restartedEndpoint}/api/auth/status`, 'The restarted packaged application');
    return restartedEndpoint;
  }
  await smoke(applicationEndpoint, restartApplication);
  console.log(`AWS ZIP smoke test passed: Node.js ${runtime.node} / Amazon Linux 2023 / ${runtime.arch}, DynamoDB persistence, origin/bootstrap gates, secure cookies, PWA assets and watch pages.`);
}

// Signals release only the temporary resources owned by this test invocation.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => { await cleanup(); process.exit(signal === 'SIGINT' ? 130 : 143); });
}

try {
  await main();
} catch (error) {
  console.error(`AWS package smoke test failed: ${safeMessage(error.message)}`);
  for (const container of containers) {
    const logs = await docker(['logs', '--tail', '80', container]).catch(() => 'Container logs unavailable.');
    if (logs) console.error(safeMessage(logs));
  }
  process.exitCode = 1;
} finally { await cleanup(); }

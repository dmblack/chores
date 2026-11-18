/**
 * Public deployment boundaries and managed-runtime regression tests.
 * @module test/deployment
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../app.js';
import { secretMatches } from '../edge.js';
import { runtimeConfigFromEnv } from '../runtime.js';
import { testStorage } from './helpers.js';

const originSecret = 'a'.repeat(64);
const bootstrapToken = 'b'.repeat(64);
const publicOrigin = 'https://tasks.fortheherd.net';
const headers = { 'x-app-origin-secret': originSecret };
const profile = { username: 'parent', nickname: 'Parent', birthDate: '1980-01-01', password: 'first-parent-password' };

/** Constant-size comparisons accept only a single exact string credential. */
test('origin secrets reject missing, malformed and incorrect header values', () => {
  assert.equal(secretMatches(originSecret, originSecret), true);
  for (const value of [undefined, null, [originSecret], `${originSecret}, ${originSecret}`, 'wrong']) {
    assert.equal(secretMatches(value, originSecret), false);
  }
});

/** Local settings retain their defaults; managed settings fail closed. */
test('runtime supports local defaults and the required Lambda listen address', () => {
  const local = runtimeConfigFromEnv({});
  assert.equal(local.port, 3000);
  assert.equal(local.host, '0.0.0.0');
  assert.equal(local.cookieSecure, false);
  const env = { AWS_LAMBDA_HTTP_ENDPOINT: '127.0.0.1:8123', STORAGE_BACKEND: 'dynamodb',
    APP_ORIGIN_SECRET: originSecret, BOOTSTRAP_TOKEN: bootstrapToken, PUBLIC_ORIGIN: publicOrigin, PORT: '9999' };
  const web = runtimeConfigFromEnv(env);
  assert.equal(web.host, '127.0.0.1');
  assert.equal(web.port, 8123);
  assert.equal(web.cookieSecure, true);
  assert.equal(web.trustProxy, true);
  assert.throws(() => runtimeConfigFromEnv({ ...env, STORAGE_BACKEND: 'sqlite' }), /require STORAGE_BACKEND/);
  assert.throws(() => runtimeConfigFromEnv({ ...env, BOOTSTRAP_TOKEN: undefined }), /require APP_ORIGIN_SECRET/);
  assert.throws(() => runtimeConfigFromEnv({ ...env, AWS_LAMBDA_HTTP_ENDPOINT: 'bad-address' }), /host:port/);
  assert.throws(() => runtimeConfigFromEnv({ ...env, APP_ORIGIN_SECRET: 'short' }), /at least 32 bytes/);
  assert.throws(() => runtimeConfigFromEnv({ ...env, PUBLIC_ORIGIN: `${publicOrigin}/path` }), /HTTPS origin/);
  assert.throws(() => runtimeConfigFromEnv({ ...env, PUBLIC_ORIGIN: 'https://name:password@example.test' }), /HTTPS origin/);
  assert.throws(() => runtimeConfigFromEnv({ PORT: 'invalid' }), /port must be/);
  assert.throws(() => runtimeConfigFromEnv({ TLS_CERT: 'certificate-only' }), /set together/);
});

/** The edge protects API, watch, static and missing paths before cookies or routes. */
test('all HTTP entry points reject requests that bypass the trusted proxy', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'chores-edge-'));
  writeFileSync(join(dir, 'index.html'), '<html>Deployment fixture</html>');
  const app = buildApp({ storage: testStorage(), originSecret, staticDir: dir });
  await app.ready();
  t.after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
  for (const url of ['/api/auth/status', '/watch', '/', '/missing']) {
    for (const requestHeaders of [{}, { 'x-app-origin-secret': 'wrong' }]) {
      const response = await app.inject({ url, headers: requestHeaders });
      assert.equal(response.statusCode, 403, url);
      assert.equal(response.headers['set-cookie'], undefined);
      assert.equal(response.headers['cache-control'], 'no-store');
    }
  }
  assert.equal((await app.inject({ url: '/', headers })).statusCode, 200);
  assert.deepEqual((await app.inject({ url: '/api/auth/status', headers })).json(), { needsSetup: true });
  assert.equal((await app.store.events()).length, 0);
});

/** Only the deployment operator can claim a fresh public household. */
test('bootstrap token gates first setup and public cookies are secure', async (t) => {
  const app = buildApp({ storage: testStorage(), originSecret, bootstrapToken, publicOrigin, cookieSecure: true, trustProxy: true });
  await app.ready();
  t.after(() => app.close());
  for (const token of [undefined, 'wrong']) {
    const response = await app.inject({ method: 'POST', url: '/api/auth/setup', payload: profile,
      headers: { ...headers, ...(token ? { 'x-bootstrap-token': token } : {}) } });
    assert.equal(response.statusCode, 403);
    assert.equal(response.json().error.code, 'bootstrap_required');
  }
  const rejectedOrigin = await app.inject({ method: 'POST', url: '/api/auth/setup', payload: profile,
    headers: { ...headers, 'x-bootstrap-token': bootstrapToken, origin: 'https://elsewhere.example' } });
  assert.equal(rejectedOrigin.statusCode, 403);
  assert.equal((await app.store.events()).length, 0);
  assert.equal(await app.store.read((tx) => tx.users.size), 0);
  const response = await app.inject({ method: 'POST', url: '/api/auth/setup', payload: profile,
    headers: { ...headers, 'x-bootstrap-token': bootstrapToken, origin: publicOrigin } });
  assert.equal(response.statusCode, 200);
  const session = response.cookies.find((cookie) => cookie.name === 'sid');
  assert.equal(session.secure, true);
  assert.equal(session.httpOnly, true);
  assert.equal(session.sameSite, 'Lax');
  const repeat = await app.inject({ method: 'POST', url: '/api/auth/setup', headers, payload: profile });
  assert.equal(repeat.statusCode, 409);
  assert.equal((await app.store.events()).filter((event) => event.type === 'user.created').length, 1);
});

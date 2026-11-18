import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../app.js';

const script = fileURLToPath(new URL('../../scripts/reset-password.js', import.meta.url));
const run = (dbPath, args, input = '') =>
  spawnSync(process.execPath, [script, ...args], { input, env: { ...process.env, STORAGE_BACKEND: 'sqlite', DB_PATH: dbPath }, encoding: 'utf8' });

async function login(app, username, password) {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });
  return res.statusCode;
}

test('npm run reset-password: resets, signs out on request, and logs the change', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'chores-reset-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, 'chores.db');

  let app = buildApp({ dbPath });
  await app.ready();
  const setup = await app.inject({
    method: 'POST',
    url: '/api/auth/setup',
    payload: { username: 'dusty', nickname: 'Dusty', birthDate: '1985-03-02', password: 'forgotten-pass' },
  });
  const sid = setup.cookies.find((c) => c.name === 'sid').value;
  await app.close();

  // Mistakes change nothing.
  assert.match(run(dbPath, []).stderr, /Usage[\s\S]*dusty/);
  assert.match(run(dbPath, ['nobody']).stderr, /No one with username "nobody"/);
  assert.match(run(dbPath, ['dusty'], 'short\nshort\n').stderr, /at least 6/);
  assert.match(run(dbPath, ['dusty'], 'new-pass-1\nnew-pass-2\n').stderr, /don’t match/);
  assert.match(run(join(dir, 'missing.db'), ['dusty']).stderr, /No database/);

  const ok = run(dbPath, ['DUSTY', '--sign-out'], 'brand-new-pass\nbrand-new-pass\n');
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /Password reset for Dusty \(dusty\)\. Signed out of 1 session/);

  app = buildApp({ dbPath });
  await app.ready();
  t.after(() => app.close());
  assert.equal(await login(app, 'dusty', 'forgotten-pass'), 401);
  assert.equal(await login(app, 'dusty', 'brand-new-pass'), 200);
  assert.equal((await app.inject({ method: 'GET', url: '/api/state', cookies: { sid } })).statusCode, 401);
  const audit = (await app.store.events()).filter((event) => event.type === 'user.updated').map((event) => event.payload);
  assert.deepEqual(audit.at(-1).changes, { passwordReset: true, via: 'console', signedOut: true });
});

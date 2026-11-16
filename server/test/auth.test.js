import { test } from 'node:test';
import assert from 'node:assert/strict';
import { household } from './helpers.js';

test('first run creates a grown-up; setup cannot run twice', async (t) => {
  const h = await household();
  t.after(h.close);
  assert.equal((await h.client().get('/api/auth/status')).body.needsSetup, false);
  const again = await h.client().post('/api/auth/setup', { username: 'x', nickname: 'X', birthDate: '1990-01-01', password: 'secret12' });
  assert.equal(again.status, 409);
  const s = await h.dusty.state();
  assert.equal(s.me.role, 'grownup');
});

test('password login, and refusal of wrong passwords', async (t) => {
  const h = await household();
  t.after(h.close);
  const c = h.client();
  assert.equal((await c.get('/api/state')).status, 401);
  assert.equal((await c.post('/api/auth/login', { username: 'dana', password: 'nope-nope' })).status, 401);
  assert.equal((await c.post('/api/auth/login', { username: 'DANA', password: 'dana-pass' })).status, 200);
  assert.equal((await c.state()).me.nickname, 'Dana');
});

test('PIN alone identifies the account; PINs must be unique', async (t) => {
  const h = await household();
  t.after(h.close);
  assert.equal((await h.dana.post('/api/me/pin', { currentPassword: 'wrong', pin: '123456' })).status, 403);
  assert.equal((await h.dana.post('/api/me/pin', { currentPassword: 'dana-pass', pin: '12345' })).status, 400);
  assert.equal((await h.dana.post('/api/me/pin', { currentPassword: 'dana-pass', pin: '123456' })).status, 200);

  const taken = await h.harrison.post('/api/me/pin', { currentPassword: 'harrison-pass', pin: '123456' });
  assert.equal(taken.status, 409);
  assert.equal(taken.body.error.code, 'pin_taken');
  assert.equal((await h.harrison.post('/api/me/pin', { currentPassword: 'harrison-pass', pin: '654321' })).status, 200);

  const ipad = h.client();
  assert.equal((await ipad.post('/api/auth/pin', { pin: '654321' })).status, 200);
  assert.equal((await ipad.state()).me.nickname, 'Harrison');
  const ipad2 = h.client();
  assert.equal((await ipad2.post('/api/auth/pin', { pin: '123456' })).status, 200);
  assert.equal((await ipad2.state()).me.nickname, 'Dana');
});

test('wrong PINs are slowed down with a growing delay', async (t) => {
  const h = await household();
  t.after(h.close);
  await h.dana.post('/api/me/pin', { currentPassword: 'dana-pass', pin: '123456' });
  const ipad = h.client();
  for (let i = 0; i < 2; i++) assert.equal((await ipad.post('/api/auth/pin', { pin: '000000' })).status, 401);
  const third = await ipad.post('/api/auth/pin', { pin: '000000' });
  assert.equal(third.status, 401);
  assert.equal(third.body.error.retryAfterMs, 1000);
  // Even the right PIN has to wait out the delay.
  assert.equal((await ipad.post('/api/auth/pin', { pin: '123456' })).status, 429);
  h.advance(1_100);
  const fourth = await ipad.post('/api/auth/pin', { pin: '000000' });
  assert.equal(fourth.body.error.retryAfterMs, 2000);
  // A fresh device id on the same network address is still throttled.
  assert.equal((await h.client().post('/api/auth/pin', { pin: '123456' })).status, 429);
  h.advance(2_100);
  assert.equal((await ipad.post('/api/auth/pin', { pin: '123456' })).status, 200);
});

test('sessions last for weeks and are refreshed on use', async (t) => {
  const h = await household();
  t.after(h.close);
  const before = h.dana.jar.sid;
  h.advance(40 * 86_400_000);
  const res = await h.dana.get('/api/state');
  assert.equal(res.status, 200);
  assert.equal(h.dana.jar.sid, before); // same token, extended expiry
  h.advance(40 * 86_400_000); // 80 days after login, but only 40 since last use
  assert.equal((await h.dana.get('/api/state')).status, 200);
  h.advance(61 * 86_400_000);
  assert.equal((await h.dana.get('/api/state')).status, 401);
});

test('switching an account off signs it out and keeps its history', async (t) => {
  const h = await household();
  t.after(h.close);
  const res = await h.dusty.patch(`/api/users/${h.mia.id}`, { active: false });
  assert.equal(res.status, 200);
  assert.equal((await h.mia.get('/api/state')).status, 401);
  assert.ok((await h.dusty.get('/api/users')).body.some((u) => u.id === h.mia.id && !u.active));
});

test('there is always at least one active grown-up; kids cannot manage accounts', async (t) => {
  const h = await household();
  t.after(h.close);
  assert.equal((await h.dusty.patch(`/api/users/${h.dusty.id}`, { role: 'kid' })).status, 409);
  assert.equal((await h.dana.get('/api/users')).status, 403);
  assert.equal((await h.dana.post('/api/users', { username: 'z', nickname: 'Z', role: 'kid', birthDate: '2015-01-01', password: 'secret12' })).status, 403);
});

// Sign-in (username + password, or a 6-digit PIN on its own), long-lived
// sessions refreshed on use, and the wrong-attempt throttle.

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { hashSecret, verifySecret } from './passwords.js';
import { createThrottle } from './throttle.js';
import { publicUser } from './store.js';
import { isDateString, localDate } from '../shared/dates.js';

const DAY = 86_400_000;
export const SESSION_TTL_MS = 60 * DAY;
const REFRESH_EVERY_MS = DAY;
const DEVICE_COOKIE = 'did';
const SESSION_COOKIE = 'sid';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

export const PIN_PATTERN = /^\d{6}$/;
export function checkPassword(pw) {
  if (typeof pw !== 'string' || pw.length < 6) return 'Password must be at least 6 characters';
  if (pw.length > 200) return 'Password is too long';
  return null;
}
export function checkProfile({ username, nickname, role, birthDate }, partial = false) {
  if (!partial || username !== undefined) {
    if (typeof username !== 'string' || !/^[a-zA-Z0-9._-]{2,32}$/.test(username)) return 'Username: 2–32 letters, numbers, dots, dashes or underscores';
  }
  if (!partial || nickname !== undefined) {
    if (typeof nickname !== 'string' || !nickname.trim() || nickname.trim().length > 30) return 'Nickname: 1–30 characters';
  }
  if (!partial || role !== undefined) {
    if (role !== 'grownup' && role !== 'kid') return 'Role must be grown-up or kid';
  }
  if (!partial || birthDate !== undefined) {
    if (!isDateString(birthDate) || birthDate > localDate()) return 'Enter a valid birth date';
  }
  return null;
}

export function registerAuth(app, { store, cookieSecure }) {
  const { db, clock } = store;
  const throttle = createThrottle(db);
  const q = {
    userById: db.prepare('SELECT * FROM users WHERE id = ?'),
    userByName: db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE'),
    pinUsers: db.prepare('SELECT * FROM users WHERE pin_hash IS NOT NULL'),
    countUsers: db.prepare('SELECT COUNT(*) AS n FROM users'),
    insertUser: db.prepare(
      'INSERT INTO users (id, username, nickname, role, birth_date, password_hash, active, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)',
    ),
    session: db.prepare('SELECT * FROM sessions WHERE token_hash = ?'),
    insertSession: db.prepare(
      'INSERT INTO sessions (token_hash, user_id, device_id, created_at, refreshed_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
    ),
    refreshSession: db.prepare('UPDATE sessions SET refreshed_at = ?, expires_at = ? WHERE token_hash = ?'),
    deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
    deleteExpired: db.prepare('DELETE FROM sessions WHERE expires_at < ?'),
  };

  const cookieOpts = (maxAgeMs) => ({
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: cookieSecure,
    maxAge: Math.floor(maxAgeMs / 1000),
  });

  // Every visitor gets a stable device id, used to throttle wrong guesses per iPad.
  app.addHook('onRequest', async (req, reply) => {
    let did = req.cookies[DEVICE_COOKIE];
    if (!did || !/^[a-f0-9]{32}$/.test(did)) {
      did = randomBytes(16).toString('hex');
      reply.setCookie(DEVICE_COOKIE, did, cookieOpts(5 * 365 * DAY));
    }
    req.deviceId = did;
  });

  function startSession(reply, req, userId) {
    const token = randomBytes(32).toString('base64url');
    const now = clock().getTime();
    q.deleteExpired.run(now);
    q.insertSession.run(sha256(token), userId, req.deviceId, now, now, now + SESSION_TTL_MS);
    reply.setCookie(SESSION_COOKIE, token, cookieOpts(SESSION_TTL_MS));
  }

  /** The signed-in, active account for this request (or null); refreshes the session once a day. */
  function sessionUser(req, reply) {
    const token = req.cookies[SESSION_COOKIE];
    const now = clock().getTime();
    const s = token ? q.session.get(sha256(token)) : null;
    const row = s && s.expires_at > now ? q.userById.get(s.user_id) : null;
    if (!row || !row.active) return null;
    if (now - s.refreshed_at > REFRESH_EVERY_MS && !req.routeOptions.config?.noRefresh) {
      q.refreshSession.run(now, now + SESSION_TTL_MS, s.token_hash);
      reply.setCookie(SESSION_COOKIE, token, cookieOpts(SESSION_TTL_MS));
    }
    return publicUser(row);
  }

  /** preHandler: requires a signed-in, active account. */
  async function requireUser(req, reply) {
    const user = sessionUser(req, reply);
    if (!user) return reply.code(401).send({ error: { code: 'signed_out', message: 'Please sign in' } });
    req.user = user;
  }

  function requireGrownup(req, reply, done) {
    if (req.user?.role !== 'grownup') reply.code(403).send({ error: { code: 'forbidden', message: 'Only a grown-up can do that' } });
    else done();
  }

  const throttleKeys = (req, kind) => [`${kind}:dev:${req.deviceId}`, `${kind}:ip:${req.ip}`];
  const tooMany = (reply, ms) =>
    reply
      .code(429)
      .header('Retry-After', Math.ceil(ms / 1000))
      .send({ error: { code: 'slow_down', message: `Too many wrong tries. Wait ${Math.ceil(ms / 1000)} seconds.`, retryAfterMs: ms } });

  app.get('/api/auth/status', async (req) => ({ needsSetup: q.countUsers.get().n === 0 }));

  // First run only: create the first grown-up account.
  app.post('/api/auth/setup', async (req, reply) => {
    const b = req.body ?? {};
    if (q.countUsers.get().n > 0) return reply.code(409).send({ error: { code: 'already_set_up', message: 'Already set up' } });
    const err = checkProfile({ ...b, role: 'grownup' }) ?? checkPassword(b.password);
    if (err) return reply.code(400).send({ error: { code: 'invalid', message: err } });
    const hash = await hashSecret(b.password);
    if (q.countUsers.get().n > 0) return reply.code(409).send({ error: { code: 'already_set_up', message: 'Already set up' } });
    const id = randomUUID();
    q.insertUser.run(id, b.username, b.nickname.trim(), 'grownup', b.birthDate, hash, clock().toISOString());
    store.record(id, 'user.created', { userId: id, username: b.username, nickname: b.nickname.trim(), role: 'grownup', birthDate: b.birthDate });
    startSession(reply, req, id);
    return { ok: true };
  });

  app.post('/api/auth/login', async (req, reply) => {
    const { username, password } = req.body ?? {};
    const keys = throttleKeys(req, 'pw');
    const wait = throttle.waitMs(keys, clock().getTime());
    if (wait > 0) return tooMany(reply, wait);
    const row = typeof username === 'string' ? q.userByName.get(username) : null;
    const ok = row?.active && (await verifySecret(String(password ?? ''), row.password_hash));
    if (!ok) {
      throttle.recordMiss(keys, clock().getTime());
      return reply.code(401).send({ error: { code: 'wrong_login', message: 'That username and password don’t match' } });
    }
    startSession(reply, req, row.id);
    return { ok: true };
  });

  /**
   * Sign in with a PIN alone. Shared by the iPad app and the watch page.
   * Returns { ok } | { waitMs } (throttled) | { wrong, retryAfterMs }.
   */
  async function pinSignIn(req, reply, pin) {
    const keys = throttleKeys(req, 'pin');
    const wait = throttle.waitMs(keys, clock().getTime());
    if (wait > 0) return { waitMs: wait };
    let match = null;
    if (typeof pin === 'string' && PIN_PATTERN.test(pin)) {
      // The PIN alone identifies the account (PINs are unique), so check it against everyone's.
      for (const row of q.pinUsers.all()) {
        if ((await verifySecret(pin, row.pin_hash)) && row.active) match = row;
      }
    }
    if (!match) {
      // Successful sign-ins don't reset the count, so a known PIN can't be used to wipe it.
      return { wrong: true, retryAfterMs: throttle.recordMiss(keys, clock().getTime()) };
    }
    startSession(reply, req, match.id);
    return { ok: true };
  }

  app.post('/api/auth/pin', async (req, reply) => {
    const r = await pinSignIn(req, reply, req.body?.pin);
    if (r.waitMs) return tooMany(reply, r.waitMs);
    if (r.wrong) return reply.code(401).send({ error: { code: 'wrong_pin', message: 'That PIN isn’t right', retryAfterMs: r.retryAfterMs } });
    return { ok: true };
  });

  function signOut(req, reply) {
    const token = req.cookies[SESSION_COOKIE];
    if (token) q.deleteSession.run(sha256(token));
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
  }

  app.post('/api/auth/logout', async (req, reply) => {
    signOut(req, reply);
    return { ok: true };
  });

  /** Is this PIN already someone else's? Checked against every account, active or not. */
  async function pinTaken(pin, exceptUserId) {
    for (const row of q.pinUsers.all()) {
      if (row.id !== exceptUserId && (await verifySecret(pin, row.pin_hash))) return true;
    }
    return false;
  }

  return { requireUser, requireGrownup, sessionUser, pinSignIn, signOut, throttle, throttleKeys, tooMany, pinTaken, q };
}

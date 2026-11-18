/**
 * Portable authentication, cookie sessions and shared login throttling.
 * Credential changes and authentication decisions use coherent storage revisions.
 * @module auth
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { hashSecret, verifySecret } from './passwords.js';
import { createThrottle } from './throttle.js';
import { publicUser } from './store.js';
import { isDateString, localDate } from '../shared/dates.js';
import { secretMatches } from './edge.js';

/** @type {number} Milliseconds in one day. */
const DAY = 86_400_000;
/** @type {number} Sliding session lifetime, shared by both adapters. */
export const SESSION_TTL_MS = 60 * DAY;
/** @type {number} Minimum interval between persisted session refreshes. */
const REFRESH_EVERY_MS = DAY;
/** @type {RegExp} PINs identify accounts and contain exactly six digits. */
export const PIN_PATTERN = /^\d{6}$/;

/** @param {string} value - Secret token. @returns {string} Non-reversible lookup key. */
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

/** @param {unknown} password - Candidate password. @returns {string|null} Validation error. */
export function checkPassword(password) {
  if (typeof password !== 'string' || password.length < 6) return 'Password must be at least 6 characters';
  if (password.length > 200) return 'Password is too long';
  return null;
}

/** @param {object} profile - Editable profile. @param {boolean} [partial] - Permit omitted fields. @returns {string|null} Validation error. */
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

/**
 * Produce an HTTP failure value without sending a reply inside a retried transaction.
 * @param {string} message - Safe explanation.
 * @param {string} [code] - Machine-readable error.
 * @param {number} [status] - HTTP status.
 * @param {number} [retryAfterMs] - Throttle delay.
 * @returns {object} Failure result.
 */
export function failure(message, code = 'invalid', status = 400, retryAfterMs) {
  return { status, error: { code, message, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) } };
}

/** @param {object} reply - Fastify reply. @param {object} result - Committed result. @returns {object} Result or sent error. */
export function respond(reply, result) {
  if (!result?.error) return result;
  if (result.status === 429) reply.header('Retry-After', Math.ceil(result.error.retryAfterMs / 1000));
  return reply.code(result.status).send({ error: result.error });
}

/**
 * Register authentication endpoints over the portable store.
 * @param {object} app - Fastify scope.
 * @param {{store: object, cookieSecure: boolean, bootstrapToken?: string}} options - Persistence, cookie and initial-setup policy.
 * @returns {object} Shared authentication operations for the API and watch.
 */
export function registerAuth(app, { store, cookieSecure, bootstrapToken }) {
  const { clock } = store;
  /** @param {number} duration - Cookie lifetime in ms. @returns {object} Cookie attributes. */
  const cookieOptions = (duration) => ({ path: '/', httpOnly: true, sameSite: 'lax', secure: cookieSecure, maxAge: Math.floor(duration / 1000) });
  /** @param {object} req - Request. @param {string} kind - Credential type. @returns {string[]} Shared throttle keys. */
  const throttleKeys = (req, kind) => [`${kind}:dev:${req.deviceId}`, `${kind}:ip:${req.ip}`];
  /** @param {number} wait - Remaining delay. @returns {object} Rate-limit result. */
  const tooMany = (wait) => failure(`Too many wrong tries. Wait ${Math.ceil(wait / 1000)} seconds.`, 'slow_down', 429, wait);

  // Device identity is independent of the storage backend and never grants access.
  app.addHook('onRequest', async (req, reply) => {
    let deviceId = req.cookies.did;
    if (!deviceId || !/^[a-f0-9]{32}$/.test(deviceId)) {
      deviceId = randomBytes(16).toString('hex');
      reply.setCookie('did', deviceId, cookieOptions(5 * 365 * DAY));
    }
    req.deviceId = deviceId;
  });

  /** @param {object} tx - Unit of work. @param {object} req - Request. @param {object} user - Account. @returns {string} New opaque token. */
  function startSession(tx, req, user) {
    const token = randomBytes(32).toString('base64url');
    const now = clock().getTime();
    const tokenHash = sha256(token);
    tx.sessions.set(tokenHash, { token_hash: tokenHash, user_id: user.id, device_id: req.deviceId,
      created_at: now, refreshed_at: now, expires_at: now + SESSION_TTL_MS, user_version: user.auth_version ?? 0 });
    return token;
  }

  /** @param {object} reply - Reply. @param {object} result - Committed sign-in result. @returns {object} Public response. */
  function finishSignIn(reply, result) {
    if (result.error) return respond(reply, result);
    reply.setCookie('sid', result.token, cookieOptions(SESSION_TTL_MS));
    return { ok: true };
  }

  /** @param {object} req - Request. @param {object} reply - Reply. @returns {Promise<object|null>} Active session account. */
  async function sessionUser(req, reply) {
    const token = req.cookies.sid;
    if (!token) return null;
    const result = await store.write(async (tx) => {
      const session = await tx.session(sha256(token));
      const now = clock().getTime();
      const row = session && session.expires_at > now ? tx.users.get(session.user_id) : null;
      if (!row?.active || (session.user_version ?? 0) !== (row.auth_version ?? 0)) return null;
      const refresh = now - session.refreshed_at > REFRESH_EVERY_MS && !req.routeOptions.config?.noRefresh;
      if (refresh) tx.sessions.set(session.token_hash, { ...session, refreshed_at: now, expires_at: now + SESSION_TTL_MS });
      return { user: { ...publicUser(row), authVersion: row.auth_version ?? 0 }, refresh };
    });
    if (result?.refresh) reply.setCookie('sid', token, cookieOptions(SESSION_TTL_MS));
    return result?.user ?? null;
  }

  /** @param {object} tx - Transaction. @param {object} req - Authenticated request. @param {boolean} [grownup] - Require admin. @returns {object|null} Authorization failure. */
  function checkActor(tx, req, grownup = false) {
    const row = tx.users.get(req.user.id);
    if (!row?.active || (row.auth_version ?? 0) !== req.user.authVersion) return failure('Please sign in', 'signed_out', 401);
    if (grownup && row.role !== 'grownup') return failure('Only a grown-up can do that', 'forbidden', 403);
    return null;
  }

  /** @param {object} req - Request. @param {object} reply - Reply. @returns {Promise<object|undefined>} */
  async function requireUser(req, reply) {
    req.user = await sessionUser(req, reply);
    if (!req.user) return respond(reply, failure('Please sign in', 'signed_out', 401));
  }

  /** @param {object} req - Request. @param {object} reply - Reply. @returns {Promise<object|undefined>} */
  async function requireGrownup(req, reply) {
    if (req.user?.role !== 'grownup') return respond(reply, failure('Only a grown-up can do that', 'forbidden', 403));
  }

  /** @param {object} tx - Transaction. @param {string} pin - Candidate PIN. @param {string} exceptId - Owner. @returns {Promise<boolean>} Collision. */
  async function pinTaken(tx, pin, exceptId) {
    for (const row of tx.users.values()) {
      if (row.id !== exceptId && row.pin_hash && await verifySecret(pin, row.pin_hash)) return true;
    }
    return false;
  }

  // First-account creation, uniqueness checks and the audit event commit together.
  app.get('/api/auth/status', async () => store.read((tx) => ({ needsSetup: tx.users.size === 0 })));
  app.post('/api/auth/setup', async (req, reply) => {
    if (await store.read((tx) => tx.users.size > 0)) return respond(reply, failure('Already set up', 'already_set_up', 409));
    if (bootstrapToken && !secretMatches(req.headers['x-bootstrap-token'], bootstrapToken)) {
      return respond(reply, failure('Initial setup requires the deployment bootstrap token', 'bootstrap_required', 403));
    }
    const body = req.body ?? {};
    const problem = checkProfile({ ...body, role: 'grownup' }) ?? checkPassword(body.password);
    if (problem) return respond(reply, failure(problem));
    const passwordHash = await hashSecret(body.password);
    const result = await store.write((tx) => {
      if (tx.users.size > 0) return failure('Already set up', 'already_set_up', 409);
      const id = randomUUID();
      const user = { id, username: body.username, nickname: body.nickname.trim(), role: 'grownup', birth_date: body.birthDate,
        password_hash: passwordHash, pin_hash: null, active: 1, created_at: clock().toISOString(), auth_version: 0 };
      tx.users.set(id, user);
      tx.record(id, 'user.created', { userId: id, username: user.username, nickname: user.nickname, role: user.role, birthDate: user.birth_date });
      return { token: startSession(tx, req, user) };
    });
    return finishSignIn(reply, result);
  });

  // Miss counters commit even when authentication fails; successful logins retain them.
  app.post('/api/auth/login', async (req, reply) => {
    const result = await store.write(async (tx) => {
      const throttle = createThrottle(tx);
      const keys = throttleKeys(req, 'pw');
      const wait = await throttle.waitMs(keys, clock().getTime());
      if (wait > 0) return tooMany(wait);
      const row = tx.userByName(req.body?.username);
      if (!row?.active || !await verifySecret(String(req.body?.password ?? ''), row.password_hash)) {
        await throttle.recordMiss(keys, clock().getTime());
        return failure('That username and password don’t match', 'wrong_login', 401);
      }
      return { token: startSession(tx, req, row) };
    });
    return finishSignIn(reply, result);
  });

  /** @param {object} req - Request. @param {object} reply - Reply. @param {string} pin - Candidate PIN. @returns {Promise<object>} Watch-compatible result. */
  async function pinSignIn(req, reply, pin) {
    const result = await store.write(async (tx) => {
      const throttle = createThrottle(tx);
      const keys = throttleKeys(req, 'pin');
      const wait = await throttle.waitMs(keys, clock().getTime());
      if (wait > 0) return { waitMs: wait };
      let match = null;
      if (typeof pin === 'string' && PIN_PATTERN.test(pin)) {
        for (const row of tx.users.values()) {
          if (row.pin_hash && await verifySecret(pin, row.pin_hash) && row.active) match = row;
        }
      }
      if (!match) return { wrong: true, retryAfterMs: await throttle.recordMiss(keys, clock().getTime()) };
      return { token: startSession(tx, req, match) };
    });
    if (result.token) { finishSignIn(reply, result); return { ok: true }; }
    return result;
  }

  app.post('/api/auth/pin', async (req, reply) => {
    const result = await pinSignIn(req, reply, req.body?.pin);
    if (result.waitMs) return respond(reply, tooMany(result.waitMs));
    if (result.wrong) return respond(reply, failure('That PIN isn’t right', 'wrong_pin', 401, result.retryAfterMs));
    return { ok: true };
  });

  /** @param {object} req - Request. @param {object} reply - Reply. @returns {Promise<void>} Revoke this session. */
  async function signOut(req, reply) {
    if (req.cookies.sid) await store.write((tx) => { tx.sessions.set(sha256(req.cookies.sid), null); });
    reply.clearCookie('sid', { path: '/' });
  }

  app.post('/api/auth/logout', async (req, reply) => { await signOut(req, reply); return { ok: true }; });
  return { requireUser, requireGrownup, sessionUser, pinSignIn, signOut, throttleKeys, tooMany, pinTaken, checkActor };
}

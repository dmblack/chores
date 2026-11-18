/**
 * HTTP API over the portable store. Routes use domain transactions and never
 * issue SQL or DynamoDB commands directly.
 * @module routes
 */
import { randomUUID } from 'node:crypto';
import { hashSecret, verifySecret } from './passwords.js';
import { createThrottle } from './throttle.js';
import { ACTION_TYPES } from './commands.js';
import { buildSnapshot } from './views.js';
import { PIN_PATTERN, checkPassword, checkProfile, failure, respond } from './auth.js';
import { ageOn, localDate } from '../shared/dates.js';

/**
 * Register state, action and account endpoints over either backend.
 * @param {object} app - Fastify scope.
 * @param {{store: object, auth: object, hub: object}} options - Shared services.
 * @returns {void}
 */
export function registerRoutes(app, { store, auth, hub }) {
  const { clock } = store;
  const signedIn = { preHandler: auth.requireUser };
  const grownUp = { preHandler: [auth.requireUser, auth.requireGrownup] };

  // Snapshots are loaded from a coherent storage revision, including remote writes.
  app.get('/api/state', signedIn, async (req) => store.read((tx) => buildSnapshot(tx.state, tx.publicUsers(), req.user.id, clock())));
  app.post('/api/actions', {
    ...signedIn,
    schema: { body: { type: 'object', required: ['actions'], properties: { actions: { type: 'array', maxItems: 100,
      items: { type: 'object', required: ['id', 'type', 'payload'], properties: {
        id: { type: 'string', pattern: '^[A-Za-z0-9_-]{8,64}$' }, type: { type: 'string', enum: ACTION_TYPES },
        payload: { type: 'object' }, clientTime: { type: 'string', maxLength: 40 },
      } } } } } },
  }, async (req) => {
    const results = [];
    // Preserve client queue order; parallel writes could invalidate dependent actions.
    for (const action of req.body.actions) results.push(await store.submit(req.user, req.deviceId, action));
    return { results, seq: await store.refresh() };
  });

  // The hub also receives revisions observed from other processes while connected.
  app.get('/api/stream', { preHandler: auth.requireUser, config: { noRefresh: true } }, async (req, reply) => {
    const seq = await store.refresh();
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write(`retry: 5000\ndata: ${JSON.stringify({ seq })}\n\n`);
    hub.add(res);
    req.raw.on('close', () => hub.remove(res));
    // Close the gap between the first read and subscribing, even if another
    // reader already announced a remote revision before this client was added.
    try {
      const latest = await store.refresh();
      if (latest !== seq && !res.destroyed && !res.writableEnded) res.write(`data: ${JSON.stringify({ seq: latest })}\n\n`);
    } catch (error) {
      req.log.warn({ err: error }, 'Could not initialize stream revision');
      res.end();
    }
  });

  /** @param {object} tx - Transaction. @param {object} user - Stored account. @returns {object} Admin-safe account. */
  function adminView(tx, user) {
    return { id: user.id, username: user.username, nickname: user.nickname, role: user.role,
      birthDate: user.birth_date, age: ageOn(user.birth_date, localDate(clock())), active: !!user.active,
      hasPin: !!user.pin_hash, balance: tx.state.balances.get(user.id) ?? 0 };
  }

  // Admin authorization is rechecked inside writes, after any hashing awaits.
  app.get('/api/users', grownUp, async (req, reply) => respond(reply, await store.read((tx) => {
    const problem = auth.checkActor(tx, req, true);
    if (problem) return problem;
    return [...tx.users.values()].sort((a, b) => a.role.localeCompare(b.role) || a.nickname.localeCompare(b.nickname)).map((user) => adminView(tx, user));
  })));

  app.post('/api/users', grownUp, async (req, reply) => {
    const body = req.body ?? {};
    const problem = checkProfile(body) ?? checkPassword(body.password);
    if (problem) return respond(reply, failure(problem));
    const passwordHash = await hashSecret(body.password);
    return respond(reply, await store.write((tx) => {
      const denied = auth.checkActor(tx, req, true);
      if (denied) return denied;
      if (tx.userByName(body.username)) return failure('That username is taken', 'username_taken', 409);
      const id = randomUUID();
      const user = { id, username: body.username, nickname: body.nickname.trim(), role: body.role, birth_date: body.birthDate,
        password_hash: passwordHash, pin_hash: null, active: 1, created_at: clock().toISOString(), auth_version: 0 };
      tx.users.set(id, user);
      tx.record(req.user.id, 'user.created', { userId: id, username: user.username, nickname: user.nickname, role: user.role, birthDate: user.birth_date });
      return adminView(tx, user);
    }));
  });

  app.patch('/api/users/:id', grownUp, async (req, reply) => {
    const body = req.body ?? {};
    const problem = checkProfile(body, true) ?? (body.password !== undefined ? checkPassword(body.password) : null);
    if (problem) return respond(reply, failure(problem));
    if (body.active !== undefined && typeof body.active !== 'boolean') return respond(reply, failure('Invalid active value'));
    const passwordHash = body.password !== undefined ? await hashSecret(body.password) : undefined;
    return respond(reply, await store.write((tx) => {
      const denied = auth.checkActor(tx, req, true);
      if (denied) return denied;
      const user = tx.users.get(req.params.id);
      if (!user) return failure('No such person', 'not_found', 404);
      const taken = body.username === undefined ? null : tx.userByName(body.username);
      if (taken && taken.id !== user.id) return failure('That username is taken', 'username_taken', 409);
      const losesGrownup = user.role === 'grownup' && user.active && (body.role === 'kid' || body.active === false);
      if (losesGrownup && [...tx.users.values()].filter((row) => row.role === 'grownup' && row.active).length <= 1) {
        return failure('There must always be at least one active grown-up', 'last_grownup', 409);
      }
      const next = { ...user, username: body.username ?? user.username, nickname: body.nickname?.trim() ?? user.nickname,
        role: body.role ?? user.role, birth_date: body.birthDate ?? user.birth_date,
        active: body.active === undefined ? user.active : body.active ? 1 : 0,
        password_hash: passwordHash ?? user.password_hash };
      // Version revocation is atomic and does not require deleting an unbounded session set.
      if (user.active && !next.active) next.auth_version = (user.auth_version ?? 0) + 1;
      tx.users.set(user.id, next);
      const changes = {};
      for (const field of ['username', 'nickname', 'role', 'birthDate', 'active']) if (body[field] !== undefined) changes[field] = body[field];
      if (passwordHash !== undefined) changes.passwordReset = true;
      tx.record(req.user.id, 'user.updated', { userId: user.id, changes });
      return adminView(tx, next);
    }));
  });

  // Self-service profile changes keep credentials and audit records in one commit.
  app.patch('/api/me', signedIn, async (req, reply) => {
    const { nickname } = req.body ?? {};
    const problem = checkProfile({ nickname }, true);
    if (problem || nickname === undefined) return respond(reply, failure(problem ?? 'Nothing to change'));
    return respond(reply, await store.write((tx) => {
      const denied = auth.checkActor(tx, req);
      if (denied) return denied;
      tx.users.set(req.user.id, { ...tx.users.get(req.user.id), nickname: nickname.trim() });
      tx.record(req.user.id, 'user.updated', { userId: req.user.id, changes: { nickname: nickname.trim() } });
      return { ok: true };
    }));
  });

  /** @param {object} tx - Transaction. @param {object} req - Request. @param {string} password - Current password. @returns {Promise<object|null>} Failure. */
  async function confirmPassword(tx, req, password) {
    const denied = auth.checkActor(tx, req);
    if (denied) return denied;
    const throttle = createThrottle(tx);
    const keys = auth.throttleKeys(req, 'pw');
    const wait = await throttle.waitMs(keys, clock().getTime());
    if (wait > 0) return auth.tooMany(wait);
    if (await verifySecret(String(password ?? ''), tx.users.get(req.user.id).password_hash)) return null;
    await throttle.recordMiss(keys, clock().getTime());
    return failure('Your current password isn’t right', 'wrong_password', 403);
  }

  app.post('/api/me/password', signedIn, async (req, reply) => {
    const { currentPassword, newPassword } = req.body ?? {};
    const problem = checkPassword(newPassword);
    if (problem) return respond(reply, failure(problem));
    const passwordHash = await hashSecret(newPassword);
    return respond(reply, await store.write(async (tx) => {
      const denied = await confirmPassword(tx, req, currentPassword);
      if (denied) return denied;
      tx.users.set(req.user.id, { ...tx.users.get(req.user.id), password_hash: passwordHash });
      tx.record(req.user.id, 'user.passwordChanged', { userId: req.user.id });
      return { ok: true };
    }));
  });

  app.post('/api/me/pin', signedIn, async (req, reply) => {
    const { currentPassword, pin } = req.body ?? {};
    if (typeof pin !== 'string' || !PIN_PATTERN.test(pin)) return respond(reply, failure('A PIN is exactly 6 digits'));
    const pinHash = await hashSecret(pin);
    return respond(reply, await store.write(async (tx) => {
      const denied = await confirmPassword(tx, req, currentPassword);
      if (denied) return denied;
      const throttle = createThrottle(tx);
      const keys = auth.throttleKeys(req, 'pin');
      const wait = await throttle.waitMs(keys, clock().getTime());
      if (wait > 0) return auth.tooMany(wait);
      if (await auth.pinTaken(tx, pin, req.user.id)) {
        await throttle.recordMiss(keys, clock().getTime());
        return failure('That PIN is already in use. Choose a different one.', 'pin_taken', 409);
      }
      tx.users.set(req.user.id, { ...tx.users.get(req.user.id), pin_hash: pinHash });
      tx.record(req.user.id, 'user.pinChanged', { userId: req.user.id });
      return { ok: true };
    }));
  });
}

// HTTP API: the per-person state, queued actions from iPads, the live update
// stream, and account management.

import { randomUUID } from 'node:crypto';
import { hashSecret, verifySecret } from './passwords.js';
import { ACTION_TYPES } from './commands.js';
import { buildSnapshot } from './views.js';
import { PIN_PATTERN, checkPassword, checkProfile } from './auth.js';
import { ageOn, localDate } from '../shared/dates.js';

const bad = (reply, message, code = 'invalid', status = 400) => reply.code(status).send({ error: { code, message } });

export function registerRoutes(app, { store, auth, hub }) {
  const { db, clock } = store;
  const { requireUser, requireGrownup } = auth;
  const signedIn = { preHandler: requireUser };
  const grownUp = { preHandler: [requireUser, requireGrownup] };

  app.get('/api/state', signedIn, async (req) => buildSnapshot(store.state, store.loadUsers(), req.user.id, clock()));

  // Queued actions from an iPad, in the order they were made. Each carries a
  // stable id, so a resend after a dropped connection is applied only once.
  app.post(
    '/api/actions',
    {
      ...signedIn,
      schema: {
        body: {
          type: 'object',
          required: ['actions'],
          properties: {
            actions: {
              type: 'array',
              maxItems: 100,
              items: {
                type: 'object',
                required: ['id', 'type', 'payload'],
                properties: {
                  id: { type: 'string', pattern: '^[A-Za-z0-9_-]{8,64}$' },
                  type: { type: 'string', enum: ACTION_TYPES },
                  payload: { type: 'object' },
                  clientTime: { type: 'string', maxLength: 40 },
                },
              },
            },
          },
        },
      },
    },
    async (req) => {
      const results = req.body.actions.map((a) => store.submit(req.user, req.deviceId, a));
      return { results, seq: store.state.seq };
    },
  );

  // Server-sent events: a nudge whenever the log grows, so badges update live.
  app.get('/api/stream', { preHandler: requireUser, config: { noRefresh: true } }, (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`retry: 5000\ndata: ${JSON.stringify({ seq: store.state.seq })}\n\n`);
    hub.add(res);
    req.raw.on('close', () => hub.remove(res));
  });

  // ---- Accounts (grown-ups) ----
  const allUsers = db.prepare('SELECT * FROM users ORDER BY role, nickname');
  const userById = db.prepare('SELECT * FROM users WHERE id = ?');
  const activeGrownups = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'grownup' AND active = 1");
  const insertUser = db.prepare(
    'INSERT INTO users (id, username, nickname, role, birth_date, password_hash, active, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)',
  );

  const adminView = (u) => ({
    id: u.id,
    username: u.username,
    nickname: u.nickname,
    role: u.role,
    birthDate: u.birth_date,
    age: ageOn(u.birth_date, localDate(clock())),
    active: !!u.active,
    hasPin: !!u.pin_hash,
    balance: store.state.balances.get(u.id) ?? 0,
  });

  app.get('/api/users', grownUp, async () => allUsers.all().map(adminView));

  app.post('/api/users', grownUp, async (req, reply) => {
    const b = req.body ?? {};
    const err = checkProfile(b) ?? checkPassword(b.password);
    if (err) return bad(reply, err);
    if (db.prepare('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE').get(b.username)) {
      return bad(reply, 'That username is taken', 'username_taken', 409);
    }
    const id = randomUUID();
    insertUser.run(id, b.username, b.nickname.trim(), b.role, b.birthDate, await hashSecret(b.password), clock().toISOString());
    store.record(req.user.id, 'user.created', { userId: id, username: b.username, nickname: b.nickname.trim(), role: b.role, birthDate: b.birthDate });
    return adminView(userById.get(id));
  });

  app.patch('/api/users/:id', grownUp, async (req, reply) => {
    const u = userById.get(req.params.id);
    if (!u) return bad(reply, 'No such person', 'not_found', 404);
    const b = req.body ?? {};
    const err = checkProfile(b, true) ?? (b.password !== undefined ? checkPassword(b.password) : null);
    if (err) return bad(reply, err);
    if (b.active !== undefined && typeof b.active !== 'boolean') return bad(reply, 'Invalid active value');
    if (b.username !== undefined && b.username.toLowerCase() !== u.username.toLowerCase() &&
        db.prepare('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE').get(b.username)) {
      return bad(reply, 'That username is taken', 'username_taken', 409);
    }
    const losesGrownup = u.role === 'grownup' && u.active && (b.role === 'kid' || b.active === false);
    if (losesGrownup && activeGrownups.get().n <= 1) return bad(reply, 'There must always be at least one active grown-up', 'last_grownup', 409);

    const next = {
      username: b.username ?? u.username,
      nickname: b.nickname?.trim() ?? u.nickname,
      role: b.role ?? u.role,
      birth_date: b.birthDate ?? u.birth_date,
      active: b.active === undefined ? u.active : b.active ? 1 : 0,
      password_hash: b.password !== undefined ? await hashSecret(b.password) : u.password_hash,
    };
    db.prepare(
      'UPDATE users SET username = @username, nickname = @nickname, role = @role, birth_date = @birth_date, active = @active, password_hash = @password_hash WHERE id = @id',
    ).run({ ...next, id: u.id });
    if (!next.active) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
    const changes = {};
    for (const k of ['username', 'nickname', 'role', 'birthDate', 'active']) if (b[k] !== undefined) changes[k] = b[k];
    if (b.password !== undefined) changes.passwordReset = true;
    store.record(req.user.id, 'user.updated', { userId: u.id, changes });
    return adminView(userById.get(u.id));
  });

  // ---- My profile ----
  app.patch('/api/me', signedIn, async (req, reply) => {
    const { nickname } = req.body ?? {};
    const err = checkProfile({ nickname }, true);
    if (err || nickname === undefined) return bad(reply, err ?? 'Nothing to change');
    db.prepare('UPDATE users SET nickname = ? WHERE id = ?').run(nickname.trim(), req.user.id);
    store.record(req.user.id, 'user.updated', { userId: req.user.id, changes: { nickname: nickname.trim() } });
    return { ok: true };
  });

  async function confirmPassword(req, reply, password) {
    const keys = auth.throttleKeys(req, 'pw');
    const wait = auth.throttle.waitMs(keys, clock().getTime());
    if (wait > 0) return auth.tooMany(reply, wait), false;
    if (await verifySecret(String(password ?? ''), userById.get(req.user.id).password_hash)) return true;
    auth.throttle.recordMiss(keys, clock().getTime());
    bad(reply, 'Your current password isn’t right', 'wrong_password', 403);
    return false;
  }

  app.post('/api/me/password', signedIn, async (req, reply) => {
    const { currentPassword, newPassword } = req.body ?? {};
    const err = checkPassword(newPassword);
    if (err) return bad(reply, err);
    if (!(await confirmPassword(req, reply, currentPassword))) return reply;
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashSecret(newPassword), req.user.id);
    store.record(req.user.id, 'user.passwordChanged', { userId: req.user.id });
    return { ok: true };
  });

  // Each person sets their own PIN. PINs sign in on their own, so they must be unique.
  app.post('/api/me/pin', signedIn, async (req, reply) => {
    const { currentPassword, pin } = req.body ?? {};
    if (typeof pin !== 'string' || !PIN_PATTERN.test(pin)) return bad(reply, 'A PIN is exactly 6 digits');
    if (!(await confirmPassword(req, reply, currentPassword))) return reply;
    // "Taken" reveals that someone has this PIN, so collisions count as wrong guesses.
    const keys = auth.throttleKeys(req, 'pin');
    const wait = auth.throttle.waitMs(keys, clock().getTime());
    if (wait > 0) return auth.tooMany(reply, wait);
    if (await auth.pinTaken(pin, req.user.id)) {
      auth.throttle.recordMiss(keys, clock().getTime());
      return bad(reply, 'That PIN is already in use. Choose a different one.', 'pin_taken', 409);
    }
    db.prepare('UPDATE users SET pin_hash = ? WHERE id = ?').run(await hashSecret(pin), req.user.id);
    store.record(req.user.id, 'user.pinChanged', { userId: req.user.id });
    return { ok: true };
  });
}

import { randomUUID } from 'node:crypto';
import { buildApp } from '../app.js';

// Monday 16 November 2026, 09:00 local time.
export const MONDAY = new Date(2026, 10, 16, 9, 0);
export const at = (day, hour, minute = 0) => new Date(2026, 10, day, hour, minute);

export async function household({ now = MONDAY } = {}) {
  let current = new Date(now);
  const app = buildApp({ clock: () => new Date(current) });
  await app.ready();

  function client() {
    const jar = {};
    async function call(method, url, payload) {
      const res = await app.inject({ method, url, payload, cookies: { ...jar } });
      for (const c of res.cookies) {
        if (c.value === '' || c.maxAge === 0) delete jar[c.name];
        else jar[c.name] = c.value;
      }
      let body = null;
      try {
        body = res.json();
      } catch {
        body = res.body;
      }
      return { status: res.statusCode, body, headers: res.headers };
    }
    const c = {
      jar,
      get: (url) => call('GET', url),
      post: (url, body) => call('POST', url, body ?? {}),
      patch: (url, body) => call('PATCH', url, body ?? {}),
      state: async () => (await call('GET', '/api/state')).body,
      /** Send one action; returns its result. Pass `id` to resend the same action. */
      async act(type, payload, { id = randomUUID(), clientTime } = {}) {
        const res = await call('POST', '/api/actions', { actions: [{ id, type, payload, clientTime }] });
        if (res.status !== 200) throw new Error(`actions ${res.status}: ${JSON.stringify(res.body)}`);
        return { ...res.body.results[0], actionId: id };
      },
    };
    return c;
  }

  const dusty = client();
  await dusty.post('/api/auth/setup', { username: 'dusty', nickname: 'Dusty', birthDate: '1985-03-02', password: 'dusty-pass' });

  async function addPerson(username, nickname, role, birthDate) {
    const res = await dusty.post('/api/users', { username, nickname, role, birthDate, password: `${username}-pass` });
    if (res.status !== 200) throw new Error(JSON.stringify(res.body));
    const c = client();
    const login = await c.post('/api/auth/login', { username, password: `${username}-pass` });
    if (login.status !== 200) throw new Error(JSON.stringify(login.body));
    c.id = res.body.id;
    return c;
  }

  const dana = await addPerson('dana', 'Dana', 'kid', '2014-05-10'); // 12
  const harrison = await addPerson('harrison', 'Harrison', 'kid', '2017-01-20'); // 9
  const mia = await addPerson('mia', 'Mia', 'kid', '2012-08-01'); // 14
  dusty.id = (await dusty.state()).me.id;

  async function createTask(def) {
    const taskId = randomUUID();
    const r = await dusty.act('task.create', {
      taskId,
      def: { criterion: 'Done properly', points: 10, list: 'evening', repeat: { type: 'daily' }, ...def },
    });
    if (r.status !== 'accepted') throw new Error(JSON.stringify(r));
    return taskId;
  }

  const eventCount = () => app.store.db.prepare('SELECT COUNT(*) AS n FROM events').get().n;

  return {
    app,
    client,
    dusty,
    dana,
    harrison,
    mia,
    createTask,
    eventCount,
    setTime: (d) => (current = new Date(d)),
    advance: (ms) => (current = new Date(current.getTime() + ms)),
    close: () => app.close(),
  };
}

export const findTask = (state, taskId) => state.myTasks.find((t) => t.taskId === taskId);

/** Mark a task from someone's own list done. */
export async function markDone(who, taskId, { helpers = [], ...opts } = {}) {
  const s = await who.state();
  const item = findTask(s, taskId) ?? s.needsAnotherGo.find((t) => t.taskId === taskId);
  if (!item) throw new Error(`task not on ${s.me.nickname}'s list`);
  const completionId = randomUUID();
  const result = await who.act(
    'completion.submit',
    { completionId, taskId, periodStart: item.periodStart, ownerId: item.ownerId, contributorIds: [s.me.id, ...helpers.map((h) => h.id)] },
    opts,
  );
  return { ...result, completionId, item };
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { household } from './helpers.js';

/** A cookie-keeping client that behaves like the watch's web view: HTML pages and form posts. */
function watch(app) {
  const jar = {};
  const keep = (res) => {
    for (const c of res.cookies) {
      if (c.value === '' || c.maxAge === 0) delete jar[c.name];
      else jar[c.name] = c.value;
    }
    return res;
  };
  return {
    get: async (url = '/watch') => keep(await app.inject({ method: 'GET', url, cookies: { ...jar } })),
    post: async (url, fields) =>
      keep(
        await app.inject({
          method: 'POST',
          url,
          cookies: { ...jar },
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          payload: new URLSearchParams(fields).toString(),
        }),
      ),
  };
}

/** The flash message a redirect carries back to /watch. */
const msg = (res) => new URLSearchParams(res.headers.location.split('?')[1] ?? '').get('m') ?? '';

/** The hidden fields of every form on a page posting to `action`, in order. */
function forms(html, action) {
  return [...html.matchAll(new RegExp(`<form method="post" action="${action}"[^>]*>(.*?)</form>`, 'gs'))].map((m) =>
    Object.fromEntries([...m[1].matchAll(/name="([^"]+)" value="([^"]*)"/g)].map((f) => [f[1], f[2].replace(/&amp;/g, '&')])),
  );
}

async function signedInWatch(h, who, pin) {
  await who.post('/api/me/pin', { currentPassword: `${(await who.state()).me.username}-pass`, pin });
  const w = watch(h.app);
  const res = await w.post('/watch/pin', { pin });
  assert.equal(res.statusCode, 303);
  return w;
}

test('watch: PIN sign-in, mark my task done, approve someone else’s', async (t) => {
  const h = await household();
  t.after(h.close);
  await h.createTask({ name: 'Feed the cat', points: 5 });

  const anon = await watch(h.app).get();
  assert.equal(anon.statusCode, 200);
  assert.match(anon.body, /name="pin"/);
  assert.match(anon.body, /name="disabled-adaptations" content="watch"/);
  assert.doesNotMatch(anon.body.split('<body>')[1], /Chores|<h1/); // just the PIN: no titles on screen
  assert.match((await watch(h.app).get('/watch/tasks')).body, /name="pin"/);

  const wrong = await watch(h.app).post('/watch/pin', { pin: '000000' });
  assert.equal(wrong.statusCode, 303);
  assert.match(wrong.headers.location, /bad=1/);

  const harrison = await signedInWatch(h, h.harrison, '111222');
  const home = (await harrison.get()).body;
  assert.match(home, /href="\/watch\/tasks">My Tasks<span class="count">1 to do/);
  assert.match(home, /href="\/watch\/approve">Approve<span class="count">Nothing waiting/);
  assert.doesNotMatch(home, /Feed the cat/); // home is just the two buttons
  let page = (await harrison.get('/watch/tasks')).body;
  assert.match(page, /✓ Feed the cat/);
  const [done] = forms(page, '/watch/done');

  const res = await harrison.post('/watch/done', done);
  assert.equal(res.statusCode, 303);
  assert.equal(msg(res), 'Done! Waiting for a tick.');
  assert.match(res.headers.location, /^\/watch\/tasks\?/); // stays on the list
  // A double tap / resubmitted form is the same action: no second completion.
  const again = await harrison.post('/watch/done', done);
  assert.doesNotMatch(again.headers.location, /bad=1/);
  assert.equal((await h.dusty.state()).approve.waiting.length, 1);
  assert.doesNotMatch((await harrison.get('/watch/tasks')).body, /✓ Feed the cat/);

  // Harrison can't approve his own; it isn't even offered.
  assert.equal(forms((await harrison.get('/watch/approve')).body, '/watch/approve').length, 0);

  const dana = await signedInWatch(h, h.dana, '333444');
  assert.match((await dana.get()).body, /Approve<span class="count">1 waiting/);
  page = (await dana.get('/watch/approve')).body;
  const [approve] = forms(page, '/watch/approve');
  const ok = await dana.post('/watch/approve', approve);
  assert.equal(msg(ok), 'Approved.');
  await dana.post('/watch/approve', approve); // resend: no extra points
  assert.equal((await h.harrison.state()).points.balance, 5);
  assert.equal((await h.dana.state()).points.balance, 1);
});

test('watch: sent-back tasks reappear with the reason; signing out works', async (t) => {
  const h = await household();
  t.after(h.close);
  await h.createTask({ name: 'Unload dishwasher' });
  const w = await signedInWatch(h, h.harrison, '555666');
  await w.post('/watch/done', forms((await w.get('/watch/tasks')).body, '/watch/done')[0]);
  const c = (await h.dusty.state()).approve.waiting[0];
  await h.dusty.act('completion.sendBack', { completionId: c.id, reasons: ['not_finished'], note: 'Bench still full' });

  const page = (await w.get('/watch/tasks')).body;
  assert.match(page, /Sent back: Not finished · Bench still full/);

  await w.post('/watch/signout', {});
  assert.match((await w.get()).body, /name="pin"/);
  const res = await w.post('/watch/approve', { a: 'aaaaaaaa-1111', c: c.id });
  assert.match(res.headers.location, /bad=1/);
});

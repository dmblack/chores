// A tiny front end for Apple Watch, opened from a link in Messages or Mail
// (the main app also sends very small screens here).
//
// The watch's web view can show pages and submit forms but can't install a
// PWA or work offline, so this is plain server-rendered HTML with no
// JavaScript: every tap is a link or a form POST, then a redirect.
//
// Fundamentals only: sign in with a PIN, then two buttons — My Tasks (mark my
// own tasks done, solo) and Approve (tick other people's). No titles or menus.
// Each button carries an action id made when the page is drawn, so a double
// tap or a resubmitted form is recognised as the same action.

import { randomUUID } from 'node:crypto';
import { buildSnapshot } from './views.js';
import { SEND_BACK_REASONS } from '../shared/rules.js';

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const pts = (n) => `${n} ${n === 1 ? 'pt' : 'pts'}`;
const time = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

const STYLE = `
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; padding: 4px 6px 16px; background: #000; color: #fff; font: 15px/1.3 -apple-system, system-ui, sans-serif; }
a { color: inherit; text-decoration: none; }
form { margin: 0 0 6px; }
button, .btn { display: block; width: 100%; min-height: 44px; border: 0; border-radius: 12px; padding: 8px 10px; font: inherit; font-weight: 600; text-align: left; color: #fff; background: #1c3d5e; margin: 0 0 6px; }
.go { background: #0f6cbd; text-align: center; }
.quiet { background: #222; color: #ccc; text-align: center; font-weight: 400; }
.big { min-height: 72px; font-size: 18px; text-align: center; display: flex; flex-direction: column; justify-content: center; align-items: center; }
.count { font-size: 13px; font-weight: 400; color: #cfe3f7; }
.nav { display: inline-block; width: auto; min-height: 32px; padding: 4px 12px; background: #222; color: #ccc; font-weight: 400; margin-bottom: 6px; }
.item { background: #161616; border-radius: 12px; padding: 8px 10px; margin-bottom: 6px; }
.small { display: block; font-size: 12px; font-weight: 400; color: #b5b9bd; margin-top: 2px; }
.back { color: #ff9f8f; }
.msg { border-radius: 10px; padding: 6px 8px; margin-bottom: 6px; font-size: 13px; background: #123b1f; }
.msg.bad { background: #4a1b16; }
.none { color: #9ea3a8; font-size: 13px; text-align: center; margin: 12px 0; }
.signout { margin-top: 28px; }
input { width: 100%; min-height: 44px; font-size: 20px; text-align: center; letter-spacing: .3em; border-radius: 12px; border: 1px solid #444; background: #111; color: #fff; margin-bottom: 6px; }
`;

function page(body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="disabled-adaptations" content="watch">
<title>Chores</title><style>${STYLE}</style></head><body>${body}</body></html>`;
}

function flash(query) {
  if (!query.m) return '';
  return `<div class="msg${query.bad ? ' bad' : ''}" role="status">${esc(String(query.m).slice(0, 160))}</div>`;
}

function hidden(fields) {
  return Object.entries(fields)
    .filter(([, v]) => v != null)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join('');
}

const homeLink = '<a class="btn nav" href="/watch" aria-label="Back">‹</a>';

function signInPage(query) {
  return page(`${flash(query)}<form method="post" action="/watch/pin">
<input name="pin" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="off" placeholder="PIN" aria-label="6-digit PIN" autofocus required>
<button class="go" type="submit">Go</button>
</form>`);
}

function reasonText(sb) {
  const labels = (sb?.reasons ?? []).map((id) => SEND_BACK_REASONS.find((r) => r.id === id)?.label).filter(Boolean);
  return [...labels, sb?.note].filter(Boolean).join(' · ');
}

const todoOf = (snap) => [...snap.needsAnotherGo, ...snap.myTasks.filter((t) => t.status === 'todo' || t.status === 'sentBack')];

function homePage(snap, query) {
  const todo = todoOf(snap).length;
  const waiting = snap.approve.waiting.length;
  return page(`${flash(query)}
<a class="btn go big" href="/watch/tasks">My Tasks<span class="count">${todo === 0 ? 'All done' : `${todo} to do`}</span></a>
<a class="btn go big" href="/watch/approve">Approve<span class="count">${waiting === 0 ? 'Nothing waiting' : `${waiting} waiting`}</span></a>
<form method="post" action="/watch/signout" class="signout"><button class="quiet" type="submit">Sign out ${esc(snap.me.nickname)}</button></form>`);
}

function tasksPage(snap, query) {
  const me = snap.me;
  const todo = todoOf(snap);
  const list = todo.length
    ? todo
        .map((t) => {
          // Solo from the watch: just me, plus the owner when finishing off someone else's own task.
          const contributors = t.ownerId && t.ownerId !== me.id ? `${me.id},${t.ownerId}` : me.id;
          const back = t.status === 'sentBack' ? `<span class="small back">Sent back: ${esc(reasonText(t.completion?.sentBack))}</span>` : '';
          return `<form method="post" action="/watch/done">${hidden({
            a: randomUUID(),
            c: randomUUID(),
            task: t.taskId,
            period: t.periodStart,
            owner: t.ownerId,
            who: contributors,
          })}<button type="submit">✓ ${esc(t.name)}<span class="small">${pts(t.points)}</span>${back}</button></form>`;
        })
        .join('')
    : '<p class="none">All done for now.</p>';
  return page(`${homeLink}${flash(query)}${list}`);
}

function approvePage(snap, query) {
  const waiting = snap.approve.waiting;
  const list = waiting.length
    ? waiting
        .map(
          (c) => `<div class="item">${esc(c.taskName)}<span class="small">${esc(c.contributorNames.join(' & '))} · ${esc(time(c.submittedAt))}</span>
<span class="small">${esc(c.criterion)}</span>
<form method="post" action="/watch/approve" style="margin:6px 0 0">${hidden({ a: randomUUID(), c: c.id })}<button class="go" type="submit">Approve</button></form></div>`,
        )
        .join('')
    : '<p class="none">Nothing waiting.</p>';
  return page(`${homeLink}${flash(query)}${list}`);
}

/** @param {object} app - Fastify scope. @param {object} options - Store and authentication. @returns {void} */
export function registerWatch(app, { store, auth }) {
  // Watch forms post as application/x-www-form-urlencoded.
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 4096 }, (req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body)));
  });

  const html = (reply, body) => reply.header('Cache-Control', 'no-store').type('text/html; charset=utf-8').send(body);
  const back = (reply, to, m, bad = false) =>
    reply.code(303).header('Cache-Control', 'no-store').redirect(`${to}?${new URLSearchParams({ m, ...(bad ? { bad: '1' } : {}) })}`);

  /** A watch page for the signed-in person, or the PIN page. */
  const view = (render) => async (req, reply) => {
    const user = await auth.sessionUser(req, reply);
    if (!user) return html(reply, signInPage(req.query));
    const snapshot = await store.read((tx) => buildSnapshot(tx.state, tx.publicUsers(), user.id, store.clock()));
    return html(reply, render(snapshot, req.query));
  };
  app.get('/watch', view(homePage));
  app.get('/watch/tasks', view(tasksPage));
  app.get('/watch/approve', view(approvePage));

  app.post('/watch/pin', async (req, reply) => {
    const r = await auth.pinSignIn(req, reply, String(req.body?.pin ?? '').trim());
    if (r.waitMs) return back(reply, '/watch', `Too many wrong tries. Wait ${Math.ceil(r.waitMs / 1000)}s.`, true);
    if (r.wrong) return back(reply, '/watch', 'That PIN isn’t right.', true);
    return reply.code(303).redirect('/watch');
  });

  app.post('/watch/signout', async (req, reply) => {
    await auth.signOut(req, reply);
    return reply.code(303).redirect('/watch');
  });

  /** @param {object} req - Request. @param {object} reply - Reply. @param {string} to - Return path. @param {string} type - Action type. @param {object} payload - Action payload. @param {string} okMessage - Success message. @returns {Promise<object>} Redirect. */
  async function act(req, reply, to, type, payload, okMessage) {
    const user = await auth.sessionUser(req, reply);
    if (!user) return back(reply, '/watch', 'Please sign in again.', true);
    const r = await store.submit(user, req.deviceId, { id: req.body?.a, type, payload });
    if (r.status === 'accepted') return back(reply, to, okMessage);
    return back(reply, to, r.error?.message ?? 'That didn’t work.', true);
  }

  const validId = (s) => typeof s === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(s);

  app.post('/watch/done', async (req, reply) => {
    const b = req.body ?? {};
    if (!validId(b.a) || !validId(b.c)) return back(reply, '/watch/tasks', 'Please try again.', true);
    return act(
      req,
      reply,
      '/watch/tasks',
      'completion.submit',
      { completionId: b.c, taskId: b.task, periodStart: b.period, ownerId: b.owner || null, contributorIds: String(b.who ?? '').split(',').filter(Boolean) },
      'Done! Waiting for a tick.',
    );
  });

  app.post('/watch/approve', async (req, reply) => {
    const b = req.body ?? {};
    if (!validId(b.a)) return back(reply, '/watch/approve', 'Please try again.', true);
    return act(req, reply, '/watch/approve', 'completion.approve', { completionId: b.c }, 'Approved.');
  });
}

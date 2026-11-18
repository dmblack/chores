import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { at, findTask, household, markDone } from './helpers.js';

test('mark done, someone else approves, points are awarded', async (t) => {
  const h = await household();
  t.after(h.close);
  const dishes = await h.createTask({ name: 'Unload dishwasher', criterion: 'Dishes in cupboards, not on the bench' });

  const sub = await markDone(h.harrison, dishes);
  assert.equal(sub.status, 'accepted');

  const own = await h.harrison.act('completion.approve', { completionId: sub.completionId });
  assert.equal(own.status, 'rejected');
  assert.equal(own.error.code, 'own_task');

  const ds = await h.dusty.state();
  assert.equal(ds.approve.badge, 1);
  assert.equal(ds.approve.waiting[0].contributorNames[0], 'Harrison');

  assert.equal((await h.dusty.act('completion.approve', { completionId: sub.completionId })).status, 'accepted');
  const hs = await h.harrison.state();
  assert.equal(hs.points.balance, 10);
  assert.equal(findTask(hs, dishes).status, 'approved');
  assert.deepEqual(hs.progress, { approved: 1, total: 1 });
  assert.equal((await h.dusty.state()).points.balance, 1); // approval points
});

test('resending the same action never applies it twice', async (t) => {
  const h = await household();
  t.after(h.close);
  const dishes = await h.createTask({ name: 'Unload dishwasher' });
  const sub = await markDone(h.harrison, dishes);
  const resub = await h.harrison.act('completion.submit', {
    completionId: sub.completionId, taskId: dishes, periodStart: sub.item.periodStart, ownerId: null, contributorIds: [h.harrison.id],
  }, { id: sub.actionId });
  assert.equal(resub.status, 'accepted');
  assert.equal(resub.duplicate, true);

  const approve = await h.dusty.act('completion.approve', { completionId: sub.completionId });
  const events = await h.eventCount();
  const retry = await h.dusty.act('completion.approve', { completionId: sub.completionId }, { id: approve.actionId });
  assert.equal(retry.duplicate, true);
  assert.equal(await h.eventCount(), events);
  assert.equal((await h.harrison.state()).points.balance, 10);
  assert.equal((await h.dusty.state()).points.balance, 1);
});

test('collaboration: off means one contributor; nobody who helped can approve', async (t) => {
  const h = await household();
  t.after(h.close);
  const solo = await h.createTask({ name: 'Feed the cat' });
  const r = await markDone(h.harrison, solo, { helpers: [h.dana] });
  assert.equal(r.error.code, 'no_collaboration');

  const together = await h.createTask({ name: 'Unload dishwasher', allowCollaboration: true });
  const item = findTask(await h.harrison.state(), together);
  assert.ok(item.helpers.includes(h.dana.id));
  const sub = await markDone(h.harrison, together, { helpers: [h.dana] });
  assert.equal(sub.status, 'accepted');
  assert.equal((await h.dana.act('completion.approve', { completionId: sub.completionId })).error.code, 'own_task');
  assert.equal((await h.dana.state()).approve.badge, 0);
  assert.equal((await h.mia.act('completion.approve', { completionId: sub.completionId })).status, 'accepted');
  assert.equal((await h.harrison.state()).points.balance, 10); // full points each (default)
  assert.equal((await h.dana.state()).points.balance, 10);
});

test('split points round up for everyone', async (t) => {
  const h = await household();
  t.after(h.close);
  const task = await h.createTask({ name: 'Tidy the garage', points: 10, allowCollaboration: true, allocation: 'split' });
  const sub = await markDone(h.harrison, task, { helpers: [h.dana, h.mia] });
  assert.equal(sub.status, 'accepted');
  await h.dusty.act('completion.approve', { completionId: sub.completionId });
  for (const kid of [h.harrison, h.dana, h.mia]) assert.equal((await kid.state()).points.balance, 4);
});

test('age limits hide tasks and reject ineligible helpers; grown-up jobs are for grown-ups', async (t) => {
  const h = await household();
  t.after(h.close);
  const washing = await h.createTask({ name: 'Run the washing machine', minAge: 10, allowCollaboration: true });
  const bills = await h.createTask({ name: 'Pay bills', list: 'grownups' });
  assert.equal(findTask(await h.harrison.state(), washing), undefined); // 9: hidden, not greyed out
  const ds = await h.dana.state();
  assert.ok(findTask(ds, washing));
  assert.ok(!findTask(ds, washing).helpers.includes(h.harrison.id));
  assert.equal(findTask(ds, bills), undefined);
  assert.ok(findTask(await h.dusty.state(), bills));

  const r = await markDone(h.dana, washing, { helpers: [h.harrison] });
  assert.equal(r.error.code, 'ineligible');
});

test('multiple approvals off: the first approval is the only one', async (t) => {
  const h = await household();
  t.after(h.close);
  const task = await h.createTask({ name: 'Unload dishwasher' });
  const sub = await markDone(h.harrison, task);
  // Two iPads approve at once; the server checks them one after the other.
  const [a, b] = await Promise.all([
    h.dusty.act('completion.approve', { completionId: sub.completionId }),
    h.mia.act('completion.approve', { completionId: sub.completionId }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), ['accepted', 'rejected']);
  assert.equal([a, b].find((x) => x.status === 'rejected').error.code, 'already_approved');
  assert.equal((await h.harrison.state()).points.balance, 10);
});

test('multiple approvals on: endorsements earn approval points; completion points are paid once', async (t) => {
  const h = await household();
  t.after(h.close);
  const task = await h.createTask({ name: 'Clean bathroom', points: 20, allowMultipleApprovals: true });
  const sub = await markDone(h.harrison, task);
  assert.equal((await h.dusty.act('completion.approve', { completionId: sub.completionId })).status, 'accepted');

  const ms = await h.mia.state();
  assert.equal(ms.approve.waiting.length, 0);
  assert.equal(ms.approve.endorse.length, 1); // can still add a tick after the first approval

  const endorse = await h.mia.act('completion.approve', { completionId: sub.completionId });
  assert.equal(endorse.status, 'accepted');
  // A resend of Mia's endorsement is the same action; a new tap is refused.
  assert.equal((await h.mia.act('completion.approve', { completionId: sub.completionId }, { id: endorse.actionId })).duplicate, true);
  assert.equal((await h.mia.act('completion.approve', { completionId: sub.completionId })).error.code, 'already_endorsed');
  assert.equal((await h.dana.act('completion.approve', { completionId: sub.completionId })).status, 'accepted');

  assert.equal((await h.harrison.state()).points.balance, 20);
  assert.equal((await h.mia.state()).points.balance, 1);
  assert.equal((await h.dana.state()).points.balance, 1);
  assert.equal((await h.dusty.state()).points.balance, 1);
  assert.equal(findTask(await h.harrison.state(), task).completion.approvals.length, 3);
});

test('sending back needs a reason and returns the task to its contributors', async (t) => {
  const h = await household();
  t.after(h.close);
  const task = await h.createTask({ name: 'Unload dishwasher', allowCollaboration: true });
  const sub = await markDone(h.harrison, task, { helpers: [h.dana] });
  assert.equal((await h.dusty.act('completion.sendBack', { completionId: sub.completionId, reasons: [], note: '  ' })).error.code, 'reason_required');
  assert.equal((await h.dusty.act('completion.sendBack', { completionId: sub.completionId, reasons: ['not_finished'], note: 'Dishes left on bench' })).status, 'accepted');

  for (const kid of [h.harrison, h.dana]) {
    const item = findTask(await kid.state(), task);
    assert.equal(item.status, 'sentBack');
    assert.equal(item.completion.sentBack.note, 'Dishes left on bench');
  }
  assert.equal(findTask(await h.mia.state(), task), undefined); // went back to the people who did it
  assert.equal((await h.dusty.act('completion.approve', { completionId: sub.completionId })).error.code, 'sent_back');

  const again = await markDone(h.harrison, task, { helpers: [h.dana] });
  assert.equal(again.status, 'accepted');
  assert.equal(findTask(await h.harrison.state(), task).status, 'pending');
});

test('shared jobs leave other lists; personal activities are per person; progress counts both rules', async (t) => {
  const h = await household();
  t.after(h.close);
  const dishes = await h.createTask({ name: 'Unload dishwasher' });
  const reading = await h.createTask({ name: 'Reading', kind: 'personal', points: 5 });

  let dana = await h.dana.state();
  assert.ok(findTask(dana, dishes));
  assert.deepEqual(dana.progress, { approved: 0, total: 1 }); // just her reading

  await markDone(h.harrison, dishes);
  const read = await markDone(h.harrison, reading);
  dana = await h.dana.state();
  assert.equal(findTask(dana, dishes), undefined);
  assert.equal(findTask(dana, reading).status, 'todo');
  assert.notEqual(findTask(dana, reading).occurrenceId, read.item.occurrenceId);

  await h.dusty.act('completion.approve', { completionId: read.completionId });
  assert.deepEqual((await h.harrison.state()).progress, { approved: 1, total: 2 });
});

test('daily rollover: pending approvals stay, and each day is its own occurrence', async (t) => {
  const h = await household({ now: at(16, 18, 40) });
  t.after(h.close);
  const dishes = await h.createTask({ name: 'Unload dishwasher' });
  const monday = await markDone(h.harrison, dishes);

  h.setTime(at(17, 7, 0));
  const ds = await h.dusty.state();
  assert.equal(ds.today, '2026-11-17');
  assert.equal(ds.approve.waiting[0].periodStart, '2026-11-16'); // didn't silently expire
  const tuesday = findTask(await h.harrison.state(), dishes);
  assert.equal(tuesday.status, 'todo');
  assert.notEqual(tuesday.occurrenceId, monday.item.occurrenceId);

  assert.equal((await h.dusty.act('completion.approve', { completionId: monday.completionId })).status, 'accepted');
  assert.equal(findTask(await h.harrison.state(), dishes).status, 'todo');
});

test('offline: a task marked done before midnight and sent after it still counts for its day', async (t) => {
  const h = await household({ now: at(16, 23, 50) });
  t.after(h.close);
  const dishes = await h.createTask({ name: 'Unload dishwasher' });
  const item = findTask(await h.harrison.state(), dishes);
  h.setTime(at(17, 0, 10));
  const payload = { completionId: randomUUID(), taskId: dishes, periodStart: item.periodStart, ownerId: null, contributorIds: [h.harrison.id] };
  const late = await h.harrison.act('completion.submit', payload, { clientTime: at(16, 23, 50).toISOString() });
  assert.equal(late.status, 'accepted');
  // Without the earlier timestamp, yesterday's occurrence is no longer on the list.
  const stale = await h.harrison.act('completion.submit', { ...payload, completionId: randomUUID() });
  assert.equal(stale.error.code, 'already_pending');
  const other = await h.createTask({ name: 'Feed the cat' });
  const r = await h.harrison.act('completion.submit', { ...payload, completionId: randomUUID(), taskId: other });
  assert.equal(r.error.code, 'not_scheduled');
});

test('every-week tasks stay on the list until done, then come back next period', async (t) => {
  const h = await household();
  t.after(h.close);
  const sheets = await h.createTask({ name: 'Change bed sheets', kind: 'personal', repeat: { type: 'interval', every: 1, unit: 'weeks', start: '2026-11-16' } });
  h.setTime(at(18, 9));
  const sub = await markDone(h.dana, sheets);
  assert.equal(sub.item.periodStart, '2026-11-16');
  assert.equal(findTask(await h.dana.state(), sheets).status, 'pending');
  h.setTime(at(19, 9));
  assert.equal(findTask(await h.dana.state(), sheets), undefined); // done earlier this week
  h.setTime(at(23, 9));
  assert.equal(findTask(await h.dana.state(), sheets).status, 'todo');
});

test('a task sent back on an earlier day can still be finished', async (t) => {
  const h = await household({ now: at(16, 18) });
  t.after(h.close);
  const dishes = await h.createTask({ name: 'Unload dishwasher' });
  const sub = await markDone(h.harrison, dishes);
  await h.dusty.act('completion.sendBack', { completionId: sub.completionId, reasons: ['not_finished'] });
  h.setTime(at(17, 8));
  const s = await h.harrison.state();
  assert.equal(s.needsAnotherGo.length, 1);
  assert.equal(s.needsAnotherGo[0].periodStart, '2026-11-16');
  const redo = await h.harrison.act('completion.submit', {
    completionId: randomUUID(), taskId: dishes, periodStart: '2026-11-16', ownerId: null, contributorIds: [h.harrison.id],
  });
  assert.equal(redo.status, 'accepted');
  assert.equal((await h.harrison.state()).needsAnotherGo.length, 0);
});

test('only grown-ups edit tasks; edits do not change terms of work already done', async (t) => {
  const h = await household();
  t.after(h.close);
  assert.equal((await h.dana.act('task.create', { taskId: randomUUID(), def: { name: 'x', criterion: 'y', points: 1, list: 'morning', repeat: { type: 'daily' } } })).error.code, 'forbidden');
  const task = await h.createTask({ name: 'Unload dishwasher', points: 10 });
  const sub = await markDone(h.harrison, task);
  const def = { name: 'Unload dishwasher', criterion: 'Done properly', points: 50, list: 'evening', repeat: { type: 'daily' } };
  assert.equal((await h.dusty.act('task.update', { taskId: task, def })).status, 'accepted');
  await h.dusty.act('completion.approve', { completionId: sub.completionId });
  assert.equal((await h.harrison.state()).points.balance, 10);
});

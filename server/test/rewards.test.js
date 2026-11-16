import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { household, markDone } from './helpers.js';

async function earn(h, kid, points) {
  const task = await h.createTask({ name: `Job ${randomUUID().slice(0, 4)}`, points });
  const sub = await markDone(kid, task);
  await h.dusty.act('completion.approve', { completionId: sub.completionId });
}

test('redeem a reward: kid asks, a grown-up approves, points are deducted', async (t) => {
  const h = await household();
  t.after(h.close);
  await earn(h, h.dana, 30);
  const rewardId = randomUUID();
  assert.equal((await h.dana.act('reward.create', { rewardId, def: { name: 'Extra game time', cost: 20 } })).error.code, 'forbidden');
  assert.equal((await h.dusty.act('reward.create', { rewardId, def: { name: 'Extra game time', cost: 20 } })).status, 'accepted');

  const redemptionId = randomUUID();
  assert.equal((await h.dana.act('redemption.request', { redemptionId, rewardId })).status, 'accepted');
  let s = await h.dana.state();
  assert.equal(s.points.balance, 30);
  assert.equal(s.points.available, 10); // held while waiting
  assert.equal((await h.dana.act('redemption.request', { redemptionId: randomUUID(), rewardId })).error.code, 'not_enough_points');

  assert.equal((await h.mia.act('redemption.approve', { redemptionId })).error.code, 'forbidden');
  const ds = await h.dusty.state();
  assert.equal(ds.approve.rewardRequests.length, 1);
  assert.equal(ds.approve.badge, 1);
  assert.equal((await h.dusty.act('redemption.approve', { redemptionId })).status, 'accepted');

  s = await h.dana.state();
  assert.equal(s.points.balance, 10);
  assert.equal(s.points.history[0].amount, -20);
  assert.equal(s.myRedemptions[0].status, 'approved');
});

test('declining needs a reason; the asker can cancel; grown-ups cannot approve their own', async (t) => {
  const h = await household();
  t.after(h.close);
  await earn(h, h.dana, 30);
  const rewardId = randomUUID();
  await h.dusty.act('reward.create', { rewardId, def: { name: 'Pick the movie', cost: 10 } });

  const one = randomUUID();
  await h.dana.act('redemption.request', { redemptionId: one, rewardId });
  assert.equal((await h.dusty.act('redemption.decline', { redemptionId: one })).error.code, 'reason_required');
  assert.equal((await h.dusty.act('redemption.decline', { redemptionId: one, reasons: ['chores_first'] })).status, 'accepted');

  const two = randomUUID();
  await h.dana.act('redemption.request', { redemptionId: two, rewardId });
  assert.equal((await h.dana.act('redemption.cancel', { redemptionId: two })).status, 'accepted');
  assert.equal((await h.dana.state()).points.balance, 30);

  const own = randomUUID();
  // Dusty has 1 point per approval; give him enough to ask.
  await h.dusty.act('settings.update', { settings: { approvalPoints: 10 } });
  await earn(h, h.mia, 1);
  assert.equal((await h.dusty.act('redemption.request', { redemptionId: own, rewardId })).status, 'accepted');
  assert.equal((await h.dusty.act('redemption.approve', { redemptionId: own })).error.code, 'own_request');
});

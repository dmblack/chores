// What one person sees: today's list, the Approve queue, progress and points.
// Everything is derived from the projected event log on each request.

import { addDays, ageOn, localDate } from '../shared/dates.js';
import { occurrenceIdFor, periodFor } from '../shared/schedule.js';
import { LIST_IDS, isEligible, shareFor } from '../shared/rules.js';

const SENT_BACK_WINDOW_DAYS = 14;
const ENDORSE_WINDOW_DAYS = 1; // extra endorsements stay offered today and yesterday

function summarise(c, state, users) {
  if (!c) return null;
  const task = state.tasks.get(c.taskId);
  return {
    id: c.id,
    taskId: c.taskId,
    taskName: task?.name ?? c.taskName,
    criterion: task?.criterion ?? '',
    occurrenceId: c.occurrenceId,
    periodStart: c.periodStart,
    ownerId: c.ownerId,
    contributorIds: c.contributorIds,
    submittedBy: c.submittedBy,
    submittedAt: c.submittedAt,
    status: c.status,
    approvals: c.approvals,
    sentBack: c.sentBack,
    terms: c.terms,
    share: shareFor(c.terms.points, c.terms.allocation, c.contributorIds.length),
    contributorNames: c.contributorIds.map((id) => users.get(id)?.nickname ?? '?'),
  };
}

function taskItem(task, period, ownerId, latest, me, today, users, state) {
  return {
    occurrenceId: occurrenceIdFor(task.id, period.start, ownerId),
    taskId: task.id,
    name: task.name,
    criterion: task.criterion,
    list: task.list,
    kind: task.kind,
    points: task.points,
    allocation: task.allocation,
    allowCollaboration: task.allowCollaboration,
    periodStart: period.start,
    periodEnd: period.end,
    ownerId,
    status: latest?.status ?? 'todo',
    completion: summarise(latest, state, users),
    helpers: task.allowCollaboration
      ? [...users.values()].filter((u) => u.id !== me.id && isEligible(u, task, today)).map((u) => u.id)
      : [],
  };
}

export function buildSnapshot(state, users, meId, now) {
  const me = users.get(meId);
  const today = localDate(now);
  const holidays = state.settings.holidays;
  const latestFor = (occ) => state.completions.get(state.latestByOccurrence.get(occ));

  // ---- My Tasks ----
  const myTasks = [];
  for (const task of state.tasks.values()) {
    if (task.removed || !isEligible(me, task, today)) continue; // ineligible tasks are hidden, not greyed
    const period = periodFor(task, today, holidays);
    if (!period) continue;
    const ownerId = task.kind === 'personal' ? me.id : null;
    const latest = latestFor(occurrenceIdFor(task.id, period.start, ownerId));
    const mine = !!latest && latest.contributorIds.includes(me.id);

    if (latest && latest.status !== 'sentBack') {
      // A multi-day occurrence finished on an earlier day is off the list for the rest of its period.
      if (localDate(new Date(latest.submittedAt)) < today) continue;
      // A shared job leaves everyone else's list once it has been marked done.
      if (task.kind === 'shared' && !mine) continue;
    }
    // A sent-back shared job goes back to the people who did it.
    if (latest?.status === 'sentBack' && task.kind === 'shared' && !mine) continue;

    const item = taskItem(task, period, ownerId, latest, me, today, users, state);
    // Today's progress: your own activities plus the shared jobs you helped with.
    item.countsToday = task.kind === 'personal' || mine;
    myTasks.push(item);
  }
  myTasks.sort((a, b) => LIST_IDS.indexOf(a.list) - LIST_IDS.indexOf(b.list) || a.name.localeCompare(b.name));

  // Sent back from an earlier day: still yours to finish.
  const listed = new Set(myTasks.map((t) => t.occurrenceId));
  const sentBackSince = addDays(today, -SENT_BACK_WINDOW_DAYS);
  const needsAnotherGo = [];
  for (const [occ, cid] of state.latestByOccurrence) {
    const c = state.completions.get(cid);
    if (c.status !== 'sentBack' || listed.has(occ) || !c.contributorIds.includes(me.id)) continue;
    if (localDate(new Date(c.sentBack.at)) < sentBackSince) continue;
    const task = state.tasks.get(c.taskId);
    if (!task) continue;
    const item = taskItem(task, { start: c.periodStart, end: null }, c.ownerId, c, me, today, users, state);
    item.name = task.removed ? c.taskName : task.name;
    needsAnotherGo.push(item);
  }

  const counted = myTasks.filter((t) => t.countsToday);
  const progress = { approved: counted.filter((t) => t.status === 'approved').length, total: counted.length };

  // ---- Approve ----
  const endorseSince = addDays(today, -ENDORSE_WINDOW_DAYS);
  const waiting = [];
  const endorse = [];
  for (const c of state.completions.values()) {
    if (c.contributorIds.includes(me.id)) continue; // never your own work
    if (c.status === 'pending') waiting.push(summarise(c, state, users));
    else if (
      c.status === 'approved' &&
      c.terms.allowMultipleApprovals &&
      !c.approvals.some((a) => a.userId === me.id) &&
      localDate(new Date(c.approvedAt)) >= endorseSince
    ) {
      endorse.push(summarise(c, state, users));
    }
  }
  waiting.sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));
  endorse.sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));

  const redemptions = [...state.redemptions.values()];
  const rewardRequests =
    me.role === 'grownup'
      ? redemptions
          .filter((r) => r.status === 'pending' && r.requesterId !== me.id)
          .map((r) => ({ ...r, requesterName: users.get(r.requesterId)?.nickname ?? '?' }))
      : [];

  // ---- Points ----
  const balance = state.balances.get(me.id) ?? 0;
  const myRedemptions = redemptions
    .filter((r) => r.requesterId === me.id)
    .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))
    .slice(0, 30);
  const held = myRedemptions.filter((r) => r.status === 'pending').reduce((s, r) => s + r.cost, 0);
  const history = state.ledger.filter((l) => l.userId === me.id).slice(-60).reverse();

  return {
    seq: state.seq,
    today,
    serverTime: now.toISOString(),
    me: { ...me, age: ageOn(me.birthDate, today) },
    users: [...users.values()].map((u) => ({
      id: u.id,
      nickname: u.nickname,
      role: u.role,
      active: u.active,
      ...(me.role === 'grownup' ? { balance: state.balances.get(u.id) ?? 0 } : {}),
    })),
    settings: state.settings,
    myTasks,
    needsAnotherGo,
    progress,
    approve: { waiting, endorse, rewardRequests, badge: waiting.length + rewardRequests.length },
    points: { balance, available: balance - held, history },
    rewards: [...state.rewards.values()].filter((r) => !r.removed),
    myRedemptions,
    tasks: me.role === 'grownup' ? [...state.tasks.values()].filter((t) => !t.removed) : undefined,
  };
}

// Turns an action sent by an iPad into the events it produces, after checking
// permissions, eligibility and the task's rules against current state.
// Throws RuleError when the action must be refused.

import { periodFor, occurrenceIdFor } from '../shared/schedule.js';
import { isDateString } from '../shared/dates.js';
import {
  DECLINE_REASONS,
  SEND_BACK_REASONS,
  isEligible,
  normaliseTaskDef,
  shareFor,
} from '../shared/rules.js';

export class RuleError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const fail = (code, message) => {
  throw new RuleError(code, message);
};
const isId = (s) => typeof s === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(s);
const nameOf = (ctx, id) => ctx.users.get(id)?.nickname ?? 'someone';
const listNames = (ctx, ids) => ids.map((id) => nameOf(ctx, id)).join(' and ');

function requireGrownup(ctx) {
  if (ctx.actor.role !== 'grownup') fail('forbidden', 'Only a grown-up can do that');
}

function readReasons(p, allowed) {
  const reasons = Array.isArray(p.reasons) ? [...new Set(p.reasons)] : [];
  if (!reasons.every((r) => allowed.some((a) => a.id === r))) fail('invalid', 'Unknown reason');
  const note = typeof p.note === 'string' ? p.note.trim().slice(0, 500) : '';
  if (reasons.length === 0 && !note) fail('reason_required', 'Pick a reason or say what still needs doing');
  return { reasons, note };
}

function availablePoints(state, userId) {
  let held = 0;
  for (const r of state.redemptions.values()) {
    if (r.requesterId === userId && r.status === 'pending') held += r.cost;
  }
  return (state.balances.get(userId) ?? 0) - held;
}

const handlers = {
  'completion.submit'(state, ctx, p) {
    if (!isId(p.completionId) || state.completions.has(p.completionId)) fail('invalid', 'Invalid completion id');
    const task = state.tasks.get(p.taskId);
    if (!task) fail('not_found', 'That task no longer exists');
    if (!isDateString(p.periodStart)) fail('invalid', 'Invalid date');

    const contributorIds = Array.isArray(p.contributorIds) ? [...new Set(p.contributorIds)] : [];
    if (contributorIds.length === 0) fail('invalid', 'Say who did it');
    if (!contributorIds.includes(ctx.actor.id)) fail('forbidden', 'You can only mark done a task you helped with');
    if (!task.allowCollaboration && contributorIds.length > 1) fail('no_collaboration', `${task.name} is a one-person task`);
    for (const id of contributorIds) if (!ctx.users.has(id)) fail('invalid', 'Unknown person');

    let ownerId = null;
    if (task.kind === 'personal') {
      ownerId = p.ownerId;
      if (!contributorIds.includes(ownerId)) fail('invalid', 'The person whose task it is must be one of the people who did it');
    } else if (p.ownerId) {
      fail('invalid', 'A household job has no owner');
    }

    const occurrenceId = occurrenceIdFor(task.id, p.periodStart, ownerId);
    const latest = state.completions.get(state.latestByOccurrence.get(occurrenceId));
    if (latest?.status === 'pending') fail('already_pending', `${listNames(ctx, latest.contributorIds)} already marked ${task.name} done`);
    if (latest?.status === 'approved') fail('already_approved', `${task.name} is already done and approved`);

    // A sent-back occurrence can be finished off later; otherwise it must be on the list when it was done.
    if (latest?.status !== 'sentBack') {
      if (task.removed) fail('not_found', 'That task no longer exists');
      const period = periodFor(task, ctx.date, state.settings.holidays);
      if (!period || period.start !== p.periodStart) fail('not_scheduled', `${task.name} isn't on the list for that day`);
    }

    for (const id of contributorIds) {
      if (!isEligible(ctx.users.get(id), task, ctx.date)) fail('ineligible', `${nameOf(ctx, id)} can't do ${task.name}`);
    }

    return [
      {
        type: 'completion.submitted',
        payload: {
          completionId: p.completionId,
          taskId: task.id,
          taskName: task.name,
          occurrenceId,
          periodStart: p.periodStart,
          ownerId,
          contributorIds,
          // The rules people saw when they did it; later edits to the task don't change them.
          terms: { points: task.points, allocation: task.allocation, allowMultipleApprovals: task.allowMultipleApprovals },
        },
      },
    ];
  },

  'completion.approve'(state, ctx, p) {
    const c = state.completions.get(p.completionId);
    if (!c) fail('not_found', 'That completion no longer exists');
    if (c.contributorIds.includes(ctx.actor.id)) fail('own_task', "You can't approve a task you helped with");
    if (c.status === 'sentBack') fail('sent_back', `${c.taskName} was already sent back`);

    const approvalAward = (label) =>
      ctx.approvalPoints > 0
        ? [{ type: 'points.awarded', payload: { userId: ctx.actor.id, amount: ctx.approvalPoints, reason: 'approval', label, completionId: c.id } }]
        : [];

    if (c.status === 'pending') {
      const share = shareFor(c.terms.points, c.terms.allocation, c.contributorIds.length);
      return [
        { type: 'completion.approved', payload: { completionId: c.id, first: true } },
        ...c.contributorIds.map((userId) => ({
          type: 'points.awarded',
          payload: { userId, amount: share, reason: 'completion', label: c.taskName, completionId: c.id },
        })),
        ...approvalAward(`Checked ${c.taskName}`),
      ];
    }

    // Already approved: further approvals are endorsements, if the task allows them.
    const first = c.approvals.find((a) => a.first);
    if (!c.terms.allowMultipleApprovals) fail('already_approved', `${nameOf(ctx, first?.userId)} already approved ${c.taskName}`);
    if (c.approvals.some((a) => a.userId === ctx.actor.id)) fail('already_endorsed', `You already approved ${c.taskName}`);
    // Contributors earned their completion points on the first approval (agreed: once per completion).
    return [
      { type: 'completion.approved', payload: { completionId: c.id, first: false } },
      ...approvalAward(`Also checked ${c.taskName}`),
    ];
  },

  'completion.sendBack'(state, ctx, p) {
    const c = state.completions.get(p.completionId);
    if (!c) fail('not_found', 'That completion no longer exists');
    if (c.contributorIds.includes(ctx.actor.id)) fail('own_task', "You can't send back a task you helped with");
    if (c.status === 'approved') fail('already_approved', `${c.taskName} was already approved`);
    if (c.status === 'sentBack') fail('sent_back', `${c.taskName} was already sent back`);
    const { reasons, note } = readReasons(p, SEND_BACK_REASONS);
    return [{ type: 'completion.sentBack', payload: { completionId: c.id, reasons, note } }];
  },

  'task.create'(state, ctx, p) {
    requireGrownup(ctx);
    if (!isId(p.taskId) || state.tasks.has(p.taskId)) fail('invalid', 'Invalid task id');
    const { def, error } = normaliseTaskDef(p.def);
    if (error) fail('invalid', error);
    return [{ type: 'task.created', payload: { taskId: p.taskId, def } }];
  },

  'task.update'(state, ctx, p) {
    requireGrownup(ctx);
    const t = state.tasks.get(p.taskId);
    if (!t || t.removed) fail('not_found', 'That task no longer exists');
    const { def, error } = normaliseTaskDef(p.def);
    if (error) fail('invalid', error);
    return [{ type: 'task.updated', payload: { taskId: t.id, def } }];
  },

  'task.remove'(state, ctx, p) {
    requireGrownup(ctx);
    const t = state.tasks.get(p.taskId);
    if (!t || t.removed) fail('not_found', 'That task no longer exists');
    return [{ type: 'task.removed', payload: { taskId: t.id } }];
  },

  'reward.create'(state, ctx, p) {
    requireGrownup(ctx);
    if (!isId(p.rewardId) || state.rewards.has(p.rewardId)) fail('invalid', 'Invalid reward id');
    return [{ type: 'reward.created', payload: { rewardId: p.rewardId, def: rewardDef(p.def) } }];
  },

  'reward.update'(state, ctx, p) {
    requireGrownup(ctx);
    const r = state.rewards.get(p.rewardId);
    if (!r || r.removed) fail('not_found', 'That reward no longer exists');
    return [{ type: 'reward.updated', payload: { rewardId: r.id, def: rewardDef(p.def) } }];
  },

  'reward.remove'(state, ctx, p) {
    requireGrownup(ctx);
    const r = state.rewards.get(p.rewardId);
    if (!r || r.removed) fail('not_found', 'That reward no longer exists');
    return [{ type: 'reward.removed', payload: { rewardId: r.id } }];
  },

  'redemption.request'(state, ctx, p) {
    if (!isId(p.redemptionId) || state.redemptions.has(p.redemptionId)) fail('invalid', 'Invalid request id');
    const reward = state.rewards.get(p.rewardId);
    if (!reward || reward.removed) fail('not_found', 'That reward is no longer available');
    if (availablePoints(state, ctx.actor.id) < reward.cost) fail('not_enough_points', `Not enough points for ${reward.name}`);
    return [
      { type: 'redemption.requested', payload: { redemptionId: p.redemptionId, rewardId: reward.id, rewardName: reward.name, cost: reward.cost } },
    ];
  },

  'redemption.approve'(state, ctx, p) {
    requireGrownup(ctx);
    const r = state.redemptions.get(p.redemptionId);
    if (!r) fail('not_found', 'That request no longer exists');
    if (r.requesterId === ctx.actor.id) fail('own_request', "You can't approve your own reward");
    if (r.status !== 'pending') fail(`already_${r.status}`, `That request was already ${r.status}`);
    if ((state.balances.get(r.requesterId) ?? 0) < r.cost) fail('not_enough_points', `${nameOf(ctx, r.requesterId)} doesn't have enough points`);
    return [
      { type: 'redemption.approved', payload: { redemptionId: r.id } },
      { type: 'points.spent', payload: { userId: r.requesterId, amount: r.cost, reason: 'reward', label: r.rewardName, redemptionId: r.id } },
    ];
  },

  'redemption.decline'(state, ctx, p) {
    requireGrownup(ctx);
    const r = state.redemptions.get(p.redemptionId);
    if (!r) fail('not_found', 'That request no longer exists');
    if (r.requesterId === ctx.actor.id) fail('own_request', "You can't decide your own reward");
    if (r.status !== 'pending') fail(`already_${r.status}`, `That request was already ${r.status}`);
    const { reasons, note } = readReasons(p, DECLINE_REASONS);
    return [{ type: 'redemption.declined', payload: { redemptionId: r.id, reasons, note } }];
  },

  'redemption.cancel'(state, ctx, p) {
    const r = state.redemptions.get(p.redemptionId);
    if (!r) fail('not_found', 'That request no longer exists');
    if (r.requesterId !== ctx.actor.id) fail('forbidden', 'Only the person who asked can cancel it');
    if (r.status !== 'pending') fail(`already_${r.status}`, `That request was already ${r.status}`);
    return [{ type: 'redemption.cancelled', payload: { redemptionId: r.id } }];
  },

  'settings.update'(state, ctx, p) {
    requireGrownup(ctx);
    const s = p.settings ?? {};
    const out = {};
    if (s.approvalPoints !== undefined) {
      if (!Number.isInteger(s.approvalPoints) || s.approvalPoints < 0 || s.approvalPoints > 100) {
        fail('invalid', 'Approval points must be a whole number from 0 to 100');
      }
      out.approvalPoints = s.approvalPoints;
    }
    if (s.holidays !== undefined) {
      if (!Array.isArray(s.holidays) || s.holidays.length > 200) fail('invalid', 'Invalid holidays');
      out.holidays = s.holidays.map((h) => {
        if (!isDateString(h?.from) || !isDateString(h?.to) || h.to < h.from) fail('invalid', 'Each holiday needs a start and an end on or after it');
        return { from: h.from, to: h.to, label: typeof h.label === 'string' ? h.label.trim().slice(0, 60) : '' };
      });
    }
    if (Object.keys(out).length === 0) fail('invalid', 'Nothing to change');
    return [{ type: 'settings.updated', payload: { settings: out } }];
  },
};

function rewardDef(def) {
  const name = typeof def?.name === 'string' ? def.name.trim() : '';
  const description = typeof def?.description === 'string' ? def.description.trim().slice(0, 200) : '';
  if (!name || name.length > 60) fail('invalid', 'Give the reward a name (60 characters max)');
  if (!Number.isInteger(def.cost) || def.cost < 1 || def.cost > 100_000) fail('invalid', 'Cost must be a whole number of points, at least 1');
  return { name, description, cost: def.cost };
}

export const ACTION_TYPES = Object.keys(handlers);

/**
 * @param ctx { actor, users: Map<id, user>, date: 'YYYY-MM-DD', approvalPoints }
 * @returns events [{ type, payload }]
 */
export function decide(state, ctx, type, payload) {
  const handler = handlers[type];
  if (!handler) fail('unknown_action', `Unknown action ${type}`);
  if (!ctx.actor.active) fail('forbidden', 'This account is switched off');
  return handler(state, ctx, payload && typeof payload === 'object' ? payload : {});
}

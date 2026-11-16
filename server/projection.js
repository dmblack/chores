// Folds the event log into current state. Pure bookkeeping: every rule is
// checked in commands.js before an event is written, so apply() never rejects.

import { DEFAULT_SETTINGS } from '../shared/rules.js';

export function createState() {
  return {
    seq: 0,
    tasks: new Map(), // taskId -> definition + { id, removed, createdAt }
    completions: new Map(), // completionId -> submission + approvals / send-back
    latestByOccurrence: new Map(), // occurrenceId -> completionId of latest submission
    rewards: new Map(),
    redemptions: new Map(),
    ledger: [], // every points earn and spend, in order
    balances: new Map(), // userId -> points
    settings: { ...DEFAULT_SETTINGS },
  };
}

export function apply(state, e) {
  state.seq = e.seq;
  const p = e.payload;
  switch (e.type) {
    case 'task.created':
      state.tasks.set(p.taskId, { ...p.def, id: p.taskId, removed: false, createdAt: e.at });
      break;
    case 'task.updated': {
      const t = state.tasks.get(p.taskId);
      if (t) state.tasks.set(p.taskId, { ...t, ...p.def });
      break;
    }
    case 'task.removed': {
      const t = state.tasks.get(p.taskId);
      if (t) t.removed = true;
      break;
    }

    case 'completion.submitted':
      state.completions.set(p.completionId, {
        id: p.completionId,
        taskId: p.taskId,
        taskName: p.taskName,
        occurrenceId: p.occurrenceId,
        periodStart: p.periodStart,
        ownerId: p.ownerId,
        contributorIds: p.contributorIds,
        terms: p.terms,
        submittedBy: e.actorId,
        submittedAt: e.at,
        status: 'pending',
        approvals: [],
        approvedAt: null,
        sentBack: null,
      });
      state.latestByOccurrence.set(p.occurrenceId, p.completionId);
      break;
    case 'completion.approved': {
      const c = state.completions.get(p.completionId);
      c.approvals.push({ userId: e.actorId, at: e.at, first: p.first });
      if (p.first) {
        c.status = 'approved';
        c.approvedAt = e.at;
      }
      break;
    }
    case 'completion.sentBack': {
      const c = state.completions.get(p.completionId);
      c.status = 'sentBack';
      c.sentBack = { by: e.actorId, at: e.at, reasons: p.reasons, note: p.note };
      break;
    }

    case 'points.awarded':
    case 'points.spent': {
      const amount = e.type === 'points.spent' ? -p.amount : p.amount;
      state.ledger.push({ seq: e.seq, at: e.at, userId: p.userId, amount, reason: p.reason, label: p.label, completionId: p.completionId ?? null, redemptionId: p.redemptionId ?? null });
      state.balances.set(p.userId, (state.balances.get(p.userId) ?? 0) + amount);
      break;
    }

    case 'reward.created':
      state.rewards.set(p.rewardId, { ...p.def, id: p.rewardId, removed: false });
      break;
    case 'reward.updated': {
      const r = state.rewards.get(p.rewardId);
      if (r) Object.assign(r, p.def);
      break;
    }
    case 'reward.removed': {
      const r = state.rewards.get(p.rewardId);
      if (r) r.removed = true;
      break;
    }

    case 'redemption.requested':
      state.redemptions.set(p.redemptionId, {
        id: p.redemptionId,
        rewardId: p.rewardId,
        rewardName: p.rewardName,
        cost: p.cost,
        requesterId: e.actorId,
        requestedAt: e.at,
        status: 'pending',
        decidedBy: null,
        decidedAt: null,
        reasons: [],
        note: '',
      });
      break;
    case 'redemption.approved':
    case 'redemption.declined':
    case 'redemption.cancelled': {
      const r = state.redemptions.get(p.redemptionId);
      r.status = e.type.split('.')[1];
      r.decidedBy = e.actorId;
      r.decidedAt = e.at;
      r.reasons = p.reasons ?? [];
      r.note = p.note ?? '';
      break;
    }

    case 'settings.updated':
      Object.assign(state.settings, p.settings);
      break;

    default:
      // user.* events are an audit trail of profile changes; accounts live in the users table.
      break;
  }
}

// Household rules shared by the server (which enforces them) and the iPads
// (which use them to preview what will happen).

import { ageOn } from './dates.js';
import { validateRepeat } from './schedule.js';

export const LISTS = [
  { id: 'morning', label: 'Morning' },
  { id: 'daytime', label: 'Daytime' },
  { id: 'evening', label: 'Evening' },
  { id: 'grownups', label: 'Grown-ups' },
];
export const LIST_IDS = LISTS.map((l) => l.id);

export const TASK_KINDS = [
  { id: 'shared', label: 'One job for the household' },
  { id: 'personal', label: 'Everyone does their own' },
];

export const ALLOCATIONS = [
  { id: 'full', label: 'Full points for each person', short: 'Full points each' },
  { id: 'split', label: 'Split points equally', short: 'Points split equally' },
];

// Agreed 15 Nov 2026: quick creation uses these unless Advanced settings change them.
export const TASK_DEFAULTS = Object.freeze({
  kind: 'shared',
  allowCollaboration: false,
  allocation: 'full',
  allowMultipleApprovals: false,
  minAge: null,
});

export const DEFAULT_SETTINGS = Object.freeze({ approvalPoints: 1, holidays: [] });

export const SEND_BACK_REASONS = [
  { id: 'not_finished', label: 'Not finished' },
  { id: 'not_criteria', label: "Doesn't match what counts as done" },
  { id: 'needs_tidy', label: 'Needs tidying up' },
  { id: 'not_done', label: "Wasn't done" },
];

export const DECLINE_REASONS = [
  { id: 'not_today', label: 'Not today' },
  { id: 'ask_later', label: 'Ask again later' },
  { id: 'chores_first', label: 'Chores first' },
];

/**
 * Completion points each contributor receives on the first accepted approval.
 * Split shares round up for everyone (agreed 15 Nov 2026): 10 between 3 is 4 each.
 */
export function shareFor(points, allocation, contributorCount) {
  if (contributorCount <= 1 || allocation !== 'split') return points;
  return Math.ceil(points / contributorCount);
}

/** Whether a person may be a contributor on this task on this date. */
export function isEligible(user, task, date) {
  if (!user || !user.active) return false;
  if (task.list === 'grownups' && user.role !== 'grownup') return false;
  if (task.minAge != null) {
    const age = ageOn(user.birthDate, date);
    if (age == null || age < task.minAge) return false;
  }
  return true;
}

/** Short summary of advanced settings that differ from the quick-create defaults. */
export function advancedSummary(def) {
  const parts = [];
  if (def.allowCollaboration) {
    parts.push('Collaboration allowed');
    parts.push(ALLOCATIONS.find((a) => a.id === def.allocation)?.short ?? '');
  }
  if (def.allowMultipleApprovals) parts.push('Multiple approvals');
  if (def.minAge != null) parts.push(`Age ${def.minAge}+`);
  return parts.filter(Boolean).join(' · ');
}

/** Returns { def } with a normalised task definition, or { error }. */
export function normaliseTaskDef(input) {
  if (!input || typeof input !== 'object') return { error: 'Missing task details' };
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const criterion = typeof input.criterion === 'string' ? input.criterion.trim() : '';
  if (!name) return { error: 'Give the task a name' };
  if (name.length > 80) return { error: 'Task name is too long (80 characters max)' };
  if (!criterion) return { error: 'Say what counts as done' };
  if (criterion.length > 200) return { error: '"What counts as done" is too long (200 characters max)' };
  const points = input.points;
  if (!Number.isInteger(points) || points < 0 || points > 1000) return { error: 'Points must be a whole number from 0 to 1000' };
  if (!LIST_IDS.includes(input.list)) return { error: 'Choose a list' };
  const kind = input.kind ?? TASK_DEFAULTS.kind;
  if (!TASK_KINDS.some((k) => k.id === kind)) return { error: 'Choose who does it' };
  const repeatError = validateRepeat(input.repeat);
  if (repeatError) return { error: repeatError };
  const allowCollaboration = input.allowCollaboration ?? TASK_DEFAULTS.allowCollaboration;
  const allocation = input.allocation ?? TASK_DEFAULTS.allocation;
  const allowMultipleApprovals = input.allowMultipleApprovals ?? TASK_DEFAULTS.allowMultipleApprovals;
  const minAge = input.minAge ?? TASK_DEFAULTS.minAge;
  if (typeof allowCollaboration !== 'boolean') return { error: 'Invalid collaboration setting' };
  if (!ALLOCATIONS.some((a) => a.id === allocation)) return { error: 'Invalid points setting' };
  if (typeof allowMultipleApprovals !== 'boolean') return { error: 'Invalid approvals setting' };
  if (minAge !== null && (!Number.isInteger(minAge) || minAge < 1 || minAge > 99)) {
    return { error: 'Minimum age must be blank or 1–99' };
  }
  const r = input.repeat;
  const repeat =
    r.type === 'weekdays' ? { type: r.type, days: [...r.days].sort() }
    : r.type === 'interval' ? { type: r.type, every: r.every, unit: r.unit, start: r.start }
    : { type: r.type };
  return {
    def: { name, criterion, points, list: input.list, kind, repeat, allowCollaboration, allocation, allowMultipleApprovals, minAge },
  };
}

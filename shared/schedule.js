// Recurrence: which scheduled occurrence of a task covers a given date.
//
// Every occurrence has a period [start, end). Day-based schedules produce
// one-day periods; "every N days/weeks" produces a period of N days that stays
// on the list until it is done or the next period starts.

import { addDays, daysBetween, isDateString, weekday, WEEKDAY_SHORT } from './dates.js';

export const REPEAT_OPTIONS = [
  { id: 'daily', label: 'Every day' },
  { id: 'schoolDays', label: 'School days (Mon–Fri, not holidays)' },
  { id: 'weekendsHolidays', label: 'Weekends and holidays' },
  { id: 'weekdays', label: 'Certain days of the week' },
  { id: 'interval', label: 'Every few days or weeks' },
];

export function isHoliday(date, holidays = []) {
  return holidays.some((h) => h.from <= date && date <= h.to);
}

export function periodFor(task, date, holidays = []) {
  const r = task.repeat;
  const oneDay = () => ({ start: date, end: addDays(date, 1) });
  const wd = weekday(date);
  switch (r?.type) {
    case 'daily':
      return oneDay();
    case 'schoolDays':
      return wd >= 1 && wd <= 5 && !isHoliday(date, holidays) ? oneDay() : null;
    case 'weekendsHolidays':
      return wd === 0 || wd === 6 || isHoliday(date, holidays) ? oneDay() : null;
    case 'weekdays':
      return r.days.includes(wd) ? oneDay() : null;
    case 'interval': {
      const len = r.every * (r.unit === 'weeks' ? 7 : 1);
      const diff = daysBetween(r.start, date);
      if (diff < 0) return null;
      const start = addDays(r.start, Math.floor(diff / len) * len);
      return { start, end: addDays(start, len) };
    }
    default:
      return null;
  }
}

/**
 * Stable id of one scheduled occurrence. A shared household job has one per
 * period; an "everyone does their own" task has one per person per period.
 */
export function occurrenceIdFor(taskId, periodStart, ownerId) {
  return ownerId ? `${taskId}/${periodStart}/${ownerId}` : `${taskId}/${periodStart}`;
}

export function validateRepeat(r) {
  if (!r || typeof r !== 'object') return 'Choose when it repeats';
  switch (r.type) {
    case 'daily':
    case 'schoolDays':
    case 'weekendsHolidays':
      return null;
    case 'weekdays':
      if (!Array.isArray(r.days) || r.days.length === 0) return 'Pick at least one day';
      if (!r.days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) return 'Invalid day';
      if (new Set(r.days).size !== r.days.length) return 'Each day once';
      return null;
    case 'interval':
      if (!Number.isInteger(r.every) || r.every < 1 || r.every > 365) return 'Repeat every 1–365';
      if (r.unit !== 'days' && r.unit !== 'weeks') return 'Choose days or weeks';
      if (!isDateString(r.start)) return 'Choose a starting date';
      return null;
    default:
      return 'Choose when it repeats';
  }
}

export function describeRepeat(r) {
  switch (r?.type) {
    case 'daily':
      return 'Every day';
    case 'schoolDays':
      return 'School days';
    case 'weekendsHolidays':
      return 'Weekends and holidays';
    case 'weekdays':
      return [...r.days].sort().map((d) => WEEKDAY_SHORT[d]).join(', ');
    case 'interval': {
      const unit = r.unit === 'weeks' ? 'week' : 'day';
      return r.every === 1 ? `Every ${unit}` : `Every ${r.every} ${unit}s`;
    }
    default:
      return '';
  }
}

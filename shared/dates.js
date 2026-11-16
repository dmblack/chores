// Calendar-date helpers. Dates are 'YYYY-MM-DD' strings in the household's
// local time zone (the server's TZ, and each iPad's own clock).

const DAY_MS = 86_400_000;

export function localDate(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function toUTC(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function fromUTC(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

export function isDateString(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && fromUTC(toUTC(s)) === s;
}

export function addDays(dateStr, n) {
  return fromUTC(toUTC(dateStr) + n * DAY_MS);
}

export function daysBetween(from, to) {
  return Math.round((toUTC(to) - toUTC(from)) / DAY_MS);
}

/** 0 = Sunday … 6 = Saturday */
export function weekday(dateStr) {
  return new Date(toUTC(dateStr)).getUTCDay();
}

/** Whole years old on a given date, worked out from the birth date. */
export function ageOn(birthDate, onDate) {
  if (!isDateString(birthDate)) return null;
  const [by, bm, bd] = birthDate.split('-').map(Number);
  const [y, m, d] = onDate.split('-').map(Number);
  let age = y - by;
  if (m < bm || (m === bm && d < bd)) age -= 1;
  return age;
}

export const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

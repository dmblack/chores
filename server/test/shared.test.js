import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ageOn, addDays, weekday } from '../../shared/dates.js';
import { periodFor, occurrenceIdFor } from '../../shared/schedule.js';
import { advancedSummary, isEligible, normaliseTaskDef, shareFor, TASK_DEFAULTS } from '../../shared/rules.js';

test('ages are worked out from the birth date', () => {
  assert.equal(ageOn('2016-11-16', '2026-11-15'), 9);
  assert.equal(ageOn('2016-11-16', '2026-11-16'), 10);
  assert.equal(ageOn('2016-02-29', '2026-02-28'), 9);
  assert.equal(ageOn('2016-02-29', '2026-03-01'), 10);
});

test('date arithmetic', () => {
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(weekday('2026-11-16'), 1); // Monday
});

test('split points round up for everyone; full points go to each person', () => {
  assert.equal(shareFor(10, 'split', 3), 4);
  assert.equal(shareFor(10, 'split', 2), 5);
  assert.equal(shareFor(10, 'split', 1), 10);
  assert.equal(shareFor(10, 'full', 3), 10);
  assert.equal(shareFor(0, 'split', 3), 0);
});

test('schedules', () => {
  const holidays = [{ from: '2026-12-21', to: '2027-01-29', label: 'Summer holidays' }];
  const school = { repeat: { type: 'schoolDays' } };
  assert.ok(periodFor(school, '2026-11-16', holidays)); // Monday
  assert.equal(periodFor(school, '2026-11-21', holidays), null); // Saturday
  assert.equal(periodFor(school, '2026-12-22', holidays), null); // holiday Tuesday

  const weekend = { repeat: { type: 'weekendsHolidays' } };
  assert.ok(periodFor(weekend, '2026-11-21', holidays));
  assert.ok(periodFor(weekend, '2026-12-22', holidays));
  assert.equal(periodFor(weekend, '2026-11-17', holidays), null);

  const binsDays = { repeat: { type: 'weekdays', days: [1, 4] } };
  assert.ok(periodFor(binsDays, '2026-11-19'));
  assert.equal(periodFor(binsDays, '2026-11-18'), null);

  const weekly = { repeat: { type: 'interval', every: 1, unit: 'weeks', start: '2026-11-16' } };
  assert.deepEqual(periodFor(weekly, '2026-11-18'), { start: '2026-11-16', end: '2026-11-23' });
  assert.deepEqual(periodFor(weekly, '2026-11-23'), { start: '2026-11-23', end: '2026-11-30' });
  assert.equal(periodFor(weekly, '2026-11-15'), null);
});

test('occurrence ids separate household jobs, people and days', () => {
  assert.equal(occurrenceIdFor('t1', '2026-11-16', null), 't1/2026-11-16');
  assert.equal(occurrenceIdFor('t1', '2026-11-16', 'u1'), 't1/2026-11-16/u1');
});

test('eligibility uses age and the grown-ups list', () => {
  const kid9 = { active: true, role: 'kid', birthDate: '2017-01-20' };
  const kid12 = { active: true, role: 'kid', birthDate: '2014-05-10' };
  assert.equal(isEligible(kid9, { minAge: 10, list: 'evening' }, '2026-11-16'), false);
  assert.equal(isEligible(kid12, { minAge: 10, list: 'evening' }, '2026-11-16'), true);
  assert.equal(isEligible(kid12, { minAge: null, list: 'grownups' }, '2026-11-16'), false);
  assert.equal(isEligible({ ...kid12, active: false }, { minAge: null, list: 'evening' }, '2026-11-16'), false);
});

test('quick creation fills in the agreed defaults', () => {
  const { def } = normaliseTaskDef({ name: 'Unload dishwasher', criterion: 'Dishes in cupboards', points: 10, list: 'evening', repeat: { type: 'daily' } });
  assert.equal(def.kind, 'shared');
  assert.equal(def.allowCollaboration, TASK_DEFAULTS.allowCollaboration);
  assert.equal(def.allowCollaboration, false);
  assert.equal(def.allocation, 'full');
  assert.equal(def.allowMultipleApprovals, false);
  assert.equal(def.minAge, null);
  assert.equal(advancedSummary(def), '');
  assert.equal(advancedSummary({ ...def, allowCollaboration: true }), 'Collaboration allowed · Full points each');
});

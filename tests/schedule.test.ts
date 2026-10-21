import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cronOf, describeSchedule, nextRuns, normalizeSchedule, type ScheduleInput, scheduleProblem } from '../src/core/schedule.ts';

const runs = (input: ScheduleInput, after: string, count = 3) => nextRuns(normalizeSchedule(input), new Date(after), count).map((at) => at.toISOString());

test('each frequency runs on the clock of its own time zone', () => {
	// 9:00 in Kolkata is 3:30 UTC; after Friday's run come Monday's.
	assert.deepEqual(runs({ frequency: 'weekdays', time: '09:00', timeZone: 'Asia/Kolkata' }, '2026-10-23T04:00:00Z', 2), ['2026-10-26T03:30:00.000Z', '2026-10-27T03:30:00.000Z']);
	assert.deepEqual(runs({ frequency: 'weekly', days: [5, 1], time: '18:15', timeZone: 'UTC' }, '2026-10-21T00:00:00Z'), [
		'2026-10-23T18:15:00.000Z',
		'2026-10-26T18:15:00.000Z',
		'2026-10-30T18:15:00.000Z',
	]);
	assert.deepEqual(runs({ frequency: 'hourly', everyHours: 8, time: '00:05', timeZone: 'UTC' }, '2026-10-21T07:00:00Z', 2), ['2026-10-21T08:05:00.000Z', '2026-10-21T16:05:00.000Z']);
	assert.deepEqual(runs({ frequency: 'monthly', dayOfMonth: 0, time: '09:00', timeZone: 'UTC' }, '2026-01-31T10:00:00Z', 2), ['2026-02-28T09:00:00.000Z', '2026-03-31T09:00:00.000Z'], 'the last day, however long the month');
	assert.deepEqual(runs({ frequency: 'cron', cron: '30 8 * * 1,3', timeZone: 'UTC' }, '2026-10-21T09:00:00Z', 1), ['2026-10-26T08:30:00.000Z']);
	assert.equal(cronOf(normalizeSchedule({ frequency: 'weekly', days: [3, 1, 3], time: '07:45' })), '45 7 * * 1,3', 'days once each, in order');
});

test('a run keeps its local time across daylight saving', () => {
	// New York moves from UTC-5 to UTC-4 on March 8, 2026, and back on November 1.
	assert.deepEqual(runs({ frequency: 'daily', time: '09:00', timeZone: 'America/New_York' }, '2026-03-07T00:00:00Z'), [
		'2026-03-07T14:00:00.000Z',
		'2026-03-08T13:00:00.000Z',
		'2026-03-09T13:00:00.000Z',
	]);
	// 2:30 never happens on March 8: that day it runs as the clock reaches 3:30.
	assert.deepEqual(runs({ frequency: 'daily', time: '02:30', timeZone: 'America/New_York' }, '2026-03-07T12:00:00Z', 2), ['2026-03-08T07:30:00.000Z', '2026-03-09T06:30:00.000Z']);
	// 1:30 happens twice on November 1; it runs once.
	assert.deepEqual(runs({ frequency: 'daily', time: '01:30', timeZone: 'America/New_York' }, '2026-10-31T12:00:00Z', 2), ['2026-11-01T05:30:00.000Z', '2026-11-02T06:30:00.000Z']);
});

test('a schedule reads as words, and says what is wrong with it', () => {
	const said = (input: ScheduleInput) => describeSchedule(normalizeSchedule(input));
	assert.equal(said({ frequency: 'daily', time: '21:05', timeZone: 'Asia/Kolkata' }), 'every day at 9:05 PM, Kolkata time');
	assert.equal(said({ frequency: 'weekdays', time: '00:00', timeZone: 'UTC' }), 'every weekday at 12:00 AM, UTC');
	assert.equal(said({ frequency: 'weekly', days: [1, 4], time: '09:00', timeZone: 'America/Los_Angeles' }), 'every Monday and Thursday at 9:00 AM, Los Angeles time');
	assert.equal(said({ frequency: 'weekly', days: [0, 1, 3], time: '09:00', timeZone: 'UTC' }), 'every Mon, Wed and Sun at 9:00 AM, UTC');
	assert.equal(said({ frequency: 'hourly', everyHours: 1, time: '00:15', timeZone: 'UTC' }), 'every hour at :15, UTC');
	assert.equal(said({ frequency: 'monthly', dayOfMonth: 22, time: '12:00', timeZone: 'UTC' }), 'on the 22nd of every month at 12:00 PM, UTC');

	const problem = (input: ScheduleInput) => scheduleProblem(normalizeSchedule(input));
	assert.equal(problem({ frequency: 'daily', timeZone: 'Asia/Kolkata' }), null);
	assert.match(problem({ frequency: 'daily', time: '25:00' }) ?? '', /time of day/);
	assert.match(problem({ frequency: 'hourly', everyHours: 5 }) ?? '', /hours apart/);
	assert.match(problem({ frequency: 'monthly', dayOfMonth: 31 }) ?? '', /day of the month/);
	assert.match(problem({ frequency: 'cron', cron: '0 9 * * * *' }) ?? '', /five fields/);
	assert.match(problem({ frequency: 'cron', cron: '0 99 * * *' }) ?? '', /does not read/);
	assert.match(problem({ frequency: 'cron', cron: '0 9 30 2 *' }) ?? '', /never runs/);
});

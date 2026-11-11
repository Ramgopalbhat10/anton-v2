import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CLOCK_AFTER_MS, CLOCK_EVERY_MS, elapsedNote, elapsedText, hoursText, replyElapsed, startReplyClock } from '../src/services/reply-clock.ts';

const MIN = 60_000;

test('a short reply is never told the time, and a long one is told at most once every few minutes', () => {
	const t0 = 1_000_000;
	startReplyClock('a', t0);
	assert.equal(elapsedNote('a', t0 + 5 * MIN), '');
	assert.equal(elapsedNote('a', t0 + CLOCK_AFTER_MS - 1), '');
	assert.equal(elapsedNote('a', t0 + CLOCK_AFTER_MS), '\n[anton] 10m since this reply started, of 4 hours allowed.');
	// Not again on the commands that follow closely.
	assert.equal(elapsedNote('a', t0 + CLOCK_AFTER_MS + MIN), '');
	assert.equal(elapsedNote('a', t0 + CLOCK_AFTER_MS + CLOCK_EVERY_MS - 1), '');
	assert.equal(elapsedNote('a', t0 + 85 * MIN, 8 * 60 * MIN), '\n[anton] 1h 25m since this reply started, of 8 hours allowed.');
});

test('a new reply counts from its own start, and a reply whose start is not known is told nothing', () => {
	const t0 = 2_000_000;
	startReplyClock('b', t0);
	assert.match(elapsedNote('b', t0 + 30 * MIN), /30m since/);
	startReplyClock('b', t0 + 40 * MIN);
	assert.equal(elapsedNote('b', t0 + 45 * MIN), '');
	assert.match(elapsedNote('b', t0 + 52 * MIN), /12m since/);
	assert.equal(elapsedNote('never-started', t0 + 500 * MIN), '');
	assert.equal(replyElapsed('b', t0 + 52 * MIN), 12 * MIN);
	assert.equal(replyElapsed('never-started'), null);
});

test('the limit reads in hours, from config alone', () => {
	assert.equal(hoursText(4 * 60 * MIN), '4 hours');
	assert.equal(hoursText(60 * MIN), '1 hour');
	assert.equal(hoursText(90 * MIN), '1.5 hours');
});

test('elapsed time reads as hours and minutes', () => {
	assert.equal(elapsedText(59 * MIN + 59_000), '59m');
	assert.equal(elapsedText(60 * MIN), '1h 0m');
	assert.equal(elapsedText(7 * 60 * MIN + 5 * MIN), '7h 5m');
});

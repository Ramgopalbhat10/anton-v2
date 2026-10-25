import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StepGivenUp, withinDeadline } from '../src/services/step-deadline.ts';

const never = () => new Promise<string>(() => undefined);

test('a step that finishes in time answers as it would', async () => {
	assert.equal(await withinDeadline(Promise.resolve('done'), 50), 'done');
	await assert.rejects(withinDeadline(Promise.reject(new Error('page crashed')), 50), /page crashed/);
});

test('a step past its deadline is given up, and what it waited on let go', async () => {
	let released = false;
	const error = await withinDeadline(never(), 30, undefined, () => (released = true)).catch((reason: unknown) => reason);
	assert.ok(error instanceof StepGivenUp);
	assert.equal(error.reason, 'deadline');
	assert.match(error.message, /did not finish within 0 seconds/);
	assert.ok(released);
});

test('a stopped reply gives its step up at once, or before it starts', async () => {
	const controller = new AbortController();
	const step = withinDeadline(never(), 60_000, controller.signal);
	controller.abort();
	await assert.rejects(step, (error: unknown) => error instanceof StepGivenUp && error.reason === 'stopped');
	await assert.rejects(withinDeadline(never(), 60_000, controller.signal), /The step was stopped\./);
});

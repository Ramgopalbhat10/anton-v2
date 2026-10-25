import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type AntonApi, parseDuration, parseTasks, runTask, summary } from '../scripts/anton-run.ts';

const usage = { inputTokens: 120_000, cachedTokens: 90_000, outputTokens: 4_000, cost: 0.0421 };
function fakeApi(send: AntonApi['send']): AntonApi & { stopped: string[]; created: unknown[] } {
	const api = {
		stopped: [] as string[],
		created: [] as unknown[],
		createTask: async (task: unknown) => (api.created.push(task), 'task-1'),
		send,
		stop: async (id: string) => void api.stopped.push(id),
		usage: async () => usage,
		context: async () => ({ used: 48_000, task: { calls: 12 } }),
	};
	return api;
}

test('a run makes a task, sends the prompt and records how it went and what it cost', async () => {
	const api = fakeApi(async (_id, prompt) => `Done: ${prompt}`);
	let clock = 0;
	const result = await runTask(api, { prompt: 'Fix the date test\nin src/date.ts', model: 'openrouter/x' }, 60_000, () => (clock += 12_340));
	assert.deepEqual(api.created, [{ prompt: 'Fix the date test\nin src/date.ts', model: 'openrouter/x' }]);
	assert.deepEqual(result, {
		name: 'Fix the date test',
		task: 'task-1',
		outcome: 'completed',
		seconds: 12.3,
		inputTokens: 120_000,
		cachedTokens: 90_000,
		outputTokens: 4_000,
		cost: 0.0421,
		calls: 12,
		peakContext: 48_000,
		reply: 'Done: Fix the date test\nin src/date.ts',
	});
	assert.equal(summary([result, { ...result, outcome: 'failed' }]), '1/2 completed in 25s: 248,000 tokens (180,000 cached), $0.0842');
});

test('a run that fails says why, and one past its time is stopped', async () => {
	const failed = await runTask(
		fakeApi(async () => {
			throw Object.assign(new Error('The model refused'), { failure: 'failed' });
		}),
		{ name: 'refusal', prompt: 'x' },
		60_000,
	);
	assert.equal(failed.outcome, 'failed');
	assert.equal(failed.error, 'The model refused');

	const slow = fakeApi((_id, _prompt, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))));
	const timedOut = await runTask(slow, { prompt: 'x' }, 20);
	assert.equal(timedOut.outcome, 'timed-out');
	assert.deepEqual(slow.stopped, ['task-1']);
});

test('tasks come one JSON object a line, and durations in s, m or h', () => {
	assert.deepEqual(parseTasks('{"name":"a","prompt":"one"}\n\n// a note\n{"prompt":"two","model":"m"}\n'), [{ name: 'a', prompt: 'one' }, { prompt: 'two', model: 'm' }]);
	assert.throws(() => parseTasks('{"name":"a"}'), /Task 1 has no prompt/);
	assert.equal(parseDuration('90s'), 90_000);
	assert.equal(parseDuration('30'), 1_800_000);
	assert.equal(parseDuration('2h'), 7_200_000);
	assert.throws(() => parseDuration('soon'));
});

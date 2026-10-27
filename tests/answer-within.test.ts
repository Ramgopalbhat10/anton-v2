import assert from 'node:assert/strict';
import { test } from 'node:test';
import { answerWithin } from '../src/services/answer-within.ts';
import { recentProblems } from '../src/services/log.ts';

test('work that ends in time answers with its result', async () => {
	assert.equal(await answerWithin(Promise.resolve('done'), () => 'later', 'Quick work', null, 1000), 'done');
	await assert.rejects(() => answerWithin(Promise.reject(new Error('no')), () => 'later', 'Quick work', null, 1000), /no/);
});

test('work past the deadline answers for now, carries on, and its failure is logged', async () => {
	let finish!: (error: Error) => void;
	const work = new Promise<string>((_resolve, reject) => {
		finish = reject;
	});
	assert.deepEqual(await answerWithin(work, () => ({ pending: true }), 'Deleting the task', 's1', 20), { pending: true });
	const quiet = console.error;
	console.error = () => undefined;
	try {
		finish(new Error('sandbox gone'));
		await new Promise((resolve) => setTimeout(resolve, 10));
	} finally {
		console.error = quiet;
	}
	assert.deepEqual({ ...recentProblems()[0], at: '' }, { at: '', level: 'error', message: 'Deleting the task failed', detail: 'sandbox gone', sessionId: 's1' });
});

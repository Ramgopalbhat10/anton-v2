import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PREWARM_AT, prewarmFor } from '../src/services/prewarm-intent.ts';

const fakes = (likely: number | null) => {
	const did: string[] = [];
	return {
		did,
		deps: {
			prewarm: async (id: string) => void did.push(`prewarm ${id}`),
			release: (id: string) => void did.push(`release ${id}`),
			judge: async () => likely,
			byIntent: true,
		},
	};
};

test('a message the decision model reads as a question starts no sandbox, and lets go of the one woken while it was typed', async () => {
	const { did, deps } = fakes(0.05);
	assert.equal(await prewarmFor('q', 'Where is the round limit defined?', deps), 'skipped');
	assert.deepEqual(did, ['release q']);
});

test('a message that likely needs commands or changes, or that the model is unsure of, is prewarmed as before', async () => {
	for (const likely of [0.9, PREWARM_AT, null]) {
		const { did, deps } = fakes(likely);
		assert.equal(await prewarmFor('w', 'Fix the failing test in src/date.ts', deps), 'prewarmed');
		assert.deepEqual(did, ['prewarm w']);
	}
});

test('without a message, or with intent turned off, every reply is prewarmed without asking', async () => {
	let asked = 0;
	const { did, deps } = fakes(0);
	const judge = async () => (asked++, 0);
	assert.equal(await prewarmFor('a', null, { ...deps, judge }), 'prewarmed');
	assert.equal(await prewarmFor('b', 'A question?', { ...deps, judge, byIntent: false }), 'prewarmed');
	assert.equal(asked, 0);
	assert.deepEqual(did, ['prewarm a', 'prewarm b']);
});

test('a failure never reaches the reply', async () => {
	const { deps } = fakes(0.9);
	assert.equal(await prewarmFor('f', 'Fix it', { ...deps, prewarm: async () => Promise.reject(new Error('no machine')) }), 'prewarmed');
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { threadState } from '../src/core/thread-state.ts';

const base = {
	working: false,
	status: 'stopped' as const,
	asking: null,
	planMode: false,
	usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
	pullRequest: null,
	prUrl: null,
	resolvedAt: null,
	brief: null,
};
const pr = (state: 'open' | 'draft' | 'merged' | 'closed', extra: { checks?: 'passed' | 'failed' | 'pending' | null; approved?: boolean } = {}) => ({
	prUrl: 'https://github.com/acme/api/pull/1',
	pullRequest: { state, checks: extra.checks ?? null, approved: extra.approved, runs: [] },
});

test('a thread is in the first state whose rule holds', () => {
	assert.equal(threadState(base), 'idle');
	assert.equal(threadState({ ...base, brief: 'Do it' }), 'queued');
	assert.equal(threadState({ ...base, working: true }), 'working');
	assert.equal(threadState({ ...base, status: 'starting' }), 'working');
	assert.equal(threadState({ ...base, asking: 'Which one?' }), 'waiting');
	assert.equal(threadState({ ...base, status: 'error' }), 'waiting');
	assert.equal(threadState({ ...base, planMode: true, usage: { inputTokens: 10, outputTokens: 10, cost: 0 } }), 'waiting', 'a plan to approve');
	assert.equal(threadState({ ...base, ...pr('open') }), 'review');
	assert.equal(threadState({ ...base, ...pr('draft', { approved: true }) }), 'review', 'a draft does not land');
	assert.equal(threadState({ ...base, ...pr('open', { approved: true }) }), 'landing');
	assert.equal(threadState({ ...base, ...pr('open', { checks: 'failed' }) }), 'waiting');
	assert.equal(threadState({ ...base, ...pr('merged') }), 'idle');
	assert.equal(threadState({ ...base, working: true, asking: 'Which one?' }), 'working', 'working wins over an old question');
	assert.equal(threadState({ ...base, working: true, resolvedAt: '2026-01-01T00:00:00Z' }), 'resolved');
});

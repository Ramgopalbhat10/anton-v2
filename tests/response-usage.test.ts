import assert from 'node:assert/strict';
import { test } from 'node:test';
import { countReplyCall, finishReply, replyTotal, startReply } from '../src/services/response-usage.ts';

const usage = (input: number, output: number, cacheRead = 0) => ({ input, output, cacheRead, cacheWrite: 0, totalTokens: input + output + cacheRead, cost: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
const turn = (patch: Record<string, unknown>, used: ReturnType<typeof usage>) => ({ type: 'turn', instanceId: 'task', agentName: 'Coder', session: 'default', response: { usage: used }, ...patch });

test('a reply counts every call it made, its subagents too, apart; the reviewer and other tasks are not in it', () => {
	startReply('task');
	countReplyCall(turn({}, usage(3179, 75, 1000)));
	countReplyCall(turn({ session: 'task:default:browser-1', taskId: 'browser-1' }, usage(954, 29)));
	countReplyCall(turn({ agentName: 'browser', session: 'task:default:browser-1', taskId: 'browser-1' }, usage(1880, 31)));
	countReplyCall(turn({ agentName: 'Reviewer' }, usage(9000, 900)));
	countReplyCall(turn({ instanceId: 'other' }, usage(500, 5)));
	countReplyCall({ type: 'turn_request', instanceId: 'task' });
	countReplyCall(turn({}, usage(4331, 17)));
	const reply = finishReply('task');
	assert.deepEqual(reply?.main, { inputTokens: 8510, outputTokens: 92, cost: 0, cachedTokens: 1000, calls: 2 });
	assert.deepEqual(reply?.subagents, { inputTokens: 2834, outputTokens: 60, cost: 0, cachedTokens: 0, calls: 2 });
	assert.deepEqual(replyTotal(reply!), { inputTokens: 11_344, outputTokens: 152, cost: 0, cachedTokens: 1000 });
	assert.equal(finishReply('task'), null, 'finishing ends the count');
});

test('a reply whose start was not seen, as after a restart, has no count of its own', () => {
	countReplyCall(turn({ instanceId: 'resumed' }, usage(100, 1)));
	assert.equal(finishReply('resumed'), null);
	startReply('quiet');
	assert.equal(finishReply('quiet'), null, 'nor one that made no calls');
});

test('a reply is on the plan only when every call ran on it; a subagent on a paid model makes it charged', () => {
	const planned = { request: { providerId: 'openai' } };
	startReply('plan');
	countReplyCall(turn({ instanceId: 'plan', ...planned }, usage(100, 1)));
	countReplyCall(turn({ instanceId: 'plan', taskId: 'sub', ...planned }, usage(100, 1)));
	assert.equal(finishReply('plan')?.billing, 'plan');
	startReply('mixed');
	countReplyCall(turn({ instanceId: 'mixed', ...planned }, usage(100, 1)));
	countReplyCall(turn({ instanceId: 'mixed', taskId: 'sub', request: { providerId: 'openrouter' } }, usage(100, 1)));
	assert.equal(finishReply('mixed')?.billing, 'api');
});

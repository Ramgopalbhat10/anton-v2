import assert from 'node:assert/strict';
import { test } from 'node:test';
import { countReplyCall, finishReply, replyFacts, replyTotal, startReply } from '../src/services/response-usage.ts';

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

test('a reply keeps the largest context one of its agent’s calls held, apart from the tokens all its calls read', () => {
	const request = { providerId: 'opencode-go', requestedModel: 'deepseek-v4-pro' };
	startReply('long');
	countReplyCall(turn({ instanceId: 'long', purpose: 'agent', request }, usage(356_000, 900)));
	countReplyCall(turn({ instanceId: 'long', purpose: 'agent', request }, usage(1200, 700, 357_000)));
	countReplyCall(turn({ instanceId: 'long', purpose: 'agent', request }, usage(800, 400, 358_500)));
	// A subagent's own conversation and compaction's summaries are billed, but are not the window.
	countReplyCall(turn({ instanceId: 'long', taskId: 'browser-1', session: 'long:default:browser-1', request }, usage(500_000, 10)));
	countReplyCall(turn({ instanceId: 'long', purpose: 'compaction', request }, usage(400_000, 3000)));
	countReplyCall({ type: 'compaction', instanceId: 'long', agentName: 'Coder', session: 'default' });
	countReplyCall({ type: 'compaction', instanceId: 'long', taskId: 'browser-1', session: 'long:default:browser-1' });
	countReplyCall({ type: 'compaction', instanceId: 'long', agentName: 'Coder', session: 'default', isError: true });
	const reply = finishReply('long')!;
	assert.equal(reply.peak, 359_700);
	assert.equal(reply.model, 'opencode-go/deepseek-v4-pro');
	assert.equal(reply.compactions, 1, 'only the agent’s own compactions that worked');
	assert.equal(reply.main.calls, 4);
	assert.equal(replyTotal(reply).inputTokens, 356_000 + 358_200 + 359_300 + 500_000 + 400_000);
	const models = [{ id: 'opencode-go/deepseek-v4-pro', contextLength: 1_000_000 }] as unknown as Parameters<typeof replyFacts>[1];
	assert.deepEqual(replyFacts(reply, models), { context: { peak: 359_700, window: 1_000_000 }, compactions: 1, estimated: false });
	assert.deepEqual(replyFacts(reply, []).context, { peak: 359_700, window: 0 }, 'a model not listed has no window to show');
});

test('Cursor’s calls are counted from their text, and the reply says so', () => {
	startReply('cursor');
	countReplyCall(turn({ instanceId: 'cursor', request: { providerId: 'cursor', requestedModel: 'grok-4.7' } }, usage(66_000, 500)));
	assert.equal(finishReply('cursor')!.estimated, true);
});

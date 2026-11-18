import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const dir = mkdtempSync(path.join(os.tmpdir(), 'anton-settled-'));
process.env.ANTON_DATA_DIR = dir;
after(() => rmSync(dir, { recursive: true, force: true }));

const { recordTraceEvent, startTrace } = await import('../src/services/context/response-trace.ts');
const { countReplyCall, startReply } = await import('../src/services/models/response-usage.ts');
const { keepSettledReply } = await import('../src/services/replies/settled-reply.ts');
const { getSettledTrace, getTrace, saveTrace } = await import('../src/db/traces.ts');

const usage = { input: 2000, output: 80, cacheRead: 0, cacheWrite: 0, totalTokens: 2080, cost: { total: 0.01 } };

/** A reply that made one call, then its model's plan turned it away. */
function failedReply(id: string) {
	startReply(id);
	startTrace(id);
	const base = { instanceId: id, agentName: 'Coder', session: 'default', purpose: 'agent', turnId: 't1' };
	const request = { providerId: 'openrouter', requestedModel: 'test/model', input: { systemPrompt: 'You are Anton.', messages: [{ role: 'user', content: 'Fix it.' }], tools: [] } };
	const turn = { ...base, type: 'turn', durationMs: 900, timestamp: new Date().toISOString(), request, response: { usage, output: { content: [{ type: 'text', text: 'Looking.' }] } } };
	recordTraceEvent({ ...base, type: 'turn_request', request, timestamp: new Date().toISOString() });
	recordTraceEvent(turn);
	countReplyCall(turn);
}

test('a failed reply keeps its trace and usage, found by its submission and those that joined it', async () => {
	failedReply('task-1');
	keepSettledReply({ type: 'submission_settled', instanceId: 'task-1', agentName: 'Coder', submissionId: 'sub-1', outcome: 'failed' });
	keepSettledReply({ type: 'submission_settled', instanceId: 'task-1', agentName: 'Coder', submissionId: 'sub-2', outcome: 'failed' });
	const trace = await getSettledTrace('task-1', 'sub-1');
	assert.ok(trace?.settled, 'kept with what the reply would have carried');
	assert.equal(trace.settled.outcome, 'failed');
	assert.equal(trace.settled.metadata.traceId, trace.id);
	assert.deepEqual((trace.settled.metadata.usage as { inputTokens: number }).inputTokens, 2000);
	assert.equal((await getSettledTrace('task-1', 'sub-2'))?.id, trace.id, 'a delivery that joined the reply finds the same trace');
	assert.equal((await getTrace('task-1', trace.id))?.spans.length, 1, 'it opens as any trace does');
	assert.equal(await getSettledTrace('task-2', 'sub-1'), null, 'only for its own task');
	await new Promise((resolve) => setTimeout(resolve, 50));
	for (let i = 0; i < 60; i += 1) await saveTrace({ ...trace, id: `other-${i}`, sessionId: 'busy', settled: undefined });
	assert.equal((await getSettledTrace('task-1', 'sub-2'))?.id, trace.id, 'read back from the database once memory has moved on');
});

test('a completed reply, or another agent’s, keeps nothing here', async () => {
	failedReply('task-3');
	keepSettledReply({ type: 'submission_settled', instanceId: 'task-3', agentName: 'Coder', submissionId: 'sub-3', outcome: 'completed' });
	keepSettledReply({ type: 'submission_settled', instanceId: 'task-3', agentName: 'Reviewer', submissionId: 'sub-4', outcome: 'failed' });
	assert.equal(await getSettledTrace('task-3', 'sub-3'), null);
	assert.equal(await getSettledTrace('task-3', 'sub-4'), null);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cacheVerdict, type ModelSpan } from '../src/core/trace.ts';
import { finishTrace, recordTraceEvent, startTrace } from '../src/services/response-trace.ts';

/** Events as the runtime sends them, which the recorder reads only in part. */
const record = (event: Record<string, unknown>) => recordTraceEvent(event as Parameters<typeof recordTraceEvent>[0]);

const usage = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({ input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite, cost: { total: 0.01 } });
const at = (ms: number) => new Date(Date.now() + ms).toISOString();
const request = (messages: unknown[], systemPrompt = 'You are Anton.') => ({
	providerId: 'openrouter',
	requestedModel: 'anthropic/claude-sonnet-5.5',
	input: { systemPrompt, messages, tools: [{ name: 'read', description: 'Read a file', parameters: {} }] },
});

test('a trace keeps each call, what it added to the context, its tools and its subagents on one clock', () => {
	const id = 'trace-task';
	const base = { instanceId: id, agentName: 'Coder', session: 'default' };
	startTrace(id);
	const first = [{ role: 'user', content: 'Fix the login bug.' }];
	record({ ...base, type: 'turn_request', turnId: 't1', purpose: 'agent', request: request(first), timestamp: at(0) });
	record({
		...base,
		type: 'turn',
		turnId: 't1',
		purpose: 'agent',
		durationMs: 1200,
		timestamp: at(1200),
		request: { providerId: 'openrouter', requestedModel: 'anthropic/claude-sonnet-5.5' },
		response: { usage: usage(2000, 80, 0, 1800), output: { content: [{ type: 'text', text: 'Looking.' }, { type: 'toolCall', id: 'c1', name: 'read', arguments: { path: 'a.ts' } }] } },
	});
	record({ ...base, type: 'tool_start', toolName: 'read', toolCallId: 'c1', args: { path: 'a.ts' }, timestamp: at(1250) });
	record({ ...base, type: 'tool', toolName: 'read', toolCallId: 'c1', isError: false, durationMs: 40, result: { content: [{ type: 'text', text: 'export const a = 1;' }] }, timestamp: at(1290) });
	record({ ...base, type: 'tool_start', toolName: 'task', toolCallId: 'c2', args: { prompt: 'Find the tests', description: 'Find tests' }, timestamp: at(1300) });
	record({ ...base, type: 'task_start', taskId: 'sub-1', prompt: 'Find the tests', agent: 'explorer', timestamp: at(1310) });
	record({ ...base, taskId: 'sub-1', session: 'x', type: 'turn_request', turnId: 's1', purpose: 'agent', request: request([{ role: 'user', content: 'Find the tests' }], 'Explore.'), timestamp: at(1320) });
	record({ ...base, taskId: 'sub-1', session: 'x', type: 'turn', turnId: 's1', purpose: 'agent', durationMs: 500, timestamp: at(1820), response: { usage: usage(300, 20) } });
	record({ ...base, type: 'task', taskId: 'sub-1', isError: false, durationMs: 600, result: 'tests/login.test.ts', timestamp: at(1910) });
	record({ ...base, type: 'tool', toolName: 'task', toolCallId: 'c2', isError: false, durationMs: 620, result: 'tests/login.test.ts', timestamp: at(1920) });
	const second = [...first, { role: 'assistant', content: [{ type: 'text', text: 'Looking.' }] }, { role: 'toolResult', toolName: 'read', content: [{ type: 'text', text: 'export const a = 1;' }] }];
	record({ ...base, type: 'turn_request', turnId: 't2', purpose: 'agent', request: request(second), timestamp: at(1930) });
	record({ ...base, type: 'turn', turnId: 't2', purpose: 'agent', durationMs: 900, timestamp: at(2830), response: { usage: usage(150, 60, 1800) } });
	// The reviewer and other tasks are not in it.
	record({ ...base, agentName: 'Reviewer', type: 'tool_start', toolName: 'read', toolCallId: 'r1', timestamp: at(2900) });
	record({ ...base, instanceId: 'other', type: 'tool_start', toolName: 'read', toolCallId: 'o1', timestamp: at(2900) });
	const trace = finishTrace(id)!;
	assert.equal(finishTrace(id), null, 'finishing ends the trace');
	assert.equal(trace.model, 'openrouter/anthropic/claude-sonnet-5.5');
	assert.deepEqual(
		trace.spans.map((span) => `${span.kind}:${span.lane}:${span.id}`),
		['model:main:t1', 'tool:main:c1', 'tool:main:c2', 'agent:sub-1:sub-1', 'model:sub-1:s1', 'model:main:t2'],
	);
	const [t1, read, , agent, , t2] = trace.spans as [ModelSpan, Extract<(typeof trace.spans)[number], { kind: 'tool' }>, unknown, Extract<(typeof trace.spans)[number], { kind: 'agent' }>, unknown, ModelSpan];
	assert.equal(t1.start >= 0 && t1.start < 100, true, 'a call starts its duration before it ended');
	assert.deepEqual(t1.added.map((message) => message.text), ['Fix the login bug.']);
	assert.deepEqual(t1.output.toolCalls, [{ id: 'c1', name: 'read' }]);
	assert.equal(Object.values(t1.parts).reduce((a, b) => a + b, 0), 3800, 'the parts add up to what the provider counted');
	assert.deepEqual(
		t2.added.map((message) => `${message.role}:${message.text}`),
		['assistant:Looking.', 'toolResult:export const a = 1;'],
		'the next call added the model’s word and the tool’s result',
	);
	assert.equal(read.output, 'export const a = 1;');
	assert.equal(read.input.includes('a.ts'), true);
	assert.deepEqual([agent.agent, agent.parent, agent.call, agent.description, agent.result], ['explorer', 'main', 'c2', 'Find tests', 'tests/login.test.ts']);
	assert.equal(t1.prompt, t2.prompt);
	assert.equal(trace.prompts[t1.prompt], 'You are Anton.');
	assert.deepEqual(cacheVerdict(t2, t1).tone, 'success');
	assert.equal(cacheVerdict(t1, null).label, 'Written');
});

test('a changed system prompt is named as the cache’s undoing', () => {
	const id = 'trace-miss';
	const base = { instanceId: id, agentName: 'Coder' };
	startTrace(id);
	record({ ...base, type: 'turn_request', turnId: 'a', purpose: 'agent', request: request([{ role: 'user', content: 'hi' }], 'One.') });
	record({ ...base, type: 'turn', turnId: 'a', purpose: 'agent', durationMs: 10, response: { usage: usage(1000, 10, 0, 1000) } });
	record({ ...base, type: 'turn_request', turnId: 'b', purpose: 'agent', request: request([{ role: 'user', content: 'hi' }], 'Two.') });
	record({ ...base, type: 'turn', turnId: 'b', purpose: 'agent', durationMs: 10, response: { usage: usage(1000, 10) } });
	record({ ...base, type: 'tool_start', toolName: 'bash', toolCallId: 'left-open' });
	const [a, b, open] = finishTrace(id)!.spans as [ModelSpan, ModelSpan, { error: string | null }];
	const verdict = cacheVerdict(b, a);
	assert.equal(verdict.label, 'Miss');
	assert.match(verdict.why, /system prompt changed/);
	assert.match(open.error ?? '', /Unfinished/, 'a call the reply never closed ends with it');
});

test('a reply whose start was not seen has no trace', () => {
	record({ type: 'tool_start', instanceId: 'unseen', toolCallId: 'x', toolName: 'read' });
	assert.equal(finishTrace('unseen'), null);
	startTrace('quiet');
	assert.equal(finishTrace('quiet'), null, 'nor one that did nothing');
});

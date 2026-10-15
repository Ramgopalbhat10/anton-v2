import assert from 'node:assert/strict';
import { test } from 'node:test';

const { agentNow, detailOf, recordAgentNow } = await import('../src/services/agent-now.ts');
const { onChange } = await import('../src/core/changes.ts');

const main = { instanceId: 'task-1' };
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('what the agent does between whole steps: thinking, writing a file as it streams, running a tool, and nothing once it settles', async () => {
	const told: unknown[] = [];
	const stop = onChange((change) => change.kind === 'now' && told.push(change));

	recordAgentNow({ type: 'turn_request', ...main, purpose: 'agent', timestamp: '2026-10-15T07:00:00.000Z' });
	assert.deepEqual(agentNow('task-1'), { what: 'thinking', tool: null, detail: null, chars: 0, since: '2026-10-15T07:00:00.000Z' });

	// The model writes a file: its path is read from the input's start, and the size grows as it comes.
	recordAgentNow({ type: 'toolcall_delta', ...main, toolCallId: 'c1', toolName: 'write', argumentTextDelta: '{"path":"./outputs/nourish/ap', timestamp: '2026-10-15T07:00:05.000Z' });
	recordAgentNow({ type: 'toolcall_delta', ...main, toolCallId: 'c1', toolName: 'write', argumentTextDelta: 'p.js","content":"const x = 1;\\n', timestamp: '2026-10-15T07:00:06.000Z' });
	let now = agentNow('task-1');
	assert.equal(now?.what, 'writing');
	assert.equal(now?.detail, 'outputs/nourish/app.js');
	assert.equal(now?.chars, 60);
	recordAgentNow({ type: 'toolcall_delta', ...main, toolCallId: 'c1', toolName: 'write', argumentTextDelta: 'x'.repeat(4000), timestamp: '2026-10-15T07:00:30.000Z' });
	now = agentNow('task-1');
	assert.equal(now?.chars, 4060);
	assert.equal(now?.since, '2026-10-15T07:00:06.000Z', 'growth keeps the moment the file was named');

	recordAgentNow({ type: 'turn', ...main, timestamp: '2026-10-15T07:00:31.000Z' });
	recordAgentNow({ type: 'tool_start', ...main, toolCallId: 'c1', toolName: 'write', args: { path: 'outputs/nourish/app.js' }, timestamp: '2026-10-15T07:00:31.000Z' });
	assert.deepEqual(agentNow('task-1'), { what: 'running', tool: 'write', detail: 'outputs/nourish/app.js', chars: 0, since: '2026-10-15T07:00:31.000Z' });

	// A subagent's events, or the reviewer's, are not the coding agent's.
	recordAgentNow({ type: 'turn_request', instanceId: 'task-1', taskId: 'sub-1', purpose: 'agent' });
	recordAgentNow({ type: 'turn_request', instanceId: 'task-1', agentName: 'reviewer', purpose: 'agent' });
	assert.equal(agentNow('task-1')?.what, 'running');

	recordAgentNow({ type: 'tool', ...main, toolCallId: 'c1', toolName: 'write', timestamp: '2026-10-15T07:00:32.000Z' });
	assert.equal(agentNow('task-1')?.what, 'thinking', 'after a tool the model reads what came back');

	// Changes landing together are said once, with the latest.
	await wait(300);
	assert.equal(told.length, 1);
	assert.equal((told[0] as { now: { what: string } }).now.what, 'thinking');

	recordAgentNow({ type: 'submission_settled', ...main });
	assert.equal(agentNow('task-1'), null);
	await wait(300);
	assert.deepEqual(told[told.length - 1], { kind: 'now', id: 'task-1', now: null });
	stop();
});

test('a file growing is said on a slower beat than a change of step', async () => {
	const told: Array<{ now: { chars: number } | null }> = [];
	const stop = onChange((change) => change.kind === 'now' && change.id === 'task-2' && told.push(change as never));
	recordAgentNow({ type: 'toolcall_delta', instanceId: 'task-2', toolCallId: 'c', toolName: 'write', argumentTextDelta: '{"path":"a.css"' });
	await wait(300);
	assert.equal(told.length, 1);
	recordAgentNow({ type: 'toolcall_delta', instanceId: 'task-2', toolCallId: 'c', toolName: 'write', argumentTextDelta: ',"content":"body{}"' });
	await wait(300);
	assert.equal(told.length, 1, 'growth waits for its beat');
	await wait(900);
	assert.equal(told.length, 2);
	assert.equal(told[1].now?.chars, 34);
	recordAgentNow({ type: 'submission_settled', instanceId: 'task-2' });
	await wait(300);
	stop();
});

test('a compaction after the reply reads as compacting until it is done, though its summaries end one by one', () => {
	const task = { instanceId: 'task-3' };
	recordAgentNow({ type: 'turn_request', ...task, purpose: 'agent' });
	recordAgentNow({ type: 'turn', ...task, purpose: 'agent' });
	assert.equal(agentNow('task-3')?.what, 'finishing');

	// A long turn is summarised in two calls at once: its history and the turn's start.
	recordAgentNow({ type: 'compaction_start', ...task });
	recordAgentNow({ type: 'turn_request', ...task, purpose: 'compaction' });
	recordAgentNow({ type: 'turn_request', ...task, purpose: 'compaction_prefix' });
	recordAgentNow({ type: 'turn', ...task, purpose: 'compaction' });
	assert.equal(agentNow('task-3')?.what, 'compacting', 'one summary done is not the compaction done');
	recordAgentNow({ type: 'turn', ...task, purpose: 'compaction_prefix' });
	assert.equal(agentNow('task-3')?.what, 'compacting');

	recordAgentNow({ type: 'compaction', ...task });
	assert.equal(agentNow('task-3')?.what, 'finishing');
	recordAgentNow({ type: 'submission_settled', ...task });
	assert.equal(agentNow('task-3'), null);
});

test('a tool call is named by its file, the first line of its command, or its subagent', () => {
	assert.equal(detailOf('read', { path: './src/app.ts' }), 'src/app.ts');
	assert.equal(detailOf('bash', { command: 'npm test\necho done' }), 'npm test');
	assert.equal(detailOf('task', { agent: 'browser', prompt: 'Test the app' }), 'browser');
	assert.equal(detailOf('bash', undefined, '{"command":"ls -la /work'), 'ls -la /work');
	assert.equal(detailOf('write', undefined, '{"path":"a\\"b.txt"'), 'a"b.txt');
	assert.equal(detailOf('browser', { action: 'click' }), null);
});

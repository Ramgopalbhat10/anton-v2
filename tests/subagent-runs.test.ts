import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const dir = mkdtempSync(path.join(os.tmpdir(), 'anton-subagents-'));
process.env.ANTON_DATA_DIR = dir;
after(() => rmSync(dir, { recursive: true, force: true }));

const { recordSubagentEvent, resetSubagentRunsForTests, subagentRuns } = await import('../src/services/subagent-runs.ts');
const { onChange } = await import('../src/core/changes.ts');
const { getSetting } = await import('../src/db/settings.ts');

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const usage = (input: number, output: number) => ({ input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output, cost: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
const inTask = { instanceId: 'task-1', taskId: 'sub-1' };

test('a subagent run is kept from the runtime events: its brief, model, tokens, each step, what it writes, and its answer', async () => {
	const told: unknown[] = [];
	const stop = onChange((change) => told.push(change));
	recordSubagentEvent({ type: 'task_start', instanceId: 'task-1', taskId: 'sub-1', agent: 'browser', prompt: 'Count the blog posts on mrgb.in', toolCallId: 'call-9', timestamp: '2026-10-09T10:00:00.000Z' });
	recordSubagentEvent({ type: 'turn_request', ...inTask, request: { requestedModel: 'gpt-6-luna' } });
	recordSubagentEvent({ type: 'tool_start', ...inTask, toolName: 'browser', toolCallId: 't1', args: { action: 'open', url: 'mrgb.in', note: 'x'.repeat(5000) } });
	recordSubagentEvent({ type: 'turn', ...inTask, response: { usage: usage(954, 29) } });
	recordSubagentEvent({ type: 'tool', ...inTask, toolName: 'browser', toolCallId: 't1', isError: false, durationMs: 2100 });
	recordSubagentEvent({ type: 'tool_start', ...inTask, toolName: 'browser', toolCallId: 't2', args: { action: 'click', target: 'text=Blog' } });
	recordSubagentEvent({ type: 'message_end', ...inTask, message: { role: 'assistant', content: [{ type: 'text', text: 'Looking at the blog list…' }] } });
	// Events of the main conversation and of other tasks are not this run's.
	recordSubagentEvent({ type: 'tool_start', instanceId: 'task-1', toolName: 'read', toolCallId: 'main-1' });
	recordSubagentEvent({ type: 'tool_start', instanceId: 'task-2', taskId: 'sub-1', toolName: 'read', toolCallId: 'other' });
	await settle();

	let [run] = await subagentRuns('task-1');
	assert.equal(run.status, 'running');
	assert.equal(run.agent, 'browser');
	assert.equal(run.toolCallId, 'call-9');
	assert.equal(run.model, 'gpt-6-luna');
	assert.equal(run.tokens, 983);
	assert.deepEqual(run.steps.map((step) => [step.id, step.state, step.durationMs]), [['t1', 'done', 2100], ['t2', 'running', null]]);
	assert.equal((run.steps[0].input as { note: string }).note.length, 1001, 'long strings are cut');
	assert.equal(run.writing, 'Looking at the blog list…');
	assert.deepEqual(await subagentRuns('task-2'), []);

	recordSubagentEvent({ type: 'task', ...inTask, agent: 'browser', isError: false, result: 'There are 4 posts.', durationMs: 12_500 });
	await settle();
	[run] = await subagentRuns('task-1');
	assert.equal(run.status, 'done');
	assert.equal(run.result, 'There are 4 posts.');
	assert.equal(run.durationMs, 12_500);
	assert.equal(run.writing, null);
	assert.equal(run.steps[1].state, 'done', 'a step left open ends with the run');

	await new Promise((resolve) => setTimeout(resolve, 450));
	assert.ok(told.some((change) => JSON.stringify(change) === JSON.stringify({ kind: 'task', id: 'task-1', what: 'subagents' })), 'open pages are told');
	stop();
	const saved = await getSetting<Array<{ id: string; status: string }>>('subagents.task-1', []);
	assert.deepEqual(saved.map((entry) => [entry.id, entry.status]), [['sub-1', 'done']], 'a finished run is saved at once');

	// After a restart the record comes back from storage.
	resetSubagentRunsForTests();
	assert.equal((await subagentRuns('task-1'))[0].result, 'There are 4 posts.');
});

test('runs are listed newest first, and a failed run keeps why', async () => {
	recordSubagentEvent({ type: 'task_start', instanceId: 'task-3', taskId: 'a', agent: 'explorer', prompt: 'Map the code' });
	recordSubagentEvent({ type: 'task_start', instanceId: 'task-3', taskId: 'b', agent: 'tester', prompt: 'Run the tests' });
	recordSubagentEvent({ type: 'task', instanceId: 'task-3', taskId: 'b', isError: true, result: 'npm test exited 1', durationMs: 900 });
	await settle();
	const list = await subagentRuns('task-3');
	assert.deepEqual(list.map((run) => [run.id, run.status, run.result]), [['b', 'failed', 'npm test exited 1'], ['a', 'running', null]]);
});

test('what a tool did inside a step is kept on that step, even when it says so before the step is recorded', async () => {
	resetSubagentRunsForTests();
	const { noteStep } = await import('../src/services/subagent-runs.ts');
	const at = { instanceId: 'task-n', taskId: 'sub-n' };
	recordSubagentEvent({ type: 'task_start', ...at, agent: 'browser', prompt: 'Fill the form' });
	await settle();
	// The tool runs before its start event is recorded, and tells its first action then.
	await noteStep('task-n', 'd1', { outcome: null, actions: [{ what: 'Typed name into textbox "Name"', p: 0.99 }], decisions: 1, cost: 0.0001 });
	recordSubagentEvent({ type: 'tool_start', ...at, toolName: 'browser', toolCallId: 'd1', args: { action: 'do', goal: 'Fill the form' } });
	await settle();
	let [run] = await subagentRuns('task-n');
	assert.equal(run.steps[0].detail?.actions.length, 1);
	await noteStep('task-n', 'd1', { outcome: 'needs_confirmation', actions: [{ what: 'Typed name into textbox "Name"', p: 0.99 }, { what: 'x'.repeat(500), p: null }], decisions: 3, cost: 0.0003 });
	[run] = await subagentRuns('task-n');
	assert.equal(run.steps[0].detail?.outcome, 'needs_confirmation');
	assert.equal(run.steps[0].detail?.decisions, 3);
	assert.equal(run.steps[0].detail?.actions[1].what.length, 300);
});

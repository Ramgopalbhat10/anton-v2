import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const dir = mkdtempSync(path.join(os.tmpdir(), 'anton-send-backs-'));
process.env.ANTON_DATA_DIR = dir;
after(() => rmSync(dir, { recursive: true, force: true }));

const { lastSendBack, noteSendBack, sendBacksOf, settleSendBacks, startSendBacks } = await import('../src/services/send-backs.ts');
const { recordReplyText } = await import('../src/services/reply-check.ts');
const { loadGate, restartGates } = await import('../src/services/gate-state.ts');
const { insertSession } = await import('../src/db/sessions.ts');
const { upsertProject } = await import('../src/db/projects.ts');

const project = await upsertProject('acme/demo', 'main');
await insertSession({ id: 's2', projectId: project.id, title: 'T', model: 'x', reasoning: null, branch: 'main', baseBranch: 'main', baseSha: 'abc', planMode: false });

const say = (id: string, text: string) => recordReplyText({ type: 'message_end', instanceId: id, agentName: 'Coder', message: { role: 'assistant', content: [{ type: 'text', text }] } } as never);

test('each send-back is marked with whether the agent then changed a file or ran anything', () => {
	startSendBacks('s1');
	const calls = [{ tool: 'read' }, { tool: 'bash' }];
	noteSendBack('s1', 'todo', calls.length, 'Update your todo list.');
	// The agent only talked and updated its list after it.
	calls.push({ tool: 'update_todos' });
	settleSendBacks('s1', calls);
	noteSendBack('s1', 'review', calls.length, 'A reviewer thinks...');
	calls.push({ tool: 'apply_patch' }, { tool: 'bash' });
	noteSendBack('s1', 'check', calls.length, 'The check fails.');
	calls.push({ tool: 'bash' });
	settleSendBacks('s1', calls);
	assert.deepEqual(sendBacksOf('s1'), [
		{ gate: 'todo', changed: false, worked: false },
		{ gate: 'review', changed: true, worked: true },
		{ gate: 'check', changed: false, worked: true },
	]);
	// A new reply starts with none.
	startSendBacks('s1');
	assert.deepEqual(sendBacksOf('s1'), []);
});

test('a review’s send-back keeps its points and what the reply had reported before it, across a restart', async () => {
	// The Coder reads the task's row as it renders, before any check runs.
	await loadGate('s2');
	startSendBacks('s2');
	say('s2', 'All three changes are in place, each with a test, and the type check passes. '.repeat(3));
	noteSendBack('s2', 'review', 4, 'A reviewer who read only the request and your diff thinks the change misses these points:\n\n- x');
	await restartGates();
	await loadGate('s2');
	const last = lastSendBack('s2');
	assert.equal(last?.gate, 'review');
	assert.match(last?.points ?? '', /misses these points/);
	assert.match(last?.before ?? '', /All three changes are in place/);
});

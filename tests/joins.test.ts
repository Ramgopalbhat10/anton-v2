import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const dir = mkdtempSync(path.join(os.tmpdir(), 'anton-joins-'));
process.env.ANTON_DATA_DIR = dir;
after(() => rmSync(dir, { recursive: true, force: true }));

const { joinsFor, noteDelivery, recordJoinEvent } = await import('../src/services/joins.ts');
const { upsertProject } = await import('../src/db/projects.ts');
const { insertSession } = await import('../src/db/sessions.ts');

const project = await upsertProject('acme/demo', 'main');
await insertSession({ id: 't', projectId: project.id, title: 'T', model: 'x', reasoning: null, branch: 'main', baseBranch: 'main', baseSha: 'abc', planMode: false });

test('a message that starts a reply is not a join', async () => {
	await noteDelivery('t', 'Build it');
	assert.deepEqual(await joinsFor('t'), []);
});

test('a message given mid-reply is noted after the tool call the agent last started, and after its last words when it had said them', async () => {
	recordJoinEvent({ type: 'tool_start', instanceId: 't', toolCallId: 'call-1' });
	// A subagent's own calls are not the reply's.
	recordJoinEvent({ type: 'tool_start', instanceId: 't', taskId: 'sub', toolCallId: 'sub-call' });
	await noteDelivery('t', '  Why is it taking so long?  ', new Date('2026-10-16T14:00:00Z'));
	recordJoinEvent({ type: 'message_end', instanceId: 't', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } });
	await noteDelivery('t', 'And the docs?', new Date('2026-10-16T14:01:00Z'));
	assert.deepEqual(await joinsFor('t'), [
		{ text: 'Why is it taking so long?', afterTool: 'call-1', final: false, at: '2026-10-16T14:00:00.000Z' },
		{ text: 'And the docs?', afterTool: 'call-1', final: true, at: '2026-10-16T14:01:00.000Z' },
	]);
	// Once the reply settles, the next message starts a reply of its own.
	recordJoinEvent({ type: 'submission_settled', instanceId: 't' });
	await noteDelivery('t', 'Next');
	assert.equal((await joinsFor('t')).length, 2);
});

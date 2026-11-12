import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const dir = mkdtempSync(path.join(os.tmpdir(), 'anton-compaction-pin-'));
process.env.ANTON_DATA_DIR = dir;
after(() => rmSync(dir, { recursive: true, force: true }));

const { noteCompaction, pinnedMessage, takePinned } = await import('../src/services/compaction-pin.ts');
const { changeTodos, writeTodos } = await import('../src/services/todos.ts');
const { noteRequest } = await import('../src/services/finish-review.ts');
const { gate, loadGate } = await import('../src/services/gate-state.ts');
const { upsertProject } = await import('../src/db/projects.ts');
const { insertSession } = await import('../src/db/sessions.ts');

const project = await upsertProject('acme/demo', 'main');
async function task(id: string): Promise<string> {
	await insertSession({ id, projectId: project.id, title: 'T', model: 'x', reasoning: null, branch: 'main', baseBranch: 'main', baseSha: 'abc', planMode: false });
	await loadGate(id);
	return id;
}

/** The runtime's event for a compaction of the Coder's main conversation, as the app's observer sees it. */
const compacted = (instanceId: string, extra: Record<string, unknown> = {}) => ({ type: 'compaction', isError: false, instanceId, agentName: 'Coder', session: 'default', ...extra });

const REQUEST = 'Add `--dry-run` to `deploy()` in src/cli.ts: print "Would deploy <name>" and exit 0, and keep `--force` as it is.';

test('the message carries the request and the list word for word, numbered as changes counts them', () => {
	const message = pinnedMessage(REQUEST, [
		{ content: 'Read the deploy command', status: 'completed', evidence: 'read src/cli.ts lines 1-80' },
		{ content: 'Add --dry-run', status: 'in_progress' },
		{ content: 'Run the CLI tests', status: 'pending' },
	]);
	assert.equal(
		message,
		[
			'The conversation was just compacted: its older turns are now a summary. What follows is not summarized but exact, as it is kept.',
			`The request you are working on:\n<request>\n${REQUEST}\n</request>`,
			[
				'Your todo list as saved, numbered as update_todos counts items in changes:',
				'1. Read the deploy command (completed; evidence: read src/cli.ts lines 1-80)',
				'2. Add --dry-run (in_progress)',
				'3. Run the CLI tests (pending)',
			].join('\n'),
			'Go on from where the summary says you were.',
		].join('\n\n'),
	);
});

test('a long request is cut where the agent’s own check cuts it, with a note; either part alone, and neither is nothing', () => {
	const long = `${'a'.repeat(12_000)}THE END`;
	const message = pinnedMessage(long, undefined)!;
	assert.ok(message.includes(`<request>\n${'a'.repeat(12_000)}\n[The request goes on past this point; only its start is repeated here.]\n</request>`));
	assert.ok(!message.includes('THE END'));
	assert.ok(!message.includes('todo list'));
	const exact = 'b'.repeat(12_000);
	assert.ok(pinnedMessage(exact, [])!.includes(`<request>\n${exact}\n</request>`), 'a request at the bound is whole');

	const list = pinnedMessage(undefined, [{ content: 'Fix it', status: 'pending' }])!;
	assert.ok(!list.includes('<request>'));
	assert.ok(list.includes('1. Fix it (pending)'));
	assert.equal(pinnedMessage(undefined, []), null);
	assert.equal(pinnedMessage('   ', undefined), null);
});

test('after a compaction the next send-back gets the request and the saved list once, and nothing more until the next compaction', async () => {
	const id = await task('pin-once');
	noteRequest(id, REQUEST);
	await writeTodos(id, [
		{ content: 'Read the deploy command', status: 'in_progress' },
		{ content: 'Add --dry-run', status: 'pending' },
	]);
	await changeTodos(id, [{ item: 1, status: 'completed', evidence: 'read it' }, { item: 2, status: 'in_progress' }]);
	assert.equal(await takePinned(id), null, 'no compaction, no message');

	noteCompaction(compacted(id));
	assert.equal(gate(id).compacted, true);
	const message = await takePinned(id);
	assert.ok(message?.includes(`<request>\n${REQUEST}\n</request>`));
	assert.ok(message?.includes('1. Read the deploy command (completed; evidence: read it)\n2. Add --dry-run (in_progress)'));
	assert.equal(await takePinned(id), null, 'once per compaction');

	// Two compactions before the agent's next step get one message, after both.
	noteCompaction(compacted(id));
	noteCompaction(compacted(id));
	assert.ok(await takePinned(id));
	assert.equal(await takePinned(id), null);
});

test('a reply started by a message gets the list alone, since the message is the request and sits word for word after the summary', async () => {
	const id = await task('pin-start');
	noteRequest(id, REQUEST);
	await writeTodos(id, [{ content: 'Add --dry-run', status: 'in_progress' }]);
	noteCompaction(compacted(id));
	const message = await takePinned(id, { request: false });
	assert.ok(message && !message.includes('<request>'));
	assert.ok(message.includes('1. Add --dry-run (in_progress)'));
});

test('a task with neither a request kept nor a list gets nothing, and its compaction is spent', async () => {
	const id = await task('pin-none');
	noteCompaction(compacted(id));
	assert.equal(await takePinned(id), null);
	await writeTodos(id, [{ content: 'Later', status: 'pending' }]);
	assert.equal(await takePinned(id), null, 'the compaction was answered already');
});

test('only a finished compaction of the Coder’s main conversation counts: not a failed one, other events, a subagent’s, the reviewer’s or an incognito chat’s', async () => {
	const id = await task('pin-other');
	noteRequest(id, REQUEST);
	for (const event of [
		compacted(id, { isError: true }),
		compacted(id, { type: 'compaction_start' }),
		compacted(id, { type: 'turn' }),
		compacted(id, { taskId: 'task-1' }),
		compacted(id, { session: 'task:explorer:1' }),
		compacted(id, { agentName: 'reviewer' }),
		compacted(id, { instanceId: undefined }),
	]) {
		noteCompaction(event);
		assert.equal(gate(id).compacted, undefined, JSON.stringify(event));
	}
	assert.equal(await takePinned(id), null);

	const incognito = 'inco_00000000-0000-0000-0000-000000000000';
	noteCompaction(compacted(incognito));
	assert.equal(gate(incognito).compacted, undefined, 'an incognito chat keeps nothing');
});

test('the Coder pins the message with every send-back and at the next message’s start, never on its own, and only in its main conversation', () => {
	const source = readFileSync(new URL('../src/agents/coder.ts', import.meta.url), 'utf8');
	const gates = source.slice(source.indexOf('useAgentFinish(async'), source.indexOf('queueCheckpoint(id);\n\t\t\t// What the reply leaves'));
	// Every gate sends the reply back through sendBack, which puts the message first; no gate appends on its own.
	assert.equal((gates.match(/await sendBack\(/g) ?? []).length, 6);
	assert.equal((gates.match(/append\(/g) ?? []).length, 2);
	assert.match(gates, /const pinned = await takePinned\(id\);\n\t\t\t\tif \(pinned\) append\(\{ kind: 'signal', type: 'reminder', body: pinned \}\);\n\t\t\t\tappend\(\{ kind: 'signal', type: 'reminder', body \}\);/);
	// A reply that ends with nothing to send back appends nothing: the message waits for the next start.
	assert.match(source, /useAgentStart\(async \(\{ append \}\) => \{\n\t\t\tconst pinned = await takePinned\(id, \{ request: delivery\.kind !== 'user' \}\);/);
	// In the Coder's non-incognito hooks only: subagents run no hooks of the Coder's.
	const hooks = source.slice(source.indexOf('\tif (!incognito) {\n\t\t// What the checks at a reply'), source.indexOf('\tif (incognito) {\n\t\t// An incognito reply keeps only'));
	assert.equal((source.match(/takePinned\(/g) ?? []).length, (hooks.match(/takePinned\(/g) ?? []).length);
	assert.equal((source.match(/takePinned\(/g) ?? []).length, 2);
	// The app notes compactions from the runtime's events.
	assert.match(readFileSync(new URL('../src/app.ts', import.meta.url), 'utf8'), /noteCompaction\(event as Parameters<typeof noteCompaction>\[0\]\);/);
});

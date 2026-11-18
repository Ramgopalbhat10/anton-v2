import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const dir = mkdtempSync(path.join(os.tmpdir(), 'anton-push-gate-'));
process.env.ANTON_DATA_DIR = dir;
after(() => rmSync(dir, { recursive: true, force: true }));

const { openedThisReply, pushGate, queuePullRequest, startPushGate } = await import('../src/services/replies/push-gate.ts');
const { gate, loadGate, restartGates } = await import('../src/services/replies/gate-state.ts');
const { InvalidInputError } = await import('../src/core/errors.ts');
const { insertSession } = await import('../src/db/sessions.ts');
const { upsertProject } = await import('../src/db/projects.ts');

const project = await upsertProject('acme/demo', 'main');
for (const id of ['p1', 'p2', 'p3', 'p4'])
	await insertSession({ id, projectId: project.id, title: 'T', model: 'x', reasoning: null, branch: `anton/${id}`, baseBranch: 'main', baseSha: 'abc', planMode: false });

function fakeHost(failures: Error[] = []) {
	const calls = { prepared: 0, pushed: [] as Array<{ title: string; body: string }>, failed: [] as Array<string | null> };
	return {
		calls,
		deps: {
			prepare: async () => {
				calls.prepared += 1;
			},
			open: async (_id: string, input: { title: string; body: string }) => {
				const failure = failures.shift();
				if (failure) throw failure;
				calls.pushed.push(input);
				return 'https://github.com/acme/demo/pull/9';
			},
			fail: async (_id: string, message: string | null) => {
				calls.failed.push(message);
			},
		},
	};
}

test('open_pull_request only commits; the branch is pushed once, when the reply ends, with the latest title', async () => {
	const host = fakeHost();
	startPushGate('p1');
	assert.match(await queuePullRequest('p1', { title: 'First', body: 'a' }, host.deps), /when your reply ends/);
	assert.match(await queuePullRequest('p1', { title: 'Restore the icon', body: 'b' }, host.deps), /title and description replaced/);
	assert.equal(host.calls.prepared, 2);
	assert.equal(host.calls.pushed.length, 0, 'nothing is pushed while the reply runs');
	assert.equal(await pushGate('p1', host.deps), null);
	assert.deepEqual(host.calls.pushed, [{ title: 'Restore the icon', body: 'b' }]);
	assert.deepEqual(openedThisReply('p1'), { url: 'https://github.com/acme/demo/pull/9', title: 'Restore the icon' });
	// Ending again pushes nothing more.
	assert.equal(await pushGate('p1', host.deps), null);
	assert.equal(host.calls.pushed.length, 1);
	startPushGate('p1');
	assert.equal(openedThisReply('p1'), undefined);
});

test('a reply that queued no pull request pushes nothing', async () => {
	const host = fakeHost();
	startPushGate('p2');
	assert.equal(await pushGate('p2', host.deps), null);
	assert.equal(host.calls.pushed.length, 0);
});

test('a failed push goes back to the agent, then to the user, and stays queued for the next reply', async () => {
	const host = fakeHost([new InvalidInputError('Resolve the merge conflicts first'), new Error('GitHub is down'), new Error('GitHub is down')]);
	startPushGate('p3');
	await queuePullRequest('p3', { title: 'Fix', body: '' }, host.deps);
	assert.match((await pushGate('p3', host.deps)) ?? '', /could not push[\s\S]*merge conflicts/);
	assert.match((await pushGate('p3', host.deps)) ?? '', /GitHub is down/);
	assert.equal(await pushGate('p3', host.deps), null, 'past two tries the reply ends');
	assert.deepEqual(host.calls.failed, ['The pull request could not be pushed: GitHub is down']);
	await restartGates();
	await loadGate('p3');
	assert.deepEqual(gate('p3').pullRequest, { title: 'Fix', body: '' }, 'kept across a restart');
	startPushGate('p3');
	assert.equal(await pushGate('p3', host.deps), null);
	assert.equal(host.calls.pushed.length, 1);
	assert.equal(gate('p3').pullRequest, undefined);
	assert.deepEqual(host.calls.failed, ['The pull request could not be pushed: GitHub is down', null], 'the error is cleared once it goes through');
});

test('nothing left to push settles the queue without sending the reply back', async () => {
	const host = fakeHost([new InvalidInputError('There are no changes to open a pull request with.')]);
	startPushGate('p4');
	await queuePullRequest('p4', { title: 'Fix', body: '' }, host.deps);
	assert.equal(await pushGate('p4', host.deps), null);
	assert.equal(gate('p4').pullRequest, undefined);
});

test('the Coder pushes after every other check at the reply end and puts the pull request on the reply', () => {
	const source = readFileSync(new URL('../src/agents/coder/index.ts', import.meta.url), 'utf8');
	const completion = source.indexOf("await sendBack('completion', undone);");
	const push = source.indexOf('await pushGate(id)');
	assert.ok(completion > 0 && push > completion, 'the push comes after the completion gate');
	assert.match(source, /startPushGate\(id\);/);
	assert.match(source, /pullRequest \? \{ pullRequest \} : \{\}/);
	const tool = readFileSync(new URL('../src/agents/coder/tools/git.ts', import.meta.url), 'utf8');
	assert.match(tool, /queuePullRequest\(id, data\)/);
	assert.doesNotMatch(tool, /openPullRequest\(/);
});

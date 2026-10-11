import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { createClient } from '@libsql/client';
import type { GitHost, ModelCatalog, ModelInfo } from '../src/core/ports.ts';

const dir = mkdtempSync(path.join(os.tmpdir(), 'anton-spaces-'));
process.env.ANTON_DATA_DIR = path.join(dir, 'data');
after(() => rmSync(dir, { recursive: true, force: true }));

const fakeHost = {
	name: 'fake',
	getRepo: async (fullName: string) => ({ fullName, defaultBranch: 'main', private: false }),
	listBranches: async () => ['main'],
	resolveRef: async () => 'sha-main',
	tree: async () => ['README.md'],
	file: async () => new TextEncoder().encode('# demo\n'),
	cloneUrl: () => '',
	gitAuthEnv: () => ({}),
	accountName: async () => 'Ada Lovelace',
	listRepos: async () => ['acme/api', 'acme/web'],
	searchRepos: async () => [],
	searchFiles: async () => [],
} as unknown as GitHost;

const model = (id: string): ModelInfo => ({
	id,
	name: id,
	vendor: 'Test',
	description: '',
	createdAt: 0,
	contextLength: 128_000,
	maxOutput: null,
	price: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	vision: false,
	reasoning: ['low', 'high'],
	defaultReasoning: 'high',
});
const fakeCatalog: ModelCatalog = { name: 'fake', list: async () => [model('openrouter/test/cheap'), model('openrouter/test/strong')] };

const { useDatabase } = await import('../src/db/client.ts');
const { setProviders } = await import('../src/providers/index.ts');
const { diskStore } = await import('../src/providers/disk/store.ts');
const { localSandboxProvider } = await import('../src/providers/local/sandbox.ts');
const { addProject } = await import('../src/services/projects.ts');
const { setAgentDelivery } = await import('../src/services/agent-runner.ts');
const spaces = await import('../src/services/spaces.ts');
const reports = await import('../src/services/thread-reports.ts');
const files = await import('../src/services/space-files.ts');
const { stateBlock } = await import('../src/services/coordinator.ts');
const sessions = await import('../src/services/sessions.ts');
const { updateSession, getSessionRecord } = await import('../src/db/sessions.ts');

useDatabase(createClient({ url: `file:${path.join(dir, 'anton.db')}` }));
setProviders({ sandbox: localSandboxProvider(path.join(dir, 'data')), store: diskStore(path.join(dir, 'data', 'objects')), git: fakeHost, models: fakeCatalog });

/** Messages Anton sent to threads' agents, and to coordinators. */
const toThreads: Array<{ id: string; text: string }> = [];
const toCoordinator: Array<{ id: string; text: string }> = [];
setAgentDelivery(async (id, text) => void toThreads.push({ id, text }));
setAgentDelivery(async (id, text) => void toCoordinator.push({ id, text }), 'coordinator');

beforeEach(() => {
	toThreads.length = 0;
	toCoordinator.length = 0;
});

const api = await addProject('acme/api');
const web = await addProject('acme/web');

test('a project needs a name and a known repository', async () => {
	await assert.rejects(() => spaces.createSpace({ name: ' ', repoIds: [api.id] }), /Name the project/);
	await assert.rejects(() => spaces.createSpace({ name: 'Nothing', repoIds: ['proj_missing'] }), /repository/);
	const space = await spaces.createSpace({ name: 'Billing', goal: 'Ship billing v2', repoIds: [api.id] });
	assert.equal(space.maxParallel, 3);
	assert.equal(space.autonomy, 'start');
	assert.deepEqual(
		space.repos.map((repo) => repo.repoFullName),
		['acme/api'],
	);
	const edited = await spaces.editSpace(space.id, { repoIds: [api.id, web.id], coordinatorModel: 'openrouter/test/cheap' });
	assert.equal(edited.repos.length, 2);
	await assert.rejects(() => spaces.editSpace(space.id, { coordinatorModel: 'openrouter/none/such' }), /Unknown model/);
	await assert.rejects(() => spaces.editSpace(space.id, { repoIds: [] }), /repository/);
});

test('threads beyond the limit queue, and start as others finish', async () => {
	const space = await spaces.createSpace({ name: 'Parallel', repoIds: [api.id, web.id], maxParallel: 2 });
	const one = await spaces.startThread(space.id, { title: 'Schema', brief: 'Add the invoices table' });
	const two = await spaces.startThread(space.id, { title: 'API', brief: 'Add the invoices endpoint', repo: 'web' });
	const three = await spaces.startThread(space.id, { title: 'Docs', brief: 'Document invoices' });
	assert.equal(two.repo, 'acme/web', 'a repository named by its short name');
	assert.deepEqual(
		toThreads.map((sent) => sent.text),
		['Add the invoices table', 'Add the invoices endpoint'],
	);
	assert.equal(three.threadState, 'queued');
	assert.equal(three.brief, 'Document invoices');

	// A note to a queued thread joins its brief rather than starting it.
	await spaces.nudgeThread(space.id, three.id, 'Use the README style');
	assert.equal(toThreads.length, 2);

	await reports.threadFinished(one.id, 'Added the table.');
	assert.equal(toThreads.length, 3);
	assert.equal(toThreads[2].id, three.id);
	assert.equal(toThreads[2].text, 'Document invoices\n\nUse the README style');
	const started = await sessions.getSession(three.id);
	assert.equal(started.brief, null);
	assert.equal((await sessions.getSession(one.id)).lastReply, 'Added the table.');
});

test('a paused project queues threads until it is active again', async () => {
	const space = await spaces.createSpace({ name: 'Paused', repoIds: [api.id] });
	await spaces.editSpace(space.id, { state: 'paused' });
	const thread = await spaces.startThread(space.id, { title: 'Later', brief: 'Wait for me' });
	assert.equal(thread.threadState, 'queued');
	assert.equal(toThreads.length, 0);
	await spaces.editSpace(space.id, { state: 'active' });
	assert.deepEqual(toThreads, [{ id: thread.id, text: 'Wait for me' }]);
	await spaces.editSpace(space.id, { state: 'archived' });
	await assert.rejects(() => spaces.startThread(space.id, { title: 'No', brief: 'Nope' }), /archived/);
});

test('reports reach the coordinator once per change of state, batched', async () => {
	const space = await spaces.createSpace({ name: 'Reports', repoIds: [api.id] });
	const ask = await spaces.startThread(space.id, { title: 'Pick a name', brief: 'Name the module' });
	const done = await spaces.startThread(space.id, { title: 'Tidy', brief: 'Tidy the code' });
	await updateSession(ask.id, { asking: 'Should it be billing or invoices?' });
	await reports.threadFinished(ask.id, 'Should it be billing or invoices?');
	await reports.threadFinished(done.id, 'Tidied.');
	await reports.flushReports();
	// Reports from earlier tests' projects go out in the same flush; only this project's count here.
	const mine = () => toCoordinator.filter((sent) => sent.id === space.id);
	assert.equal(mine().length, 1, 'one message for both threads');
	const [message] = mine();
	assert.equal(message.id, space.id);
	assert.match(message.text, /^<thread-reports>/);
	assert.match(message.text, /title="Pick a name" state="waiting" asks="Should it be billing or invoices\?"/);
	assert.match(message.text, /title="Tidy" state="idle">Tidied\.<\/thread>/);

	// Nothing new: no second report.
	await reports.threadChanged(done.id, 5);
	await reports.flushReports();
	assert.equal(mine().length, 1);

	// A merged pull request resolves the thread and is reported.
	await updateSession(done.id, { prUrl: 'https://github.com/acme/api/pull/7', pullRequestJson: JSON.stringify({ url: 'https://github.com/acme/api/pull/7', state: 'merged', checks: 'passed', runs: [] }) });
	await reports.threadChanged(done.id, 5);
	await reports.flushReports();
	assert.equal(mine().length, 2);
	assert.match(mine()[1].text, /state="resolved" pr="#7 merged, checks passed"/);
	assert.ok((await getSessionRecord(done.id))?.resolvedAt);
});

test('the coordinator reads the project, its threads and what they ask', async () => {
	const space = await spaces.createSpace({ name: 'State', goal: 'Keep it green', repoIds: [api.id], instructions: 'Small PRs.' });
	const thread = await spaces.startThread(space.id, { title: 'Fix CI', brief: 'Make the build pass' });
	await updateSession(thread.id, { asking: 'Can I skip the flaky test?' });
	const block = await stateBlock(space.id);
	assert.match(block, /Keep it green/);
	assert.match(block, /Small PRs\./);
	assert.match(block, new RegExp(`\\[${thread.id.slice(0, 8)}\\] "Fix CI"`));
	assert.match(block, /Can I skip the flaky test\?/);
	assert.equal((await spaces.findThread(space.id, thread.id.slice(0, 8))).id, thread.id);
	assert.equal((await spaces.findThread(space.id, 'fix ci')).id, thread.id);
	await assert.rejects(() => spaces.findThread(space.id, 'nope'), /No thread/);
});

test('tasks move into and out of a project, and deleting it keeps its threads', async () => {
	const space = await spaces.createSpace({ name: 'Moves', repoIds: [api.id] });
	const task = await sessions.createSession({ projectId: web.id, title: 'Loose task' });
	const moved = await spaces.moveToSpace(task.id, space.id);
	assert.equal(moved.spaceId, space.id);
	assert.equal(moved.threadState, 'idle');
	assert.ok((await spaces.spaceView(space.id)).repoIds.includes(web.id), 'its repository joins the project');
	await spaces.removeSpace(space.id);
	const kept = await sessions.getSession(task.id);
	assert.equal(kept.spaceId, null);
	assert.equal(kept.threadState, null);
});

test('idle threads resolve after a week, and project files reach every thread', async () => {
	const space = await spaces.createSpace({ name: 'Files', repoIds: [api.id] });
	const thread = await spaces.startThread(space.id, { title: 'Read the spec', brief: 'Read it' });
	await reports.threadFinished(thread.id, 'Read.');
	assert.equal(await reports.resolveIdleThreads(Date.now()), 0);
	assert.ok((await reports.resolveIdleThreads(Date.now() + reports.IDLE_RESOLVE_MS + 60_000)) >= 1);
	assert.equal((await sessions.getSession(thread.id)).threadState, 'resolved');

	await files.uploadSpaceFile(space.id, 'spec.md', new TextEncoder().encode('# Spec\nInvoices are monthly.\n'));
	assert.deepEqual(
		(await files.listSpaceFiles(space.id)).map((file) => file.path),
		['spec.md'],
	);
	assert.match(await files.readProjectFileForAgent(thread.id), /spec\.md/);
	assert.match(await files.readProjectFileForAgent(thread.id, 'spec.md'), /Invoices are monthly/);
	await assert.rejects(() => files.readSpaceFile(space.id, '../escape'));
	await files.removeSpaceFile(space.id, 'spec.md');
	assert.deepEqual(await files.listSpaceFiles(space.id), []);
});

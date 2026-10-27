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
const automations = await import('../src/services/automations.ts');
/** A routine's schedule in the tests: every day at 9:00 on the UTC clock. */
const DAILY = { frequency: 'daily', time: '09:00', timeZone: 'UTC' } as const;

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

test('a project needs a name, and only known repositories', async () => {
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
	await assert.rejects(() => spaces.editSpace(space.id, { repoIds: ['proj_missing'] }), /repository/);
	assert.deepEqual((await spaces.editSpace(space.id, { repoIds: [] })).repos, [], 'the last repository can be removed');
});

test('a project without repositories starts its threads as chats', async () => {
	const space = await spaces.createSpace({ name: 'Research', goal: 'Compare vendors' });
	assert.deepEqual(space.repos, []);
	const thread = await spaces.startThread(space.id, { title: 'Pricing', brief: 'Compare the pricing pages', planMode: true });
	assert.equal(thread.projectId, null);
	assert.equal(thread.repo, '');
	assert.equal(thread.spaceId, space.id);
	assert.equal(thread.planMode, false, 'a chat has no code to plan');
	assert.deepEqual(toThreads, [{ id: thread.id, text: 'Compare the pricing pages' }]);
	await assert.rejects(() => spaces.startThread(space.id, { title: 'No', brief: 'Fix the API', repo: 'acme/api' }), /not one of this project's repositories/);
	const block = await stateBlock(space.id);
	assert.match(block, /Repositories: none/);
	assert.match(block, /"Pricing" · no repository · /);

	// A repository added later is where new threads start; a thread can still ask for none.
	await spaces.editSpace(space.id, { repoIds: [api.id] });
	assert.equal((await spaces.startThread(space.id, { title: 'Fix', brief: 'Fix the API' })).repo, 'acme/api');
	assert.equal((await spaces.startThread(space.id, { title: 'Read', brief: 'Read the docs', repo: 'none' })).projectId, null);
	assert.equal((await spaces.startThread(space.id, { title: 'Ask', brief: 'Ask around', projectId: null })).projectId, null);

	// A chat can join a project as a thread, and stays a chat.
	const chat = await sessions.createSession({ title: 'Loose chat' });
	const moved = await spaces.moveToSpace(chat.id, space.id);
	assert.equal(moved.spaceId, space.id);
	assert.equal(moved.projectId, null);
	assert.deepEqual((await spaces.spaceView(space.id)).repoIds, [api.id]);
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

test('a thread you start is reported as it starts, with its brief, and again when it replies', async () => {
	const space = await spaces.createSpace({ name: 'Yours', repoIds: [api.id] });
	const thread = await spaces.startThread(space.id, { title: 'API keys', brief: 'Add API key auth <for> third-party apps.' });
	await reports.threadStarted(thread.id, { by: 'you', brief: 'Add API key auth <for> third-party apps.' });
	await reports.flushReports();
	const mine = () => toCoordinator.filter((sent) => sent.id === space.id);
	assert.equal(mine().length, 1, 'the coordinator hears of it at once, before it replies');
	assert.match(mine()[0].text, new RegExp(`<thread id="${thread.id.slice(0, 8)}" title="API keys" state="\\w+" started="you">Add API key auth &lt;for> third-party apps\\.</thread>`));
	// Its first reply is news, as for any thread.
	await reports.threadFinished(thread.id, 'Which routes should the keys reach?');
	await reports.flushReports();
	assert.equal(mine().length, 2);
	assert.doesNotMatch(mine()[1].text, /started=/);
});

test('a project without repositories runs routines on a schedule, starting chats', async () => {
	const space = await spaces.createSpace({ name: 'Digest', goal: 'A weekly digest' });
	await assert.rejects(() => automations.addAutomation(null, { kind: 'schedule', schedule: DAILY, prompt: 'Summarize the news.' }), /repository/);
	await assert.rejects(() => automations.addAutomation(null, { kind: 'issues', label: 'anton', prompt: '', spaceId: space.id }), /need a repository/);
	const routine = await automations.addAutomation(null, { kind: 'schedule', schedule: DAILY, prompt: 'Summarize the news.', spaceId: space.id });
	assert.equal(routine.projectId, '');
	assert.deepEqual(
		(await automations.spaceAutomations(space.id)).map((item) => item.id),
		[routine.id],
	);
	const ran = await automations.runAutomation(routine.id, { force: true });
	assert.equal(ran.lastError, null);
	assert.deepEqual(
		toThreads.map((item) => item.text),
		['Summarize the news.'],
	);
	const thread = await sessions.getSession(toThreads[0].id);
	assert.equal(thread.spaceId, space.id);
	assert.equal(thread.projectId, null, 'the thread is a chat');
	// The coordinator did not start it, so it hears of it as it starts.
	await reports.flushReports();
	const told = toCoordinator.filter((sent) => sent.id === space.id);
	assert.equal(told.length, 1);
	// Without a title model, a run is named by the start of the routine's instructions and the day it ran.
	assert.match(thread.title, /^Summarize the news · \w{3} \d{1,2}$/);
	assert.equal(thread.automationId, routine.id);
	assert.match(told[0].text, new RegExp(`<thread id="${thread.id.slice(0, 8)}" title="Summarize the news · \\w+ \\d+" state="\\w+" started="routine">Started by the routine that runs every day at 9:00 AM, UTC\\.</thread>`));
	// Its first reply is reported too; a run that replies without asking anything is done, with no decision model to judge it.
	await reports.threadFinished(thread.id, 'Here is the digest.');
	await reports.flushReports();
	assert.match(toCoordinator.filter((sent) => sent.id === space.id)[1]?.text ?? '', /title="Summarize the news · \w+ \d+" state="resolved">Here is the digest\.<\/thread>/);

	// A routine is changed in place, checked as when it was added, and keeps its runs.
	const sixHourly = { frequency: 'hourly', everyHours: 6, time: '00:30', timeZone: 'Asia/Kolkata' } as const;
	const edited = await automations.editAutomation(routine.id, { kind: 'schedule', schedule: sixHourly, prompt: ' Summarize the headlines. ', model: 'openrouter/test/cheap', reasoning: 'low' });
	assert.equal(edited.id, routine.id);
	assert.deepEqual(edited.schedule, { ...sixHourly, days: [1], dayOfMonth: 1, cron: '', timeZone: 'Asia/Kolkata' }, 'what it leaves out takes its defaults');
	// 00:30, 06:30, 12:30 and 18:30 in Kolkata: on the hour in UTC, and never more than six hours away.
	const next = Date.parse(edited.nextRunAt!);
	assert.equal(new Date(next).getUTCMinutes(), 0);
	assert.ok(next > Date.now() && next <= Date.now() + 6 * 60 * 60_000);
	assert.equal(edited.prompt, 'Summarize the headlines.');
	assert.equal(edited.model, 'openrouter/test/cheap');
	assert.equal(edited.reasoning, 'low');
	assert.equal(edited.lastRunAt, ran.lastRunAt);
	assert.equal(edited.spaceId, space.id);
	await assert.rejects(() => automations.editAutomation(routine.id, { kind: 'issues', label: 'anton', prompt: '' }), /need a repository/);
	await assert.rejects(() => automations.editAutomation(routine.id, { kind: 'schedule', schedule: sixHourly, prompt: ' ' }), /needs instructions/);
	await assert.rejects(() => automations.editAutomation(routine.id, { kind: 'schedule', prompt: 'x' }), /when the routine runs/);
	await assert.rejects(() => automations.editAutomation(routine.id, { kind: 'schedule', schedule: { frequency: 'weekly', days: [] }, prompt: 'x' }), /at least one day/);
	await assert.rejects(() => automations.editAutomation(routine.id, { kind: 'schedule', schedule: { frequency: 'cron', cron: '0 9 * *' }, prompt: 'x' }), /five fields/);
	await assert.rejects(() => automations.editAutomation(routine.id, { kind: 'schedule', schedule: { frequency: 'daily', timeZone: 'Mars/Olympus' }, prompt: 'x' }), /not a time zone/);
	await assert.rejects(() => automations.editAutomation(routine.id, { kind: 'schedule', schedule: sixHourly, prompt: 'x', projectId: api.id }), /not in this project/);
	assert.equal((await automations.spaceAutomations(space.id))[0].schedule?.everyHours, 6, 'a rejected change leaves it as it was');

	// It only ever starts this project's threads, so it goes when the project does.
	await spaces.removeSpace(space.id);
	await assert.rejects(() => automations.runAutomation(routine.id), /not found/);
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
	assert.equal(kept.threadState, 'idle', 'a task of its own stands where it did, as every task has a state');
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

test('a deleted thread leaves the project and keeps its files as project files; a resolved one is reopened first', async () => {
	const space = await spaces.createSpace({ name: 'Deletes', repoIds: [api.id] });
	const thread = await spaces.startThread(space.id, { title: 'Draw the diagram', brief: 'Draw it' });
	const { uploadOutput } = await import('../src/services/files.ts');
	await uploadOutput(thread.id, 'diagram.svg', new TextEncoder().encode('<svg/>'));
	await updateSession(thread.id, { resolvedAt: new Date().toISOString() });
	await assert.rejects(() => spaces.deleteTask(thread.id), /Reopen it to delete it/);
	assert.ok(await getSessionRecord(thread.id), 'a resolved thread stays');

	await updateSession(thread.id, { resolvedAt: null });
	const { kept } = await spaces.deleteTask(thread.id);
	assert.deepEqual(kept, ['From threads/Draw the diagram/uploads/diagram.svg']);
	assert.equal(await getSessionRecord(thread.id), null);
	assert.equal((await spaces.spaceView(space.id)).threads, 0);
	assert.equal(new TextDecoder().decode((await files.readSpaceFile(space.id, kept[0]))!), '<svg/>');
	// Its coordinator learns it is gone, and a message for it says so rather than "no such thread".
	assert.match(await stateBlock(space.id), new RegExp(`Deleted by the user[^\\n]*\\n- \\[${thread.id.slice(0, 8)}\\] "Draw the diagram" · deleted`));
	await assert.rejects(() => spaces.findThread(space.id, thread.id.slice(0, 8)), /"Draw the diagram" was deleted by the user and takes no messages/);

	// Another thread of the same name keeps its files beside the first's, not over them.
	const again = await spaces.startThread(space.id, { title: 'Draw the diagram', brief: 'Draw it again' });
	await uploadOutput(again.id, 'diagram.svg', new TextEncoder().encode('<svg id="2"/>'));
	assert.deepEqual((await spaces.deleteTask(again.id)).kept, ['From threads/Draw the diagram 2/uploads/diagram.svg']);

	// A task outside a project is deleted as before.
	const loose = await sessions.createSession({ projectId: api.id, title: 'Loose' });
	assert.deepEqual(await spaces.deleteTask(loose.id), { kept: [] });
	assert.equal(await getSessionRecord(loose.id), null);
});

test("a thread gets the files its brief names, or else the ones attached to the user's message", async () => {
	const space = await spaces.createSpace({ name: 'Pictures', repoIds: [api.id] });
	const { filesForThread } = await import('../src/services/attachments.ts');
	const { withAttachments } = await import('../src/core/attachments.ts');
	await files.uploadSpaceFile(space.id, 'pasted-092117.png', new Uint8Array([1, 2, 3]));
	await files.uploadSpaceFile(space.id, 'spec.md', new TextEncoder().encode('# Spec'));
	const asked = withAttachments('Build this diagram', [{ name: 'pasted-092117.png', path: 'pasted-092117.png', size: 3, kind: 'PNG image', text: null, cut: null }], 'project');

	assert.deepEqual(await filesForThread(space.id, 'Recreate the diagram in pasted-092117.png.'), ['pasted-092117.png']);
	assert.deepEqual(await filesForThread(space.id, 'Follow ../project-files/spec.md'), ['spec.md']);
	assert.deepEqual(await filesForThread(space.id, 'Read myspec.md'), [], 'a name inside another word is not the file');
	assert.deepEqual(await filesForThread(space.id, 'Recreate the diagram from the screenshot', [], asked), ['pasted-092117.png'], "the user's attachment goes along");
	assert.deepEqual(await filesForThread(space.id, 'Write the spec', ['spec.md'], asked), ['spec.md'], 'files the coordinator lists are the ones that go');
	assert.deepEqual(await filesForThread(space.id, 'Recreate the diagram'), []);
});

test('a thread whose reply delivers what was asked is done, an answer stays open, and its next message reopens it', async () => {
	const { recordLatestInput } = await import('../src/services/latest-input.ts');
	const finished = (state: Record<string, unknown>) => /Saved diagram\.svg/.test(String(state.reply));
	setProviders({
		sandbox: localSandboxProvider(path.join(dir, 'data')),
		store: diskStore(path.join(dir, 'data', 'objects')),
		git: fakeHost,
		models: fakeCatalog,
		decisions: {
			name: 'fake',
			decide: async (state, questions) => ({ answers: Object.fromEntries(Object.keys(questions).map((key) => [key, { yes: finished(state) ? 0.9 : 0.1 }])), inputTokens: 1, cost: 0 }),
		},
	});
	try {
		const space = await spaces.createSpace({ name: 'Finishing', repoIds: [] });
		const made = await spaces.startThread(space.id, { title: 'Diagram', brief: 'Draw the diagram' });
		const answered = await spaces.startThread(space.id, { title: 'Question', brief: 'Which queue do we use?' });
		await reports.threadFinished(made.id, 'Saved diagram.svg and a PNG preview.');
		await reports.threadFinished(answered.id, 'We use SQS for the order queue.');
		assert.equal((await sessions.getSession(made.id)).threadState, 'resolved');
		assert.equal((await sessions.getSession(answered.id)).threadState, 'idle', 'an answer leaves the thread open');
		await recordLatestInput(made.id, 'Make the arrows vertical');
		assert.equal((await sessions.getSession(made.id)).resolvedAt, null);
	} finally {
		setProviders({ sandbox: localSandboxProvider(path.join(dir, 'data')), store: diskStore(path.join(dir, 'data', 'objects')), git: fakeHost, models: fakeCatalog });
	}
});

test('a reply is judged as it ends, while it still counts as working, and any task can be done, not only a thread', async () => {
	const { recordAgentEvent } = await import('../src/services/activity.ts');
	setProviders({
		sandbox: localSandboxProvider(path.join(dir, 'data')),
		store: diskStore(path.join(dir, 'data', 'objects')),
		git: fakeHost,
		models: fakeCatalog,
		decisions: {
			name: 'fake',
			decide: async (_state, questions) => ({ answers: Object.fromEntries(Object.keys(questions).map((key) => [key, { yes: key === 'finished' ? 0.9 : 0.1 }])), inputTokens: 1, cost: 0 }),
		},
	});
	try {
		const space = await spaces.createSpace({ name: 'In flight', repoIds: [] });
		const thread = await spaces.startThread(space.id, { title: 'Report', brief: 'Write the report' });
		const task = await sessions.createSession({ title: 'Loose report' });
		for (const id of [thread.id, task.id]) {
			// The finish hook runs inside the reply, before its submission settles.
			recordAgentEvent({ type: 'submission_running', instanceId: id, submissionId: 'reply' });
			assert.equal((await sessions.getSession(id)).threadState, 'working');
			await reports.threadFinished(id, 'Saved report.md.');
			recordAgentEvent({ type: 'submission_settled', instanceId: id, submissionId: 'reply' });
			assert.equal((await sessions.getSession(id)).threadState, 'resolved');
		}
		assert.equal((await sessions.getSession(task.id)).lastReply, 'Saved report.md.');
	} finally {
		setProviders({ sandbox: localSandboxProvider(path.join(dir, 'data')), store: diskStore(path.join(dir, 'data', 'objects')), git: fakeHost, models: fakeCatalog });
	}
});

test('a thread finishing its reply frees its slot for a queued one at once', async () => {
	const { recordAgentEvent } = await import('../src/services/activity.ts');
	const space = await spaces.createSpace({ name: 'One at a time', repoIds: [], maxParallel: 1 });
	const first = await spaces.startThread(space.id, { title: 'First', brief: 'Do the first' });
	const second = await spaces.startThread(space.id, { title: 'Second', brief: 'Do the second' });
	recordAgentEvent({ type: 'submission_running', instanceId: first.id, submissionId: 'first' });
	assert.equal((await sessions.getSession(second.id)).threadState, 'queued');
	await reports.threadFinished(first.id, 'Done the first.');
	recordAgentEvent({ type: 'submission_settled', instanceId: first.id, submissionId: 'first' });
	assert.deepEqual(
		toThreads.map((sent) => sent.text),
		['Do the first', 'Do the second'],
	);
});

test('tasks and routines are named in a few words by the title model, unless renamed first', async () => {
	const prompts: string[] = [];
	let answer = '"Daily tech briefing."';
	setProviders({
		sandbox: localSandboxProvider(path.join(dir, 'data')),
		store: diskStore(path.join(dir, 'data', 'objects')),
		git: fakeHost,
		models: fakeCatalog,
		text: {
			runs: (model) => model.startsWith('openrouter/'),
			write: async ({ prompt }) => {
				prompts.push(prompt);
				return { text: answer, inputTokens: 40, outputTokens: 4, cost: 0.0001 };
			},
		},
	});
	const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
	try {
		const space = await spaces.createSpace({ name: 'Names', repoIds: [] });
		const long = 'Go through the internet and capture the latest news on tech and AI from yesterday, with sources';
		const { titleFrom, cleanTitle } = await import('../src/services/titles.ts');
		assert.equal(titleFrom(long), 'Go through the internet and capture the latest news on…', 'the start of the brief, until the model answers or without one');
		assert.equal(cleanTitle('Title: **"Q3 pricing review."**\nBecause…'), 'Q3 pricing review');
		const thread = await spaces.startThread(space.id, { title: '', brief: long });
		await settle();
		assert.equal((await sessions.getSession(thread.id)).title, 'Daily tech briefing');
		assert.match(prompts[0], /capture the latest news/);
		assert.ok((await sessions.getSession(thread.id)).usage.cost > 0, 'the call counts on the task');

		// A title the coordinator gave stands; a task renamed meanwhile keeps your name.
		const named = await spaces.startThread(space.id, { title: 'Pricing', brief: 'Compare pricing' });
		const task = await sessions.createSession({ title: 'Compare pricing pages', titleFrom: 'Compare pricing pages' });
		await sessions.editSession(task.id, { title: 'Mine' });
		await settle();
		assert.equal((await sessions.getSession(named.id)).title, 'Pricing');
		assert.equal((await sessions.getSession(task.id)).title, 'Mine');

		// A routine is named once, and each run takes that name with its day.
		answer = 'Morning briefing';
		const routine = await automations.addAutomation(null, { kind: 'schedule', schedule: DAILY, prompt: long, spaceId: space.id });
		const calls = prompts.length;
		await automations.runAutomation(routine.id, { force: true });
		await automations.runAutomation(routine.id, { force: true });
		assert.equal(prompts.length, calls + 1, 'named on its first run only');
		const runs = (await sessions.listThreads(space.id)).filter((item) => item.automationId === routine.id);
		assert.equal(runs.length, 2);
		for (const run of runs) assert.match(run.title, /^Morning briefing · \w{3} \d{1,2}$/);
		const edited = await automations.editAutomation(routine.id, { kind: 'schedule', schedule: DAILY, prompt: 'Summarize the markets' });
		assert.equal(edited.title, null, 'new instructions are named again');
	} finally {
		setProviders({ sandbox: localSandboxProvider(path.join(dir, 'data')), store: diskStore(path.join(dir, 'data', 'objects')), git: fakeHost, models: fakeCatalog });
	}
});

test('a project’s usage counts the month by thread, and its daily bars, with tokens, the last 14 days even across the month', async () => {
	const { addSessionUsage } = await import('../src/db/sessions.ts');
	const space = await spaces.createSpace({ name: 'Usage', repoIds: [] });
	const thread = await spaces.startThread(space.id, { title: 'Counted', brief: 'Count this' });
	await addSessionUsage(thread.id, { inputTokens: 900_000, outputTokens: 10_000, cost: 0 }, new Date('2026-09-28T12:00:00Z'));
	await addSessionUsage(thread.id, { inputTokens: 40_000, outputTokens: 2_000, cost: 0.002 }, new Date('2026-10-04T12:00:00Z'));
	const usage = await spaces.spaceUsage(space.id, new Date('2026-10-05T12:00:00Z'));
	assert.deepEqual(
		usage.byThread.map((row) => [row.title, row.tokens]),
		[['Counted', 42_000]],
		'the month starts on the 1st',
	);
	assert.deepEqual(
		usage.daily.map((day) => [day.day, day.tokens]),
		[
			['2026-09-28', 910_000],
			['2026-10-04', 42_000],
		],
		'the daily bars reach back into September',
	);
});

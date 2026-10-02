import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { createClient } from '@libsql/client';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import type { GitHost, Issue, Machine, ModelCatalog, ModelInfo, PullRequestActivity } from '../src/core/ports.ts';

const dir = mkdtempSync(path.join(os.tmpdir(), 'anton-task-'));
process.env.ANTON_DATA_DIR = path.join(dir, 'data');
after(() => rmSync(dir, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

// A local bare repo stands in for GitHub.
const remote = path.join(dir, 'remote.git');
const seed = path.join(dir, 'seed');
execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
execFileSync('git', ['init', '-q', '-b', 'main', seed]);
git(seed, 'config', 'user.email', 'test@example.com');
git(seed, 'config', 'user.name', 'Test');
writeFileSync(path.join(seed, 'README.md'), '# demo\n');
writeFileSync(path.join(seed, 'old.txt'), 'remove me\n');
git(seed, 'add', '.');
git(seed, 'commit', '-q', '-m', 'init');
git(seed, 'push', '-q', remote, 'main');

const pullRequests: string[] = [];
let cloneFrom = remote;
const fakeHost: GitHost = {
	name: 'fake',
	getRepo: async (fullName) => ({ fullName, defaultBranch: 'main', private: false }),
	listBranches: async () => ['main'],
	resolveRef: async (_repo, ref) => git(remote, 'rev-parse', ref),
	tree: async (_repo, sha) => git(remote, 'ls-tree', '-r', '--name-only', sha).split('\n'),
	file: async (_repo, sha, file) => new TextEncoder().encode(`${git(remote, 'show', `${sha}:${file}`)}\n`),
	cloneUrl: () => cloneFrom,
	gitAuthEnv: () => ({}),
	openPullRequest: async (input) => {
		pullRequests.push(input.head);
		return 'https://example.test/pull/1';
	},
	pullRequestState: async () => 'open',
	listIssues: async () => issues,
	pullRequestActivity: async () => activity,
};
// What the fake GitHub reports; tests change these.
let issues: Issue[] = [];
let activity: PullRequestActivity = { state: 'open', headSha: 'sha-1', checks: [], comments: [] };

const model = (id: string, reasoning: ModelInfo['reasoning'], defaultReasoning: ModelInfo['reasoning'][number]): ModelInfo => ({
	id,
	name: id,
	vendor: 'Test',
	description: '',
	createdAt: 0,
	contextLength: 128_000,
	maxOutput: null,
	price: { input: 0, output: 0 },
	vision: false,
	reasoning,
	defaultReasoning,
});
const fakeCatalog: ModelCatalog = {
	name: 'fake',
	list: async () => [
		model('openrouter/~deepseek/deepseek-flash-latest', ['low', 'high', 'max'], 'high'),
		model('openrouter/moonshotai/kimi-k2.6', ['off', 'low', 'medium', 'high'], 'medium'),
		model('openrouter/plain/no-reasoning', [], 'off'),
	],
};

const { useDatabase } = await import('../src/db/client.ts');
const { setProviders } = await import('../src/providers/index.ts');
const { localSandboxProvider } = await import('../src/providers/local/sandbox.ts');
const { recordAgentEvent } = await import('../src/services/activity.ts');
const { handleTerminalUpgrade } = await import('../src/services/terminal.ts');
const { diskStore } = await import('../src/providers/disk/store.ts');
const { addProject, updateSettings } = await import('../src/services/projects.ts');
const { getProject, setWarmImage } = await import('../src/db/projects.ts');
const { previewsView } = await import('../src/services/previews.ts');
const { takeScreenshot } = await import('../src/services/browser.ts');
const sessions = await import('../src/services/sessions.ts');
const files = await import('../src/services/files.ts');
const { forgetMachine, machineFor } = await import('../src/services/workspace.ts');
const { listCheckpoints, readCheckpoint, readCheckpointPatchAt, saveCheckpoint } = await import('../src/services/checkpoints.ts');
const { assertWithinBudget, budget, setLimits } = await import('../src/services/budget.ts');
const { cleanUpStorage, storageView } = await import('../src/services/storage.ts');
const { restoreCheckpoint } = await import('../src/services/restore.ts');
const { toUsage } = await import('../src/services/usage.ts');
const { addSessionUsage } = await import('../src/db/sessions.ts');
const { openPullRequest, pullRequestView } = await import('../src/services/pull-requests.ts');
const { setAgentDelivery } = await import('../src/services/agent-runner.ts');
const { addAutomation, runAutomation, runDueAutomations } = await import('../src/services/automations.ts');
const { followUp, MAX_FOLLOW_UPS } = await import('../src/services/follow-ups.ts');
const { getSessionRecord, updateSession } = await import('../src/db/sessions.ts');

useDatabase(createClient({ url: `file:${path.join(dir, 'anton.db')}` }));
// Messages Anton sends to agents on its own, in place of the running agent.
const delivered: Array<{ id: string; text: string }> = [];
let deliveryFails = false;
setAgentDelivery(async (id, text) => {
	if (deliveryFails) throw new Error('agent unavailable');
	delivered.push({ id, text });
});
// Counts shells, so a test can tell whether one was opened.
let shellsOpened = 0;
const local = localSandboxProvider(path.join(dir, 'data'));
const countShells = (machine: Machine): Machine => ({
	...machine,
	exec: machine.exec,
	openPty: (size) => {
		shellsOpened += 1;
		return machine.openPty(size);
	},
});
setProviders({
	sandbox: {
		...local,
		acquire: async (request) => {
			const acquired = await local.acquire(request);
			return { ...acquired, machine: countShells(acquired.machine) };
		},
	},
	store: diskStore(path.join(dir, 'data', 'objects')),
	git: fakeHost,
	models: fakeCatalog,
});

const run = async (machine: Machine, command: string) => text((await machine.exec(command, { cwd: `${machine.root}/repo` })).stdout);
const text = (bytes: Uint8Array | null) => new TextDecoder().decode(bytes ?? new Uint8Array());

test('a task runs, checkpoints, stops, stays viewable, and opens a pull request', async () => {
	const project = await addProject('acme/demo');
	const session = await sessions.createSession({ projectId: project.id, title: 'Fix the readme' });
	assert.match(session.branch, /^anton\/fix-the-readme-/);
	assert.equal(session.status, 'stopped');

	const before = await files.fileTree(session.id);
	assert.equal(before.source, 'base');
	assert.deepEqual(before.paths.sort(), ['README.md', 'old.txt']);

	const machine = await machineFor(session.id);
	const repo = `${machine.root}/repo`;
	await machine.exec(`cd ${repo} && echo '# demo, fixed' > README.md && rm old.txt && echo new > added.txt`);
	await machine.exec(`echo report > ${machine.root}/outputs/report.md`);

	sessions.invalidateRunning();
	const live = await files.changesView(session.id);
	assert.equal(live.source, 'live');
	assert.match(live.patch, /\+# demo, fixed/);
	assert.match(live.patch, /added\.txt/);
	assert.equal((live.patch.match(/^diff --git/gm) ?? []).length, 3, 'each change appears once');

	await saveCheckpoint(session.id, machine);
	await sessions.stopSession(session.id);

	const saved = await files.fileTree(session.id);
	assert.equal(saved.source, 'saved');
	assert.deepEqual(saved.paths, ['README.md', 'added.txt']);
	assert.equal(text(await files.readFile(session.id, 'README.md')), '# demo, fixed\n');
	assert.match((await files.changesView(session.id)).patch, /old\.txt/);
	assert.deepEqual(
		(await files.outputsView(session.id)).outputs.map((output) => output.path),
		['report.md'],
	);
	assert.equal(text(await files.readOutputFile(session.id, 'report.md')), 'report\n');
	await assert.rejects(() => files.readFile(session.id, '../secrets'));

	const url = await openPullRequest(session.id, { title: 'Fix the readme', body: '' });
	assert.equal(url, 'https://example.test/pull/1');
	assert.deepEqual(pullRequests, [session.branch]);
	assert.equal(git(remote, 'show', `${session.branch}:README.md`), '# demo, fixed');
	assert.equal((await sessions.getSession(session.id)).prUrl, url);
});

test('the model and reasoning picker change what the agent reads', async () => {
	const project = await addProject('acme/demo');
	const session = await sessions.createSession({ projectId: project.id, model: 'openrouter/moonshotai/kimi-k2.6' });
	await sessions.primeModel(session.id);
	assert.deepEqual(sessions.modelFor(session.id), { model: 'openrouter/moonshotai/kimi-k2.6', reasoning: 'medium' });

	await sessions.editSession(session.id, { model: 'openrouter/~deepseek/deepseek-flash-latest', reasoning: 'max' });
	await sessions.primeModel(session.id);
	assert.deepEqual(sessions.modelFor(session.id), { model: 'openrouter/~deepseek/deepseek-flash-latest', reasoning: 'max' });

	// A level the new model does not offer falls back to its default.
	await sessions.editSession(session.id, { reasoning: 'off' });
	await sessions.primeModel(session.id);
	assert.equal(sessions.modelFor(session.id).reasoning, 'high');

	await sessions.editSession(session.id, { model: 'openrouter/plain/no-reasoning' });
	await sessions.primeModel(session.id);
	assert.equal(sessions.modelFor(session.id).reasoning, 'off');

	await assert.rejects(() => sessions.editSession(session.id, { model: 'openrouter/made/up' }), /Unknown model/);
});

test('setup that fails part way runs again on the next start', async () => {
	// A repo with no warm image yet, so setup clones.
	const project = await addProject('acme/fresh');
	const session = await sessions.createSession({ projectId: project.id, title: 'Retry setup' });

	cloneFrom = path.join(dir, 'missing.git');
	await assert.rejects(() => machineFor(session.id));
	sessions.invalidateRunning();
	const failed = await sessions.getSession(session.id);
	assert.equal(failed.status, 'error', 'a machine left up by a failed setup still reads as failed');
	assert.ok(failed.errorMessage);

	cloneFrom = remote;
	const machine = await machineFor(session.id);
	assert.equal((await run(machine, 'git branch --show-current')).trim(), session.branch);
	sessions.invalidateRunning();
	assert.equal((await sessions.getSession(session.id)).status, 'running');

	// A ready machine is reused as is: work in it survives the next start.
	await machine.exec(`echo kept > ${machine.root}/repo/kept.txt`);
	forgetMachine(session.id);
	const again = await machineFor(session.id);
	assert.equal((await run(again, 'cat kept.txt')).trim(), 'kept');
	await sessions.stopSession(session.id);
});

test('a task reads as working while its agent has a message in flight', async () => {
	const project = await addProject('acme/demo');
	const session = await sessions.createSession({ projectId: project.id });
	assert.equal(session.working, false);

	recordAgentEvent({ type: 'submission_running', instanceId: session.id, submissionId: 'sub-1' });
	assert.equal((await sessions.getSession(session.id)).working, true);
	recordAgentEvent({ type: 'turn_start', instanceId: session.id });
	assert.equal((await sessions.getSession(session.id)).working, true);
	recordAgentEvent({ type: 'submission_settled', instanceId: session.id, submissionId: 'sub-1' });
	assert.equal((await sessions.getSession(session.id)).working, false);
});

async function terminalServer() {
	const server = createServer();
	server.on('upgrade', handleTerminalUpgrade);
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address() as AddressInfo;
	const open = (id: string) =>
		new WebSocket(`ws://127.0.0.1:${port}/vm/${id}/pty?cols=80&rows=24`, { headers: { Origin: `http://127.0.0.1:${port}` } });
	return { open, close: () => server.close() };
}

test('the terminal keeps what was typed while its machine was starting', async () => {
	const project = await addProject('acme/demo');
	const session = await sessions.createSession({ projectId: project.id });
	const server = await terminalServer();
	const socket = server.open(session.id);
	let output = '';
	socket.on('message', (data: Buffer) => (output += data.toString()));
	await new Promise((resolve) => socket.once('open', resolve));
	// Sent at once, long before the machine has cloned the repo.
	socket.send(JSON.stringify({ type: 'resize', cols: 123, rows: 45 }));
	socket.send(new TextEncoder().encode('echo typed-$((40 + 2)); sleep 0.5; stty size\n'));

	const deadline = Date.now() + 30_000;
	while (!/45 123/.test(output) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
	socket.close();
	server.close();
	assert.match(output, /typed-42/);
	assert.match(output, /45 123/);
	await sessions.stopSession(session.id);
});

test('a terminal closed while its machine starts opens no shell', async () => {
	const project = await addProject('acme/demo');
	const session = await sessions.createSession({ projectId: project.id });
	const server = await terminalServer();
	const before = shellsOpened;
	const socket = server.open(session.id);
	await new Promise((resolve) => socket.once('open', resolve));
	socket.close();
	await new Promise((resolve) => socket.once('close', resolve));
	await machineFor(session.id);
	await new Promise((resolve) => setTimeout(resolve, 200));
	server.close();
	assert.equal(shellsOpened, before);
	await sessions.stopSession(session.id);
});

test('a task can be renamed, shows its pull request, and can be deleted', async () => {
	const project = await addProject('acme/demo');
	const session = await sessions.createSession({ projectId: project.id, title: 'Old name' });
	assert.equal((await sessions.editSession(session.id, { title: '  New name ' })).title, 'New name');
	assert.equal(await pullRequestView(session.id), null);

	const machine = await machineFor(session.id);
	await machine.exec(`echo change > ${machine.root}/repo/change.txt`);
	await saveCheckpoint(session.id, machine);
	const url = await openPullRequest(session.id, { title: 'Change', body: '' });
	assert.deepEqual(await pullRequestView(session.id), { url, state: 'open' });

	const store = diskStore(path.join(dir, 'data', 'objects'));
	assert.ok((await store.list(`sessions/${session.id}/`)).length > 0);
	await sessions.deleteSession(session.id);
	assert.deepEqual(await store.list(`sessions/${session.id}/`), []);
	assert.ok(!(await sessions.listSessions()).some((task) => task.id === session.id));
	await assert.rejects(() => sessions.getSession(session.id), /not found/);
	sessions.invalidateRunning();
	assert.ok(!(await local.running()).has(session.id), 'its machine is stopped');
});

test('repo settings reach the sandbox: variables, setup script and preview ports', async () => {
	const project = await addProject('acme/settings');
	const server = createServer((_request, response) => response.end('ok'));
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	after(() => server.close());
	const port = (server.address() as AddressInfo).port;

	const first = await updateSettings(project.id, {
		env: { GREETING: 'hello', TOKEN: 'secret' },
		setupScript: 'echo "$GREETING" > setup-ran.txt',
		previewPorts: [port, 9],
		baseImage: '  ',
	});
	assert.deepEqual(first.envKeys, ['GREETING', 'TOKEN']);
	assert.ok(!('env' in first), 'values never leave the server');
	assert.equal(first.baseImage, null);
	// A kept variable is sent as null; one left out is removed.
	const saved = await updateSettings(project.id, { ...first, env: { GREETING: null } });
	assert.deepEqual(saved.envKeys, ['GREETING']);
	// The warm image survives other changes; a new base image drops it.
	await setWarmImage(project.id, 'warm-1');
	await updateSettings(project.id, { ...saved, env: { GREETING: null } });
	assert.equal((await getProject(project.id))?.warmImage, 'warm-1');
	await updateSettings(project.id, { ...saved, env: { GREETING: null }, baseImage: 'python:3.13' });
	assert.equal((await getProject(project.id))?.warmImage, null);
	await updateSettings(project.id, { ...saved, env: { GREETING: null }, baseImage: null });

	const session = await sessions.createSession({ projectId: project.id, title: 'Settings' });
	assert.deepEqual(await previewsView(session.id), { live: false, previews: [] });
	sessions.invalidateRunning();
	assert.ok(!(await local.running()).has(session.id), 'looking at previews starts nothing');

	const machine = await machineFor(session.id);
	assert.equal((await run(machine, 'cat setup-ran.txt')).trim(), 'hello');
	assert.equal((await run(machine, 'echo "$GREETING|${TOKEN:-gone}|$ANTON_PREVIEW_PORTS"')).trim(), `hello|gone|${port} 9`);
	assert.deepEqual(await previewsView(session.id), {
		live: true,
		previews: [
			{ port, url: `http://localhost:${port}`, listening: true },
			{ port: 9, url: 'http://localhost:9', listening: false },
		],
	});
});

test('a failing setup script fails the task setup', async () => {
	const project = await addProject('acme/broken-setup');
	await updateSettings(project.id, { env: {}, setupScript: 'echo nope >&2; exit 4', previewPorts: [], baseImage: null });
	const session = await sessions.createSession({ projectId: project.id, title: 'Broken' });
	await assert.rejects(() => machineFor(session.id), /nope/);
});

const browserReady = (() => {
	try {
		const root = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
		execFileSync('node', ['-e', "require('fs').accessSync(require('playwright').chromium.executablePath())"], {
			env: { ...process.env, NODE_PATH: root },
		});
		return Boolean(process.env.PLAYWRIGHT_BROWSERS_PATH);
	} catch {
		return false;
	}
})();

test('the screenshot tool saves a page to the Library', { skip: !browserReady && 'needs a global playwright with chromium' }, async () => {
	const project = await addProject('acme/screens');
	await updateSettings(project.id, {
		env: { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? '' },
		setupScript: '',
		previewPorts: [],
		baseImage: null,
	});
	const server = createServer((_request, response) => {
		response.setHeader('Content-Type', 'text/html');
		response.end('<title>Demo app</title><h1>Hello</h1><script>console.error("boom")</script>');
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	after(() => server.close());
	const session = await sessions.createSession({ projectId: project.id, title: 'Screens' });
	const machine = await machineFor(session.id);

	const shot = await takeScreenshot(machine, { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, name: 'Home Page!' });
	assert.equal(shot.path, '../outputs/screenshots/home-page.png');
	assert.equal(shot.title, 'Demo app');
	assert.equal(shot.status, 200);
	assert.ok(shot.errors.some((error) => error.includes('boom')));
	await saveCheckpoint(session.id, machine);
	assert.ok((await files.outputsView(session.id)).outputs.some((output) => output.path === 'screenshots/home-page.png'));
	const png = await files.readOutputFile(session.id, 'screenshots/home-page.png');
	assert.deepEqual([...(png ?? new Uint8Array()).subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'a PNG file');
});

test('the checkpoint timeline keeps distinct states, and restoring one puts its files back', async () => {
	const project = await addProject('acme/demo');
	const session = await sessions.createSession({ projectId: project.id, title: 'Timeline' });
	const machine = await machineFor(session.id);
	await run(machine, 'echo one > a.txt');
	const first = await saveCheckpoint(session.id, machine);
	await saveCheckpoint(session.id, machine);
	assert.equal((await listCheckpoints(session.id)).length, 1, 'an unchanged state adds no entry');

	await run(machine, 'echo two > a.txt && mkdir -p deep && echo new > deep/b.txt && rm README.md');
	await saveCheckpoint(session.id, machine);
	const timeline = await listCheckpoints(session.id);
	assert.deepEqual(
		timeline.map(({ files, added, removed }) => [files, added, removed]),
		[
			[3, 2, 1],
			[1, 1, 0],
		],
	);
	assert.match((await readCheckpointPatchAt(session.id, first.at)) ?? '', /\+one/);
	assert.equal(await readCheckpointPatchAt(session.id, '../../escape'), null);

	recordAgentEvent({ type: 'submission_running', instanceId: session.id, submissionId: 'busy' });
	await assert.rejects(() => restoreCheckpoint(session.id, first.at), /Stop the agent/);
	recordAgentEvent({ type: 'submission_settled', instanceId: session.id, submissionId: 'busy' });

	const result = await restoreCheckpoint(session.id, first.at);
	assert.deepEqual(result, { at: first.at, skipped: [] });
	assert.equal((await run(machine, 'cat a.txt')).trim(), 'one');
	assert.equal((await run(machine, 'test -e deep/b.txt && echo yes || echo no')).trim(), 'no');
	assert.equal((await run(machine, 'cat README.md')).trim(), '# demo');
	const after = await listCheckpoints(session.id);
	assert.equal(after.length, 3, 'the restored state is the newest entry');
	assert.equal(after[0].files, 1);
	await assert.rejects(() => restoreCheckpoint(session.id, '2020-01-01T00:00:00.000Z'), /not found/);
});

test('a task adds up the tokens and cost of its responses', async () => {
	const project = await addProject('acme/demo');
	const session = await sessions.createSession({ projectId: project.id, title: 'Usage' });
	assert.deepEqual(session.usage, { inputTokens: 0, outputTokens: 0, cost: 0 });
	const usage = toUsage({ input: 100, output: 20, cacheRead: 50, cacheWrite: 0, cost: { total: 0.01 } });
	assert.deepEqual(usage, { inputTokens: 150, outputTokens: 20, cost: 0.01 });
	await addSessionUsage(session.id, usage);
	await addSessionUsage(session.id, usage);
	const totals = (await sessions.getSession(session.id)).usage;
	assert.equal(totals.inputTokens, 300);
	assert.equal(totals.outputTokens, 40);
	assert.ok(Math.abs(totals.cost - 0.02) < 1e-9);
});

test('spending caps stop new messages once today or a task has spent enough', async () => {
	const project = await addProject('acme/demo');
	const session = await sessions.createSession({ projectId: project.id, title: 'Budget' });
	await setLimits({ dailyUsd: null, taskUsd: null });
	const spentBefore = (await budget()).today;
	await addSessionUsage(session.id, { inputTokens: 10, outputTokens: 10, cost: 0.5 });
	await addSessionUsage(session.id, { inputTokens: 10, outputTokens: 10, cost: 0.25 }, new Date(Date.now() - 2 * 86_400_000));
	assert.ok(Math.abs((await budget()).today - spentBefore - 0.5) < 1e-9, 'only today counts toward the day');
	await assertWithinBudget(session.id);

	await setLimits({ dailyUsd: null, taskUsd: 0.7 });
	const capped = await budget(session.id);
	assert.equal(capped.task, 0.75);
	assert.match(capped.blocked ?? '', /task's spending cap of \$0\.7/);
	await assert.rejects(() => assertWithinBudget(session.id), (error: Error & { status?: number }) => error.status === 429);

	await setLimits({ dailyUsd: spentBefore + 0.4, taskUsd: null });
	assert.match((await budget()).blocked ?? '', /Today's spending cap/);
	await setLimits({ dailyUsd: null, taskUsd: null });
	assert.equal((await budget(session.id)).blocked, null);
});

test('storage cleanup removes deleted tasks, old history and unused file contents', async () => {
	const store = diskStore(path.join(dir, 'data', 'objects'));
	const project = await addProject('acme/demo');
	const session = await sessions.createSession({ projectId: project.id, title: 'Storage' });
	const machine = await machineFor(session.id);
	await run(machine, 'echo kept > kept.txt');
	await saveCheckpoint(session.id, machine);
	const kept = (await readCheckpoint(session.id))!.files[0].blob!;

	await store.put('sessions/gone-task/checkpoint.json', '{}');
	await store.put('blobs/unused', 'nobody points here');
	for (let index = 0; index < 52; index += 1) {
		await store.put(`sessions/${session.id}/checkpoints/2000-01-01T00:00:${String(index).padStart(2, '0')}.000Z.json`, '{"files":[],"log":[]}');
	}
	// Too new to remove: it may belong to a checkpoint still being written.
	const early = await cleanUpStorage(Date.now());
	assert.ok(await store.has('blobs/unused'));
	assert.ok(!(await store.has('sessions/gone-task/checkpoint.json')));
	assert.ok(early.removed >= 3);

	const later = await cleanUpStorage(Date.now() + 2 * 60 * 60_000);
	assert.ok(!(await store.has('blobs/unused')));
	assert.ok(await store.has(kept), 'contents a checkpoint uses stay');
	assert.ok(later.removed >= 1);
	const history = (await store.list(`sessions/${session.id}/checkpoints/`)).filter((object) => object.key.endsWith('.json'));
	assert.equal(history.length, 50);
	assert.ok((await listCheckpoints(session.id)).some((entry) => entry.files === 1), 'the newest real entry survives');
	assert.equal((await storageView()).lastCleanup?.at, later.at);
});

test('automations start one task per labeled issue and run schedules when due', async () => {
	const project = await addProject('acme/automated');
	const issue = (number: number): Issue => ({ number, title: `Bug ${number}`, body: `Steps for ${number}`, url: `https://example.test/issues/${number}` });
	issues = [issue(1), issue(2), issue(3), issue(4)];
	await assert.rejects(() => addAutomation(project.id, { kind: 'issues', label: ' ', prompt: '' }), /label/);
	const fromIssues = await addAutomation(project.id, { kind: 'issues', label: 'anton', prompt: 'Keep the change small.' });
	delivered.length = 0;

	const first = await runAutomation(fromIssues.id);
	assert.deepEqual(first.seen, [1, 2, 3], 'at most three issues per run');
	assert.equal(first.lastError, null);
	assert.equal(delivered.length, 3);
	assert.match(delivered[0].text, /Resolve GitHub issue #1: Bug 1[\s\S]*Steps for 1[\s\S]*Keep the change small\.[\s\S]*Closes #1/);
	assert.equal((await sessions.getSession(delivered[0].id)).title, '#1 Bug 1');

	await runAutomation(fromIssues.id);
	await runAutomation(fromIssues.id);
	assert.deepEqual(
		delivered.map((item) => item.text.match(/#(\d+)/)?.[1]),
		['1', '2', '3', '4'],
		'each issue starts one task, ever',
	);

	const schedule = await addAutomation(project.id, { kind: 'schedule', everyHours: 24, prompt: 'Update the dependencies\nand run the tests.' });
	const now = Date.parse(schedule.createdAt) + 24 * 60 * 60_000;
	await runAutomation(schedule.id, { now: now - 60_000 });
	assert.equal(delivered.length, 4, 'the first run is one interval after it was added');
	const ran = await runAutomation(schedule.id, { now });
	assert.equal(delivered.length, 5);
	assert.equal((await sessions.getSession(delivered[4].id)).title, 'Update the dependencies');
	await runAutomation(schedule.id, { now: now + 60 * 60_000 });
	assert.equal(delivered.length, 5, 'not due again within the day');
	await runAutomation(schedule.id, { now: now + 60 * 60_000, force: true });
	assert.equal(delivered.length, 6, 'Run now starts it early');
	assert.ok(ran.lastRunAt);

	deliveryFails = true;
	const tasksBefore = (await sessions.listSessions()).length;
	const failed = await runAutomation(schedule.id, { force: true });
	deliveryFails = false;
	assert.equal(failed.lastError, 'agent unavailable');
	assert.equal((await sessions.listSessions()).length, tasksBefore, 'a task its agent never got is removed');

	await setLimits({ dailyUsd: 0, taskUsd: null });
	await runDueAutomations(now + 48 * 60 * 60_000);
	assert.equal(delivered.length, 6, 'nothing starts past the daily cap');
	await setLimits({ dailyUsd: null, taskUsd: null });
});

test('follow-ups tell the agent about failed checks and new comments on its pull request', async () => {
	const project = await addProject('acme/followed');
	const session = await sessions.createSession({ projectId: project.id, title: 'Follow' });
	const record = async () => (await getSessionRecord(session.id))!;
	delivered.length = 0;
	assert.equal(await followUp(await record()), false, 'no pull request yet');

	await updateSession(session.id, { prUrl: 'https://example.test/pull/9' });
	const failing = { name: 'test', status: 'failed', summary: '2 tests failed', url: 'https://example.test/checks/1' } as const;
	activity = { state: 'open', headSha: 'sha-1', checks: [failing, { name: 'lint', status: 'pending', summary: '', url: '' }], comments: [] };
	assert.equal(await followUp(await record()), false, 'waits for every check to finish');

	activity = { ...activity, checks: [failing] };
	assert.equal(await followUp(await record()), true);
	assert.match(delivered[0].text, /Checks failed[\s\S]*sha-1[\s\S]*test: 2 tests failed/);
	assert.equal(await followUp(await record()), false, 'a commit is reported once');

	activity = {
		...activity,
		comments: [
			{ id: 'comment-1', author: 'deploy-preview[bot]', body: 'Preview ready', path: null, line: null, at: '' },
			{ id: 'line-2', author: 'reviewer', body: 'Rename this', path: 'src/a.ts', line: 4, at: '' },
		],
	};
	assert.equal(await followUp(await record()), true);
	assert.match(delivered[1].text, /@reviewer on src\/a\.ts line 4: Rename this/);
	assert.doesNotMatch(delivered[1].text, /Preview ready/, 'status bots are left out');

	recordAgentEvent({ type: 'submission_running', instanceId: session.id, submissionId: 'busy' });
	activity = { ...activity, headSha: 'sha-2' };
	assert.equal(await followUp(await record()), false, 'never interrupts a working agent');
	recordAgentEvent({ type: 'submission_settled', instanceId: session.id, submissionId: 'busy' });
	assert.equal(await followUp(await record()), true, 'a new commit that fails is reported');

	await updateSession(session.id, { followState: JSON.stringify({ sha: null, seen: [], sent: MAX_FOLLOW_UPS }) });
	assert.equal(await followUp(await record()), false, 'stops after the most it may send');
	await updateSession(session.id, { followState: null });
	await updateSettings(project.id, { ...(await getProject(project.id))!, env: {}, followUps: false });
	assert.equal(await followUp(await record()), false, 'off in the repo settings');
	assert.equal(delivered.length, 3);
});

test('MCP server tokens are kept on save and never shown', async () => {
	const project = await addProject('acme/mcp');
	const stored = (await getProject(project.id))!;
	const base = { ...stored, env: {} };
	const saved = await updateSettings(project.id, { ...base, mcpServers: [{ name: 'docs', url: 'https://mcp.example.test', auth: 'secret-token', tools: [] }] });
	assert.deepEqual(saved.mcpServers, [{ name: 'docs', url: 'https://mcp.example.test', tools: [], hasAuth: true }]);
	assert.ok(!JSON.stringify(saved).includes('secret-token'));

	await updateSettings(project.id, { ...base, mcpServers: [{ name: 'docs', url: 'https://mcp.example.test/v2', auth: null, tools: ['search'] }] });
	assert.equal((await getProject(project.id))!.mcpServers[0].auth, 'secret-token', 'a server saved without a token keeps its own');
	await updateSettings(project.id, { ...base, mcpServers: [{ name: 'docs', url: 'https://mcp.example.test/v2', auth: '', tools: ['search'] }] });
	assert.equal((await getProject(project.id))!.mcpServers[0].auth, null, 'an empty token removes it');
});

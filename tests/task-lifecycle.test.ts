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
import type { AcquireRequest, GitHost, Issue, Machine, ModelCatalog, ModelInfo, PullRequestActivity } from '../src/core/ports.ts';
import { bareRemote } from './bare-remote.ts';

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
const pushes = bareRemote(remote);
/** Commits whose files were downloaded for read-only tasks. */
const archives: string[] = [];
const fakeHost: GitHost = {
	name: 'fake',
	getRepo: async (fullName) => ({ fullName, defaultBranch: 'main', private: false }),
	listBranches: async () => ['main'],
	resolveRef: async (_repo, ref) => git(remote, 'rev-parse', ref),
	tree: async (_repo, sha) => git(remote, 'ls-tree', '-r', '--name-only', sha).split('\n'),
	archive: async (_repo, sha) => {
		archives.push(sha);
		return new Blob([execFileSync('git', ['archive', '--format=tar.gz', '--prefix=acme-demo-snapshot/', sha], { cwd: remote })]).stream();
	},
	file: async (_repo, sha, file) => new TextEncoder().encode(`${git(remote, 'show', `${sha}:${file}`)}\n`),
	cloneUrl: () => cloneFrom,
	gitAuthEnv: () => ({}),
	branchHead: pushes.branchHead,
	pushCommits: pushes.pushCommits,
	openPullRequest: async (input) => {
		pullRequests.push(input.head);
		return 'https://example.test/pull/1';
	},
	pullRequestState: async () => 'open',
	listIssues: async () => issues,
	pullRequestActivity: async () => activity,
	accountName: async () => 'Ada Lovelace',
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
	price: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
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
const { toUsage, usageView } = await import('../src/services/usage.ts');
const { connections } = await import('../src/services/connections.ts');
const { sandboxSettings, setSandboxSettings } = await import('../src/services/sandbox-settings.ts');
const { rebuildPreparedImage } = await import('../src/services/projects.ts');
const { computeView, stopAllSandboxes } = await import('../src/services/compute.ts');
const { addSessionUsage } = await import('../src/db/sessions.ts');
const { openPullRequest, pullRequestView } = await import('../src/services/pull-requests.ts');
const { setAgentDelivery } = await import('../src/services/agent-runner.ts');
const { addAutomation, removeAutomation, runAutomation, runDueAutomations } = await import('../src/services/automations.ts');
const { followUp, MAX_FOLLOW_UPS, resetFollowUps } = await import('../src/services/follow-ups.ts');
const { getSessionRecord, updateSession } = await import('../src/db/sessions.ts');

const database = createClient({ url: `file:${path.join(dir, 'anton.db')}` });
useDatabase(database);
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
/** What the last machine start asked for. */
let lastAcquire: AcquireRequest | undefined;
setProviders({
	sandbox: {
		...local,
		acquire: async (request) => {
			lastAcquire = request;
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

	// A used machine that lost its marker could hold anything (a fake git, say), so setup runs on a fresh one.
	await again.exec(`echo planted > ${again.root}/planted.txt && rm ${again.root}/.anton-ready`);
	forgetMachine(session.id);
	const fresh = await machineFor(session.id);
	assert.equal((await fresh.exec(`cat ${fresh.root}/planted.txt`)).exitCode, 1, 'nothing from the used machine is left');
	assert.equal((await run(fresh, 'git branch --show-current')).trim(), session.branch);
	await sessions.stopSession(session.id);
});

test('a machine without the setup marker counts as set up only for tasks older than the marker', async () => {
	const project = await addProject('acme/demo');
	const session = await sessions.createSession({ projectId: project.id, title: 'Marker' });
	const machine = await machineFor(session.id);
	const unmark = async () => {
		await machine.exec(`echo work > ${machine.root}/repo/work.txt && rm ${machine.root}/.anton-ready`);
		await database.execute({ sql: 'UPDATE sessions SET checkpoint_at = ? WHERE id = ?', args: [new Date().toISOString(), session.id] });
		forgetMachine(session.id);
	};
	// A checkpoint saved after a setup that never finished must not make the machine count as ready.
	await unmark();
	const redone = await machineFor(session.id);
	assert.equal((await run(redone, 'test -e work.txt && echo yes || echo no')).trim(), 'no', 'setup ran again');

	await database.execute({ sql: 'UPDATE sessions SET legacy_setup = 1 WHERE id = ?', args: [session.id] });
	await unmark();
	const legacy = await machineFor(session.id);
	assert.equal((await run(legacy, 'cat work.txt')).trim(), 'work', "an older task's machine is reused as is");
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
	await setWarmImage(project.id, 'built-on-the-old-base', null);
	assert.equal((await getProject(project.id))?.warmImage, null, 'a snapshot of the old base is not kept');
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
	assert.match(shot.path, /^\.\.\/outputs\/screenshots\/home-page-\d+\.png$/);
	const shotFile = shot.path.replace('../outputs/', '');
	assert.equal(shot.title, 'Demo app');
	assert.equal(shot.status, 200);
	assert.ok(shot.errors.some((error) => error.includes('boom')));
	await saveCheckpoint(session.id, machine);
	assert.ok((await files.outputsView(session.id)).outputs.some((output) => output.path === shotFile));
	const png = await files.readOutputFile(session.id, shotFile);
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

test('spend this month breaks down by repository and model, and outlives a deleted task', async () => {
	const project = await addProject('acme/breakdown');
	const session = await sessions.createSession({ projectId: project.id, title: 'Breakdown', model: 'openrouter/plain/no-reasoning' });
	await addSessionUsage(session.id, { inputTokens: 100, outputTokens: 50, cost: 0.3 });
	await addSessionUsage(session.id, { inputTokens: 10, outputTokens: 5, cost: 0.2 });
	await sessions.deleteSession(session.id);
	const view = await usageView();
	const repo = view.byRepo.find((row) => row.key === 'acme/breakdown');
	assert.equal(repo?.tokens, 165);
	assert.ok(Math.abs((repo?.cost ?? 0) - 0.5) < 1e-9);
	assert.ok(view.byModel.some((row) => row.key === 'openrouter/plain/no-reasoning' && Math.abs(row.cost - 0.5) < 1e-9));
	assert.ok(view.month >= view.today && view.today >= 0.5);
});

test('connections are checked through the ports, and Compute lists and stops running sandboxes', async () => {
	const byId = Object.fromEntries((await connections()).map((connection) => [connection.id, connection]));
	assert.equal(byId.sandbox?.state, 'ok');
	assert.match(byId.sandbox?.detail ?? '', /running now/);
	assert.equal(byId.store?.state, 'ok');
	assert.equal(byId.database?.state, 'ok');
	assert.ok(byId.git?.state === 'off' || /Ada Lovelace/.test(byId.git?.detail ?? ''));

	const project = await addProject('acme/demo');
	const session = await sessions.createSession({ projectId: project.id, title: 'Compute' });
	await sessions.resumeSession(session.id);
	assert.ok((await computeView()).running.some((task) => task.id === session.id));
	const { stopped } = await stopAllSandboxes();
	assert.ok(stopped >= 1);
	assert.equal((await computeView()).running.length, 0);
	assert.equal((await sessions.getSession(session.id)).status, 'stopped');
});

test('sandbox settings reach new machines, and a new default base image retires prepared images', async () => {
	const project = await addProject('acme/demo');
	const before = await sandboxSettings();
	await setWarmImage(project.id, 'image-old');
	await setSandboxSettings({ ...before, cpu: 4, memoryMiB: 8192, region: 'eu', idleMinutes: 30, allowedDomains: ['registry.npmjs.org'], baseImage: 'python:3.12' });
	assert.equal((await getProject(project.id))?.warmImage, null, 'the old default image is retired');

	const session = await sessions.createSession({ projectId: project.id, title: 'Sizes' });
	await sessions.resumeSession(session.id);
	assert.equal(lastAcquire?.baseImage, 'python:3.12');
	assert.deepEqual({ ...lastAcquire?.resources, allowedDomains: undefined }, { cpu: 4, memoryMiB: 8192, idleTimeoutMs: 30 * 60_000, lifetimeMs: 24 * 3_600_000, regions: ['eu'], allowedDomains: undefined });
	assert.ok(lastAcquire?.resources.allowedDomains.includes('registry.npmjs.org') && lastAcquire.resources.allowedDomains.includes('github.com'));
	await sessions.stopSession(session.id);

	await setWarmImage(project.id, 'image-new');
	assert.equal((await rebuildPreparedImage(project.id)).warmedAt, null);
	await setSandboxSettings(before);
});

test('General settings decide how a new task starts when the launcher does not say', async () => {
	const { generalSettings, setGeneralSettings } = await import('../src/services/general.ts');
	const project = await addProject('acme/demo');
	const before = await generalSettings();
	await assert.rejects(() => setGeneralSettings({ ...before, model: 'openrouter/nobody/unknown' }), /Unknown model/);
	await setGeneralSettings({ model: 'openrouter/moonshotai/kimi-k2.6', reasoning: 'low', planMode: true });

	const plain = await sessions.createSession({ projectId: project.id, title: 'Defaults' });
	assert.deepEqual([plain.model, plain.reasoning, plain.planMode], ['openrouter/moonshotai/kimi-k2.6', 'low', true]);
	// Another model starts at its own default level; an explicit choice wins over the defaults.
	const other = await sessions.createSession({ projectId: project.id, title: 'Other', model: 'openrouter/plain/no-reasoning', planMode: false });
	assert.deepEqual([other.model, other.reasoning, other.planMode], ['openrouter/plain/no-reasoning', null, false]);
	await sessions.deleteSession(plain.id);
	await sessions.deleteSession(other.id);
	await setGeneralSettings(before);
});

test('shared variables reach every repo under its own, and their values stay out of what the agent reads', async () => {
	const { secretsView, setSharedEnv, setGuardrails, secretsToHide } = await import('../src/services/secrets.ts');
	const { machineSandbox } = await import('../src/flue/machine-sandbox.ts');
	const project = await addProject('acme/secrets');
	const settings = await updateSettings(project.id, { env: { API_KEY: 'repo-key-123456' }, setupScript: '', previewPorts: [], baseImage: null });
	await setSharedEnv({ API_KEY: 'shared-key-123456', SHARED_TOKEN: 'shared-token-abcdef', SHORT: 'yes' });
	// Null keeps a stored value; a variable left out is removed.
	const view = await setSharedEnv({ API_KEY: null, SHARED_TOKEN: null });
	assert.deepEqual(view.shared, ['API_KEY', 'SHARED_TOKEN']);
	assert.deepEqual(view.repos.find((repo) => repo.projectId === project.id)?.names, ['API_KEY']);
	assert.ok(!JSON.stringify(view).includes('123456'), 'values never leave the server');

	const session = await sessions.createSession({ projectId: project.id, title: 'Secrets' });
	const machine = await machineFor(session.id);
	assert.equal((await run(machine, 'echo "$API_KEY|$SHARED_TOKEN|${SHORT:-gone}"')).trim(), 'repo-key-123456|shared-token-abcdef|gone');

	const sandbox = machineSandbox(machine, `${machine.root}/repo`, () => true, await secretsToHide(session.id));
	const shown = await sandbox.exec('echo "$API_KEY $SHARED_TOKEN" && echo "$SHARED_TOKEN" >&2 && echo "$SHARED_TOKEN" > token.txt');
	assert.equal(shown.stdout.trim(), '[API_KEY hidden] [SHARED_TOKEN hidden]');
	assert.equal(shown.stderr.trim(), '[SHARED_TOKEN hidden]');
	assert.equal((await sandbox.readFile(`${machine.root}/repo/token.txt`)).trim(), 'shared-token-abcdef', 'files are read as they are');

	await setGuardrails({ hideSecrets: false });
	assert.deepEqual(await secretsToHide(session.id), {});
	await setGuardrails({ hideSecrets: true });
	await sessions.deleteSession(session.id);
	await updateSettings(project.id, { ...settings, env: {} });
	await setSharedEnv({});
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
	// An output the agent wrote is not a manifest, whatever its name.
	await store.put(`sessions/${session.id}/outputs/report.json`, 'not a checkpoint');
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
	const twin = await addAutomation(project.id, { kind: 'issues', label: 'anton', prompt: '' });
	await removeAutomation(fromIssues.id);
	const again = await addAutomation(project.id, { kind: 'issues', label: 'anton', prompt: '' });
	await Promise.all([runAutomation(twin.id), runAutomation(again.id), runAutomation(again.id, { force: true })]);
	assert.equal(delivered.length, 4, 'no issue starts a second task, whichever automation finds it');

	issues = [...issues, issue(5), issue(6), issue(7), issue(8)];
	const busy = delivered.slice(0, 3).map((item) => item.id);
	for (const id of busy) recordAgentEvent({ type: 'submission_running', instanceId: id, submissionId: 'issue' });
	await runAutomation(again.id);
	assert.equal(delivered.length, 4, 'waits while three issue tasks are working');
	recordAgentEvent({ type: 'submission_settled', instanceId: busy[0], submissionId: 'issue' });
	await runAutomation(again.id);
	assert.deepEqual(
		delivered.slice(4).map((item) => item.text.match(/#(\d+)/)?.[1]),
		['5'],
		'starts one when one finishes',
	);
	for (const id of busy.slice(1)) recordAgentEvent({ type: 'submission_settled', instanceId: id, submissionId: 'issue' });
	await removeAutomation(twin.id);
	await removeAutomation(again.id);

	const schedule = await addAutomation(project.id, { kind: 'schedule', everyHours: 24, prompt: 'Update the dependencies\nand run the tests.' });
	const now = Date.parse(schedule.createdAt) + 24 * 60 * 60_000;
	await runAutomation(schedule.id, { now: now - 60_000 });
	assert.equal(delivered.length, 5, 'the first run is one interval after it was added');
	const ran = await runAutomation(schedule.id, { now });
	assert.equal(delivered.length, 6);
	assert.equal((await sessions.getSession(delivered[5].id)).title, 'Update the dependencies');
	await runAutomation(schedule.id, { now: now + 60 * 60_000 });
	assert.equal(delivered.length, 6, 'not due again within the day');
	await runAutomation(schedule.id, { now: now + 60 * 60_000, force: true });
	assert.equal(delivered.length, 7, 'Run now starts it early');
	assert.ok(ran.lastRunAt);

	deliveryFails = true;
	const tasksBefore = (await sessions.listSessions()).length;
	const failed = await runAutomation(schedule.id, { force: true });
	deliveryFails = false;
	assert.equal(failed.lastError, 'agent unavailable');
	assert.equal((await sessions.listSessions()).length, tasksBefore, 'a task its agent never got is removed');

	await setLimits({ dailyUsd: 0, taskUsd: null });
	await runDueAutomations(now + 48 * 60 * 60_000);
	assert.equal(delivered.length, 7, 'nothing starts past the daily cap');
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
	await resetFollowUps(session.id);
	assert.equal(await followUp(await record()), true, 'a person writing lets it follow up again');
	activity = { ...activity, state: 'merged' };
	assert.equal(await followUp(await record()), false);
	activity = { ...activity, state: 'open', headSha: 'sha-3' };
	assert.equal(await followUp(await record()), false, 'a merged pull request is never looked at again');
	await updateSession(session.id, { prUrl: 'https://example.test/pull/10' });
	assert.equal(await followUp(await record()), true, 'a new pull request starts afresh');
	await updateSession(session.id, { followState: null });
	await updateSettings(project.id, { ...(await getProject(project.id))!, env: {}, followUps: false });
	assert.equal(await followUp(await record()), false, 'off in the repo settings');
	assert.equal(delivered.length, 5);
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
	await updateSettings(project.id, { ...base, mcpServers: [{ name: 'docs', url: 'https://elsewhere.example.test/v2', auth: null, tools: ['search'] }] });
	assert.equal((await getProject(project.id))!.mcpServers[0].auth, null, 'a token never follows a server to a new host');
	await updateSettings(project.id, { ...base, mcpServers: [{ name: 'docs', url: 'https://mcp.example.test/v2', auth: 'secret-token', tools: ['search'] }] });
	await updateSettings(project.id, { ...base, mcpServers: [{ name: 'docs', url: 'https://mcp.example.test/v2', auth: '', tools: ['search'] }] });
	assert.equal((await getProject(project.id))!.mcpServers[0].auth, null, 'an empty token removes it');
});

test('stopping a task stops its working agent', async () => {
	const { setAgentAbort } = await import('../src/services/activity.ts');
	const aborted: string[] = [];
	setAgentAbort(async (id) => void aborted.push(id));
	const project = await addProject('acme/demo');
	const session = await sessions.createSession({ projectId: project.id, title: 'Abort' });
	await sessions.stopSession(session.id);
	assert.deepEqual(aborted, [], 'an idle agent is left alone');
	recordAgentEvent({ type: 'submission_running', instanceId: session.id, submissionId: 'busy' });
	await sessions.deleteSession(session.id);
	assert.deepEqual(aborted, [session.id]);
	recordAgentEvent({ type: 'submission_settled', instanceId: session.id, submissionId: 'busy' });
});

test('a reply that crosses a spending cap is stopped at its next model call', async () => {
	const { setAgentAbort } = await import('../src/services/activity.ts');
	const { stopIfOverBudget } = await import('../src/services/budget.ts');
	const aborted: string[] = [];
	setAgentAbort(async (id) => void aborted.push(id));
	const project = await addProject('acme/demo');
	const session = await sessions.createSession({ projectId: project.id, title: 'Runaway' });
	recordAgentEvent({ type: 'submission_running', instanceId: session.id, submissionId: 'loop' });
	await setLimits({ dailyUsd: null, taskUsd: 1 });
	await stopIfOverBudget(session.id);
	assert.deepEqual(aborted, [], 'under the cap it keeps going');
	await addSessionUsage(session.id, { inputTokens: 10, outputTokens: 10, cost: 1.5 });
	await stopIfOverBudget(session.id);
	assert.deepEqual(aborted, [session.id]);
	await setLimits({ dailyUsd: null, taskUsd: null });
	recordAgentEvent({ type: 'submission_settled', instanceId: session.id, submissionId: 'loop' });
});

test('pushes rebuild the agent\'s own commits on the host with the same hashes, sending each once', async () => {
	const project = await addProject('acme/demo');
	const session = await sessions.createSession({ projectId: project.id, title: 'Pushes' });
	const record = (await getSessionRecord(session.id))!;
	const machine = await machineFor(session.id);
	const repo = `${machine.root}/repo`;
	// Commits the way an agent might: its own name, a far-off time zone, odd files, a removal and a merge.
	const commit = (message: string, date: string) =>
		run(machine, `GIT_AUTHOR_DATE=${date} GIT_COMMITTER_DATE=${date} git -c user.name='Agent Ä' -c user.email=a@example.test commit -q -m ${JSON.stringify(message)}`);
	await run(machine, `printf 'run\\n' > 'tool.sh' && chmod +x tool.sh && ln -s README.md link && printf x > 'with space\ttab.txt' && git rm -q old.txt && git add -A`);
	await commit('Add tools\n\nWith a body.', '2026-10-03T06:20:01+05:30');
	await run(machine, 'git checkout -q -b side HEAD~1 && printf side > side.txt && git add side.txt');
	await commit('Side work', '2026-10-03T01:00:00-07:00');
	await run(machine, `git checkout -q ${record.branch} && git -c user.name=Agent -c user.email=a@example.test merge -q --no-edit side`);

	await openPullRequest(session.id, { title: 'First', body: '' });
	const head = git(remote, 'rev-parse', record.branch);
	assert.equal(head, (await run(machine, 'git rev-parse HEAD')).trim(), 'the host has the very same commits');
	assert.equal(git(remote, 'show', `${record.branch}:side.txt`), 'side');
	assert.equal(git(remote, 'ls-tree', record.branch, 'tool.sh').split(' ')[0], '100755');
	assert.equal(git(remote, 'ls-tree', record.branch, 'link').split(' ')[0], '120000');
	const sent = pushes.received.length;

	await run(machine, 'printf more > more.txt');
	await openPullRequest(session.id, { title: 'Second', body: '' });
	assert.equal(pushes.received.length, sent + 1, 'only the new commit is sent');
	assert.equal(git(remote, 'log', '-1', '--format=%s', record.branch), 'Second');

	// A header the host would drop, such as a signature, would change the hash: refused, not pushed changed.
	const raw = await run(machine, 'git cat-file commit HEAD');
	const odd = raw.replace('\n\n', '\nencoding ISO-8859-1\n\n').replace('Second', 'Odd');
	await machine.exec('git reset -q --hard "$(git hash-object -t commit -w --stdin)"', { cwd: repo, stdin: new TextEncoder().encode(odd) });
	await assert.rejects(() => openPullRequest(session.id, { title: 'Third', body: '' }), /"encoding" header/);
	assert.equal(git(remote, 'log', '-1', '--format=%s', record.branch), 'Second', 'the branch is left as it was');
});

test('a task reads the repo without a sandbox, clone or branch', async () => {
	const { listRepoFiles, readRepoFile, searchRepo } = await import('../src/services/repo-snapshot.ts');
	// A branch of the fake GitHub with folders, a long path, a link and a file too large to keep.
	const work = path.join(dir, 'snapshot-seed');
	execFileSync('git', ['clone', '-q', remote, work]);
	const deep = `src/${'nested/'.repeat(20)}deep.ts`;
	execFileSync('mkdir', ['-p', path.join(work, path.dirname(deep))]);
	writeFileSync(path.join(work, deep), 'export const answer = 42;\n');
	writeFileSync(path.join(work, 'src', 'app.ts'), 'import { answer } from "./deep";\nconsole.log(Answer);\n');
	writeFileSync(path.join(work, 'big.bin'), Buffer.alloc(2 * 1024 * 1024, 1));
	execFileSync('ln', ['-s', 'README.md', path.join(work, 'readme-link')]);
	git(work, 'add', '.');
	git(work, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'snapshot files');
	git(work, 'push', '-q', 'origin', 'HEAD:refs/heads/snapshot-test');

	const project = await addProject('acme/demo');
	const session = await sessions.createSession({ projectId: project.id, title: 'Question', branch: 'snapshot-test' });
	const before = archives.length;
	const listing = await listRepoFiles(session.id, {});
	assert.match(listing, /^README\.md$/m);
	assert.match(listing, new RegExp(`^${deep}$`, 'm'), 'long paths come through whole');
	assert.match(listing, /^readme-link -> README\.md$/m);
	assert.equal(await listRepoFiles(session.id, { glob: '*.ts' }), `src/app.ts\n${deep}`);
	assert.equal(await listRepoFiles(session.id, { path: 'src', glob: 'app.*' }), 'src/app.ts');
	assert.equal(await readRepoFile(session.id, 'src/app.ts'), '1\timport { answer } from "./deep";\n2\tconsole.log(Answer);\n3\t');
	assert.match(await readRepoFile(session.id, 'src/app.ts', 2, 1), /^2\tconsole\.log\(Answer\);\n\(lines 2-2 of 3; read on with offset 3\)$/);
	assert.match(await readRepoFile(session.id, 'big.bin'), /too large to read without a workspace/);
	assert.match(await readRepoFile(session.id, 'readme-link'), /link to README\.md/);
	assert.match(await readRepoFile(session.id, 'missing.ts'), /does not exist/);
	await assert.rejects(() => readRepoFile(session.id, '../../etc/passwd'));
	assert.equal(await searchRepo(session.id, { pattern: 'answer' }), `src/app.ts:1: import { answer } from "./deep";\n${deep}:1: export const answer = 42;`);
	assert.equal(await searchRepo(session.id, { pattern: 'ANSWER\\)', ignoreCase: true }), 'src/app.ts:2: console.log(Answer);');
	assert.match(await searchRepo(session.id, { pattern: '(' }), /Invalid pattern/);
	assert.equal(archives.length, before + 1, 'downloaded once, then read from disk');

	const record = (await sessions.getSession(session.id))!;
	assert.equal(record.workspace, false, 'no workspace, so no branch');
	assert.ok(!(await local.running()).has(session.id), 'no sandbox was started');
	await machineFor(session.id);
	assert.equal((await sessions.getSession(session.id)).workspace, true);
	await sessions.stopSession(session.id);
});

test('checkpoints and restore keep odd file names, symlinks and executables as they were', async () => {
	const project = await addProject('acme/demo');
	const session = await sessions.createSession({ projectId: project.id, title: 'Odd files' });
	const machine = await machineFor(session.id);
	await run(machine, `mkdir shared && echo conf > shared/conf && ln -s shared/conf link && ln -s shared dirlink && printf 'é\\n' > 'café.txt' && echo q > 'a"b.txt' && printf '#!/bin/sh\\necho hi\\n' > run.sh && chmod +x run.sh`);
	const saved = await saveCheckpoint(session.id, machine);
	assert.deepEqual(
		saved.files.map((file) => [file.path, file.mode]).sort(),
		[
			['a"b.txt', '100644'],
			['café.txt', '100644'],
			['dirlink', '120000'],
			['link', '120000'],
			['run.sh', '100755'],
			['shared/conf', '100644'],
		],
	);
	// Everything changes: links become files, a file becomes a directory.
	await run(machine, `rm link dirlink run.sh 'café.txt' && echo plain > link && mkdir -p run.sh && echo x > run.sh/inner && rm run.sh/inner`);
	await restoreCheckpoint(session.id, saved.at);
	assert.equal((await run(machine, 'readlink link')).trim(), 'shared/conf');
	assert.equal((await run(machine, 'readlink dirlink')).trim(), 'shared');
	assert.equal((await run(machine, 'cat shared/conf')).trim(), 'conf', 'the link target was not written through');
	assert.equal((await run(machine, './run.sh')).trim(), 'hi');
	assert.equal((await run(machine, "cat 'café.txt'")).trim(), 'é');
	assert.equal((await run(machine, 'git diff --cached --name-only')).trim(), '', "the agent's index is untouched");
});

test('usage is counted for every model call, as it ends', async () => {
	const { recordTurnUsage } = await import('../src/services/usage.ts');
	const project = await addProject('acme/demo');
	const session = await sessions.createSession({ projectId: project.id, title: 'Per call' });
	const call = (cost: number) => ({ input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: cost } });
	await recordTurnUsage({ type: 'turn', instanceId: session.id, response: { usage: call(0.01) } });
	await recordTurnUsage({ type: 'turn', instanceId: session.id, response: { usage: call(0.02) } });
	await recordTurnUsage({ type: 'turn_start', instanceId: session.id });
	const { usage } = await sessions.getSession(session.id);
	assert.equal(usage.inputTokens, 20);
	assert.ok(Math.abs(usage.cost - 0.03) < 1e-9);
});

test('plan mode: the agent cannot write until the plan is approved, and plan-first automations start in it', async () => {
	const { machineSandbox } = await import('../src/flue/machine-sandbox.ts');
	const { isPlanning, primeAgent } = await import('../src/services/agent-runner.ts');
	const project = await addProject('acme/planned');
	const session = await sessions.createSession({ projectId: project.id, title: 'Plan it', planMode: true });
	assert.equal(session.planMode, true);
	await primeAgent(session.id);
	assert.equal(isPlanning(session.id), true);

	const machine = await machineFor(session.id);
	const sandbox = machineSandbox(machine, `${machine.root}/repo`, () => !isPlanning(session.id));
	await assert.rejects(() => sandbox.writeFile(`${machine.root}/repo/new.txt`, 'hi\n'), /Plan mode is on/);
	await assert.rejects(() => sandbox.rm(`${machine.root}/repo/README.md`), /Plan mode is on/);
	assert.match(await sandbox.readFile(`${machine.root}/repo/README.md`), /# demo/, 'reading still works');

	// Approving turns plan mode off, and the agent sees it from the next message.
	await sessions.editSession(session.id, { planMode: false });
	await primeAgent(session.id);
	assert.equal(isPlanning(session.id), false);
	await sandbox.writeFile(`${machine.root}/repo/new.txt`, 'hi\n');
	assert.equal(await run(machine, 'cat new.txt'), 'hi\n');
	await sessions.deleteSession(session.id);

	const automation = await addAutomation(project.id, { kind: 'schedule', everyHours: 24, prompt: 'Tidy the README.', planFirst: true });
	assert.equal(automation.planFirst, true);
	delivered.length = 0;
	await runAutomation(automation.id, { force: true });
	assert.equal((await sessions.getSession(delivered[0].id)).planMode, true);
	await removeAutomation(automation.id);
});

test('open pages hear about task changes as they happen', async () => {
	const { onChange } = await import('../src/core/changes.ts');
	const heard: string[] = [];
	const stop = onChange((change) => heard.push(change.kind === 'task' ? `${change.what} ${change.id}` : change.kind));
	const project = await addProject('acme/live');
	const session = await sessions.createSession({ projectId: project.id, title: 'Live' });
	await sessions.editSession(session.id, { title: 'Live, renamed' });
	recordAgentEvent({ type: 'submission_running', instanceId: session.id, submissionId: 'live' });
	recordAgentEvent({ type: 'tool', instanceId: session.id });
	recordAgentEvent({ type: 'submission_settled', instanceId: session.id, submissionId: 'live' });
	await sessions.deleteSession(session.id);
	stop();
	assert.deepEqual(heard.slice(0, 5), ['sessions', `state ${session.id}`, `state ${session.id}`, `files ${session.id}`, `state ${session.id}`]);
	assert.equal(heard.at(-1), 'sessions', 'deleting a task changes the list');
});

test('repo memory: the agent adds notes, the user edits them, and every task reads them', async () => {
	const { remember, saveMemory, MAX_MEMORY } = await import('../src/services/memory.ts');
	const { memoryFor, primeAgent } = await import('../src/services/agent-runner.ts');
	const project = await addProject('acme/remembered');
	const session = await sessions.createSession({ projectId: project.id, title: 'Learn' });
	assert.match(await remember(session.id, 'Tests need   Docker\nrunning.'), /Saved/);
	await Promise.all([remember(session.id, 'Use pnpm, not npm.'), remember(session.id, 'Migrations live in db/.')]);
	const notes = (await getProject(project.id))!.memory.split('\n');
	assert.equal(notes[0], '- Tests need Docker running.');
	assert.equal(notes.length, 3, 'notes saved at once all land');

	const next = await sessions.createSession({ projectId: project.id, title: 'Use it' });
	await primeAgent(next.id);
	assert.match(memoryFor(next.id), /Use pnpm, not npm\./);

	await saveMemory(project.id, '- Only this.\n');
	assert.equal((await getProject(project.id))!.memory, '- Only this.');
	await saveMemory(project.id, 'x'.repeat(MAX_MEMORY - 20));
	assert.match(await remember(session.id, 'One more fact that does not fit.'), /full/);
	await assert.rejects(() => saveMemory(project.id, 'x'.repeat(MAX_MEMORY + 1)), /under/);
});

test('removing a repo deletes its tasks, machines and automations, and the profile names the host account', async () => {
	const { removeProject, projects } = await import('../src/services/projects.ts');
	const { listAutomations } = await import('../src/db/automations.ts');
	const { profileName } = await import('../src/services/profile.ts');
	const project = await addProject('acme/removed');
	const session = await sessions.createSession({ projectId: project.id, title: 'Goes away' });
	await machineFor(session.id);
	await addAutomation(project.id, { kind: 'schedule', everyHours: 24, prompt: 'Nightly.' });

	await removeProject(project.id);
	assert.equal(await getProject(project.id), null);
	assert.equal(await getSessionRecord(session.id), null);
	assert.equal(await sessions.isRunning(session.id), false, 'its machine is stopped');
	assert.equal((await listAutomations(project.id)).length, 0);
	assert.ok(!(await projects()).some((item) => item.id === project.id));
	await assert.rejects(() => removeProject(project.id), /not found/);
	assert.equal(await profileName(), 'Ada Lovelace');
});

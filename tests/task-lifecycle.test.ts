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
import type { GitHost, Machine, ModelCatalog, ModelInfo } from '../src/core/ports.ts';

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
};

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
const { saveCheckpoint } = await import('../src/services/checkpoints.ts');
const { openPullRequest, pullRequestView } = await import('../src/services/pull-requests.ts');

const database = createClient({ url: `file:${path.join(dir, 'anton.db')}` });
useDatabase(database);
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
	assert.equal(shot.path, '../outputs/screenshots/home-page.png');
	assert.equal(shot.title, 'Demo app');
	assert.equal(shot.status, 200);
	assert.ok(shot.errors.some((error) => error.includes('boom')));
	await saveCheckpoint(session.id, machine);
	assert.ok((await files.outputsView(session.id)).outputs.some((output) => output.path === 'screenshots/home-page.png'));
	const png = await files.readOutputFile(session.id, 'screenshots/home-page.png');
	assert.deepEqual([...(png ?? new Uint8Array()).subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'a PNG file');
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

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { Machine } from '../src/core/ports.ts';

const dir = mkdtempSync(path.join(os.tmpdir(), 'anton-repo-check-'));
process.env.ANTON_DATA_DIR = dir;
after(() => rmSync(dir, { recursive: true, force: true }));

const { upsertProject, getProject } = await import('../src/db/projects.ts');
const { MAX_CHECK_COMMAND, updateSettings } = await import('../src/services/projects.ts');
const { localSandboxProvider } = await import('../src/providers/local/sandbox.ts');
const { machineSandbox } = await import('../src/flue/machine-sandbox.ts');
const { createShellTool } = await import('../src/flue/shell-tool.ts');
const { gate, loadGate, restartGates } = await import('../src/services/gate-state.ts');
const check = await import('../src/services/repo-check.ts');
const { checkGate, checkNotice, forgetRepoCheck, hasRepoCheck, noteRepoCheckEvent, repoCheckRuns, setRepoCheckDeps, settledRepoCheck, startCheckGate, stopRepoCheck, watchRepoCheck } = check;

test('a repository’s check command is empty until set, saved trimmed, kept when a save leaves it out, and refused when too long', async () => {
	const project = await upsertProject('acme/checked', 'main');
	assert.equal(project.checkCommand, '');
	const saved = await updateSettings(project.id, { env: {}, setupScript: 'npm ci', checkCommand: '  npm run check:types\n', previewPorts: [], baseImage: null });
	assert.equal(saved.checkCommand, 'npm run check:types');
	assert.equal((await getProject(project.id))?.checkCommand, 'npm run check:types');
	assert.equal((await getProject(project.id))?.setupScript, 'npm ci');
	await updateSettings(project.id, { env: {}, setupScript: '', previewPorts: [], baseImage: null });
	assert.equal((await getProject(project.id))?.checkCommand, 'npm run check:types', 'left out, it is kept');
	await assert.rejects(updateSettings(project.id, { env: {}, setupScript: '', checkCommand: 'x'.repeat(MAX_CHECK_COMMAND + 1), previewPorts: [], baseImage: null }), /check command/);
	assert.equal((await getProject(project.id))?.checkCommand, 'npm run check:types');
	await updateSettings(project.id, { env: {}, setupScript: '', checkCommand: '', previewPorts: [], baseImage: null });
	assert.equal((await getProject(project.id))?.checkCommand, '', 'cleared, it runs none');
});

const resources = { runtime: 'container' as const, cpu: 1, memoryMiB: 1024, idleTimeoutMs: 60_000, lifetimeMs: 60_000, regions: [], allowedDomains: [] };
const { machine: local } = await localSandboxProvider(path.join(dir, 'data')).acquire({ key: 'checks', state: null, image: null, baseImage: null, ports: [], resources });
/** Every command the check sent to the machine. */
const sent: string[] = [];
const machine: Machine = { ...local, exec: (command, options) => (sent.push(command), local.exec(command, options)) };

/** The check command and base commit of each task; a task not here has none. */
const commands = new Map<string, { command: string; baseSha?: string }>();
let cwd = '';
const checkDir = path.join(dir, 'check');
const deps = {
	live: async (): Promise<Machine | null> => machine,
	settings: async (id: string) => {
		const found = commands.get(id);
		return found ? { command: found.command, baseSha: found.baseSha ?? '', env: { CHECK_GREETING: 'hello' } } : null;
	},
	secrets: async () => ({ API_TOKEN: 'supersecretvalue' }),
	cwd: () => cwd,
	dir: checkDir,
	quietMs: 40,
	timeoutMs: 20_000,
};
setRepoCheckDeps(deps);

const git = (repo: string, ...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], { encoding: 'utf8' }).trim();

/** A repository with one commit, which the check runs in from now on; its HEAD. */
function repo(name: string, files: Record<string, string> = { 'file.txt': 'good\n' }): string {
	cwd = path.join(local.root, name);
	mkdirSync(cwd, { recursive: true });
	git(cwd, 'init', '-q');
	for (const [file, content] of Object.entries(files)) writeFileSync(path.join(cwd, file), content);
	git(cwd, 'add', '-A');
	git(cwd, 'commit', '-qm', 'start');
	return git(cwd, 'rev-parse', 'HEAD');
}

const write = (file: string, content: string) => writeFileSync(path.join(cwd, file), content);
const tool = (id: string, toolName: string, agentName?: string) => noteRepoCheckEvent({ type: 'tool', instanceId: id, toolName, ...(agentName ? { agentName } : {}) });
const counted = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).length : 0);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A check that fails while file.txt does not say good, as a type checker does, and counts its runs. */
const failing = (counter: string) => `echo run >> ${counter}; grep -q good file.txt && exit 0; echo "src/file.ts(1,1): error TS2322: Type 'bad' is not assignable to type 'good'."; exit 2`;

test('with no check command, no command is run for any change, nothing is told and the gate returns at once', async () => {
	repo('none');
	watchRepoCheck('n1', true);
	startCheckGate('n1');
	const before = sent.length;
	for (const name of ['edit', 'write', 'apply_patch', 'bash']) tool('n1', name);
	write('file.txt', 'changed\n');
	await settledRepoCheck('n1');
	assert.equal(sent.length, before, 'nothing ran in the machine');
	assert.equal(checkNotice('n1'), '');
	const started = Date.now();
	assert.equal(await checkGate('n1', [{ tool: 'edit' }]), null);
	assert.ok(Date.now() - started < 1_000);
	// A task its agent never marked as checked (a chat, a plan, a review, a task on this server) has nothing at all.
	commands.set('n2', { command: 'echo nope' });
	tool('n2', 'edit');
	assert.equal(hasRepoCheck('n2'), false);
	assert.equal(await checkGate('n2', [{ tool: 'edit' }]), null);
	assert.equal(sent.length, before);
});

test('a failing check is told once at the end of the next command’s result, the same failure is not told again, and a pass after it says so once', async () => {
	repo('fails');
	const counter = path.join(dir, 'fails.count');
	commands.set('f1', { command: failing(counter) });
	watchRepoCheck('f1', true);
	startCheckGate('f1');
	write('file.txt', 'bad\n');
	tool('f1', 'edit');
	await settledRepoCheck('f1');
	assert.deepEqual(repoCheckRuns('f1'), { runs: 1, last: 'failed' });
	// The notice ends the next command result, as the reply clock and job notices do.
	const sandbox = machineSandbox(machine, cwd, () => true, {}, undefined, () => checkNotice('f1'));
	const bash = createShellTool(sandbox, { dir: path.join(dir, 'out') });
	const first = await bash.execute('c1', { command: 'echo listed' }, undefined);
	const said = (first.content[0] as { text: string }).text;
	assert.match(said, /^listed\n\n\[anton\] This repository's check \(echo run >> .*\) fails after your last change:\nLog: .*f1\.log \(\d+ lines?\); grep it for more\.\n/);
	assert.match(said, /error TS2322: Type 'bad' is not assignable/);
	assert.ok(said.length < 1_800, 'a short digest');
	const second = await bash.execute('c2', { command: 'echo again' }, undefined);
	assert.equal((second.content[0] as { text: string }).text, 'again', 'told once');
	// Another change with the same failure is not told again.
	write('other.txt', 'more\n');
	tool('f1', 'write');
	await settledRepoCheck('f1');
	assert.equal(repoCheckRuns('f1').runs, 2);
	assert.equal(checkNotice('f1'), '');
	// Fixed: the pass is told once, as the failure was.
	write('file.txt', 'good\n');
	tool('f1', 'edit');
	await settledRepoCheck('f1');
	assert.deepEqual(repoCheckRuns('f1'), { runs: 3, last: 'passed' });
	assert.equal(checkNotice('f1'), "\n[anton] This repository's check passes again.");
	assert.equal(checkNotice('f1'), '');
	// A pass with no failure told before it says nothing.
	write('third.txt', 'x\n');
	tool('f1', 'edit');
	await settledRepoCheck('f1');
	assert.equal(repoCheckRuns('f1').runs, 4);
	assert.equal(checkNotice('f1'), '');
	assert.equal(counted(counter), 4);
});

test('a pass with no failure before it says nothing, and the command has the agent’s variables with secrets hidden in what comes back', async () => {
	repo('passes');
	commands.set('p1', { command: 'echo "$CHECK_GREETING supersecretvalue"; [ -e broken.txt ] && { echo "error: broken"; exit 1; }; exit 0' });
	watchRepoCheck('p1', true);
	write('file.txt', 'changed\n');
	tool('p1', 'apply_patch');
	await settledRepoCheck('p1');
	assert.deepEqual(repoCheckRuns('p1'), { runs: 1, last: 'passed' });
	assert.equal(checkNotice('p1'), '');
	write('broken.txt', 'x\n');
	tool('p1', 'edit');
	await settledRepoCheck('p1');
	const notice = checkNotice('p1');
	assert.match(notice, /hello \[API_TOKEN hidden\]/);
	assert.doesNotMatch(notice, /supersecretvalue/);
});

test('a burst of changes causes one run, and a change during a run causes exactly one more', async () => {
	repo('burst');
	const counter = path.join(dir, 'burst.count');
	const started = path.join(dir, 'burst.started');
	commands.set('b1', { command: `echo run >> ${counter}; : > ${started}; sleep 0.6` });
	watchRepoCheck('b1', true);
	for (let n = 0; n < 5; n++) {
		write(`f${n}.txt`, `${n}\n`);
		tool('b1', n % 2 ? 'edit' : 'write');
	}
	await settledRepoCheck('b1');
	assert.equal(counted(counter), 1);
	rmSync(started, { force: true });
	write('next.txt', 'a\n');
	tool('b1', 'edit');
	while (!existsSync(started)) await sleep(10);
	// Two changes while it runs: one run more, of the tree as they left it.
	write('during.txt', 'b\n');
	tool('b1', 'edit');
	tool('b1', 'bash');
	await settledRepoCheck('b1');
	assert.equal(counted(counter), 3);
	assert.equal(repoCheckRuns('b1').runs, 3);
});

test('a command that changes nothing runs no check: the script finds the tree as the last run saw it', async () => {
	const head = repo('unchanged');
	const counter = path.join(dir, 'unchanged.count');
	commands.set('u1', { command: `echo run >> ${counter}; mkdir -p dist && date +%N > dist/out.txt`, baseSha: head });
	watchRepoCheck('u1', true);
	// A task still at its base commit with nothing changed has no change of the agent's to check.
	tool('u1', 'bash');
	await settledRepoCheck('u1');
	assert.equal(counted(counter), 0);
	write('file.txt', 'changed\n');
	tool('u1', 'edit');
	await settledRepoCheck('u1');
	assert.equal(counted(counter), 1);
	// The check wrote build output of its own; the agent's tree is the same, so a bash that only read checks nothing.
	const before = sent.length;
	tool('u1', 'bash');
	tool('u1', 'bash');
	await settledRepoCheck('u1');
	assert.equal(counted(counter), 1);
	assert.equal(sent.length, before + 1, 'one short command');
	// An untracked file the agent writes is a change.
	write('new.txt', 'x\n');
	tool('u1', 'bash');
	await settledRepoCheck('u1');
	assert.equal(counted(counter), 2);
});

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

test('a check that runs past its time is stopped with every process it started, and told once as a timeout, not a failure', async () => {
	repo('slow');
	const pids = path.join(dir, 'slow.pids');
	commands.set('s1', { command: `echo $$ > ${pids}; sleep 30 & echo $! >> ${pids}; wait` });
	const restore = setRepoCheckDeps({ ...deps, timeoutMs: 1_000 });
	try {
		watchRepoCheck('s1', true);
		startCheckGate('s1');
		write('file.txt', 'changed\n');
		tool('s1', 'edit');
		const started = Date.now();
		await settledRepoCheck('s1');
		assert.ok(Date.now() - started < 8_000, 'stopped at its limit');
		assert.deepEqual(repoCheckRuns('s1'), { runs: 1, last: 'timed out' });
		const [shell, sleeper] = readFileSync(pids, 'utf8').trim().split('\n').map(Number);
		for (let n = 0; n < 100 && (alive(shell) || alive(sleeper)); n++) await sleep(20);
		assert.equal(alive(shell), false);
		assert.equal(alive(sleeper), false);
		const notice = checkNotice('s1');
		assert.match(notice, /^\n\[anton\] This repository's check \(.*\) did not finish in 1s and was stopped, so it says nothing of your change\. .*faster check command/);
		assert.doesNotMatch(notice, /fails/);
		assert.equal(checkNotice('s1'), '');
		assert.equal(await checkGate('s1', [{ tool: 'edit' }]), null, 'a timeout sends nothing back');
		// Timing out again is not told again.
		write('file.txt', 'again\n');
		tool('s1', 'edit');
		await settledRepoCheck('s1');
		assert.equal(checkNotice('s1'), '');
	} finally {
		restore();
		setRepoCheckDeps(deps);
	}
});

test('the gate waits for the check of the last change and sends the reply back with its digest, once a failure and twice a reply at most', async () => {
	repo('gate');
	commands.set('g1', { command: 'sleep 0.4; cat file.txt; grep -q good file.txt || exit 1' });
	watchRepoCheck('g1', true);
	await loadGate('g1');
	startCheckGate('g1');
	write('file.txt', 'error: first failure\n');
	tool('g1', 'edit');
	// Called at once: it does not wait for the quiet, and waits for the run.
	const back = await checkGate('g1', [{ tool: 'edit' }]);
	assert.ok(back);
	assert.match(back, /^This repository's check \(sleep 0\.4; .*\) fails after your change:\nLog: /);
	assert.match(back, /error: first failure/);
	assert.match(back, /Fix what your change broke before you end\. If this failure was there before your change, say so and end\.$/);
	assert.equal(checkNotice('g1'), '', 'the send-back told it');
	assert.equal(await checkGate('g1', [{ tool: 'bash' }]), null, 'once for a failure');
	// What it was sent back for survives a restart of the server.
	await restartGates();
	await loadGate('g1');
	assert.equal(gate('g1').check.sends, 1);
	assert.equal(await checkGate('g1', [{ tool: 'bash' }]), null);
	write('file.txt', 'error: second failure\n');
	tool('g1', 'edit');
	assert.match((await checkGate('g1', [{ tool: 'edit' }])) ?? '', /second failure/);
	write('file.txt', 'error: third failure\n');
	tool('g1', 'edit');
	assert.equal(await checkGate('g1', [{ tool: 'edit' }]), null, 'twice a reply at most');
	// A new reply may be sent back again, but never when it ends on ask or propose_plan, nor when stopped.
	startCheckGate('g1');
	write('file.txt', 'error: fourth failure\n');
	tool('g1', 'edit');
	assert.equal(await checkGate('g1', [{ tool: 'edit' }, { tool: 'ask' }]), null);
	assert.equal(await checkGate('g1', [{ tool: 'propose_plan' }]), null);
	const stopped = new AbortController();
	stopped.abort();
	assert.equal(await checkGate('g1', [{ tool: 'edit' }], { signal: stopped.signal }), null);
	assert.match((await checkGate('g1', [{ tool: 'edit' }])) ?? '', /fourth failure/);
	// A reply that changed nothing is not sent back for the failure the tree still has.
	startCheckGate('g1');
	tool('g1', 'bash');
	assert.equal(await checkGate('g1', [{ tool: 'bash' }]), null);
});

test('stopping the reply stops a running check, which is not told, and the next change is checked again', async () => {
	repo('stop');
	const marker = path.join(dir, 'stop.started');
	const pids = path.join(dir, 'stop.pids');
	commands.set('x1', { command: `sleep 30 & echo $! > ${pids}; : > ${marker}; wait` });
	watchRepoCheck('x1', true);
	write('file.txt', 'changed\n');
	tool('x1', 'edit');
	while (!existsSync(marker)) await sleep(10);
	const started = Date.now();
	await stopRepoCheck('x1');
	assert.ok(Date.now() - started < 8_000);
	const sleeper = Number(readFileSync(pids, 'utf8').trim());
	for (let n = 0; n < 100 && alive(sleeper); n++) await sleep(20);
	assert.equal(alive(sleeper), false);
	assert.deepEqual(repoCheckRuns('x1'), { runs: 0, last: null });
	assert.equal(checkNotice('x1'), '');
	// The stopped run left no fingerprint: the same tree is checked on the next change.
	commands.set('x1', { command: 'exit 0' });
	tool('x1', 'bash');
	await settledRepoCheck('x1');
	assert.deepEqual(repoCheckRuns('x1'), { runs: 1, last: 'passed' });
});

test('only a finished call of a tool that changes files counts, never one of the reviewer, and a deleted task leaves nothing in memory', async () => {
	repo('events');
	const counter = path.join(dir, 'events.count');
	commands.set('e1', { command: `echo run >> ${counter}` });
	watchRepoCheck('e1', true);
	write('file.txt', 'changed\n');
	noteRepoCheckEvent({ type: 'tool_start', instanceId: 'e1', toolName: 'edit' });
	tool('e1', 'read');
	tool('e1', 'grep');
	tool('e1', 'edit', 'reviewer');
	await settledRepoCheck('e1');
	assert.equal(counted(counter), 0);
	// A subagent's edit, from the coder's instance, counts.
	tool('e1', 'edit', 'coder');
	await settledRepoCheck('e1');
	assert.equal(counted(counter), 1);
	// Its agent rendered it as a plan or a review now: nothing runs.
	watchRepoCheck('e1', false);
	write('file.txt', 'again\n');
	tool('e1', 'edit');
	await settledRepoCheck('e1');
	assert.equal(counted(counter), 1);
	forgetRepoCheck('e1');
	assert.equal(hasRepoCheck('e1'), false);
});

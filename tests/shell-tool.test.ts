import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { Sandbox } from '@flue/runtime';
import { localSandboxProvider } from '../src/providers/local/sandbox.ts';
import { machineSandbox } from '../src/flue/machine-sandbox.ts';
import { COMMAND_TIMEOUT_MS, createShellTool, cutInMemory, HEAD_BYTES, INLINE_BYTES, KEEP_OUTPUTS, shellResult, shellScript, startAndEnd, stoppedNote, TAIL_BYTES } from '../src/flue/shell-tool.ts';
import { sandboxTools } from '../src/flue/sandbox-tools.ts';
import { taskTools } from '../src/flue/task-sandbox.ts';

const dir = mkdtempSync(path.join(os.tmpdir(), 'anton-shell-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const resources = { runtime: 'container' as const, cpu: 1, memoryMiB: 1024, idleTimeoutMs: 60_000, lifetimeMs: 60_000, regions: [], allowedDomains: [] };
const { machine } = await localSandboxProvider(path.join(dir, 'data')).acquire({ key: 'shell', state: null, image: null, baseImage: null, ports: [], resources });
mkdirSync(path.join(machine.root, 'repo'), { recursive: true });
const outputs = path.join(dir, 'out');
const clockLines: string[] = [];
const sandbox = machineSandbox(machine, `${machine.root}/repo`, () => true, { API_TOKEN: 'supersecretvalue' }, undefined, () => clockLines.shift() ?? '');
let runs = 0;
const bash = createShellTool(sandbox, { dir: outputs, id: () => `run${++runs}` });

async function run(command: string, timeout?: number, signal?: AbortSignal) {
	const result = await bash.execute('call', timeout === undefined ? { command } : { command, timeout }, signal);
	return { text: (result.content[0] as { text: string }).text, details: result.details as { exitCode: number; output?: string } };
}

const kept = () => (existsSync(outputs) ? readdirSync(outputs) : []);

test('bash keeps the name and parameters the models know, on every kind of task', async () => {
	const chat = sandboxTools({ sees: async () => false, describe: async () => '' })(sandbox, { subagents: {} }).find((tool) => tool.name === 'bash')!;
	const task = taskTools({} as never, { sees: async () => false, describe: async () => '' })(sandbox, { subagents: {} }).find((tool) => tool.name === 'bash')!;
	for (const tool of [chat, task]) {
		assert.equal(tool.label, 'Run Command');
		assert.deepEqual(Object.keys((tool.parameters as { properties: object }).properties), ['command', 'timeout']);
		assert.deepEqual((tool.parameters as { required: string[] }).required, ['command']);
		assert.match(tool.description, /past 16KB comes back as its start and end/);
		assert.match(tool.description, /stops after 3 minutes/);
	}
});

test('a short output comes back whole, in the order written, and leaves no file behind', async () => {
	const result = await run('echo one; echo two >&2; echo three');
	assert.equal(result.text, 'one\ntwo\nthree');
	assert.equal(result.details.exitCode, 0);
	assert.equal(result.details.output, undefined);
	assert.deepEqual(kept(), []);
	assert.equal((await run('true')).text, '(no output)');
	assert.ok((await run('pwd')).text.endsWith('/repo'), 'runs in the working folder');
});

test('a long output comes back as its start and end, cut at line ends, with what is left out and the file that holds it all', async () => {
	const result = await run('for i in $(seq 1 5000); do echo "line $i"; done; echo "error: the last thing" >&2; exit 2');
	const whole = readFileSync(result.details.output!.replace(outputs, outputs), 'utf8');
	assert.equal(result.details.output, `${outputs}/run${runs}.log`);
	assert.equal(whole, `${Array.from({ length: 5000 }, (_, index) => `line ${index + 1}`).join('\n')}\nerror: the last thing\n`, 'the file holds all of it');
	assert.match(result.text, /^line 1\nline 2\n/);
	assert.match(result.text, /line 4999\nline 5000\nerror: the last thing\n\nCommand exited with code 2$/);
	const marker = /\n\[([\d,]+) lines \(([\d.]+) KB\) cut here\. The whole output is in (\S+); grep or read it for the rest\.\]\n/.exec(result.text)!;
	assert.ok(marker, result.text.slice(0, 200));
	assert.equal(marker[3], result.details.output);
	// Every line shown is whole, and the lines shown and left out add up to the output.
	const [head, tail] = result.text.split(marker[0]);
	const tailLines = tail.replace(/\n\nCommand exited with code 2$/, '').split('\n');
	for (const line of [...head.split('\n'), ...tailLines.slice(0, -1)]) assert.match(line, /^line \d+$/);
	assert.equal(head.split('\n').length + tailLines.length + Number(marker[1].replaceAll(',', '')), 5001);
	assert.ok(Buffer.byteLength(head) <= HEAD_BYTES && Buffer.byteLength(tail) <= TAIL_BYTES + 40, 'its parts stay within their share');
	assert.ok(Buffer.byteLength(result.text) < INLINE_BYTES + 300);
});

test('stdout and stderr come back in the order they were written, and the exit code as it was', async () => {
	const result = await run('echo out1; echo err1 >&2; echo out2; echo err2 >&2; exit 7');
	assert.equal(result.text, 'out1\nerr1\nout2\nerr2\n\nCommand exited with code 7');
	assert.equal(result.details.exitCode, 7);
});

test('a command that calls exit, one with a syntax error and one that fails all come back with their output and code', async () => {
	assert.equal((await run('echo before; exit 3; echo after')).text, 'before\n\nCommand exited with code 3');
	const syntax = await run('echo fine; if then fi');
	assert.match(syntax.text, /syntax error/);
	assert.match(syntax.text, /Command exited with code 2$/);
	assert.match((await run('ls /no/such/folder')).text, /No such file or directory\n\nCommand exited with code 2$/);
	assert.match((await run('nosuchcommand-anton')).text, /command not found\n\nCommand exited with code 127$/);
});

test('a command cut by its timeout keeps what it wrote, as start and end with the file named, and its pipeline is stopped', async () => {
	const started = Date.now();
	const result = await run('for i in $(seq 1 3000); do echo "row $i"; done; echo halfway; sleep 30 | cat; echo never', 1);
	assert.ok(Date.now() - started < 10_000, 'stopped at its time');
	assert.match(result.text, /^row 1\n/);
	assert.match(result.text, /row 3000\nhalfway\n\[anton\] Command timed out after 1 seconds\.\n\nCommand exited with code 124$/);
	assert.match(result.text, new RegExp(`cut here\\. The whole output is in ${result.details.output}`));
	assert.doesNotMatch(result.text, /never/);
	assert.equal(result.details.exitCode, 124);
	const left = await machine.exec('pgrep -f "^sleep 30$" || true');
	assert.equal(new TextDecoder().decode(left.stdout).trim(), '', 'the whole process group was stopped');
	// A short one keeps all it wrote.
	assert.equal((await run('echo started; sleep 30', 1)).text, 'started\n[anton] Command timed out after 1 seconds.\n\nCommand exited with code 124');
});

test('a command that names no timeout gets the default, and the note says what to do when it is stopped', async () => {
	const seen: Array<{ command: string; timeoutMs?: number }> = [];
	const fake = { exec: async (command: string, options?: { timeoutMs?: number }) => (seen.push({ command, timeoutMs: options?.timeoutMs }), { stdout: '', stderr: '', exitCode: 0 }) } as unknown as Sandbox;
	const tool = createShellTool(fake, { id: () => 'x' });
	await tool.execute('call', { command: 'npm test' });
	await tool.execute('call', { command: 'npm test', timeout: 900 });
	assert.equal(COMMAND_TIMEOUT_MS, 3 * 60_000);
	assert.match(seen[0].command, /\( sleep 180; /);
	assert.match(seen[1].command, /\( sleep 900; /);
	assert.ok(seen[0].timeoutMs! > COMMAND_TIMEOUT_MS, "the machine's own limit is past the command's, so the script can print what it wrote");
	assert.ok(seen[1].timeoutMs! > 900_000);
	assert.match(seen[0].command, /\/tmp\/anton-out\/x\.log/);
	// Bash before 5.3 reports a job's end on stderr once job control is on; the script's own stderr is shut first.
	assert.match(seen[0].command, /\nexec 2>\/dev\/null\nset -m\n/);

	// The script stopped at the default (one second here) says so, with what to do.
	const file = `${outputs}/default.log`;
	const nonce = '__anton_default_nonce__';
	const result = await sandbox.exec(shellScript('echo working; sleep 30', 1, { file, nonce }, outputs), { timeoutMs: 40_000 });
	const shaped = shellResult('echo working; sleep 30', result, { file, nonce }, 1, false);
	assert.equal(
		shaped.content[0].text,
		'working\n[anton] Stopped after 3 minutes, the time a command gets when it names no timeout. For a command that needs longer, pass timeout (in seconds), or start it with run_in_background (if you have it) and go on working.\n\nCommand exited with code 124',
	);
	assert.equal(stoppedNote(30, true), '[anton] Command timed out after 30 seconds.');
});

test('secrets are hidden in what comes back, cut or whole, while the file holds the output as it was', async () => {
	assert.equal((await run('echo "token supersecretvalue"')).text, 'token [API_TOKEN hidden]');
	const long = await run('echo "first supersecretvalue"; seq 1 6000; echo "last supersecretvalue"');
	assert.match(long.text, /^first \[API_TOKEN hidden\]/);
	assert.match(long.text, /last \[API_TOKEN hidden\]$/);
	assert.doesNotMatch(long.text, /supersecretvalue/);
	assert.match(readFileSync(long.details.output!, 'utf8'), /^first supersecretvalue/);
	assert.match((await sandbox.exec(`head -1 ${long.details.output}`)).stdout, /first \[API_TOKEN hidden\]/, 'read back through a command, it is hidden again');
});

test("the reply clock and a job's notice still end a command's result", async () => {
	clockLines.push('\n[anton] 25m since this reply started.');
	assert.equal((await run('echo ok')).text, 'ok\n\n[anton] 25m since this reply started.');
	clockLines.push('\n[anton] 26m since this reply started.');
	assert.equal((await run('echo bad; exit 1')).text, 'bad\n\n[anton] 26m since this reply started.\n\nCommand exited with code 1');
});

test('a command returns when it leaves a server running in the background', async () => {
	const started = Date.now();
	const result = await run('sleep 21 & echo started');
	assert.equal(result.text, 'started');
	assert.ok(Date.now() - started < 5_000, 'did not wait for the background job');
	const alive = await machine.exec('pgrep -f "^sleep 21$"');
	assert.equal(alive.exitCode, 0, 'the background job keeps running');
	await machine.exec('pkill -f "^sleep 21$" || true');
});

test('stopping the reply stops the command', async () => {
	const controller = new AbortController();
	const pending = run('echo go; sleep 22 | cat', 60, controller.signal);
	await new Promise((resolve) => setTimeout(resolve, 700));
	controller.abort();
	await assert.rejects(pending);
	await new Promise((resolve) => setTimeout(resolve, 700));
	assert.equal(new TextDecoder().decode((await machine.exec('pgrep -f "^sleep 22$" || true')).stdout).trim(), '');
});

test('only so many outputs are kept, the oldest dropped first', async () => {
	for (const name of kept()) rmSync(path.join(outputs, name));
	const names: string[] = [];
	for (let index = 0; index < KEEP_OUTPUTS + 3; index++) {
		names.push(path.basename((await run('seq 1 9000')).details.output!));
		await new Promise((resolve) => setTimeout(resolve, 15));
	}
	assert.deepEqual(kept().sort(), names.slice(3).sort());
});

test("the sandbox's other commands come back as they did: stdout and stderr apart, nothing cut, nothing saved", async () => {
	const before = kept().length;
	const result = await sandbox.exec('seq 1 20000; echo warn >&2');
	assert.equal(result.stdout.split('\n').length, 20001);
	assert.equal(result.stderr, 'warn\n');
	assert.equal(result.exitCode, 0);
	assert.equal(kept().length, before);
	assert.equal(new TextDecoder().decode((await machine.exec('echo plain')).stdout), 'plain\n');
});

test("the prompts say a long result is cut, and no longer give a figure bash's results do not keep to", async () => {
	const { workspacePrompts } = await import('../src/agents/coder.ts');
	for (const profile of ['edit', 'patch'] as const) {
		const prompts = workspacePrompts(profile);
		for (const name of ['task', 'workspace', 'chatWorkspace'] as const) {
			assert.match(prompts[name], /since a long result is cut and everything you read is sent again with every later step/, `${profile} ${name}`);
			assert.doesNotMatch(prompts[name], /50 ?KB/, `${profile} ${name}`);
		}
	}
});

test('output cut in memory (when the script never printed its end) keeps its start and end, cut at line ends', () => {
	const output = Array.from({ length: 4000 }, (_, index) => `entry ${index}`).join('\n');
	const cut = cutInMemory(output);
	assert.match(cut, /^entry 0\n/);
	assert.match(cut, /\nentry 3999$/);
	assert.match(cut, /\n\[[\d,]+ lines \([\d.]+ KB\) cut here\.\]\n/);
	assert.equal(cutInMemory('short\n'), 'short\n');
	// One long line is cut where it is.
	assert.match(startAndEnd('a'.repeat(50), 'b'.repeat(50), 1000, 0, null), /^a{50}\n\[0 lines \(0\.9 KB\) cut here\.\]\nb{50}$/);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RuntimeToolOutput } from '../src/core/ports.ts';
import { STILL_RUNNING, WorkspaceBridge } from '../src/providers/acp/workspace-bridge.ts';
import { numberedLines } from '../src/services/sandbox/repo-snapshot.ts';

type Call = { name: string; args: Record<string, unknown> };

function bridge(answer: (call: Call) => RuntimeToolOutput, tools = ['read', 'write', 'bash']) {
	const calls: Call[] = [];
	const b = new WorkspaceBridge(
		async (name, args) => {
			calls.push({ name, args });
			return answer({ name, args });
		},
		(name) => tools.includes(name),
		'/work',
	);
	return { b, calls };
}

const text = (t: string, isError = false): RuntimeToolOutput => ({ content: [{ type: 'text', text: t }], isError });

/** Answers `read` the way Anton's own tool does, numbered lines and all, from these files. */
const files = (map: Record<string, string>) => (call: Call) => {
	const file = map[String(call.args.path)];
	if (file === undefined) return text(`${String(call.args.path)} does not exist. List files to find the right path.`);
	return text(numberedLines(file, call.args.offset as number | undefined, call.args.limit as number | undefined));
};

test('a file read under the agent\'s cwd returns the file\'s own text, without the read tool\'s line numbers', async () => {
	const source = '\tconst a = 1;\n12\tnot a number\n\n';
	const { b, calls } = bridge(files({ 'src/a.ts': source }));
	assert.deepEqual(await b.handle('fs/read_text_file', { sessionId: 's', path: '/work/src/a.ts' }), { content: source });
	assert.deepEqual(calls.map((c) => c.args), [{ path: 'src/a.ts', limit: 2000 }]);
});

test('a long file is read whole across pages, and a ranged read returns just its lines', async () => {
	const source = Array.from({ length: 4500 }, (_, i) => `line ${i + 1}`).join('\n');
	const { b, calls } = bridge(files({ 'big.ts': source }));
	assert.deepEqual(await b.handle('fs/read_text_file', { path: '/work/big.ts' }), { content: source });
	assert.deepEqual(calls.map((c) => c.args.offset), [undefined, 2001, 4001]);
	assert.deepEqual(await b.handle('fs/read_text_file', { path: '/work/big.ts', line: 1999, limit: 3 }), { content: 'line 1999\nline 2000\nline 2001' });
	assert.deepEqual(await b.handle('fs/read_text_file', { path: '/work/big.ts', line: 4499, limit: 20001 }), { content: 'line 4499\nline 4500' });
	assert.deepEqual(await b.handle('fs/read_text_file', { path: '/work/big.ts', line: 9000 }), { content: '' });
});

test('a line too long to read whole is refused, never returned as the file', async () => {
	const { b } = bridge(files({ 'big.min.js': `ok\n${'x'.repeat(5000)}` }));
	await assert.rejects(b.handle('fs/read_text_file', { path: '/work/big.min.js' })!, /too long/);
});

test('a missing file fails the request with the read\'s answer', async () => {
	const { b } = bridge(files({}));
	await assert.rejects(b.handle('fs/read_text_file', { path: '/work/gone.ts' })!, /gone\.ts does not exist/);
});

test('writes go to the repo path, and a failed tool is a failed request', async () => {
	const { b, calls } = bridge(({ name }) => (name === 'write' ? text('Successfully wrote') : text('nope', true)));
	assert.equal(await b.handle('fs/write_text_file', { path: '/work/README.md', content: 'hi' }), null);
	assert.deepEqual(calls[0], { name: 'write', args: { path: 'README.md', content: 'hi' } });
	await assert.rejects(b.handle('fs/read_text_file', { path: '/etc/hosts' })!, /nope/);
	assert.equal(calls[1]?.args.path, '/etc/hosts', 'a path outside the cwd passes through');
});

/** The agent's command inside a terminal step, as the step quotes it in `__c`. */
const commandOf = (script: unknown) => /\n__c='((?:[^']|'\\'')*)'\n/.exec(String(script))?.[1]?.replace(/'\\''/g, "'");

test('a terminal runs detached in the repo, in one bash step when it ends in time, with its exit code and output', async () => {
	const { b, calls } = bridge(() => text('FAIL src/a.test.ts\n\nCommand exited with code 1'));
	const { terminalId } = (await b.handle('terminal/create', { command: 'npm', args: ['test', '--', "it's"], cwd: '/work/pkg', env: [{ name: 'CI', value: '1' }] })) as { terminalId: string };
	assert.deepEqual(await b.handle('terminal/wait_for_exit', { terminalId }), { exitCode: 1, signal: null });
	assert.deepEqual(await b.handle('terminal/output', { terminalId }), { output: 'FAIL src/a.test.ts', truncated: false, exitStatus: { exitCode: 1, signal: null } });
	assert.equal(calls.length, 1, 'a command that ends in time is one step');
	assert.equal(commandOf(calls[0]?.args.command), `export NO_COLOR=1 FORCE_COLOR=0; export CI='1'; cd 'pkg' && npm 'test' '--' 'it'\\''s'`);
	assert.match(String(calls[0]?.args.command), /^# export CI='1'; cd 'pkg' && npm 'test'/, 'the line the thread shows names the command');
	assert.match(String(calls[0]?.args.command), /setsid/);
	assert.equal(await b.handle('terminal/release', { terminalId }), null);
	const second = (await b.handle('terminal/create', { command: 'ls', cwd: '/work' })) as { terminalId: string };
	await b.handle('terminal/wait_for_exit', second);
	assert.equal(commandOf(calls[1]?.args.command), 'export NO_COLOR=1 FORCE_COLOR=0; ls', 'no cd into the repo root it already runs in');
	await assert.rejects(b.handle('terminal/output', { terminalId })!, /Unknown terminal/);
});

test('a command still running returns its output so far, never holds the next command, and can be waited on or stopped', async () => {
	const steps: string[] = [];
	let suiteWaits = 0;
	const { b } = bridge(({ args }) => {
		const script = String(args.command);
		const first = script.split('\n')[0]!;
		steps.push(first);
		if (first === '# ls') return text('a.ts');
		if (first.startsWith('# stopping:')) return text('Ready on 5173\n\nCommand exited with code 143');
		if (first === '# waiting for: npm test' && ++suiteWaits === 2) return text('all passed');
		return text(`Ready on 5173\n\n${STILL_RUNNING}\n[anton] 3m since this reply started.`);
	});
	const server = (await b.handle('terminal/create', { command: 'npm run dev' })) as { terminalId: string };
	const status = (await b.handle('terminal/output', server)) as { output: string; exitStatus: unknown };
	assert.equal(status.exitStatus, null, 'no exit yet, and no wait on the step that is running');
	const ls = (await b.handle('terminal/create', { command: 'ls' })) as { terminalId: string };
	assert.deepEqual(await b.handle('terminal/wait_for_exit', ls), { exitCode: 0, signal: null });
	const polled = (await b.handle('terminal/output', server)) as { output: string; exitStatus: unknown };
	assert.match(polled.output, /^Ready on 5173/);
	assert.doesNotMatch(polled.output, /still running/);
	assert.equal(polled.exitStatus, null);
	assert.equal(await b.handle('terminal/kill', server), null);
	assert.deepEqual(await b.handle('terminal/wait_for_exit', server), { exitCode: 143, signal: null });
	assert.deepEqual(steps.filter((s) => s.startsWith('# stopping:')), ['# stopping: npm run dev']);

	const suite = (await b.handle('terminal/create', { command: 'npm test' })) as { terminalId: string };
	assert.deepEqual(await b.handle('terminal/wait_for_exit', suite), { exitCode: 0, signal: null });
	assert.deepEqual(steps.filter((s) => s.startsWith('# waiting for:')), ['# waiting for: npm test', '# waiting for: npm test']);
});

test('the user\'s words ride with the next command output the agent reads', async () => {
	let waiting: string | null = '<user_message>\nuse pierre\n</user_message>';
	const b = new WorkspaceBridge(
		async () => text('ok'),
		() => true,
		'/work',
		() => {
			const note = waiting;
			waiting = null;
			return note;
		},
	);
	const term = (await b.handle('terminal/create', { command: 'true' })) as { terminalId: string };
	await b.handle('terminal/wait_for_exit', term);
	assert.deepEqual(await b.handle('terminal/output', term), { output: 'ok\n\n<user_message>\nuse pierre\n</user_message>', truncated: false, exitStatus: { exitCode: 0, signal: null } });
	assert.equal(((await b.handle('terminal/output', term)) as { output: string }).output, 'ok', 'once only');
});

test('before a workspace exists the agent is told to start one', async () => {
	const { b, calls } = bridge(() => text(''), ['start_workspace']);
	await assert.rejects(b.handle('fs/read_text_file', { path: '/work/a' })!, /start_workspace/);
	assert.throws(() => b.handle('terminal/create', { command: 'ls' }), /start_workspace/);
	assert.equal(calls.length, 0);
	assert.equal(b.handle('session/unknown', {}), undefined);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RuntimeToolOutput } from '../src/core/ports.ts';
import { WorkspaceBridge } from '../src/providers/acp/workspace-bridge.ts';

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

test('a file read under the agent\'s cwd reads the repo-relative path, whole across chunks', async () => {
	const { b, calls } = bridge(({ args }) =>
		args.offset === 3 ? text('c\nd') : text('a\nb\n\n[Showing lines 1-2 of 4. Use offset=3 to continue.]'),
	);
	assert.deepEqual(await b.handle('fs/read_text_file', { sessionId: 's', path: '/work/src/a.ts' }), { content: 'a\nb\nc\nd' });
	assert.deepEqual(calls.map((c) => c.args), [{ path: 'src/a.ts' }, { path: 'src/a.ts', offset: 3 }]);
});

test('a line too long to read whole is refused, never returned as the file', async () => {
	const { b } = bridge(() => text('abc\n\n[Line 1 exceeds the 51200-byte read limit; showing the first 51200 bytes of it.]'));
	await assert.rejects(b.handle('fs/read_text_file', { path: '/work/big.min.js' })!, /too long/);
});

test('writes go to the repo path, and a failed tool is a failed request', async () => {
	const { b, calls } = bridge(({ name }) => (name === 'write' ? text('Successfully wrote') : text('nope', true)));
	assert.equal(await b.handle('fs/write_text_file', { path: '/work/README.md', content: 'hi' }), null);
	assert.deepEqual(calls[0], { name: 'write', args: { path: 'README.md', content: 'hi' } });
	await assert.rejects(b.handle('fs/read_text_file', { path: '/etc/hosts' })!, /nope/);
	assert.equal(calls[1]?.args.path, '/etc/hosts', 'a path outside the cwd passes through');
});

test('a terminal runs as bash in the repo and reports its exit code and output', async () => {
	const { b, calls } = bridge(() => text('FAIL src/a.test.ts\n\nCommand exited with code 1'));
	const { terminalId } = (await b.handle('terminal/create', { command: 'npm', args: ['test', '--', "it's"], cwd: '/work/pkg', env: [{ name: 'CI', value: '1' }] })) as { terminalId: string };
	assert.deepEqual(await b.handle('terminal/wait_for_exit', { terminalId }), { exitCode: 1, signal: null });
	assert.deepEqual(await b.handle('terminal/output', { terminalId }), { output: 'FAIL src/a.test.ts', truncated: false, exitStatus: { exitCode: 1, signal: null } });
	assert.equal(calls[0]?.args.command, `export CI='1'; cd 'pkg' && npm 'test' '--' 'it'\\''s'`);
	assert.equal(await b.handle('terminal/release', { terminalId }), null);
	const second = (await b.handle('terminal/create', { command: 'ls', cwd: '/work' })) as { terminalId: string };
	await b.handle('terminal/wait_for_exit', second);
	assert.equal(calls[1]?.args.command, 'ls', 'no cd into the repo root it already runs in');
	await assert.rejects(b.handle('terminal/output', { terminalId })!, /Unknown terminal/);
});

test('before a workspace exists the agent is told to start one', async () => {
	const { b, calls } = bridge(() => text(''), ['start_workspace']);
	await assert.rejects(b.handle('fs/read_text_file', { path: '/work/a' })!, /start_workspace/);
	assert.throws(() => b.handle('terminal/create', { command: 'ls' }), /start_workspace/);
	assert.equal(calls.length, 0);
	assert.equal(b.handle('session/unknown', {}), undefined);
});

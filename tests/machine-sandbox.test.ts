import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ExecOptions, Machine } from '../src/core/ports.ts';
import { EXEC_TIMEOUT_MS, machineSandbox } from '../src/flue/machine-sandbox.ts';

test('a command through the sandbox gets a timeout when it names none, and keeps its own', async () => {
	const seen: Array<number | undefined> = [];
	const machine = {
		id: 'fake',
		root: '/work',
		exec: async (_command: string, options?: ExecOptions) => {
			seen.push(options?.timeoutMs);
			return { stdout: new Uint8Array(), stderr: '', exitCode: 0 };
		},
	} as unknown as Machine;
	const sandbox = machineSandbox(machine, '/work/repo');
	await sandbox.exec('grep -rl 10723 /');
	await sandbox.exec('make docs', { timeoutMs: 3_600_000 });
	assert.deepEqual(seen, [EXEC_TIMEOUT_MS, 3_600_000]);
});

test("a command's result ends with the line the clock gives, when it gives one", async () => {
	const machine = { id: 'fake', root: '/work', exec: async () => ({ stdout: new TextEncoder().encode('ok\n'), stderr: 'warn', exitCode: 0 }) } as unknown as Machine;
	const lines = ['', '\n[anton] 25m since this reply started.'];
	const sandbox = machineSandbox(machine, '/work/repo', () => true, {}, undefined, () => lines.shift() ?? '');
	assert.equal((await sandbox.exec('true')).stderr, 'warn');
	const told = await sandbox.exec('true');
	assert.equal(told.stderr, 'warn\n[anton] 25m since this reply started.');
	assert.equal(told.stdout, 'ok\n');
});

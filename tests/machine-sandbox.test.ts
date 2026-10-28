import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ExecOptions, Machine } from '../src/core/ports.ts';
import { COMMAND_TIMEOUT_MS, machineSandbox } from '../src/flue/machine-sandbox.ts';

test("the agent's command gets a timeout when it names none, and keeps its own", async () => {
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
	assert.deepEqual(seen, [COMMAND_TIMEOUT_MS, 3_600_000]);
});

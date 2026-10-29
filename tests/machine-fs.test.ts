import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readMachineFile } from '../src/core/machine-fs.ts';
import type { ExecResult, Machine } from '../src/core/ports.ts';

/** A machine whose output arrives cut short the first `cuts` times, as Modal's did when a large file paused on its way out. */
function machine(file: Uint8Array, cuts: number) {
	const commands: string[] = [];
	const exec = async (command: string): Promise<ExecResult> => {
		commands.push(command);
		const shown = cuts-- > 0 ? file.subarray(0, file.length - 100) : file;
		return { stdout: shown, stderr: `      ${file.length}\n`, exitCode: 0 };
	};
	return { machine: { id: 'm', root: '/w', exec } as unknown as Machine, commands };
}

const screenshot = new Uint8Array(4096).map((_, index) => index % 251);

test('a file whose bytes arrived cut short is read again, so a broken copy never passes for whole', async () => {
	const { machine: m, commands } = machine(screenshot, 1);
	assert.deepEqual(await readMachineFile(m, '/w/outputs/shot.png'), screenshot);
	assert.equal(commands.length, 2);
	assert.match(commands[0], /wc -c < '\/w\/outputs\/shot\.png' >&2 && cat -- '\/w\/outputs\/shot\.png'/);
});

test('a read that keeps arriving short fails rather than returning part of the file', async () => {
	const { machine: m, commands } = machine(screenshot, 5);
	await assert.rejects(readMachineFile(m, '/w/outputs/shot.png'), /3996 of 4096 bytes/);
	assert.equal(commands.length, 3);
});

test('a whole file is read once', async () => {
	const { machine: m, commands } = machine(screenshot, 0);
	assert.equal((await readMachineFile(m, '/w/a')).length, 4096);
	assert.equal(commands.length, 1);
});

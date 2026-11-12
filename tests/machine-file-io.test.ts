import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { type Sandbox, SandboxFilesystemFileTooLargeError, SandboxFilesystemNotFoundError } from 'modal';
import { readMachineFile, writeMachineFile } from '../src/core/machine-fs.ts';
import type { ExecResult, Machine } from '../src/core/ports.ts';
import { CommandError } from '../src/core/shell.ts';
import { localSandboxProvider } from '../src/providers/local/sandbox.ts';
import { modalMachine } from '../src/providers/modal/sandbox.ts';

const dir = mkdtempSync(path.join(os.tmpdir(), 'anton-fileio-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const resources = { runtime: 'container' as const, cpu: 1, memoryMiB: 1024, idleTimeoutMs: 60_000, lifetimeMs: 60_000, regions: [], allowedDomains: [] };
const { machine } = await localSandboxProvider(path.join(dir, 'data')).acquire({ key: 'files', state: null, image: null, baseImage: null, ports: [], resources });

/** The same machine counting its commands, and the same without its own file access, as every machine was before. */
function counted(own: Machine) {
	const commands: string[] = [];
	const exec = (command: string, options?: Parameters<Machine['exec']>[1]) => (commands.push(command), own.exec(command, options));
	return { direct: { ...own, exec } as Machine, shell: { ...own, exec, readFile: undefined, writeFile: undefined } as Machine, commands };
}

const every = new Uint8Array(70_000).map((_, index) => (index * 7) % 256);

test('the local machine reads and writes files without a command, with the same bytes as through the shell', async () => {
	const { direct, shell, commands } = counted(machine);
	for (const [name, bytes] of [['every-byte.bin', every], ['empty.txt', new Uint8Array()], ['text.txt', new TextEncoder().encode('one\ntwo\n')]] as const) {
		await writeMachineFile(direct, `${machine.root}/${name}`, bytes);
		assert.deepEqual(await readMachineFile(shell, `${machine.root}/${name}`), bytes, `${name} written directly reads the same through the shell`);
		await writeMachineFile(shell, `${machine.root}/shell-${name}`, bytes);
		assert.deepEqual(await readMachineFile(direct, `${machine.root}/shell-${name}`), bytes, `${name} written through the shell reads the same directly`);
	}
	const before = commands.length;
	await writeMachineFile(direct, `${machine.root}/again.bin`, every);
	assert.deepEqual(await readMachineFile(direct, `${machine.root}/again.bin`), every);
	assert.equal(commands.length, before, 'no command for a direct read or write');
	// A relative path is from the folder commands run in, as for `cat`.
	await writeMachineFile(direct, 'relative.txt', new TextEncoder().encode('here'));
	assert.equal(new TextDecoder().decode(await readMachineFile(shell, 'relative.txt')), 'here');
});

test('the local machine fails as the shell does: the same error, operation, path and reason, and no folder made', async () => {
	const { direct, shell } = counted(machine);
	const locked = `${machine.root}/locked.txt`;
	writeFileSync(locked, 'secret');
	chmodSync(locked, 0o000);
	const cases: Array<[string, (m: Machine) => Promise<unknown>]> = [
		['missing file', (m) => readMachineFile(m, `${machine.root}/no-such-file`)],
		['folder read', (m) => readMachineFile(m, machine.root)],
		['missing folder', (m) => writeMachineFile(m, `${machine.root}/no/such/folder/file.txt`, every)],
		['folder written', (m) => writeMachineFile(m, machine.root, every)],
		['file as a folder', (m) => readMachineFile(m, `${machine.root}/again.bin/inside`)],
		...(process.getuid?.() === 0 ? [] : ([['no permission', (m: Machine) => readMachineFile(m, locked)]] as Array<[string, (m: Machine) => Promise<unknown>]>)),
	];
	for (const [name, attempt] of cases) {
		const [byShell, byDirect] = await Promise.all([attempt(shell).then(() => null, (error: unknown) => error), attempt(direct).then(() => null, (error: unknown) => error)]);
		assert.ok(byShell instanceof CommandError && byDirect instanceof CommandError, name);
		const [shellOp, shellReason] = [/^`(\w+ [^`]+)` failed/.exec(byShell.message)?.[1], byShell.message.split(': ').pop()];
		assert.equal(/^`(\w+ [^`]+)` failed/.exec(byDirect.message)?.[1], shellOp, `${name}: the same operation and path`);
		assert.equal(byDirect.message.split(': ').pop(), shellReason, `${name}: the same reason (${byShell.message})`);
	}
	assert.equal(existsSync(`${machine.root}/no`), false, 'a write never makes the folders it lacks');
	chmodSync(locked, 0o600);
});

/** A Modal sandbox as far as a file read or write uses it: an exec that runs a shell command, and the file API. */
function fakeModal(files: Record<string, Uint8Array>, failure?: Error) {
	const calls: string[] = [];
	const stream = (bytes: Uint8Array) => new ReadableStream<Uint8Array>({ start: (controller) => (controller.enqueue(bytes), controller.close()) });
	const sandbox = {
		sandboxId: 'sb-test',
		async exec(argv: string[]) {
			calls.push(`exec ${argv.join(' ')}`);
			const file = /cat (?:-- )?'([^']+)'/.exec(argv[2])?.[1] ?? '';
			const written: Uint8Array[] = [];
			return {
				stdin: new WritableStream<Uint8Array>({ write: (chunk) => void written.push(chunk), close: () => void (files[file] = new Uint8Array(Buffer.concat(written))) }),
				stdout: stream(argv[2].includes('cat >') ? new Uint8Array() : (files[file] ?? new Uint8Array())),
				stderr: stream(new TextEncoder().encode(argv[2].includes('wc -c') ? `${files[file]?.length ?? 0}\n` : '')),
				wait: async () => 0,
			};
		},
		filesystem: {
			async readBytes(file: string) {
				calls.push(`readBytes ${file}`);
				if (failure) throw failure;
				return files[file];
			},
			async writeBytes(data: Uint8Array, file: string) {
				calls.push(`writeBytes ${file}`);
				if (failure) throw failure;
				files[file] = data;
			},
		},
	};
	return { sandbox: sandbox as unknown as Sandbox, calls, files };
}

test('a Modal machine reads and writes through a login shell, as before, unless ANTON_SANDBOX_FILE_API turns the file API on', async () => {
	const off = fakeModal({ '/workspace/a.txt': new TextEncoder().encode('hello') });
	const machineOff = modalMachine(off.sandbox);
	assert.equal(machineOff.readFile, undefined);
	assert.equal(machineOff.writeFile, undefined);
	assert.equal(new TextDecoder().decode(await readMachineFile(machineOff, '/workspace/a.txt')), 'hello');
	await writeMachineFile(machineOff, '/workspace/b.txt', every);
	assert.deepEqual(off.files['/workspace/b.txt'], every);
	assert.deepEqual(off.calls, ["exec bash -lc wc -c < '/workspace/a.txt' >&2 && cat -- '/workspace/a.txt'", "exec bash -lc cat > '/workspace/b.txt'"]);

	const on = fakeModal({ '/workspace/a.txt': new TextEncoder().encode('hello') });
	const machineOn = modalMachine(on.sandbox, true);
	assert.equal(new TextDecoder().decode(await readMachineFile(machineOn, '/workspace/a.txt')), 'hello');
	await writeMachineFile(machineOn, '/workspace/b.txt', every);
	assert.deepEqual(on.files['/workspace/b.txt'], every);
	assert.deepEqual(on.calls, ['readBytes /workspace/a.txt', 'writeBytes /workspace/b.txt']);
	// The file API takes absolute paths only: a relative one goes to the shell.
	await readMachineFile(machineOn, 'a.txt');
	assert.match(on.calls.at(-1)!, /^exec bash -lc wc -c < 'a\.txt'/);
});

test("with the file API on, a missing file fails as the shell's read does, and a file past its limit is read by the shell", async () => {
	const missing = modalMachine(fakeModal({}, new SandboxFilesystemNotFoundError('No such file: /workspace/gone')).sandbox, true);
	await assert.rejects(readMachineFile(missing, '/workspace/gone'), (error: unknown) => error instanceof CommandError && error.message === '`read /workspace/gone` failed: /workspace/gone: No such file or directory');
	await assert.rejects(writeMachineFile(missing, '/workspace/gone/x', every), /`write \/workspace\/gone\/x` failed: \/workspace\/gone\/x: No such file or directory/);
	const large = fakeModal({ '/workspace/big.bin': every }, new SandboxFilesystemFileTooLargeError('too large'));
	assert.deepEqual(await readMachineFile(modalMachine(large.sandbox, true), '/workspace/big.bin'), every);
	assert.deepEqual(large.calls, ['readBytes /workspace/big.bin', "exec bash -lc wc -c < '/workspace/big.bin' >&2 && cat -- '/workspace/big.bin'"]);
});

test('a machine without its own file access reads and writes through the shell exactly as before', async () => {
	const commands: string[] = [];
	const fake = {
		id: 'm',
		root: '/w',
		exec: async (command: string): Promise<ExecResult> => (commands.push(command), { stdout: new Uint8Array([1, 2]), stderr: '2\n', exitCode: 0 }),
	} as unknown as Machine;
	await readMachineFile(fake, '/w/x');
	await writeMachineFile(fake, '/w/y', every);
	assert.deepEqual(commands, ["wc -c < '/w/x' >&2 && cat -- '/w/x'", "cat > '/w/y'"]);
});

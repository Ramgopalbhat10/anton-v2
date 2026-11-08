import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';
import type { ExecResult, GitHost, Machine, ModelCatalog, ObjectStore, SandboxProvider } from '../src/core/ports.ts';

const dir = mkdtempSync(path.join(os.tmpdir(), 'anton-machine-download-'));
process.env.ANTON_DATA_DIR = dir;

/** The store's objects, and what its links serve: the same bytes unless a test serves others. */
const objects = new Map<string, Uint8Array>();
const served = new Map<string, Uint8Array>();
let gets: string[] = [];
let links = true;

const server = createServer((request, response) => {
	const url = new URL(request.url ?? '/', 'http://x');
	const key = decodeURIComponent(url.pathname.slice(1));
	const body = url.searchParams.get('sig') === 'ok' ? (served.get(key) ?? objects.get(key)) : undefined;
	response.writeHead(body ? 200 : 404).end(body ? Buffer.from(body) : undefined);
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => {
	server.close();
	rmSync(dir, { recursive: true, force: true });
});

const store = {
	name: 'test',
	get: async (key: string) => {
		gets.push(key);
		return objects.get(key) ?? null;
	},
	signedUrl: async (key: string) => `${base}/${encodeURIComponent(key)}?sig=ok`,
} as unknown as ObjectStore & { signedUrl?: ObjectStore['signedUrl'] };
const { setProviders } = await import('../src/providers/index.ts');
setProviders({
	git: {} as GitHost,
	get store() {
		return links ? store : { ...store, signedUrl: undefined };
	},
	sandbox: {} as SandboxProvider,
	models: {} as ModelCatalog,
} as never);
const { downloadInto } = await import('../src/services/machine-download.ts');

/** A machine that is a folder on this computer, recording each command it runs. */
function folderMachine(): Machine & { commands: string[] } {
	const root = mkdtempSync(path.join(dir, 'machine-'));
	const commands: string[] = [];
	return {
		id: root,
		root,
		commands,
		exec: (command, options = {}) =>
			new Promise<ExecResult>((resolve) => {
				commands.push(command);
				const child = spawn('bash', ['-c', command], { cwd: options.cwd ?? root });
				const out: Buffer[] = [];
				let err = '';
				child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
				child.stderr.on('data', (chunk: Buffer) => (err += chunk));
				child.on('close', (code) => resolve({ stdout: new Uint8Array(Buffer.concat(out)), stderr: err, exitCode: code ?? 1 }));
				child.stdin.end(options.stdin ? Buffer.from(options.stdin) : undefined);
			}),
	} as Machine & { commands: string[] };
}

const bytes = (value: string) => new TextEncoder().encode(value);
const put = (key: string, value: string) => objects.set(key, bytes(value));

beforeEach(() => {
	objects.clear();
	served.clear();
	gets = [];
	links = true;
});

test('the machine fetches the files itself, in one command, with the links on stdin rather than the command line', async () => {
	put('spaces/s/files/a.png', 'aaa');
	put('spaces/s/files/notes/plan "v2".md', 'the plan');
	const machine = folderMachine();
	const missing = await downloadInto(machine, [
		{ key: 'spaces/s/files/a.png', target: `${machine.root}/project-files/a.png`, size: 3 },
		{ key: 'spaces/s/files/notes/plan "v2".md', target: `${machine.root}/project-files/notes/plan "v2".md`, size: 8 },
	]);
	assert.deepEqual(missing, []);
	assert.equal(readFileSync(`${machine.root}/project-files/a.png`, 'utf8'), 'aaa');
	assert.equal(readFileSync(`${machine.root}/project-files/notes/plan "v2".md`, 'utf8'), 'the plan');
	assert.deepEqual(gets, [], 'nothing passes through this server');
	assert.equal(machine.commands.length, 1);
	assert.doesNotMatch(machine.commands[0], /sig=ok/);
});

test('a file the machine got cut short is copied through this server; one gone from the store is reported', async () => {
	put('k/whole', 'whole file');
	put('k/short', 'the full contents');
	served.set('k/short', bytes('the full'));
	const machine = folderMachine();
	const target = (name: string) => `${machine.root}/outputs/${name}`;
	const missing = await downloadInto(machine, [
		{ key: 'k/whole', target: target('whole'), size: 10 },
		{ key: 'k/short', target: target('short'), size: 17 },
		{ key: 'k/gone', target: target('sub/gone'), size: 4 },
	]);
	assert.deepEqual(missing, [target('sub/gone')]);
	assert.equal(readFileSync(target('whole'), 'utf8'), 'whole file');
	assert.equal(readFileSync(target('short'), 'utf8'), 'the full contents');
	assert.deepEqual(gets.sort(), ['k/gone', 'k/short']);
});

test('a store that cannot make links copies every file through this server, several at once', async () => {
	links = false;
	for (let i = 0; i < 12; i += 1) put(`k/${i}`, `file ${i}`);
	const machine = folderMachine();
	const missing = await downloadInto(
		machine,
		Array.from({ length: 12 }, (_, i) => ({ key: `k/${i}`, target: `${machine.root}/project-files/dir ${i % 2}/${i}.txt` })),
	);
	assert.deepEqual(missing, []);
	for (let i = 0; i < 12; i += 1) assert.equal(readFileSync(`${machine.root}/project-files/dir ${i % 2}/${i}.txt`, 'utf8'), `file ${i}`);
	assert.equal(gets.length, 12);
	assert.ok(!machine.commands.some((command) => command.includes('curl')));
});

test('a machine without curl gets the files through this server', async () => {
	put('k/a', 'abc');
	const machine = folderMachine();
	const exec = machine.exec.bind(machine);
	machine.exec = (command, options) => exec(command.replace('command -v curl', 'command -v no-such-curl'), options);
	assert.deepEqual(await downloadInto(machine, [{ key: 'k/a', target: `${machine.root}/project-files/a`, size: 3 }]), []);
	assert.equal(readFileSync(`${machine.root}/project-files/a`, 'utf8'), 'abc');
	assert.deepEqual(gets, ['k/a']);
});

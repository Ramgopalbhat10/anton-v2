import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ExecOptions, ExecResult, Machine } from '../src/core/ports.ts';
import { desktopLayout, desktopRunning } from '../src/core/desktop.ts';

const { browse } = await import('../src/services/browser.ts');
const { ensureDesktop, forgetDesktop } = await import('../src/services/computer.ts');

const answer = new TextEncoder().encode(JSON.stringify({ url: 'http://localhost:3000/', title: 'App', status: 200, problem: null, snapshot: '- button "Add one"' }));

/** A machine with a browser running, that notes every command; each is a round trip to the sandbox. */
function machine(root: string) {
	const commands: string[] = [];
	const state = { gone: 0 };
	const exec = async (command: string, _options?: ExecOptions): Promise<ExecResult> => {
		commands.push(command);
		if (command.startsWith('node ') && state.gone-- > 0) return { stdout: new Uint8Array(), stderr: "Error: Cannot find module '/tmp/x-client.cjs'", exitCode: 1 };
		return { stdout: command.startsWith('node ') ? answer : new Uint8Array(), stderr: '', exitCode: 0 };
	};
	return { machine: { id: `m-${root}`, root, exec } as unknown as Machine, commands, state };
}

test('a browser step after the first sends its command alone, one round trip', async () => {
	const { machine: m, commands } = machine('/w/one');
	await browse(m, { action: 'open', url: 'http://localhost:3000' });
	const first = commands.length;
	assert.ok(first >= 3, 'the first step installs the browser and writes the client');
	await browse(m, { action: 'click', target: 'role=button[name="Add one"]' });
	await browse(m, { action: 'look' });
	assert.equal(commands.length, first + 2);
	assert.ok(commands.slice(first).every((command) => command.startsWith('node ')));
});

test('a client that went is written again, and the step still answers', async () => {
	const { machine: m, commands, state } = machine('/w/two');
	await browse(m, { action: 'look' });
	const before = commands.length;
	state.gone = 1;
	const page = await browse(m, { action: 'look' });
	assert.equal(page.title, 'App');
	const again = commands.slice(before);
	assert.equal(again.filter((command) => command.startsWith('node ')).length, 2, 'sent, then sent again once set up');
	assert.ok(again.some((command) => command.includes('-client.cjs') && command.startsWith('cat >')), 'the client is written again');
});

test('a desktop seen running is not asked about again at every step, until the computer is turned off', async () => {
	const { machine: m, commands } = machine('/w/desk');
	const running = desktopRunning(desktopLayout('/w/desk'));
	assert.equal(await ensureDesktop(m), false, 'already running, so not started');
	assert.equal(await ensureDesktop(m), false);
	assert.equal(commands.filter((command) => command === running).length, 1);
	forgetDesktop(m);
	await ensureDesktop(m);
	assert.equal(commands.filter((command) => command === running).length, 2);
});

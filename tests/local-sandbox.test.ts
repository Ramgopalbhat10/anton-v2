import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { localSandboxProvider } from '../src/providers/local/sandbox.ts';

const dir = mkdtempSync(path.join(os.tmpdir(), 'anton-local-'));
after(() => rmSync(dir, { recursive: true, force: true }));

test('a command returns when it leaves a server running in the background', async () => {
	const { machine } = await localSandboxProvider(dir).acquire({ key: 'bg', state: null, image: null, baseImage: null, ports: [] });
	const started = Date.now();
	// The background job keeps the shell's output open, as `npm run dev &` does.
	const result = await machine.exec('sleep 20 & echo started');
	assert.equal(result.exitCode, 0);
	assert.equal(new TextDecoder().decode(result.stdout).trim(), 'started');
	assert.ok(Date.now() - started < 5000, 'did not wait for the background job');
	await machine.exec('pkill -f "^sleep 20$" || true');
});

test('a background server that logs to the shell keeps running after the command returns', async () => {
	const { machine } = await localSandboxProvider(dir).acquire({ key: 'bg-log', state: null, image: null, baseImage: null, ports: [] });
	const server = `require('http').createServer((q, s) => { console.log('hit', q.url); s.end('ok'); }).listen(43391)`;
	await machine.exec(`node -e ${JSON.stringify(server)} & sleep 0.5; echo started`);
	await new Promise((resolve) => setTimeout(resolve, 1500));
	for (let attempt = 0; attempt < 3; attempt += 1) {
		const response = await fetch('http://127.0.0.1:43391/');
		assert.equal(await response.text(), 'ok', `request ${attempt} answered`);
	}
	await machine.exec('pkill -f "listen\\(43391\\)" || true');
});

test('output that keeps arriving after the shell exits is read in full', async () => {
	const { machine } = await localSandboxProvider(dir).acquire({ key: 'bg-out', state: null, image: null, baseImage: null, ports: [] });
	// The background writer outlives the shell but keeps writing; every byte it writes before going quiet counts.
	const result = await machine.exec('(for i in 1 2 3; do sleep 0.6; echo line$i; done) & echo first');
	assert.deepEqual(new TextDecoder().decode(result.stdout).trim().split('\n'), ['first', 'line1', 'line2', 'line3']);
});

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

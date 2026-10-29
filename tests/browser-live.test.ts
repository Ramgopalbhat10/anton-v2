import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const dir = mkdtempSync(path.join(os.tmpdir(), 'anton-browser-live-'));
process.env.ANTON_DATA_DIR = dir;

const { setProviders } = await import('../src/providers/index.ts');
const { localSandboxProvider } = await import('../src/providers/local/sandbox.ts');
const { diskStore } = await import('../src/providers/disk/store.ts');
const { insertSession } = await import('../src/db/sessions.ts');
const { browse, browserLiveUrl, closeBrowser } = await import('../src/services/browser.ts');
const { machineFor } = await import('../src/services/workspace.ts');

setProviders({ sandbox: localSandboxProvider(path.join(dir, 'data')), store: diskStore(path.join(dir, 'objects')), git: {} as never, models: { name: 'x', list: async () => [] } });
await insertSession({ id: 'live', projectId: null, title: 'Live', model: 'x', reasoning: null, branch: '', baseBranch: '', baseSha: '', planMode: false });

/** Checked as a local machine's commands run, without this computer's browser path, so a test never installs a browser. */
const hasBrowser = (() => {
	try {
		execSync(`env -u PLAYWRIGHT_BROWSERS_PATH NODE_PATH="$(npm root -g)" node -e "require('fs').accessSync(require('playwright').chromium.executablePath())"`, { stdio: 'ignore', shell: '/bin/bash' });
		return true;
	} catch {
		return false;
	}
})();

after(() => rmSync(dir, { recursive: true, force: true }));

/** A viewer of the live view: the frames and messages it got, and a way to send it input. */
async function watch(url: string) {
	const socket = new WebSocket(url);
	socket.binaryType = 'arraybuffer';
	const frames: Uint8Array[] = [];
	const messages: Array<Record<string, unknown>> = [];
	socket.addEventListener('message', (event) => {
		if (typeof event.data === 'string') messages.push(JSON.parse(event.data));
		else frames.push(new Uint8Array(event.data as ArrayBuffer));
	});
	await new Promise((resolve, reject) => {
		socket.addEventListener('open', resolve);
		socket.addEventListener('error', reject);
	});
	return { socket, frames, messages, send: (message: object) => socket.send(JSON.stringify(message)) };
}

async function until(check: () => boolean, ms = 10_000) {
	const end = Date.now() + ms;
	while (!check()) {
		if (Date.now() > end) throw new Error('timed out');
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

test('the sandbox browser runs headless, streams its tab to a viewer, and takes their mouse and keyboard', { skip: !hasBrowser && 'needs Playwright Chromium' }, async (t) => {
	const app = createServer((_request, response) => {
		response.setHeader('content-type', 'text/html');
		response.end('<title>Live</title><input id="name" style="position:absolute;left:20px;top:20px;width:200px;height:30px"><button id="add" style="position:absolute;left:20px;top:80px;width:120px;height:40px" onclick="this.textContent=\'Added\'">Add one</button>');
	});
	await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', resolve));
	const machine = await machineFor('live');
	t.after(async () => {
		app.close();
		await closeBrowser(machine);
	});
	assert.equal(await browserLiveUrl(machine), null, 'nothing to watch before the browser starts');
	const opened = await browse(machine, { action: 'open', url: `http://127.0.0.1:${(app.address() as AddressInfo).port}/` });
	assert.equal(opened.title, 'Live');

	const url = await browserLiveUrl(machine);
	assert.match(url ?? '', /^ws:\/\/localhost:\d+$/);
	const viewer = await watch(url!);
	t.after(() => viewer.socket.close());
	await until(() => viewer.frames.length > 0);
	const jpeg = viewer.frames[0];
	assert.deepEqual([...jpeg.subarray(0, 2)], [0xff, 0xd8], 'a JPEG frame');
	assert.deepEqual(viewer.messages.find((message) => message.type === 'size'), { type: 'size', width: 1280, height: 800 });

	// Taken over: a click and typing reach the page, and the agent's next step sees them.
	viewer.send({ type: 'down', x: 60, y: 100, button: 'left', clicks: 1 });
	viewer.send({ type: 'up', x: 60, y: 100, button: 'left', clicks: 1 });
	viewer.send({ type: 'down', x: 60, y: 35, button: 'left', clicks: 1 });
	viewer.send({ type: 'up', x: 60, y: 35, button: 'left', clicks: 1 });
	for (const [type, key] of [['keydown', 'Shift'], ['keydown', 'H'], ['keyup', 'H'], ['keyup', 'Shift'], ['keydown', 'i'], ['keyup', 'i'], ['keydown', 'é'], ['keyup', 'é']]) viewer.send({ type, key });
	await new Promise((resolve) => setTimeout(resolve, 500));
	const seen = await browse(machine, { action: 'look' });
	assert.match(seen.snapshot, /button "Added"/);
	assert.match(seen.snapshot, /textbox[^\n]*: Hié/);

	// A second viewer gets the last frame at once, without waiting for the page to repaint.
	const late = await watch(url!);
	t.after(() => late.socket.close());
	await until(() => late.frames.length > 0, 3_000);
});

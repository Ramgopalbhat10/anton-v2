import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { WebSocketServer } from 'ws';
import type { BrowserHost, HostedBrowser } from '../src/core/ports.ts';

const dir = mkdtempSync(path.join(os.tmpdir(), 'anton-release-'));
process.env.ANTON_DATA_DIR = dir;
// Connections are let go this long after their last use (15 seconds in Anton).
process.env.ANTON_BROWSER_RELEASE_MS = '80';

const { browserConnected, browserView, closeBrowser, navigate, openBrowser, watchBrowser } = await import('../src/services/live-browser.ts');
const { setProviders } = await import('../src/providers/index.ts');
const { upsertProject } = await import('../src/db/projects.ts');
const { insertSession } = await import('../src/db/sessions.ts');

/** A browser's DevTools endpoint, enough for the panel, counting the connections made to it. */
const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
let connected = 0;
const history = { currentIndex: 0, entries: [{ id: 1, url: 'https://example.com/', title: 'Example' }] };
server.on('connection', (socket) => {
	connected += 1;
	socket.on('message', (raw) => {
		const { id, method, params } = JSON.parse(String(raw));
		const reply = (result: unknown) => socket.send(JSON.stringify({ id, result }));
		if (method === 'Target.getTargets') return reply({ targetInfos: [{ targetId: 'tab-1', type: 'page', url: 'https://example.com/' }] });
		if (method === 'Target.attachToTarget') return reply({ sessionId: 'page-1' });
		if (method === 'Page.getNavigationHistory') return reply(history);
		if (method === 'Page.navigate') {
			history.entries.push({ id: history.entries.length + 1, url: params.url, title: 'Next' });
			history.currentIndex = history.entries.length - 1;
		}
		return reply({});
	});
});
await new Promise((resolve) => server.once('listening', resolve));

const hosted = new Map<string, HostedBrowser>();
const host: BrowserHost = {
	name: 'fake',
	async create() {
		const browser = { id: `b${hosted.size + 1}`, cdpUrl: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/devtools/browser/x`, liveViewUrl: 'https://live.example/view' };
		hosted.set(browser.id, browser);
		return browser;
	},
	get: async (id) => hosted.get(id) ?? null,
	async remove(id) {
		hosted.delete(id);
	},
};
setProviders({ sandbox: {} as never, store: {} as never, git: {} as never, models: { name: 'x', list: async () => [] }, browsers: host });
const project = await upsertProject('acme/demo', 'main');
await insertSession({ id: 'idle', projectId: project.id, title: 'Idle', model: 'x', reasoning: null, branch: 'main', baseBranch: 'main', baseSha: 'abc', planMode: false });
after(async () => {
	await closeBrowser('idle').catch(() => undefined);
	server.close();
	rmSync(dir, { recursive: true, force: true });
});

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('Anton lets go of an unused browser, so it stands by unbilled, and comes back to the same one when needed', async () => {
	await openBrowser('idle');
	assert.equal(browserConnected('idle'), true);
	await pause(200);
	assert.equal(browserConnected('idle'), false, 'nothing used it: the connection is let go');
	assert.equal(hosted.size, 1, 'the browser itself stays, with its pages');

	// Showing the panel does not wake the browser: it shows the page as last seen.
	const before = connected;
	const view = await browserView('idle');
	assert.equal(view.browser?.page?.url, 'https://example.com/');
	assert.equal(connected, before);
	assert.equal(browserConnected('idle'), false);

	// Using it connects again, to the same browser, and lets go again after.
	assert.equal((await navigate('idle', { url: 'example.com/next' })).url, 'https://example.com/next');
	assert.equal(connected, before + 1);
	assert.equal(hosted.size, 1);
	await pause(200);
	assert.equal(browserConnected('idle'), false);
	assert.equal((await browserView('idle')).browser?.page?.url, 'https://example.com/next', 'where it was left');
});

test('while the panel shows the live view, Anton stays connected to follow the page', async () => {
	await watchBrowser('idle');
	await pause(200);
	assert.equal(browserConnected('idle'), true, 'watched: the browser is billed for the live view anyway');
	await closeBrowser('idle');
	assert.equal(browserConnected('idle'), false);
	assert.equal(hosted.size, 0);
});

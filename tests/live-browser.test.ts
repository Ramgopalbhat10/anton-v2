import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { WebSocketServer } from 'ws';
import type { BrowserHost, HostedBrowser } from '../src/core/ports.ts';

const dir = mkdtempSync(path.join(os.tmpdir(), 'anton-browser-'));
process.env.ANTON_DATA_DIR = dir;

const { addressToUrl, agentBrowse, agentBusy, browserView, browserScreenshot, closeBrowser, inspectAt, navigate, openBrowser } = await import('../src/services/live-browser.ts');
const { setProviders } = await import('../src/providers/index.ts');
const { upsertProject } = await import('../src/db/projects.ts');
const { insertSession } = await import('../src/db/sessions.ts');
const { onChange } = await import('../src/core/changes.ts');

/** A browser's DevTools endpoint that answers like Chromium for the commands the panel sends, and records them. */
function fakeChromium() {
	const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
	const calls: Array<{ method: string; params: Record<string, unknown>; sessionId?: string }> = [];
	const history = { currentIndex: 0, entries: [{ id: 1, url: 'about:blank', title: '' }] };
	server.on('connection', (socket) => {
		socket.on('message', (raw) => {
			const { id, method, params, sessionId } = JSON.parse(String(raw));
			calls.push({ method, params, sessionId });
			const reply = (result: unknown) => socket.send(JSON.stringify({ id, result }));
			switch (method) {
				case 'Target.getTargets':
					return reply({ targetInfos: [{ targetId: 'tab-1', type: 'page', url: 'about:blank' }] });
				case 'Target.attachToTarget':
					return reply({ sessionId: 'page-1' });
				case 'Page.getNavigationHistory':
					return reply(history);
				case 'Page.navigate': {
					history.entries = [...history.entries.slice(0, history.currentIndex + 1), { id: history.entries.length + 1, url: params.url, title: 'Example' }];
					history.currentIndex = history.entries.length - 1;
					reply({ frameId: 'f1' });
					return socket.send(JSON.stringify({ method: 'Page.frameNavigated', params: { frame: { id: 'f1', url: params.url } }, sessionId: 'page-1' }));
				}
				case 'Page.navigateToHistoryEntry':
					history.currentIndex = history.entries.findIndex((entry) => entry.id === params.entryId);
					return reply({});
				case 'DOM.getNodeForLocation':
					return reply({ backendNodeId: 42 });
				case 'DOM.resolveNode':
					return reply({ object: { objectId: 'node-42' } });
				case 'Runtime.callFunctionOn':
					return reply({
						result: {
							value: {
								tag: 'button',
								selector: 'form > button.primary',
								text: 'Sign in',
								html: '<button class="primary">Sign in</button>',
								rect: { x: 100, y: 200, width: 80, height: 32 },
								styles: { color: 'rgb(255, 255, 255)' },
								components: [{ name: 'LoginForm', source: 'src/login-form.tsx:46' }],
								url: 'https://example.com/',
								title: 'Example',
							},
						},
					});
				case 'Page.getLayoutMetrics':
					return reply({ cssVisualViewport: { clientWidth: 1280, clientHeight: 800 } });
				case 'Page.captureScreenshot':
					return reply({ data: 'cG5n' });
				default:
					return reply({});
			}
		});
	});
	return { server, calls, url: () => `ws://127.0.0.1:${(server.address() as AddressInfo).port}/devtools/browser/x` };
}

const chromium = fakeChromium();
await new Promise((resolve) => chromium.server.once('listening', resolve));
const hosted = new Map<string, HostedBrowser>();
let checks = 0;
const created: Array<Parameters<BrowserHost['create']>[0]> = [];
const host: BrowserHost = {
	name: 'fake',
	async create(options) {
		created.push(options);
		const browser = { id: `b${hosted.size + 1}`, cdpUrl: chromium.url(), liveViewUrl: 'https://live.example/view' };
		hosted.set(browser.id, browser);
		return browser;
	},
	get: async (id) => {
		checks += 1;
		return hosted.get(id) ?? null;
	},
	async remove(id) {
		hosted.delete(id);
	},
};
setProviders({ sandbox: {} as never, store: {} as never, git: {} as never, models: { name: 'x', list: async () => [] }, browsers: host });
after(async () => {
	for (const id of ['web']) await closeBrowser(id).catch(() => undefined);
	chromium.server.close();
	rmSync(dir, { recursive: true, force: true });
});

const project = await upsertProject('acme/demo', 'main');
await insertSession({ id: 'web', projectId: project.id, title: 'Web', model: 'x', reasoning: null, branch: 'main', baseBranch: 'main', baseSha: 'abc', planMode: false });

test('what you type in the address bar becomes a URL, or a search', () => {
	assert.equal(addressToUrl('example.com'), 'https://example.com');
	assert.equal(addressToUrl('example.com/docs?a=1'), 'https://example.com/docs?a=1');
	assert.equal(addressToUrl('localhost:3000'), 'http://localhost:3000');
	assert.equal(addressToUrl('0.0.0.0:3000/app'), 'http://0.0.0.0:3000/app');
	assert.equal(addressToUrl('http://localhost:5173/app'), 'http://localhost:5173/app');
	assert.equal(addressToUrl('https://kernel.sh'), 'https://kernel.sh');
	assert.equal(addressToUrl('react grab element picker'), 'https://www.google.com/search?q=react%20grab%20element%20picker');
	assert.equal(addressToUrl('  '), 'about:blank');
});

test('a task opens one browser, reuses it, follows its page, and closes it', async () => {
	assert.deepEqual(await browserView('web'), { available: true, browser: null });
	const announced: unknown[] = [];
	const stop = onChange((change) => announced.push(change));

	let view = await openBrowser('web', 'example.com');
	assert.equal(created.length, 1);
	assert.equal(created[0].startUrl, 'https://example.com');
	assert.equal(created[0].viewport.width, 1280);
	assert.equal(view.browser?.liveViewUrl, 'https://live.example/view');

	view = await openBrowser('web');
	assert.equal(created.length, 1, 'the open browser is reused');

	// While Anton is connected to the browser, it does not ask the host whether it still exists.
	const asked = checks;
	const page = await navigate('web', { url: 'news.ycombinator.com' });
	assert.equal(checks, asked);
	assert.equal(page.url, 'https://news.ycombinator.com');
	assert.equal(page.canGoBack, true);
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.ok(announced.some((change) => JSON.stringify(change) === JSON.stringify({ kind: 'task', id: 'web', what: 'browser' })), 'a navigation refreshes the address bar');
	assert.equal((await navigate('web', { action: 'back' })).url, 'about:blank');
	assert.ok(chromium.calls.every((call) => !call.method.startsWith('Page.') || call.sessionId === 'page-1'), 'page commands go to the attached tab');

	await closeBrowser('web');
	assert.equal(hosted.size, 0);
	assert.deepEqual(await browserView('web'), { available: true, browser: null });
	stop();
});

test('pointing highlights an element; picking reads it and takes its picture without the highlight', async () => {
	await openBrowser('web');
	chromium.calls.length = 0;
	assert.equal(await inspectAt('web', { x: 120.4, y: 210.6, pick: false }), null);
	assert.deepEqual(
		chromium.calls.map((call) => call.method),
		['DOM.getNodeForLocation', 'Overlay.highlightNode'],
	);
	assert.deepEqual(chromium.calls[0].params, { x: 120, y: 211, includeUserAgentShadowDOM: false, ignorePointerEventsNone: true });

	chromium.calls.length = 0;
	const element = await inspectAt('web', { x: 120, y: 210, pick: true });
	assert.equal(element?.tag, 'button');
	assert.deepEqual(element?.components, [{ name: 'LoginForm', source: 'src/login-form.tsx:46' }]);
	assert.equal(element?.image, 'cG5n');
	const methods = chromium.calls.map((call) => call.method);
	assert.ok(methods.indexOf('Overlay.hideHighlight') < methods.indexOf('Page.captureScreenshot'));
	const shot = chromium.calls.find((call) => call.method === 'Page.captureScreenshot');
	assert.deepEqual(shot?.params.clip, { x: 92, y: 192, width: 96, height: 48, scale: 1 }, 'the box with 8px around it');

	const screenshot = await browserScreenshot('web');
	assert.deepEqual(screenshot, { data: 'cG5n', width: 1280, height: 800 });
});

test('without a browser host the panel says so, and a browser the host removed is forgotten', async () => {
	await openBrowser('web');
	// A browser the host removes drops its connection; Anton then asks the host, and forgets it.
	hosted.clear();
	for (const socket of chromium.server.clients) socket.terminate();
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.deepEqual(await browserView('web'), { available: true, browser: null });
	setProviders({ sandbox: {} as never, store: {} as never, git: {} as never, models: { name: 'x', list: async () => [] }, browsers: null });
	assert.deepEqual(await browserView('web'), { available: false, browser: null });
	await assert.rejects(openBrowser('web'), /KERNEL_API_KEY/);
	await assert.rejects(agentBrowse('web', { action: 'look' }), /KERNEL_API_KEY/);
	assert.equal(agentBusy('web'), false, 'a step that could not start leaves no busy note behind');
	setProviders({ sandbox: {} as never, store: {} as never, git: {} as never, models: { name: 'x', list: async () => [] }, browsers: host });
});

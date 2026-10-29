import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const dir = mkdtempSync(path.join(os.tmpdir(), 'anton-computer-'));
process.env.ANTON_DATA_DIR = dir;

const { setProviders } = await import('../src/providers/index.ts');
const { localSandboxProvider } = await import('../src/providers/local/sandbox.ts');
const { diskStore } = await import('../src/providers/disk/store.ts');
const { insertSession } = await import('../src/db/sessions.ts');
const { onChange } = await import('../src/core/changes.ts');
const { DESKTOP_TOOLS, desktopLayout, SCREEN } = await import('../src/core/desktop.ts');
const { act, asAgentStep, browseOnComputer, computerScreenshot, computerView, connectBrowser, connectComputer, inputCommand, setComputerControl, startComputer, stopComputer, userHasControl } = await import('../src/services/computer.ts');
const { BrowserStopError, closeBrowser } = await import('../src/services/browser.ts');
const { untilAborted, withinDeadline } = await import('../src/services/step-deadline.ts');
const { liveMachine, machineFor } = await import('../src/services/workspace.ts');
const { describe, jsonIn, locate, visionModelFor } = await import('../src/services/vision.ts');
const { openRouterVision } = await import('../src/providers/openrouter/vision.ts');

const local = localSandboxProvider(path.join(dir, 'data'));
// The vision model answers what each test says, and remembers what it was asked.
let seeing = (_prompt: string) => '';
const looks: Array<{ model: string; prompt: string; bytes: number }> = [];
const vision = {
	runs: (model: string) => model.startsWith('openrouter/'),
	look: async ({ model, prompt, image }: { model: string; prompt: string; image: Uint8Array }) => {
		looks.push({ model, prompt, bytes: image.length });
		return { text: seeing(prompt), inputTokens: 100, outputTokens: 20, cost: 0.0001 };
	},
};
setProviders({ sandbox: local, store: diskStore(path.join(dir, 'objects')), git: {} as never, models: { name: 'x', list: async () => [] }, vision });
await insertSession({ id: 'pc', projectId: null, title: 'Computer', model: 'x', reasoning: null, branch: '', baseBranch: '', baseSha: '', planMode: false });

const hasDesktop = (() => {
	try {
		execSync(DESKTOP_TOOLS.map((tool) => `command -v ${tool}`).join(' && '), { stdio: 'ignore', shell: '/bin/bash' });
		return true;
	} catch {
		return false;
	}
})();

/** Checked as a local machine's commands run, without this computer's browser path, so a test never installs a browser. */
const hasBrowser = (() => {
	try {
		execSync(`env -u PLAYWRIGHT_BROWSERS_PATH NODE_PATH="$(npm root -g)" node -e "require('fs').accessSync(require('playwright').chromium.executablePath())"`, { stdio: 'ignore', shell: '/bin/bash' });
		return true;
	} catch { return false; }
})();

after(() => {
	// Local machines share this computer, so the desktop the tests started is stopped here.
	const layout = desktopLayout(path.join(dir, 'data', 'machines', 'pc'));
	execSync(`for name in x wm panel icons socket; do [ -f ${layout.files}-$name.pid ] && kill "$(cat ${layout.files}-$name.pid)" 2>/dev/null; done; rm -rf ${layout.home}; true`, { shell: '/bin/bash' });
	rmSync(dir, { recursive: true, force: true });
});

/** The PNG's size, from its header. */
const pngSize = (png: Uint8Array) => {
	const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
	return { width: view.getUint32(16), height: view.getUint32(20) };
};

test('each step is one xdotool command, kept on the screen', () => {
	assert.equal(inputCommand({ action: 'click', x: 10.4, y: 20.6 }), 'xdotool mousemove 10 21 click 1');
	assert.equal(inputCommand({ action: 'click', x: -5, y: 5000 }), `xdotool mousemove 0 ${SCREEN.height - 1} click 1`);
	assert.equal(inputCommand({ action: 'double_click', x: 1, y: 2 }), 'xdotool mousemove 1 2 click --repeat 2 --delay 80 1');
	assert.equal(inputCommand({ action: 'right_click', x: 1, y: 2 }), 'xdotool mousemove 1 2 click 3');
	assert.equal(inputCommand({ action: 'drag', x: 1, y: 2, toX: 30, toY: 40 }), 'xdotool mousemove 1 2 mousedown 1 sleep 0.2 mousemove 30 40 sleep 0.2 mouseup 1');
	assert.equal(inputCommand({ action: 'type', text: "it's here" }), `xdotool type --delay 15 -- 'it'\\''s here'`);
	assert.equal(inputCommand({ action: 'key', keys: 'ctrl+s Return' }), "xdotool key -- 'ctrl+s' 'Return'");
	assert.equal(inputCommand({ action: 'scroll', direction: 'up', amount: 3 }), 'xdotool click --repeat 3 --delay 30 4');
	assert.equal(inputCommand({ action: 'scroll', x: 5, y: 6 }), 'xdotool mousemove 5 6 click --repeat 5 --delay 30 5');
	assert.equal(inputCommand({ action: 'look' }), null);
	assert.throws(() => inputCommand({ action: 'click' }), /needs a position/);
	assert.throws(() => inputCommand({ action: 'type' }), /needs text/);
	assert.throws(() => inputCommand({ action: 'key', keys: ' ' }), /needs keys/);
});

test('looking at the panel never starts the sandbox', async () => {
	assert.deepEqual(await computerView('pc'), { live: false, running: false, browser: false, screen: { width: 1280, height: 800 }, agentBusy: false, userControl: false });
	assert.equal((await local.running()).size, 0);
	await assert.rejects(connectComputer('pc'), /not running/);
	await assert.rejects(connectBrowser('pc'), /not running/);
	await assert.rejects(computerView('nope'), /not found/);
});

test('Start computer starts the sandbox and its desktop, and the panel can connect', { skip: !hasDesktop && 'needs the desktop packages' }, async () => {
	const changes: string[] = [];
	const stop = onChange((change) => change.kind === 'task' && changes.push(change.what));
	const started = await startComputer('pc');
	stop();
	assert.equal(started.live, true);
	assert.equal(started.running, true);
	assert.ok(changes.includes('computer'), 'the panel hears that the desktop started');
	const layout = desktopLayout(path.join(dir, 'data', 'machines', 'pc'));
	assert.equal(started.url, `ws://localhost:${layout.socketPort}`);
	// The panel speaks VNC over the socket: the server greets first.
	const greeting = await new Promise<string>((resolve, reject) => {
		const socket = new WebSocket(started.url, ['binary']);
		socket.binaryType = 'arraybuffer';
		socket.onmessage = (event) => {
			resolve(new TextDecoder().decode(event.data as ArrayBuffer));
			socket.close();
		};
		socket.onerror = () => reject(new Error('could not connect'));
	});
	assert.equal(greeting, 'RFB 003.008\n');
	// Connecting again reuses the running desktop.
	assert.equal((await connectComputer('pc')).url, started.url);
});

test('the agent launches a program, types into it, and sees the screen', { skip: !hasDesktop && 'needs the desktop packages' }, async () => {
	const machine = await liveMachine('pc');
	assert.ok(machine);
	const launched = await act(machine, { action: 'launch', command: "xterm -title anton-test -xrm 'XTerm*allowTitleOps: false' -geometry 80x20+0+0" });
	assert.deepEqual(pngSize(launched.png), SCREEN);
	assert.equal(launched.window, 'anton-test');
	await act(machine, { action: 'type', text: 'echo hi' });
	const after = await act(machine, { action: 'key', keys: 'Return' });
	assert.notDeepEqual(after.png, launched.png, 'the screen changed');
	const shot = await computerScreenshot('pc');
	assert.equal(shot.width, 1280);
	assert.deepEqual(pngSize(Buffer.from(shot.data, 'base64')), SCREEN);
	await act(machine, { action: 'key', keys: 'ctrl+d' });
});

test('Turn off closes the desktop and leaves the sandbox running; Start computer brings it back', { skip: !hasDesktop && 'needs the desktop packages' }, async () => {
	await setComputerControl('pc', 'user');
	const off = await stopComputer('pc');
	assert.deepEqual({ live: off.live, running: off.running, userControl: off.userControl }, { live: true, running: false, userControl: false });
	assert.equal((await local.running()).size, 1, 'the sandbox runs on for the task');
	const { socketPort } = desktopLayout(path.join(dir, 'data', 'machines', 'pc'));
	await assert.rejects(fetch(`http://127.0.0.1:${socketPort}`), 'nothing listens for the panel');
	const on = await startComputer('pc');
	assert.equal(on.running, true);
});

test('sandbox browser tests a real app without the desktop, and an open panel hears it to show the live view', { skip: !hasBrowser && 'needs Playwright Chromium' }, async (t) => {
	const server = createServer((_req, res) => {
		res.writeHead(200, { 'content-type': 'text/html' });
		res.end('<title>Visible test page</title><p id="count">0</p><button onclick="document.querySelector(\'#count\').textContent++">Add one</button>');
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	t.after(() => server.close());
	const port = (server.address() as AddressInfo).port;
	const machine = await machineFor('pc');
	if (hasDesktop) await stopComputer('pc');
	assert.equal((await computerView('pc')).running, false);
	const changes: string[] = [];
	const unsubscribe = onChange((change) => change.kind === 'task' && changes.push(change.what));
	try {
		const page = await browseOnComputer('pc', async () => machine, { action: 'open', url: `http://127.0.0.1:${port}/` }, () => false);
		assert.equal(page.problem, null);
		assert.equal(page.title, 'Visible test page');
		const view = await computerView('pc');
		assert.deepEqual({ running: view.running, browser: view.browser }, { running: false, browser: true }, 'no desktop was started for it');
		assert.ok(changes.includes('computer'), 'the panel hears the browser started');
		assert.match((await connectBrowser('pc')).url, /^ws:\/\/localhost:\d+$/);
		const clicked = await browseOnComputer('pc', async () => machine, { action: 'click', target: 'role=button[name="Add one"]' }, () => false);
		assert.match(clicked.snapshot, /1/);
		const again = await browseOnComputer('pc', async () => machine, { action: 'look' }, () => false);
		assert.equal(again.title, 'Visible test page');
		assert.match(again.snapshot, /1/);
		await setComputerControl('pc', 'user');
		const held = await browseOnComputer('pc', async () => machine, { action: 'look' }, () => false);
		assert.match(held.problem ?? '', /taken over/);
		await setComputerControl('pc', 'agent');
	} finally {
		unsubscribe();
		await closeBrowser(machine);
	}
	assert.equal((await computerView('pc')).browser, false);
});

test('steps called at once run one after another, in the order they were called', async () => {
	const order: string[] = [];
	const step = (name: string, ms: number) => asAgentStep('pc', async () => {
		order.push(`${name} starts`);
		await new Promise((resolve) => setTimeout(resolve, ms));
		order.push(`${name} ends`);
		if (name === 'type') throw new Error('typing failed');
		return name;
	});
	const results = await Promise.allSettled([step('click', 30), step('type', 10), step('key', 0)]);
	assert.deepEqual(order, ['click starts', 'click ends', 'type starts', 'type ends', 'key starts', 'key ends']);
	assert.deepEqual(results.map((result) => result.status), ['fulfilled', 'rejected', 'fulfilled'], 'a failed step does not stop the next');
});

test('taking over makes the agent wait until it is handed back', async () => {
	assert.equal((await setComputerControl('pc', 'user')).userControl, true);
	assert.equal(userHasControl('pc'), true);
	assert.equal((await setComputerControl('pc', 'agent')).userControl, false);
	assert.equal(userHasControl('pc'), false);
});

test('a sandbox browser step never asks for, starts or waits on the desktop', async () => {
	const commands: string[] = [];
	const machine = { id: 'no-desktop', root: '/tmp/no-desktop', exec: async (command: string) => (commands.push(command), { stdout: new Uint8Array(), stderr: '', exitCode: 0 }) } as unknown as import('../src/core/ports.ts').Machine;
	const steps: string[] = [];
	const browser = async (_machine: import('../src/core/ports.ts').Machine, command: import('../src/services/browser.ts').BrowserInput) => {
		steps.push(command.action);
		return { url: command.url ?? '', title: 'App', status: 200, problem: null, errors: [], screenshot: null, snapshot: 'App' };
	};
	for (const command of [{ action: 'open' as const, url: 'http://localhost:3000' }, { action: 'click' as const, target: 'button' }, { action: 'look' as const }]) {
		const result = await browseOnComputer('no-desktop', async () => machine, command, () => false, browser);
		assert.equal(result.problem, null);
		assert.equal(result.notice, undefined);
	}
	assert.deepEqual(steps, ['open', 'click', 'look']);
	assert.deepEqual(commands, [], 'not one command of its own');
});

test('a stopped sandbox browser step does not start a machine or desktop', async () => {
	let started = false;
	const state = await browseOnComputer('pc', async () => { started = true; throw new Error('must not start'); }, { action: 'look' }, () => true);
	assert.equal(started, false);
	assert.ok(state.problem);
});

test('a step stopped before it acts never reaches the browser, and releases takeover', async () => {
	const controller = new AbortController();
	let browserCalled = false;
	const machine = {} as import('../src/core/ports.ts').Machine;
	let resolveMachine!: (machine: import('../src/core/ports.ts').Machine) => void;
	const work = browseOnComputer('pc', () => new Promise((resolve) => { resolveMachine = resolve; }), { action: 'open', url: 'http://localhost:3000' }, () => controller.signal.aborted, async () => {
		browserCalled = true;
		throw new Error('must not run');
	}, controller.signal);
	await assert.rejects(withinDeadline(work, 30, undefined, () => controller.abort()), /given up/);
	resolveMachine(machine);
	await work.catch(() => undefined);
	assert.equal(browserCalled, false);
	assert.equal((await setComputerControl('pc', 'user')).userControl, true);
	await setComputerControl('pc', 'agent');
});

test('a timed-out real browser action closes the browser before takeover', { skip: !hasBrowser && 'needs Playwright Chromium' }, async () => {
	const machine = await machineFor('pc');
	assert.ok(machine);
	const open = await browseOnComputer('pc', async () => machine, { action: 'open', url: 'data:text/html,<title>Cancellation test</title>' }, () => false);
	assert.equal(open.title, 'Cancellation test');
	const controller = new AbortController();
	const work = browseOnComputer('pc', async () => machine, { action: 'click', target: 'text=Missing forever' }, () => controller.signal.aborted, undefined, controller.signal);
	await assert.rejects(withinDeadline(work, 1000, undefined, () => controller.abort()), /given up/);
	await work.catch(() => undefined);
	assert.equal((await setComputerControl('pc', 'user')).userControl, true);
	await setComputerControl('pc', 'agent');
	const next = await browseOnComputer('pc', async () => machine, { action: 'open', url: 'data:text/html,<title>New tab</title>' }, () => false);
	assert.equal(next.title, 'New tab');
	await closeBrowser(machine);
});

test('a timed-out read-only vision wait releases the screen without a late action', async () => {
	const controller = new AbortController();
	let finish!: () => void;
	let acted = false;
	const slowVision = new Promise<void>((resolve) => { finish = resolve; });
	const work = asAgentStep('pc', async () => {
		await untilAborted(slowVision, controller.signal);
		controller.signal.throwIfAborted();
		acted = true;
	});
	await assert.rejects(withinDeadline(work, 30, undefined, () => controller.abort()), /given up/);
	await work.catch(() => undefined);
	assert.equal((await setComputerControl('pc', 'user')).userControl, true);
	finish();
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(acted, false);
	await setComputerControl('pc', 'agent');
});

test('a timed-out browser action is cancelled before takeover is granted', async () => {
	const controller = new AbortController();
	const machine = {} as import('../src/core/ports.ts').Machine;
	let running = false;
	let cleaned = false;
	const work = browseOnComputer('pc', async () => machine, { action: 'look' }, () => controller.signal.aborted, async (_machine, _command, signal) => {
		running = true;
		await new Promise<void>((resolve) => signal!.addEventListener('abort', () => { running = false; cleaned = true; resolve(); }, { once: true }));
		return { url: '', title: '', status: null, problem: null, errors: [], screenshot: null, snapshot: '' };
	}, controller.signal);
	await assert.rejects(withinDeadline(work, 30, undefined, () => controller.abort()), /given up/);
	assert.equal(running, false);
	assert.equal(cleaned, true);
	assert.equal((await setComputerControl('pc', 'user')).userControl, true);
	await setComputerControl('pc', 'agent');
});

test('failed browser termination fences the screen instead of granting takeover', async () => {
	await insertSession({ id: 'unsafe-pc', projectId: null, title: 'Unsafe screen', model: 'x', reasoning: null, branch: '', baseBranch: '', baseSha: '', planMode: false });
	const machine = {} as import('../src/core/ports.ts').Machine;
	await assert.rejects(browseOnComputer('unsafe-pc', async () => machine, { action: 'look' }, () => false, async () => { throw new BrowserStopError('did not stop'); }), /did not stop/);
	await assert.rejects(setComputerControl('unsafe-pc', 'user'), /could not be stopped/);
	assert.equal(userHasControl('unsafe-pc'), true);
});

test('takeover fails closed promptly if a screen step does not stop', async () => {
	let release!: () => void;
	let started!: () => void;
	const ready = new Promise<void>((resolve) => { started = resolve; });
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const work = asAgentStep('pc', async () => { started(); await gate; });
	await ready;
	await assert.rejects(setComputerControl('pc', 'user', 30), /still stopping/);
	assert.equal((await computerView('pc')).userControl, false);
	release();
	await work;
	assert.equal((await setComputerControl('pc', 'user')).userControl, true);
	await setComputerControl('pc', 'agent');
});

test('takeover waits for an in-flight step and blocks queued steps before granting input', async () => {
	let release!: () => void;
	let started!: () => void;
	const ready = new Promise<void>((resolve) => { started = resolve; });
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const first = asAgentStep('pc', async () => { started(); await gate; });
	await ready;
	const takeover = setComputerControl('pc', 'user');
	// Let the task lookup finish and mark takeover pending while the first step is still running.
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(userHasControl('pc'), true);
	let acknowledged = false;
	void takeover.then(() => { acknowledged = true; });
	const second = asAgentStep('pc', async () => userHasControl('pc') ? 'held' : 'acted');
	assert.equal(acknowledged, false);
	release();
	await first;
	assert.equal(await second, 'held');
	assert.equal((await takeover).userControl, true);
	await setComputerControl('pc', 'agent');
});

test('the vision model finds what the agent named, kept on the screen, and says what the screen shows', async () => {
	const png = new Uint8Array([1, 2, 3]);
	// The task's model is not in the catalog as one that reads images, so the default vision model looks.
	assert.equal(visionModelFor('pc'), 'openrouter/anthropic/claude-haiku-5.5');
	seeing = () => 'Here it is:\n```json\n{"found": true, "x": 640.4, "y": 400, "note": "the Save button"}\n```';
	assert.deepEqual(await locate('pc', 'the Save button', png), { at: { x: 640.4, y: 400 }, note: 'the Save button', cost: 0.0001 });
	assert.match(looks.at(-1)!.prompt, /Find the Save button\. Reply with JSON only/);
	assert.equal(looks.at(-1)!.bytes, 3);
	seeing = () => '{"found": true, "x": 5000, "y": 10, "note": "off the edge"}';
	assert.equal((await locate('pc', 'the Save button', png)).at, null, 'a point off the screen is not a find');
	seeing = () => '{"found": false, "note": "A terminal fills the screen."}';
	assert.deepEqual(await locate('pc', 'the Save button', png), { at: null, note: 'A terminal fills the screen.', cost: 0.0001 });
	seeing = () => 'I cannot tell.';
	assert.equal((await locate('pc', 'the Save button', png)).at, null);
	seeing = () => 'An xterm at the top left, showing hi.';
	assert.deepEqual(await describe('pc', png, 'what the terminal printed'), { screen: 'An xterm at the top left, showing hi.', cost: 0.0001 });
	assert.match(looks.at(-1)!.prompt, /Focus on what bears on this: what the terminal printed$/);
	assert.equal(jsonIn('no json'), null);
});

test('the OpenRouter vision model is sent the image and the question, and no tools', async () => {
	const { createServer } = await import('node:http');
	let sent: { model?: string; tools?: unknown; messages?: Array<{ content: Array<{ type: string; text?: string; image_url?: { url: string } }> }> } = {};
	let auth = '';
	const server = createServer((request, response) => {
		let body = '';
		request.on('data', (chunk) => (body += chunk));
		request.on('end', () => {
			sent = JSON.parse(body);
			auth = request.headers.authorization ?? '';
			response.setHeader('content-type', 'application/json');
			response.end(JSON.stringify({ choices: [{ message: { content: ' A dialog. ' } }], usage: { prompt_tokens: 900, completion_tokens: 12, cost: 0.0004 } }));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address() as { port: number };
	try {
		const model = openRouterVision({ apiUrl: `http://127.0.0.1:${port}`, apiKey: 'key' });
		assert.equal(model.runs('openrouter/anthropic/claude-haiku-5.5'), true);
		assert.equal(model.runs('claude-code/sonnet'), false);
		const answer = await model.look({ model: 'openrouter/anthropic/claude-haiku-5.5', prompt: 'What is there?', image: new Uint8Array([137, 80]), mimeType: 'image/png' });
		assert.deepEqual(answer, { text: 'A dialog.', inputTokens: 900, outputTokens: 12, cost: 0.0004 });
		assert.equal(auth, 'Bearer key');
		assert.equal(sent.model, 'anthropic/claude-haiku-5.5');
		assert.equal(sent.tools, undefined);
		const [image, question] = sent.messages![0].content;
		assert.equal(image.image_url?.url, `data:image/png;base64,${Buffer.from([137, 80]).toString('base64')}`);
		assert.equal(question.text, 'What is there?');
	} finally {
		server.close();
	}
});

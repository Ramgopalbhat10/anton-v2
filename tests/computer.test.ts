import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
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
const { act, asAgentStep, computerScreenshot, computerView, connectComputer, inputCommand, setComputerControl, startComputer, userHasControl } = await import('../src/services/computer.ts');
const { liveMachine } = await import('../src/services/workspace.ts');
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
	assert.deepEqual(await computerView('pc'), { live: false, running: false, screen: { width: 1280, height: 800 }, agentBusy: false, userControl: false });
	assert.equal((await local.running()).size, 0);
	await assert.rejects(connectComputer('pc'), /not running/);
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

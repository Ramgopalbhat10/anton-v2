import { createHash, randomUUID } from 'node:crypto';
import { config } from '../config.ts';
import { desktopLayout } from '../core/desktop.ts';
import { writeMachineFile } from '../core/machine-fs.ts';
import type { Machine } from '../core/ports.ts';
import { quote, run } from '../core/shell.ts';
import { addressToUrl, BROWSER_STEP, clipSnapshot, screenshotFile } from './browser-step.ts';

/**
 * Runs inside the machine: opens the page in headless Chromium, saves a
 * PNG, and prints what the page said about itself.
 */
const SCRIPT = `
const { chromium } = require('playwright');
const { url, out, width, height, fullPage } = JSON.parse(process.argv[2]);
(async () => {
	const browser = await chromium.launch();
	const page = await browser.newPage({ viewport: { width, height } });
	const errors = [];
	page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));
	page.on('pageerror', (error) => errors.push(String(error)));
	let status = null;
	try {
		status = (await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 }))?.status() ?? null;
	} catch (error) {
		errors.push('Navigation: ' + error.message);
	}
	await page.screenshot({ path: out, fullPage });
	console.log(JSON.stringify({ title: await page.title(), status, errors: errors.slice(0, 20) }));
	await browser.close();
})().catch((error) => {
	console.error(error.message);
	process.exit(1);
});
`;

/** Installs the browser on first use; sandbox images built since the browser was added already have it. */
const ENSURE_BROWSER = `
command -v node >/dev/null || { echo "The screenshot tool needs Node.js in the sandbox." >&2; exit 3; }
export NODE_PATH="$(npm root -g)"
node -e "require('fs').accessSync(require('playwright').chromium.executablePath())" >/dev/null 2>&1 && exit 0
npm install -g --no-audit --no-fund ${config.browserPackage} >/dev/null
if [ "$(id -u)" = 0 ] && command -v apt-get >/dev/null; then playwright install --with-deps chromium; else playwright install chromium; fi
`;

export type ScreenshotInput = { url: string; name?: string; fullPage?: boolean; width?: number; height?: number };
export type Screenshot = { path: string; title: string; status: number | null; errors: string[] };

/** Screenshots a page from inside the machine into its outputs, so it shows in the Library. */
export async function takeScreenshot(machine: Machine, input: ScreenshotInput): Promise<Screenshot> {
	await run(machine, ENSURE_BROWSER, { timeoutMs: 10 * 60_000 });
	const file = screenshotFile(input.name || 'shot');
	const out = `${machine.root}/outputs/${file}`;
	// Its own script per call, so two screenshots at once never read each other's half-written file.
	const script = `/tmp/anton-screenshot-${randomUUID()}.cjs`;
	await writeMachineFile(machine, script, new TextEncoder().encode(SCRIPT));
	const args = JSON.stringify({ url: input.url, out, width: input.width ?? 1280, height: input.height ?? 800, fullPage: input.fullPage ?? false });
	const stdout = await run(machine, `mkdir -p ${quote(`${machine.root}/outputs/screenshots`)} && NODE_PATH="$(npm root -g)" node ${script} ${quote(args)}`, {
		timeoutMs: 90_000,
	}).finally(() => machine.exec(`rm -f ${script}`).catch(() => undefined));
	const report = JSON.parse(stdout.trim().split('\n').pop() ?? '{}') as Omit<Screenshot, 'path'>;
	return { path: `../outputs/${file}`, ...report };
}

/**
 * The browser server's live view, for the Computer panel: a WebSocket that
 * sends the tab as JPEG frames from Chromium's screencast, and takes your
 * mouse and keyboard when you have taken over. The sandbox browser used to
 * run on the Computer's desktop so you could watch it, and every step waited
 * on that desktop (a minute or more to start, and a check on each step); it
 * now runs headless, and only a panel that is watching costs anything.
 * WebSocket framing is written out here, as the sandbox has Playwright but
 * no WebSocket server package. Expects `page` and `idle` from the server.
 */
const LIVE_VIEW = `
const viewers = new Set();
let cast = null;
let lastFrame = null;
let lastSize = null;
let casting = Promise.resolve();
let inputs = Promise.resolve();

function frame(opcode, payload) {
	const length = payload.length;
	let head;
	if (length < 126) head = Buffer.from([0x80 | opcode, length]);
	else if (length < 65536) head = Buffer.from([0x80 | opcode, 126, length >> 8, length & 255]);
	else {
		head = Buffer.alloc(10);
		head[0] = 0x80 | opcode;
		head[1] = 127;
		head.writeBigUInt64BE(BigInt(length), 2);
	}
	return Buffer.concat([head, payload]);
}
// A viewer that falls behind misses frames rather than holding the tab's memory.
const send = (viewer, opcode, payload) => !viewer.destroyed && viewer.writableLength < 2 * 1024 * 1024 && viewer.write(frame(opcode, payload));
const tell = (viewer, message) => send(viewer, 1, Buffer.from(JSON.stringify(message)));

async function stopCast() {
	const old = cast;
	cast = null;
	if (old) await old.session.detach().catch(() => {});
}

/** Streams the current tab while anyone watches; follows a new tab, and says when there is none. */
function recast() {
	casting = casting.then(async () => {
		if (!viewers.size || !page || page.isClosed()) {
			await stopCast();
			if (!page) {
				lastFrame = null;
				for (const viewer of viewers) tell(viewer, { type: 'idle' });
			}
			return;
		}
		if (cast && cast.page === page) return;
		await stopCast();
		const target = page;
		const session = await target.context().newCDPSession(target);
		cast = { page: target, session };
		session.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
			session.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
			if (!cast || cast.session !== session) return;
			const size = { type: 'size', width: Math.round(metadata.deviceWidth), height: Math.round(metadata.deviceHeight) };
			if (!lastSize || lastSize.width !== size.width || lastSize.height !== size.height) {
				lastSize = size;
				for (const viewer of viewers) tell(viewer, size);
			}
			lastFrame = Buffer.from(data, 'base64');
			for (const viewer of viewers) send(viewer, 2, lastFrame);
		});
		const { width, height } = target.viewportSize() || { width: 1280, height: 800 };
		await session.send('Page.startScreencast', { format: 'jpeg', quality: 70, maxWidth: width, maxHeight: height, everyNthFrame: 1 });
	}).catch(() => {});
}

/** One input from a viewer who has taken over, in the tab's own pixels. */
async function input(message) {
	const target = page;
	if (!target || target.isClosed()) return;
	idle();
	const at = () => target.mouse.move(Number(message.x) || 0, Number(message.y) || 0);
	const button = ['left', 'right', 'middle'].includes(message.button) ? message.button : 'left';
	switch (message.type) {
		case 'move': return at();
		case 'down': await at(); return target.mouse.down({ button, clickCount: Number(message.clicks) || 1 });
		case 'up': await at(); return target.mouse.up({ button, clickCount: Number(message.clicks) || 1 });
		case 'wheel': await at(); return target.mouse.wheel(Number(message.dx) || 0, Number(message.dy) || 0);
		// A key Playwright has no name for (an accented letter, say) is typed as text.
		case 'keydown': return target.keyboard.down(String(message.key)).catch(() => String(message.key).length === 1 && target.keyboard.insertText(String(message.key)));
		case 'keyup': return target.keyboard.up(String(message.key)).catch(() => {});
		case 'text': return target.keyboard.insertText(String(message.text || ''));
	}
}

function join(socket) {
	viewers.add(socket);
	idle();
	socket.setNoDelay(true);
	let pending = Buffer.alloc(0);
	socket.on('data', (chunk) => {
		pending = Buffer.concat([pending, chunk]);
		while (pending.length >= 2) {
			const opcode = pending[0] & 15;
			const masked = (pending[1] & 128) !== 0;
			let length = pending[1] & 127;
			let at = 2;
			if (length === 126) {
				if (pending.length < 4) return;
				length = pending.readUInt16BE(2);
				at = 4;
			} else if (length === 127) {
				if (pending.length < 10) return;
				length = Number(pending.readBigUInt64BE(2));
				at = 10;
			}
			if (pending.length < at + (masked ? 4 : 0) + length) return;
			const mask = masked ? pending.subarray(at, at + 4) : null;
			if (masked) at += 4;
			const body = Buffer.from(pending.subarray(at, at + length));
			pending = pending.subarray(at + length);
			if (mask) for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3];
			if (opcode === 8) return socket.end(frame(8, Buffer.alloc(0)));
			if (opcode === 9) send(socket, 10, body);
			if (opcode !== 1) continue;
			let message;
			try { message = JSON.parse(body.toString('utf8')); } catch { continue; }
			inputs = inputs.then(() => input(message)).catch(() => {});
		}
	});
	const leave = () => {
		if (viewers.delete(socket) && !viewers.size) recast();
	};
	socket.on('close', leave);
	socket.on('error', leave);
	// What the tab last showed, at once: a page that is not repainting sends no frame of its own.
	if (lastSize) tell(socket, lastSize);
	if (lastFrame && page) send(socket, 2, lastFrame);
	else if (!page) tell(socket, { type: 'idle' });
	recast();
}

/** On every address, where only the provider's authenticated way in reaches it, or on ANTON_SCREEN_BIND (a local machine's own). */
function listenLive(port) {
	const live = http.createServer((request, response) => {
		response.statusCode = 426;
		response.end();
	});
	live.on('upgrade', (request, socket) => {
		const key = request.headers['sec-websocket-key'];
		if (!key) return socket.destroy();
		const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
		socket.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: ' + accept + '\\r\\n\\r\\n');
		join(socket);
	});
	// A port another machine's browser holds (local machines share this computer) leaves this one without a live view.
	live.on('error', (error) => console.error('Live view: ' + error.message));
	live.listen(port, process.env.ANTON_SCREEN_BIND || '0.0.0.0');
}
`;

/**
 * Runs inside the machine and keeps one browser tab open between the agent's
 * steps, so a page keeps its state while the agent clicks and types through
 * it. Takes commands over a Unix socket and quits after a quiet spell.
 */
const SERVER = `
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const { chromium } = require('playwright');
const [socket, outputs, livePort] = process.argv.slice(2);
const IDLE_MS = 15 * 60 * 1000;
let browser = null;
let page = null;
const NO_GOOGLE_KEYS = { GOOGLE_API_KEY: 'no', GOOGLE_DEFAULT_CLIENT_ID: 'no', GOOGLE_DEFAULT_CLIENT_SECRET: 'no' };
let errors = [];
let quit = null;
process.on('SIGTERM', () => { void (async () => { await browser?.close().catch(() => {}); process.exit(0); })(); });
// Set when the tab the agent was on went away (its browser quit or crashed, or the page crashed), so the next step says so.
let lost = false;
const idle = () => { clearTimeout(quit); quit = setTimeout(async () => { await browser?.close().catch(() => {}); process.exit(0); }, IDLE_MS); };

async function tab(width, height) {
	// A browser that quit or crashed is started again, rather than every later step failing on it.
	if (browser && !browser.isConnected()) {
		browser = null;
		page = null;
		lost = true;
	}
	if (!browser) {
		// Headless, so a step never waits for a desktop: the Computer panel shows the tab through its live view below.
		const launched = await chromium.launch({ env: { ...process.env, ...NO_GOOGLE_KEYS } });
		launched.on('disconnected', () => {
			if (browser !== launched) return;
			browser = null;
			page = null;
			lost = true;
			recast();
		});
		browser = launched;
	}
	if (!page || page.isClosed()) {
		if (page) lost = true;
		const opened = await browser.newPage({ viewport: { width, height } });
		opened.on('console', (message) => message.type() === 'error' && errors.push(message.text()));
		opened.on('pageerror', (error) => errors.push(String(error)));
		// A crashed tab answers every later action with an error; the next step opens a new one.
		opened.on('crash', () => {
			if (page !== opened) return;
			page = null;
			lost = true;
			opened.close().catch(() => {});
			recast();
		});
		page = opened;
		recast();
	} else if (page.viewportSize()?.width !== width || page.viewportSize()?.height !== height) {
		await page.setViewportSize({ width, height });
	}
	return page;
}

${LIVE_VIEW}

${BROWSER_STEP}

async function act(command) {
	const page = await tab(command.width ?? 1280, command.height ?? 800);
	const reopened = lost;
	lost = false;
	const result = await browserStep(page, command);
	if (reopened && command.action !== 'open') {
		result.problem = 'The browser had closed or crashed, so this step ran in a new, blank tab. Open the page again.' + (result.problem ? ' ' + result.problem : '');
	}
	let screenshot = null;
	if (command.screenshot) {
		try {
			fs.mkdirSync(outputs + '/screenshots', { recursive: true });
			await page.screenshot({ path: outputs + '/' + command.screenshot, fullPage: Boolean(command.fullPage) });
			screenshot = command.screenshot;
		} catch (error) {
			result.problem = (result.problem ? result.problem + ' ' : '') + 'No screenshot: ' + String(error.message || error).split('\\n')[0];
		}
	}
	return { ...result, errors: errors.splice(0).slice(0, 20), screenshot };
}

/** A step that failed before it acted, answered in the same shape as any other. */
const failed = (error) => ({ url: page && !page.isClosed() ? page.url() : '', title: '', status: null, problem: 'The browser failed: ' + String((error && error.message) || error).split('\\n')[0], snapshot: '', errors: [], screenshot: null });

/** Lets the browser go after a failure, so the next try starts a new one. */
async function restart() {
	const old = browser;
	browser = null;
	page = null;
	lost = true;
	recast();
	await old?.close().catch(() => {});
}

let queue = Promise.resolve();
fs.rmSync(socket, { force: true });
http.createServer((request, response) => {
	idle();
	let body = '';
	request.on('data', (chunk) => (body += chunk));
	request.on('end', () => {
		queue = queue.then(async () => {
			const command = JSON.parse(body);
			// A failure may have happened after a click; never replay an action of unknown outcome.
			const result = await act(command).catch(async (error) => {
				await restart();
				return failed(error);
			});
			response.end(JSON.stringify(result));
		});
	});
}).listen(socket, idle);
if (livePort) listenLive(Number(livePort));
`;

/** Sends one command to the browser and prints its answer; exits 4 when no browser is running. */
const CLIENT = `
const http = require('http');
const [socket, command] = process.argv.slice(2);
const request = http.request({ socketPath: socket, method: 'POST' }, (response) => {
	let body = '';
	response.on('data', (chunk) => (body += chunk));
	response.on('end', () => console.log(body));
});
request.on('error', (error) => {
	console.error(error.message);
	process.exit(error.code === 'ECONNREFUSED' || error.code === 'ENOENT' ? 4 : 1);
});
request.end(command);
`;

export type BrowserAction = 'open' | 'click' | 'type' | 'select' | 'press' | 'hover' | 'scroll' | 'back' | 'wait' | 'look';

export type BrowserInput = {
	action: BrowserAction;
	url?: string;
	/** A Playwright selector: `role=button[name="Save"]`, `text=Sign in`, `label=Email` or CSS. */
	target?: string;
	text?: string;
	submit?: boolean;
	key?: string;
	amount?: number;
	ms?: number;
	/** Saves a PNG of the page after the action, under this name. */
	screenshot?: string;
	fullPage?: boolean;
	width?: number;
	height?: number;
};

export type BrowserState = {
	url: string;
	title: string;
	status: number | null;
	/** Why the action failed, such as no element matching the target; the page is described as it is anyway. */
	problem: string | null;
	/** A nonfatal limitation to pass on to the agent. */
	notice?: string;
	errors: string[];
	screenshot: string | null;
	/** The page's accessibility tree as YAML: roles, names and text, which is what the agent targets. */
	snapshot: string;
	/** Where the page is scrolled to (`StepResult.view`), for telling a step that only scrolled from one that did nothing. */
	view?: string;
};

/** The browser's files for one machine. Under /tmp, as a socket path must be short; named by the machine, as local machines share /tmp. */
function browserFiles(machine: Machine) {
	const base = `/tmp/anton-browser-${createHash('sha256').update(machine.root).digest('hex').slice(0, 10)}`;
	return { socket: `${base}.sock`, pid: `${base}.pid`, log: `${base}.log`, server: `${base}-server.cjs`, client: `${base}-client.cjs` };
}

/** The live view's port, a thousand above the desktop's socket, so it is named by the machine the same way. */
export const browserLivePort = (machine: Machine): number => desktopLayout(machine.root).socketPort + 1000;

/** Whether the machine's browser server runs, as one shell test with no side effects. */
export function browserRunning(machine: Machine): string {
	const { socket, pid } = browserFiles(machine);
	return `[ -S ${socket} ] && [ -f ${pid} ] && kill -0 "$(cat ${pid})" 2>/dev/null`;
}

/** An address for the Computer panel to watch the browser's tab at, or null when the browser does not run or the provider has no way in. */
export async function browserLiveUrl(machine: Machine): Promise<string | null> {
	if ((await machine.exec(browserRunning(machine))).exitCode !== 0) return null;
	return machine.socketUrl(browserLivePort(machine));
}

/** The browser could not be stopped, so nobody else may safely drive its screen yet. */
export class BrowserStopError extends Error {}

/** Stops the machine's browser and waits for it to leave before another driver can act. */
export async function closeBrowser(machine: Machine): Promise<void> {
	const { pid, socket } = browserFiles(machine);
	const result = await machine.exec(`
if [ -f ${pid} ]; then
  p=$(cat ${pid})
  alive() { state=$(ps -o stat= -p "$p" 2>/dev/null | tr -d ' '); case "$state" in ''|Z*) return 1;; *) return 0;; esac; }
  kill "$p" 2>/dev/null || true
  for i in $(seq 1 30); do alive || break; sleep 0.1; done
  if alive; then kill -KILL -- "-$p" 2>/dev/null || kill -KILL "$p" 2>/dev/null || true; fi
  for i in $(seq 1 30); do alive || break; sleep 0.1; done
  if alive; then echo 'Browser did not stop' >&2; exit 1; fi
  rm -f ${pid}
fi
rm -f ${socket}`);
	if (result.exitCode !== 0) throw new BrowserStopError(result.stderr.trim() || 'The sandbox browser did not stop.');
}

/**
 * Machines whose browser is installed and whose client is written. Each is a
 * command in the machine (a second or more on Modal, Playwright loaded to check
 * it), so a step after the first sends its command alone.
 */
const prepared = new Set<string>();
const machineKey = (machine: Machine) => `${machine.id}:${machine.root}`;

async function prepare(machine: Machine, signal?: AbortSignal): Promise<void> {
	if (prepared.has(machineKey(machine))) return;
	await run(machine, ENSURE_BROWSER, { timeoutMs: 10 * 60_000, signal });
	signal?.throwIfAborted();
	await writeMachineFile(machine, browserFiles(machine).client, new TextEncoder().encode(CLIENT));
	prepared.add(machineKey(machine));
}

/**
 * One step in the machine's browser: open a page, click, type and so on, then
 * describe the page. The tab stays open between steps; the first step starts
 * the browser.
 */
export async function browse(machine: Machine, input: BrowserInput, signal?: AbortSignal): Promise<BrowserState> {
	signal?.throwIfAborted();
	try {
		await prepare(machine, signal);
		signal?.throwIfAborted();
		const outputs = `${machine.root}/outputs`;
		const command = quote(JSON.stringify({ ...input, url: input.url && addressToUrl(input.url), screenshot: input.screenshot && screenshotFile(input.screenshot) }));
		const files = browserFiles(machine);
		const send = () => machine.exec(`node ${files.client} ${files.socket} ${command}`, { timeoutMs: 120_000, signal });
		let result = await send();
		signal?.throwIfAborted();
		// The client went (a machine's /tmp cleared, say): set the machine up again and send once more.
		if (result.exitCode !== 0 && result.exitCode !== 4 && /Cannot find module/.test(result.stderr)) {
			prepared.delete(machineKey(machine));
			await prepare(machine, signal);
			signal?.throwIfAborted();
			result = await send();
			signal?.throwIfAborted();
		}
		if (result.exitCode === 4) {
			await writeMachineFile(machine, files.server, new TextEncoder().encode(SERVER));
			signal?.throwIfAborted();
			await run(
				machine,
				`env -u DISPLAY NODE_PATH="$(npm root -g)" setsid nohup node ${files.server} ${files.socket} ${quote(outputs)} ${browserLivePort(machine)} < /dev/null > ${files.log} 2>&1 & echo $! > ${files.pid}; ` +
					`for i in $(seq 1 50); do [ -S ${files.socket} ] && exit 0; sleep 0.2; done; cat ${files.log} >&2; exit 1`,
				{ signal },
			);
			signal?.throwIfAborted();
			result = await send();
		}
		if (result.exitCode !== 0) throw new Error(`The browser failed: ${result.stderr.trim() || 'no answer'}`);
		const state = JSON.parse(new TextDecoder().decode(result.stdout).trim()) as Partial<BrowserState>;
		// Every field filled, whatever the server answered, so a failed step reads as a problem rather than breaking the tool.
		return {
			url: state.url ?? input.url ?? '',
			title: state.title ?? '',
			status: state.status ?? null,
			problem: state.problem ?? null,
			errors: state.errors ?? [],
			screenshot: state.screenshot ? `../outputs/${state.screenshot}` : null,
			snapshot: clipSnapshot(state.snapshot ?? ''),
			view: state.view,
		};
	} finally {
		// The detached browser can still be handling a request after its client is aborted.
		// Close it before the shared Computer queue is released.
		if (signal?.aborted) {
			try { await closeBrowser(machine); }
			catch (error) { throw new BrowserStopError(`Could not stop the sandbox browser: ${error instanceof Error ? error.message : String(error)}`); }
		}
	}
}

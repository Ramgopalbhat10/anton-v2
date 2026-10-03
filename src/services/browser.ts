import { createHash, randomUUID } from 'node:crypto';
import { config } from '../config.ts';
import { writeMachineFile } from '../core/machine-fs.ts';
import type { Machine } from '../core/ports.ts';
import { quote, run } from '../core/shell.ts';

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

const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

/** Screenshots a page from inside the machine into its outputs, so it shows in the Library. */
export async function takeScreenshot(machine: Machine, input: ScreenshotInput): Promise<Screenshot> {
	await run(machine, ENSURE_BROWSER, { timeoutMs: 10 * 60_000 });
	// Unique per call, so an earlier screenshot in the conversation never shows a later image.
	const file = `screenshots/${slug(input.name ?? '') || 'shot'}-${Date.now()}.png`;
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
 * Runs inside the machine and keeps one browser tab open between the agent's
 * steps, so a page keeps its state while the agent clicks and types through
 * it. Takes commands over a Unix socket and quits after a quiet spell.
 */
const SERVER = `
const http = require('http');
const fs = require('fs');
const { chromium } = require('playwright');
const [socket, outputs] = process.argv.slice(2);
const IDLE_MS = 15 * 60 * 1000;
let browser = null;
let page = null;
let errors = [];
let quit = null;
const idle = () => { clearTimeout(quit); quit = setTimeout(async () => { await browser?.close().catch(() => {}); process.exit(0); }, IDLE_MS); };

async function tab(width, height) {
	browser ??= await chromium.launch();
	if (!page || page.isClosed()) {
		page = await browser.newPage({ viewport: { width, height } });
		page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));
		page.on('pageerror', (error) => errors.push(String(error)));
	} else if (page.viewportSize().width !== width || page.viewportSize().height !== height) {
		await page.setViewportSize({ width, height });
	}
	return page;
}

async function act(command) {
	const page = await tab(command.width ?? 1280, command.height ?? 800);
	const target = () => {
		if (!command.target) throw new Error('This action needs a target');
		return page.locator(command.target).first();
	};
	let status = null;
	let problem = null;
	try {
		if (command.action === 'open') status = (await page.goto(command.url, { waitUntil: 'domcontentloaded', timeout: 30000 }))?.status() ?? null;
		else if (command.action === 'click') await target().click({ timeout: 10000 });
		else if (command.action === 'type') {
			await target().fill(command.text ?? '', { timeout: 10000 });
			if (command.submit) await target().press('Enter');
		} else if (command.action === 'select') await target().selectOption(command.text ?? '', { timeout: 10000 });
		else if (command.action === 'press') await (command.target ? target().press(command.key, { timeout: 10000 }) : page.keyboard.press(command.key));
		else if (command.action === 'hover') await target().hover({ timeout: 10000 });
		else if (command.action === 'scroll') await page.mouse.wheel(0, command.amount ?? 600);
		else if (command.action === 'back') await page.goBack({ waitUntil: 'domcontentloaded' });
		else if (command.action === 'wait') await (command.target ? target().waitFor({ timeout: 15000 }) : page.waitForTimeout(Math.min(command.ms ?? 1000, 15000)));
	} catch (error) {
		problem = error.message.split('\\n')[0];
	}
	await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
	let screenshot = null;
	if (command.screenshot) {
		fs.mkdirSync(outputs + '/screenshots', { recursive: true });
		screenshot = 'screenshots/' + command.screenshot + '.png';
		await page.screenshot({ path: outputs + '/' + screenshot, fullPage: Boolean(command.fullPage) });
	}
	const snapshot = await page.locator('body').ariaSnapshot({ timeout: 5000 }).catch(() => '');
	return { url: page.url(), title: await page.title().catch(() => ''), status, problem, errors: errors.splice(0).slice(0, 20), screenshot, snapshot };
}

let queue = Promise.resolve();
fs.rmSync(socket, { force: true });
http.createServer((request, response) => {
	idle();
	let body = '';
	request.on('data', (chunk) => (body += chunk));
	request.on('end', () => {
		queue = queue.then(async () => {
			const result = await act(JSON.parse(body)).catch((error) => ({ problem: error.message }));
			response.end(JSON.stringify(result));
		});
	});
}).listen(socket, idle);
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
	errors: string[];
	screenshot: string | null;
	/** The page's accessibility tree as YAML: roles, names and text, which is what the agent targets. */
	snapshot: string;
};

/** A page described this long is cut, so one step never floods the agent's context. */
const MAX_SNAPSHOT = 15_000;

/** The browser's files for one machine. Under /tmp, as a socket path must be short; named by the machine, as local machines share /tmp. */
function browserFiles(machine: Machine) {
	const base = `/tmp/anton-browser-${createHash('sha256').update(machine.root).digest('hex').slice(0, 10)}`;
	return { socket: `${base}.sock`, pid: `${base}.pid`, log: `${base}.log`, server: `${base}-server.cjs`, client: `${base}-client.cjs` };
}

/** Stops the machine's browser, if one is running. */
export async function closeBrowser(machine: Machine): Promise<void> {
	const { pid } = browserFiles(machine);
	await machine.exec(`[ -f ${pid} ] && kill "$(cat ${pid})" 2>/dev/null; rm -f ${pid}`);
}

/**
 * One step in the machine's browser: open a page, click, type and so on, then
 * describe the page. The tab stays open between steps; the first step starts
 * the browser.
 */
export async function browse(machine: Machine, input: BrowserInput): Promise<BrowserState> {
	await run(machine, ENSURE_BROWSER, { timeoutMs: 10 * 60_000 });
	const outputs = `${machine.root}/outputs`;
	const name = input.screenshot ? `${slug(input.screenshot) || 'page'}-${Date.now()}` : undefined;
	const command = quote(JSON.stringify({ ...input, screenshot: name }));
	const files = browserFiles(machine);
	await writeMachineFile(machine, files.client, new TextEncoder().encode(CLIENT));
	const send = () => machine.exec(`node ${files.client} ${files.socket} ${command}`, { timeoutMs: 120_000 });
	let result = await send();
	if (result.exitCode === 4) {
		await writeMachineFile(machine, files.server, new TextEncoder().encode(SERVER));
		await run(
			machine,
			`NODE_PATH="$(npm root -g)" nohup node ${files.server} ${files.socket} ${quote(outputs)} < /dev/null > ${files.log} 2>&1 & echo $! > ${files.pid}; ` +
				`for i in $(seq 1 50); do [ -S ${files.socket} ] && exit 0; sleep 0.2; done; cat ${files.log} >&2; exit 1`,
		);
		result = await send();
	}
	if (result.exitCode !== 0) throw new Error(`The browser failed: ${result.stderr.trim() || 'no answer'}`);
	const state = JSON.parse(new TextDecoder().decode(result.stdout).trim()) as BrowserState;
	const snapshot = state.snapshot ?? '';
	return {
		...state,
		screenshot: state.screenshot ? `../outputs/${state.screenshot}` : null,
		snapshot: snapshot.length > MAX_SNAPSHOT ? `${snapshot.slice(0, MAX_SNAPSHOT)}\n… (cut; scroll or open a narrower page)` : snapshot,
	};
}

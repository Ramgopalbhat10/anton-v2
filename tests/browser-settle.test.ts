import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import http from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { BROWSER_STEP, type StepResult } from '../src/services/browser-step.ts';

/** The sandbox's Playwright, where this computer has it, as the sandbox's browser server runs the step. */
const playwright = (() => {
	try {
		const root = execSync('npm root -g', { encoding: 'utf8' }).trim();
		const found = createRequire(`${root}/`)('playwright');
		found.chromium.executablePath();
		return found as typeof import('playwright-core');
	} catch {
		return null;
	}
})();

const browserStep = new Function(`return (${BROWSER_STEP})`)() as (page: unknown, command: Record<string, unknown>) => Promise<StepResult>;

/**
 * Three apps: one holding a live event stream open and one polling, as Anton's own
 * UI does (its network never idles), and a plain one. A click on either fetches data and draws it.
 */
const PAGE = (kind: string, delay: number) => `<!doctype html><body><button onclick="go()">Load</button><p id="out">none</p><script>
${kind === 'live' ? "new EventSource('/events');" : ''}
${kind === 'polling' ? "setInterval(() => fetch('/data?delay=5'), 250);" : ''}
async function go() { const r = await fetch('/data?delay=${delay}'); document.getElementById('out').textContent = await r.text(); }
</script></body>`;

let server: http.Server;
let base = '';
before(async () => {
	server = http.createServer((request, response) => {
		const url = new URL(request.url ?? '/', 'http://x');
		if (url.pathname === '/events') {
			response.writeHead(200, { 'Content-Type': 'text/event-stream' });
			const timer = setInterval(() => response.write('data: tick\n\n'), 200);
			request.on('close', () => clearInterval(timer));
			return;
		}
		if (url.pathname === '/data') {
			setTimeout(() => response.end('loaded'), Number(url.searchParams.get('delay')));
			return;
		}
		response.setHeader('Content-Type', 'text/html');
		response.end(PAGE(url.pathname.slice(1), Number(url.searchParams.get('delay') ?? 300)));
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.closeAllConnections?.() ?? server.close());

async function timedClick(path: string) {
	const browser = await playwright!.chromium.launch();
	try {
		const page = await browser.newPage();
		await browserStep(page, { action: 'open', url: `${base}${path}` });
		const start = Date.now();
		const result = await browserStep(page, { action: 'click', target: 'role=button[name="Load"]' });
		return { result, ms: Date.now() - start };
	} finally {
		await browser.close();
	}
}

test('a click on a page holding a live event stream describes what the click fetched', { skip: !playwright && 'needs Playwright Chromium' }, async () => {
	const { result, ms } = await timedClick('/live?delay=300');
	assert.equal(result.problem, null);
	assert.match(result.snapshot, /paragraph: loaded/, 'what the click fetched is drawn before the page is described');
	assert.ok(ms < 3500, `took ${ms} ms`);
});

test('a click on a page that keeps polling answers once its page is still, not after the network timeout', { skip: !playwright && 'needs Playwright Chromium' }, async () => {
	const { result, ms } = await timedClick('/polling?delay=300');
	assert.match(result.snapshot, /paragraph: loaded/);
	assert.ok(ms < 3500, `took ${ms} ms; waiting for an idle network took over 5 s`);
});

test('a plain page still waits for what the click fetched, even past the quiet spell', { skip: !playwright && 'needs Playwright Chromium' }, async () => {
	const { result } = await timedClick('/plain?delay=1600');
	assert.match(result.snapshot, /paragraph: loaded/);
});

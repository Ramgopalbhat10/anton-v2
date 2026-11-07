import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import http from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { codeReport, quickjsExecute } from '../src/services/browser-run.ts';
import { browserFunctions } from '../src/services/browser-step.ts';

/** The sandbox's Playwright, where this computer has it. */
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
const skip = !playwright && 'needs Playwright Chromium';

const { browserStep, browserRun, antonNodeExecute } = browserFunctions();

const PAGES: Record<string, string> = {
	'/list': `<title>List</title><ul>${[1, 2, 3, 4, 5].map((n) => `<li class="item ${n % 2 ? 'odd' : 'even'}">Item ${n}</li>`).join('')}</ul><a href="/two">Next</a>`,
	'/two': '<title>Two</title><p>Second page</p>',
	'/form': `<title>Form</title><input aria-label="Name" id="name"><button onclick="document.querySelector('#out').textContent='Hello ' + document.querySelector('#name').value">Greet</button>
		<button onclick="document.querySelector('#out').textContent='Deleted'">Delete account</button><p id="out"></p>`,
	// Shows "Loading..." and nothing else changes until a timer shows the result, as a page counting down does.
	'/slow': `<title>Slow</title><button onclick="document.querySelector('#l').hidden=false; setTimeout(() => { document.querySelector('#l').hidden=true; document.querySelector('#r').textContent='Done'; }, 2500)">Start</button>
		<div id="l" hidden>Loading...</div><p id="r"></p>`,
};

let server: http.Server;
let base = '';
before(async () => {
	server = http.createServer((request, response) => {
		response.setHeader('Content-Type', 'text/html');
		response.end(PAGES[new URL(request.url ?? '/', 'http://x').pathname] ?? '<title>None</title>');
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.closeAllConnections?.() ?? server.close());

async function withPage<T>(work: (page: import('playwright-core').Page) => Promise<T>): Promise<T> {
	const browser = await playwright!.chromium.launch();
	try {
		return await work(await browser.newPage());
	} finally {
		await browser.close();
	}
}

for (const [where, execute] of [['in a QuickJS VM (the Browser panel)', quickjsExecute], ['in the sandbox’s own process', antonNodeExecute]] as const) {
	test(`run does several steps in one call and answers with what the code returns, ${where}`, { skip }, async () => {
		await withPage(async (page) => {
			const ran = await browserRun(
				page,
				{
					code: `await page.goto(${JSON.stringify(`${base}/list`)});
const odd = await page.$$eval('li.item', (items) => items.filter((item) => item.classList.contains('odd')).length);
const texts = await page.getByText(/Item [45]/).allTextContents();
console.log('items', await page.locator('li').count());
await page.getByRole('link', { name: 'Next' }).click();
await page.waitForURL(/two/);
return { odd, texts, at: page.url(), title: await page.title() };`,
				},
				undefined,
				execute,
			);
			assert.equal(ran.problem, null);
			assert.deepEqual(JSON.parse(ran.result!), { odd: 3, texts: ['Item 4', 'Item 5'], at: `${base}/two`, title: 'Two' });
			assert.deepEqual(ran.logs, ['items 5']);
			assert.equal(ran.url, `${base}/two`);
			assert.match(ran.snapshot, /Second page/, 'the page is described for the checks after a run');
		});
	});

	test(`a click in run on something risky asks first, once per name, and a no stops the run, ${where}`, { skip }, async () => {
		await withPage(async (page) => {
			await page.goto(`${base}/form`);
			const asked: string[] = [];
			const allowed = await browserRun(
				page,
				{ code: `await page.getByLabel('Name').fill('Ada'); await page.getByRole('button', { name: 'Greet' }).click(); await page.getByText('Delete account').click(); await page.getByText('Delete account').click(); return page.locator('#out').innerText();` },
				async (name) => {
					asked.push(name);
					return true;
				},
				execute,
			);
			assert.equal(allowed.problem, null);
			assert.equal(allowed.result, 'Deleted');
			assert.deepEqual(asked, ['Delete account'], 'Greet has no risky word; Delete is asked about once');

			await page.goto(`${base}/form`);
			const refused = await browserRun(
				page,
				{ code: `try { await page.getByText('Delete account').click(); } catch {} await page.getByRole('button', { name: 'Greet' }).click(); return 'went on';` },
				async () => false,
				execute,
			);
			assert.match(refused.problem ?? '', /^Not clicked: "Delete account" may buy, send, post or delete something/);
			assert.equal(refused.result, '', 'code that caught the stop does not go on');
			assert.equal(await page.locator('#out').innerText(), '');
		});
	});

	test(`a wrong selector in run fails within seconds, not Playwright's 30, ${where}`, { skip }, async () => {
		await withPage(async (page) => {
			await page.goto(`${base}/form`);
			const start = Date.now();
			const ran = await browserRun(page, { code: `await page.locator('#nothing-here').click(); return 'no';` }, undefined, execute);
			assert.match(ran.problem ?? '', /^The code failed: .*Timeout 5000ms/);
			assert.ok(Date.now() - start < 9000, `took ${Date.now() - start} ms`);
		});
	});
}

test('code run for the Browser panel reaches nothing of Anton’s process', { skip }, async () => {
	await withPage(async (page) => {
		const ran = await browserRun(page, { code: `return [typeof process, typeof require, typeof fetch, typeof globalThis.setTimeout].join(',');` }, undefined, quickjsExecute);
		assert.equal(ran.result, 'undefined,undefined,undefined,undefined');
	});
});

test('a wait ends early once the page is done, but not while it says it is loading', { skip }, async () => {
	await withPage(async (page) => {
		await page.goto(`${base}/slow`);
		let start = Date.now();
		await browserStep(page, { action: 'wait', ms: 6000 });
		assert.ok(Date.now() - start < 2000, `a still page waited ${Date.now() - start} ms of 6000`);
		await browserStep(page, { action: 'click', target: 'role=button[name="Start"]' });
		start = Date.now();
		const waited = await browserStep(page, { action: 'wait', ms: 6000 });
		assert.match(waited.snapshot, /paragraph: Done/, 'the wait lasted until the page showed its result');
		assert.ok(Date.now() - start < 5000, `took ${Date.now() - start} ms`);
	});
});

test('a step targets an element by the ref the page description gave it', { skip }, async () => {
	await withPage(async (page) => {
		const opened = await browserStep(page, { action: 'open', url: `${base}/form` });
		const ref = /textbox "Name" \[ref=(e\d+)\]/.exec(opened.snapshot)?.[1];
		assert.ok(ref, opened.snapshot);
		const typed = await browserStep(page, { action: 'type', target: ref, text: 'Ada' });
		assert.equal(typed.problem, null);
		const greet = /button "Greet" \[ref=(e\d+)\]/.exec(typed.snapshot)![1];
		const clicked = await browserStep(page, { action: 'click', target: `ref=${greet}` });
		assert.match(clicked.snapshot, /paragraph: Hello Ada/);
	});
});

test('what a run returns is cut for the agent, and so are its logs', () => {
	const report = codeReport('x'.repeat(5000), ['a'.repeat(3000), 'b'.repeat(3000), 'c']);
	assert.equal(report.result.length > 4000 && report.result.length < 4100, true);
	assert.match(report.result, /cut at 4000 characters; return less/);
	assert.deepEqual(report.logs?.map((line) => line.length), [3000, 1000]);
	assert.deepEqual(codeReport('', []), { result: '' });
});

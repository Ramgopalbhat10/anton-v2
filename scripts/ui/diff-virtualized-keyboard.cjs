const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');

// Run against ui:fixture, not a live account: node scripts/ui/diff-virtualized-keyboard.cjs <url>.
async function check() {
	const url = process.argv[2];
	assert(url, 'Pass the running UI fixture URL');
	const executablePath = process.env.PERF_CHROMIUM || undefined;
	const browser = await chromium.launch({
		channel: 'chromium',
		...(executablePath ? { executablePath } : {}),
		ignoreDefaultArgs: ['--hide-scrollbars'],
	});
	try {
		const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
		const errors = [];
		page.on('console', (msg) => {
			if (msg.type() === 'error') errors.push(`[console.error] ${msg.text()}`);
		});
		page.on('pageerror', (error) => errors.push(`[pageerror] ${error.message}`));

		const diffLines = Array.from({ length: 2000 }, (_, i) =>
			i === 0 || i === 1999 ? `+export const line${i + 1} = ${i + 1};` : ` export const line${i + 1} = ${i + 1};`,
		);
		const largePatch = [
			'diff --git a/src/large.ts b/src/large.ts',
			'index 1111111..2222222 100644',
			'--- a/src/large.ts',
			'+++ b/src/large.ts',
			'@@ -1,1998 +1,2000 @@',
			...diffLines,
			'',
		].join('\n');

		await page.route('**/api/sessions/perf-task/changes*', async (route) => {
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({
					source: 'live',
					at: null,
					branch: 'anton/perf',
					baseBranch: 'main',
					patch: largePatch,
					log: [{ sha: 'abcdef1234567', subject: 'Large synthetic change', at: '2026-10-01T00:00:00Z' }],
				}),
			});
		});

		await page.goto(new URL('/agents/perf-task?turns=0&panel=Changes', url).href);
		await page.waitForFunction(() => Boolean(window.__chat));
		await page.getByRole('list', { name: 'Changed files' }).waitFor({ state: 'visible', timeout: 15000 });

		const region = page.getByRole('region', { name: /Diff for src\/large\.ts/ });
		await region.waitFor({ state: 'visible', timeout: 15000 });
		await page.waitForFunction(() => {
			const el = document.querySelector('diffs-container');
			return Boolean(el && el.shadowRoot && el.shadowRoot.querySelectorAll('[data-line]').length > 0);
		});

		const initialState = await page.evaluate(() => {
			const shadow = document.querySelector('diffs-container').shadowRoot;
			return {
				mountedCount: shadow.querySelectorAll('[data-line]').length,
				has2000: Boolean(shadow.querySelector('[data-line="2000"]')),
			};
		});
		assert.equal(initialState.has2000, false, 'Expected line 2000 not to be mounted initially by virtualizer');
		assert.ok(initialState.mountedCount < 1000, `Expected virtualizer to mount a subset, saw ${initialState.mountedCount}`);

		await region.focus();
		await page.keyboard.press('End');
		await page.waitForFunction(() => {
			const shadow = document.querySelector('diffs-container')?.shadowRoot;
			return Boolean(shadow?.querySelector('[data-line="2000"]') && shadow?.querySelector('[data-line][data-selected-line]'));
		}, null, { timeout: 10000 });

		await page.keyboard.press('Enter');
		const textarea = page.getByRole('textbox', { name: 'Comment' });
		await textarea.waitFor({ state: 'visible', timeout: 10000 });
		assert.equal(await textarea.evaluate((el) => document.activeElement === el), true, 'Expected Comment textarea to receive focus');
		const box = await textarea.boundingBox();
		assert.ok(box && box.height > 0 && box.y >= 0 && box.y + box.height <= 900, `Expected visible composer box, got ${JSON.stringify(box)}`);
		assert.deepEqual(errors, [], `Browser errors detected: ${errors.join('; ')}`);
		console.log(`Virtualized diff keyboard End+Enter passed (initial mounted=${initialState.mountedCount}, composer y=${Math.round(box.y)}).`);
	} finally {
		await browser.close();
	}
}

check().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});

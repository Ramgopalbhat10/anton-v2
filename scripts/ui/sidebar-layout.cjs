const assert = require('node:assert/strict');
const { mkdir } = require('node:fs/promises');
const { join } = require('node:path');
const { chromium } = require('playwright-core');

// Run against ui:fixture, not a live account: node scripts/ui/sidebar-layout.cjs <url> [screenshots-dir].
async function check() {
	const url = process.argv[2];
	assert(url, 'Pass the running UI fixture URL');
	const screenshots = process.argv[3];
	if (screenshots) await mkdir(screenshots, { recursive: true });
	const browser = await chromium.launch({ executablePath: process.env.PERF_CHROMIUM });
	try {
		const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
		const errors = [];
		page.on('pageerror', (error) => errors.push(error.message));
		await page.addInitScript(() => localStorage.setItem('anton.sidebar', 'open'));
		await page.goto(new URL('/projects/space-billing', url).href);
		const sidebar = page.locator('aside.sg-nav');
		const switcher = sidebar.getByRole('button', { name: /Billing v2/ });
		const menu = page.getByRole('menu');
		await sidebar.getByRole('button', { name: 'Hide sidebar', exact: true }).click();

		async function placement(side, width) {
			await page.waitForFunction(({ side, width }) => {
				const menu = document.querySelector('[role="menu"]');
				if (!menu || menu.getAttribute('data-side') !== side) return false;
				const rect = menu.getBoundingClientRect();
				return rect.width > 0 && rect.left >= 0 && rect.right <= width;
			}, { side, width });
			await menu.evaluate(async (element) => {
				await Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished));
			});
			const rect = await menu.boundingBox();
			assert(rect && rect.x >= 0 && rect.x + rect.width <= width, `Menu stays inside ${width}px after its animation`);
			for (const label of ['Project settings', 'All projects', 'All tasks']) {
				assert(await menu.getByRole('menuitem', { name: label, exact: true }).isVisible(), `${label} visible at ${width}px`);
			}
		}

		await page.waitForFunction(() => document.querySelector('.sg-nav-column').getBoundingClientRect().width === 48);
		await switcher.click();
		await placement('right', 1280);
		await page.keyboard.press('Escape');

		// Reproduce the review: collapse at desktop width, then resize without reloading.
		for (const width of [390, 320, 767]) {
			await page.setViewportSize({ width, height: 800 });
			await page.waitForFunction(() => document.querySelector('aside.sg-nav').dataset.collapsed === 'false');
			if (await sidebar.getAttribute('data-open') !== 'true') {
				await page.getByRole('button', { name: 'Open sidebar', exact: true }).click();
			}
			await page.waitForFunction(() => document.querySelector('aside.sg-nav').getBoundingClientRect().x === 0);
			assert((await switcher.boundingBox()).width > 200, 'Mobile switcher is a full row');
			assert.equal(await page.evaluate(() => localStorage.getItem('anton.sidebar')), 'collapsed', 'Saved preference survives resizing');
			await switcher.click();
			await placement('bottom', width);
			if (screenshots) await page.screenshot({ path: join(screenshots, `project-switcher-${width}.png`) });
			await page.keyboard.press('Escape');
		}

		// Crossing md restores the rail and right placement, including while the menu is open.
		await switcher.click();
		await placement('bottom', 767);
		await page.setViewportSize({ width: 768, height: 800 });
		await placement('right', 768);
		await page.setViewportSize({ width: 390, height: 800 });
		await placement('bottom', 390);
		assert.deepEqual(errors, [], 'No browser runtime errors');
		console.log('Sidebar layout passed: desktop rail → 390/320/767px drawers → 768px rail → drawer, with menus inside the viewport.');
	} finally {
		await browser.close();
	}
}

check().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});

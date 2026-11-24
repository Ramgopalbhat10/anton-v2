const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');

// Run against ui:fixture: node scripts/ui/connectors-menu-layout.cjs <url> [screenshots-dir]
// A failed connector toggle puts a long API error in the Connectors sub-menu; the rows must stay reachable,
// the error must be visible without scrolling, and a toggle still in flight at close must not post it late.
async function check() {
	const url = process.argv[2];
	assert(url, 'Pass the running UI fixture URL');
	const screenshots = process.argv[3];
	const browser = await chromium.launch({ channel: 'chromium', executablePath: process.env.PERF_CHROMIUM });
	try {
		const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
		const errors = [];
		page.on('pageerror', (error) => errors.push(error.message));

		const account = {
			id: 'acct-1',
			name: 'Google',
			client: null,
			email: 'me@example.com',
			connectedAt: '2026-01-01T00:00:00.000Z',
			scopes: [],
			problem: null,
			callbackPath: '/settings/connectors',
		};
		const mailboxes = Array.from({ length: 24 }, (_, i) => ({
			id: `mb-${i}`,
			name: `Team mailbox ${String(i).padStart(2, '0')}`,
			account: 'acct-1',
			options: { enabled: i % 3 !== 0, draft: false, send: false },
			canDraft: true,
			access: { read: true, draft: false, send: false },
		}));
		const view = { accounts: [account], mailboxes, mcpServers: [], composio: { configured: false, keyFromEnv: false, accounts: [] } };
		const longError = `Toggle failed: ${'the connector service returned an unexpected response '.repeat(30)}`;

		// The first toggle stays in flight until released, so the menu can close while its request is pending.
		let puts = 0;
		let releaseFirst;
		const firstGate = new Promise((resolve) => (releaseFirst = resolve));
		await page.route('**/api/connectors/mailboxes/*', async (route) => {
			if (route.request().method() !== 'PUT') return route.continue();
			puts += 1;
			if (puts === 1) await firstGate;
			return route.fulfill({ status: 500, json: { error: longError } });
		});
		await page.route('**/api/connectors', (route) => {
			if (route.request().method() === 'GET') return route.fulfill({ json: view });
			return route.continue();
		});

		const openMenu = async () => {
			await page.getByRole('button', { name: 'Add files and connectors' }).click();
			await page.getByRole('menuitem', { name: /^Connectors/ }).hover();
			const submenu = page.getByRole('menu').filter({ hasText: 'Manage connectors' });
			await submenu.waitFor({ state: 'visible' });
			return submenu;
		};

		await page.goto(new URL('/agents/perf-task?turns=0', url).href);
		await page.waitForFunction(() => Boolean(window.__chat));
		let submenu = await openMenu();

		// Close while the first toggle's request is still pending; its late failure must not appear on reopen.
		const firstPut = page.waitForRequest('**/api/connectors/mailboxes/*');
		const firstResponse = page.waitForResponse('**/api/connectors/mailboxes/*');
		await submenu.getByRole('menuitemcheckbox', { name: /Team mailbox 00/ }).click();
		await firstPut;
		await page.keyboard.press('Escape');
		releaseFirst();
		await firstResponse;
		await page.waitForTimeout(250);
		submenu = await openMenu();
		assert((await submenu.getByText(/Toggle failed/).count()) === 0, 'A toggle that fails after close cannot post its error');

		const scroller = submenu.locator('div.overflow-y-auto');
		assert(await scroller.evaluate((el) => el.scrollHeight > el.clientHeight), 'The rows overflow the capped sub-menu');
		const menuBox = await submenu.boundingBox();
		assert(menuBox && menuBox.height <= 421, `Sub-menu stays within its 420px cap (got ${menuBox?.height})`);

		// A failing toggle shows its error in the pinned area, inside the visible sub-menu without scrolling.
		await submenu.getByRole('menuitemcheckbox', { name: /Team mailbox 01/ }).click();
		const error = submenu.getByText(/Toggle failed/);
		await error.waitFor({ state: 'visible' });
		const errorBox = await error.boundingBox();
		const box = await submenu.boundingBox();
		assert(errorBox && box && errorBox.y >= box.y - 1 && errorBox.y + errorBox.height <= box.y + box.height + 1, 'The error is inside the visible sub-menu without scrolling');
		assert((await scroller.getByText(/Toggle failed/).count()) === 0, 'The error is not buried at the bottom of the scroll region');

		await scroller.evaluate((el) => {
			el.scrollTop = el.scrollHeight;
		});
		await submenu.getByRole('menuitemcheckbox', { name: /Team mailbox 23/ }).waitFor({ state: 'visible' });
		const help = submenu.getByText('On for every task. Tools load only when a task uses them', { exact: false });
		assert(await help.isVisible(), 'The help text stays pinned below the scroll region');
		const helpBox = await help.boundingBox();
		const finalBox = await submenu.boundingBox();
		assert(helpBox && finalBox && helpBox.y + helpBox.height <= finalBox.y + finalBox.height + 1, 'The pinned footer is not clipped by the cap');
		if (screenshots) await page.screenshot({ path: `${screenshots}/connectors-menu-long-error.png` });

		// Closing and reopening the sub-menu clears the old error.
		await page.keyboard.press('Escape');
		submenu = await openMenu();
		assert((await submenu.getByText(/Toggle failed/).count()) === 0, 'Reopening the sub-menu clears the old error');
		assert.deepEqual(errors, []);
	} finally {
		await browser.close();
	}
}

check().catch((error) => {
	console.error(error);
	process.exit(1);
});

const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');

// Run against ui:fixture: node scripts/ui/connectors-menu-layout.cjs <url> [screenshots-dir]
// A failed connector toggle puts a long API error in the Connectors sub-menu; the rows must stay reachable.
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

		await page.route('**/api/connectors/mailboxes/*', (route) => {
			if (route.request().method() === 'PUT') return route.fulfill({ status: 500, json: { error: longError } });
			return route.continue();
		});
		await page.route('**/api/connectors', (route) => {
			if (route.request().method() === 'GET') return route.fulfill({ json: view });
			return route.continue();
		});

		await page.goto(new URL('/agents/perf-task?turns=0', url).href);
		await page.waitForFunction(() => Boolean(window.__chat));
		await page.getByRole('button', { name: 'Add files and connectors' }).click();
		const trigger = page.getByRole('menuitem', { name: /^Connectors/ });
		await trigger.hover();
		const submenu = page.getByRole('menu').filter({ hasText: 'Manage connectors' });
		await submenu.waitFor({ state: 'visible' });

		const scroller = submenu.locator('div.overflow-y-auto');
		assert(await scroller.evaluate((el) => el.scrollHeight > el.clientHeight), 'The rows overflow the capped sub-menu');
		const menuBox = await submenu.boundingBox();
		assert(menuBox && menuBox.height <= 421, `Sub-menu stays within its 420px cap (got ${menuBox?.height})`);

		// The failing toggle lands its long error inside the scroll region, not the pinned footer.
		await submenu.getByRole('menuitemcheckbox', { name: /Team mailbox 00/ }).click();
		await submenu.getByText(longError.slice(0, 60)).waitFor({ state: 'visible' });

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
		assert.deepEqual(errors, []);
	} finally {
		await browser.close();
	}
}

check().catch((error) => {
	console.error(error);
	process.exit(1);
});

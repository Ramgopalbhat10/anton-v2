/*
 * What the agent's two browsers share: one step, written once. The sandbox's
 * browser server runs it as part of its script, and the Browser panel's shared
 * browser runs it on Anton's side, so a step behaves the same in both.
 */

/** A page described this long is cut, so one step never floods the agent's context. */
export const MAX_SNAPSHOT = 15_000;

export function clipSnapshot(snapshot: string): string {
	return snapshot.length > MAX_SNAPSHOT ? `${snapshot.slice(0, MAX_SNAPSHOT)}\n… (cut; scroll or open a narrower page)` : snapshot;
}

export const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

/** Where a step's screenshot goes in the task's outputs: unique per call, so an earlier one in the conversation never shows a later image. */
export const screenshotFile = (name: string) => `screenshots/${slug(name) || 'page'}-${Date.now()}.png`;

/** The local machine's own addresses, which only a browser inside the sandbox can reach. */
export const isLocalAddress = (url: string | undefined) => Boolean(url && /^(https?:\/\/)?(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?(\/|$)/i.test(url.trim()));

/** What was typed as an address as a URL: a host gets https, a local one http, anything else is searched for. */
export function addressToUrl(input: string): string {
	const text = input.trim();
	if (!text) return 'about:blank';
	if (isLocalAddress(text)) return /^https?:\/\//i.test(text) ? text : `http://${text}`;
	if (/^[a-z][a-z0-9+.-]*:/i.test(text)) return text;
	if (!/\s/.test(text) && /^[^/]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(text)) return `https://${text}`;
	return `https://www.google.com/search?q=${encodeURIComponent(text)}`;
}

/** What a step reports, before the caller adds console errors and a screenshot. */
export type StepResult = { url: string; title: string; status: number | null; problem: string | null; snapshot: string };

/**
 * One step on a Playwright page, as plain JavaScript source: `browserStep(page, command)`
 * acts, waits for a page it loaded to settle, and describes the page as an accessibility tree.
 */
export const BROWSER_STEP = `async function browserStep(page, command) {
	const target = () => {
		if (!command.target) throw new Error('This action needs a target');
		return page.locator(command.target).first();
	};
	let status = null;
	let problem = null;
	try {
		switch (command.action) {
			case 'open': status = (await page.goto(command.url, { waitUntil: 'domcontentloaded', timeout: 30000 }))?.status() ?? null; break;
			case 'click': await target().click({ timeout: 10000 }); break;
			case 'type':
				await target().fill(command.text ?? '', { timeout: 10000 });
				if (command.submit) await target().press('Enter');
				break;
			case 'select': await target().selectOption(command.text ?? '', { timeout: 10000 }); break;
			case 'press': await (command.target ? target().press(command.key ?? 'Enter', { timeout: 10000 }) : page.keyboard.press(command.key ?? 'Enter')); break;
			case 'hover': await target().hover({ timeout: 10000 }); break;
			case 'scroll': await page.mouse.wheel(0, command.amount ?? 600); break;
			case 'back': await page.goBack({ waitUntil: 'domcontentloaded' }); break;
			case 'wait': await (command.target ? target().waitFor({ timeout: 15000 }) : page.waitForTimeout(Math.min(command.ms ?? 1000, 15000))); break;
		}
	} catch (error) {
		problem = String((error && error.message) || error).split('\\n')[0];
	}
	// Only a step that can load a page waits for it to settle; scrolling, hovering, waiting and looking answer at once.
	if (!['scroll', 'hover', 'wait', 'look'].includes(command.action)) await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
	const snapshot = await page.locator('body').ariaSnapshot({ timeout: 5000 }).catch(() => '');
	return { url: page.url(), title: await page.title().catch(() => ''), status, problem, snapshot };
}`;

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

/**
 * A raw file on GitHub's file hosts: plain text with nothing to act on, which web_fetch reads in a second and a
 * browser renders as one long page (one such step once hung for 22 minutes). The browser tool sends it to web_fetch.
 */
export const isRawFile = (url: string | undefined) => Boolean(url && /^(https?:\/\/)?(raw\.githubusercontent\.com|gist\.githubusercontent\.com)\//i.test(url.trim()));

/** What was typed as an address as a URL: a host gets https, a local one http, anything else is searched for. */
export function addressToUrl(input: string): string {
	const text = input.trim();
	if (!text) return 'about:blank';
	if (isLocalAddress(text)) return /^https?:\/\//i.test(text) ? text : `http://${text}`;
	if (/^[a-z][a-z0-9+.-]*:/i.test(text)) return text;
	if (!/\s/.test(text) && /^[^/]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(text)) return `https://${text}`;
	return `https://www.google.com/search?q=${encodeURIComponent(text)}`;
}

/**
 * What a step reports, before the caller adds console errors and a screenshot. `view` is where the page and
 * its scrolled areas are scrolled to: a click that only scrolls (a table of contents, a "go to" link) leaves
 * the accessibility tree as it was, and this is how a caller still sees that it did something.
 */
export type StepResult = { url: string; title: string; status: number | null; problem: string | null; snapshot: string; view?: string };

/** How many iframes a step describes, and how much of each: a page of ads would otherwise fill the snapshot. */
export const MAX_FRAMES = 5;
const FRAME_CHARS = 4_000;

/**
 * One step on a Playwright page, as plain JavaScript source: `browserStep(page, command)`
 * acts, waits for a page it loaded to settle, and describes the page as an accessibility tree.
 * A page's own tree shows an iframe only as "- iframe", so a payment form or an embed was out
 * of the agent's reach: each iframe big enough to use has its tree added after the page's,
 * under "- iframe [frame=N]:", N its place among the page's iframes.
 */
export const BROWSER_STEP = `async function browserStep(page, command) {
	const framesOf = async () => {
		const frames = await page.locator('iframe').elementHandles().catch(() => []);
		let out = '';
		let shown = 0;
		for (const [index, handle] of frames.entries()) {
			if (shown < ${MAX_FRAMES}) {
				const box = await handle.boundingBox().catch(() => null);
				const frame = box && box.width >= 40 && box.height >= 20 ? await handle.contentFrame().catch(() => null) : null;
				const tree = frame ? (await frame.locator('body').ariaSnapshot({ timeout: 2000 }).catch(() => '')).trim() : '';
				if (tree) {
					shown += 1;
					const clipped = tree.length > ${FRAME_CHARS} ? tree.slice(0, ${FRAME_CHARS}) + '\\n… (cut)' : tree;
					out += '\\n- iframe [frame=' + index + ']:\\n' + clipped.split('\\n').map((line) => '  ' + line).join('\\n');
				}
			}
			await handle.dispose().catch(() => {});
		}
		return out;
	};
	// A control inside an iframe is named as frame=N >> its selector, N counting the page's iframes from 0, as its tree lists it.
	const target = () => {
		if (!command.target) throw new Error('This action needs a target');
		const inFrame = command.target.startsWith('frame=') ? command.target.indexOf(' >> ') : -1;
		if (inFrame === -1) return page.locator(command.target).first();
		const frame = page.locator('iframe').nth(Number(command.target.slice(6, inFrame)) || 0).contentFrame();
		return frame.locator(command.target.slice(inFrame + 4)).first();
	};
	// Requests the step sets off. Playwright's networkidle fires once per load, so after a click on a page that
	// already idled it answers at once, before what the click fetched is drawn; and on a page that keeps polling it
	// never fires, so every step there waited out the whole timeout.
	const pending = new Map();
	let lastNetwork = Date.now();
	const started = (request) => {
		lastNetwork = Date.now();
		if (!['eventsource', 'websocket'].includes(request.resourceType())) pending.set(request, Date.now());
	};
	const ended = (request) => {
		lastNetwork = Date.now();
		pending.delete(request);
	};
	page.on('request', started);
	page.on('requestfinished', ended);
	page.on('requestfailed', ended);
	// How long the page's DOM has gone unchanged, from an observer the first look at a document leaves in it.
	const domQuietFor = () =>
		page
			.evaluate(() => {
				const seen = window.__antonMutations;
				if (seen) return performance.now() - seen.last;
				const record = { last: performance.now() };
				window.__antonMutations = record;
				new MutationObserver(() => { record.last = performance.now(); }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
				return 0;
			})
			.catch(() => 0);
	await domQuietFor();
	// Settled once nothing it asked for is in flight and the network has been quiet a moment, for the page to draw
	// what came back; or, on a page whose polling keeps the network busy, once a second has passed and its DOM has
	// been still for half of one. A request open over two seconds is taken for a live connection, which never ends.
	const settle = async () => {
		const begun = Date.now();
		while (Date.now() - begun < 5000) {
			const now = Date.now();
			const busy = [...pending.values()].some((at) => now - at < 2000);
			if (!busy && now - lastNetwork >= 300) return;
			if (!busy && now - begun >= 1000 && (await domQuietFor()) >= 500) return;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
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
			// From off the element first: a mouse already over it (after a click on it) fires no mouseenter, so nothing it reveals would show.
			case 'hover': await page.mouse.move(0, 0); await target().hover({ timeout: 10000 }); break;
			case 'scroll': await page.mouse.wheel(0, command.amount ?? 600); break;
			// A page restored from the back-forward cache fires no load event, so only the commit is awaited; the settle below does the rest.
			case 'back': await page.goBack({ waitUntil: 'commit', timeout: 10000 }); break;
			case 'wait': await (command.target ? target().waitFor({ timeout: 15000 }) : page.waitForTimeout(Math.min(command.ms ?? 1000, 15000))); break;
		}
	} catch (error) {
		problem = String((error && error.message) || error).split('\\n')[0];
	}
	// Only a step that can load a page waits for it to settle; scrolling, hovering, waiting and looking answer at once.
	if (!['scroll', 'hover', 'wait', 'look'].includes(command.action)) await settle();
	const snapshot = (await page.locator('body').ariaSnapshot({ timeout: 5000 }).catch(() => '')) + (await framesOf());
	page.off('request', started);
	page.off('requestfinished', ended);
	page.off('requestfailed', ended);
	const view = await page
		.evaluate(() => {
			const at = [scrollX + ',' + scrollY];
			for (const element of document.querySelectorAll('*')) if (element.scrollTop || element.scrollLeft) at.push(element.scrollTop + ',' + element.scrollLeft);
			return at.join(' ');
		})
		.catch(() => '');
	return { url: page.url(), title: await page.title().catch(() => ''), status, problem, snapshot, view };
}`;

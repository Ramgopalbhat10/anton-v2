/*
 * What the agent's two browsers share: one step, and one run of code, written
 * once. The sandbox's browser server runs this source as part of its script,
 * and the Browser panel's shared browser runs it on Anton's side, so a step
 * behaves the same in both.
 */

/** A page described this long is cut, so one step never floods the agent's context. */
export const MAX_SNAPSHOT = 15_000;

export function clipSnapshot(snapshot: string): string {
	return snapshot.length > MAX_SNAPSHOT ? `${snapshot.slice(0, MAX_SNAPSHOT)}\n… (cut; use run to read the rest, or open a narrower page)` : snapshot;
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

/** Words on a control that make a click on it worth asking about before it happens: it may buy, send, post or delete. */
export const RISKY_WORDS =
	/\b(buy|pay|purchase|order|checkout|check out|place|submit|send|post|publish|delete|remove|destroy|confirm|subscribe|unsubscribe|book|reserve|transfer|donate|sign up|register|create|save|apply|accept|tweet|reply|comment|invite|share|cancel|archive|merge|deploy|approve|install|withdraw|deposit|logout|log out|sign out)\b/i;

/**
 * What a step reports, before the caller adds console errors and a screenshot. `view` is where the page and
 * its scrolled areas are scrolled to: a click that only scrolls (a table of contents, a "go to" link) leaves
 * the accessibility tree as it was, and this is how a caller still sees that it did something. A run of code
 * also reports what the code returned and logged.
 */
export type StepResult = { url: string; title: string; status: number | null; problem: string | null; snapshot: string; view?: string; result?: string; logs?: string[] };

/** How many iframes a step describes, and how much of each, on a Playwright too old to describe them itself. */
export const MAX_FRAMES = 5;
const FRAME_CHARS = 4_000;

/** Roles whose elements keep their ref in a page's description, as the ones an agent acts on; any element styled as clickable keeps its ref too. */
const REF_ROLES = [
	'button', 'link', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'checkbox', 'radio', 'switch', 'option', 'treeitem',
	'textbox', 'searchbox', 'combobox', 'spinbutton', 'slider', 'listbox', 'columnheader', 'gridcell', 'iframe',
];

/**
 * The page facade a run's code gets as `page`, as source: Playwright's own API, for the
 * parts a script on a web page needs, where every call goes through `call(op)` to the
 * real page. It is plain JavaScript that also runs in a QuickJS VM, so the Browser
 * panel can run model-written code without giving it Anton's process. RegExps and
 * functions (for evaluate) are sent as their source and rebuilt on the other side;
 * a function is only ever run in the web page.
 */
const PAGE_FACADE = `function antonPage(call) {
	const known = { url: '' };
	const enc = (value) => {
		if (value instanceof RegExp) return { __regex: [value.source, value.flags] };
		if (typeof value === 'function') return { __function: String(value) };
		if (Array.isArray(value)) return value.map(enc);
		if (value && typeof value === 'object') {
			const out = {};
			for (const key of Object.keys(value)) out[key] = enc(value[key]);
			return out;
		}
		return value;
	};
	const send = async (op) => {
		const answer = await call(enc(op));
		if (answer && typeof answer.url === 'string') known.url = answer.url;
		return answer ? answer.value : undefined;
	};
	const CHAIN = ['locator', 'getByRole', 'getByText', 'getByLabel', 'getByPlaceholder', 'getByTestId', 'getByTitle', 'getByAltText', 'first', 'last', 'nth', 'filter'];
	const METHODS = ['click', 'dblclick', 'fill', 'pressSequentially', 'type', 'press', 'check', 'uncheck', 'setChecked', 'selectOption', 'hover', 'focus', 'blur', 'clear', 'scrollIntoViewIfNeeded',
		'innerText', 'textContent', 'innerHTML', 'inputValue', 'getAttribute', 'count', 'isVisible', 'isHidden', 'isChecked', 'isEnabled', 'isDisabled', 'isEditable',
		'allTextContents', 'allInnerTexts', 'boundingBox', 'waitFor', 'evaluate', 'evaluateAll', 'ariaSnapshot'];
	const locator = (chain) => {
		const self = {};
		for (const name of CHAIN) self[name] = (...args) => locator(chain.concat([[name].concat(args)]));
		for (const name of METHODS) self[name] = (...args) => send({ chain, method: name, args });
		self.all = async () => {
			const count = await send({ chain, method: 'count', args: [] });
			const out = [];
			for (let index = 0; index < count; index++) out.push(locator(chain.concat([['nth', index]])));
			return out;
		};
		return self;
	};
	const page = { url: () => known.url };
	for (const name of ['goto', 'goBack', 'goForward', 'reload', 'title', 'content', 'evaluate', '$eval', '$$eval', 'waitForTimeout', 'waitForLoadState', 'waitForURL', 'waitForSelector', 'waitForFunction', 'snapshot']) {
		page[name] = (...args) => send({ method: name, args });
	}
	for (const name of CHAIN.slice(0, 8)) page[name] = (...args) => locator([[name].concat(args)]);
	for (const name of ['click', 'dblclick', 'fill', 'type', 'press', 'check', 'uncheck', 'selectOption', 'hover', 'focus', 'innerText', 'textContent', 'innerHTML', 'inputValue', 'getAttribute', 'isVisible', 'isHidden', 'isChecked', 'isEnabled']) {
		page[name] = (selector, ...args) => send({ chain: [['locator', selector]], method: name, args });
	}
	page.keyboard = {};
	for (const name of ['press', 'type', 'insertText', 'down', 'up']) page.keyboard[name] = (...args) => send({ target: 'keyboard', method: name, args });
	page.mouse = {};
	for (const name of ['click', 'dblclick', 'move', 'wheel', 'down', 'up']) page.mouse[name] = (...args) => send({ target: 'mouse', method: name, args });
	return page;
}`;

/** The facade's source, for a caller that runs a run's code somewhere else (the Browser panel's QuickJS VM). */
export const RUN_FACADE = PAGE_FACADE;

/**
 * The browser's shared source, as plain JavaScript declarations:
 *
 * - `browserStep(page, command)` does one action, waits for a page it loaded to settle, and
 *   describes the page as an accessibility tree. With a Playwright that has AI snapshots, each
 *   element the agent acts on carries a ref (`[ref=e12]`, `[ref=f1e3]` in an iframe) that a
 *   step targets as `e12`, and iframes are described in place. On an older Playwright, a
 *   page's own tree shows an iframe only as "- iframe", so each iframe big enough to use has
 *   its tree added after the page's, under "- iframe [frame=N]:".
 * - `browserRun(page, command, ask, execute)` runs model-written code against the page facade
 *   above: several steps in one call, answering with what the code returned. `execute` runs
 *   the code (`antonNodeExecute` where the code may run in the same process, the sandbox's own;
 *   a QuickJS VM on Anton's side). A click (or Enter) on an element whose name has a risky word
 *   asks `ask(name)` first, and stops the run when it says no.
 */
export const BROWSER_SOURCE = `
const ANTON_MAX_SNAPSHOT = ${MAX_SNAPSHOT};
const ANTON_REF_ROLES = new Set(${JSON.stringify(REF_ROLES)});
const ANTON_RISKY = new RegExp(${JSON.stringify(RISKY_WORDS.source)}, 'i');
const ANTON_PAGE_FACADE = ${JSON.stringify(PAGE_FACADE)};

/**
 * An AI snapshot made smaller and steadier: no cursor or focus notes, refs only on what an agent acts on (any
 * element styled clickable included), and no unnamed wrappers ("- generic:"), whose children move up in their place.
 */
function antonTrimTree(tree) {
	const out = [];
	const dropped = [];
	for (const line of String(tree || '').split('\\n')) {
		const pointer = line.includes(' [cursor=pointer]');
		// Focus moves with every click, so a page described with it would never read as unchanged.
		let kept = line.split(' [cursor=pointer]').join('').split(' [active]').join('');
		const role = /^\\s*- '?([a-z]+)/.exec(kept);
		if (role && !pointer && !ANTON_REF_ROLES.has(role[1])) kept = kept.replace(/ \\[ref=[a-z0-9]+\\]/, '');
		const indent = kept.length - kept.trimStart().length;
		while (dropped.length && dropped[dropped.length - 1] >= indent) dropped.pop();
		if (/^\\s*- generic:$/.test(kept)) {
			dropped.push(indent);
			continue;
		}
		out.push(kept.slice(Math.min(indent, dropped.length * 2)));
	}
	return out.join('\\n');
}

/** A target written as a ref from the page's description (e12, ref=e12, [ref=e12]), as Playwright's aria-ref selector; any other target as it is. */
function antonTarget(target) {
	const ref = /^\\[?(?:aria-)?(?:ref=)?((?:f\\d+)?e\\d+)\\]?$/.exec(String(target).trim());
	return ref ? 'aria-ref=' + ref[1] : target;
}

/**
 * Runs in the page: resolves true once its DOM has been still for \`still\` ms, no sooner than \`min\` ms, and (with
 * \`idle\`) nothing on it says it is still loading; or false after \`max\` ms. One call, however long it waits, so a
 * browser across the network costs one round trip rather than one every 50 ms.
 */
const ANTON_STILL = ({ still, max, min, idle }) => new Promise((resolve) => {
	let seen = window.__antonMutations;
	if (!seen) {
		seen = { last: performance.now() };
		window.__antonMutations = seen;
		new MutationObserver(() => { seen.last = performance.now(); }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
	}
	const begun = performance.now();
	const shown = (element) => Boolean(element && element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden');
	const busy = () => {
		for (const element of document.querySelectorAll('[aria-busy="true"], [role="progressbar"], progress')) if (shown(element)) return true;
		const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
		for (let count = 0, node = walker.nextNode(); node && count < 3000; count++, node = walker.nextNode()) {
			const text = (node.nodeValue || '').trim();
			if (text.length < 40 && /^(loading|please wait|one moment)\\b/i.test(text) && shown(node.parentElement)) return true;
		}
		return false;
	};
	const tick = () => {
		const now = performance.now();
		if (now - begun >= (min || 0) && now - seen.last >= still && (!idle || !busy())) return resolve(true);
		if (now - begun >= max) return resolve(false);
		setTimeout(tick, 50);
	};
	tick();
});

/**
 * A wait the agent asked for, ended early once the page is done: its DOM still for half a second, no request it
 * started in flight, and no spinner, progress bar or "Loading" text showing (a page counting down to show
 * something changes nothing while it waits, so stillness alone would end the wait too soon).
 */
async function antonWait(page, ms, pending) {
	const limit = Math.min(Math.max(Number(ms) || 0, 0), 15000);
	const begun = Date.now();
	if (limit <= 500) return page.waitForTimeout(limit);
	while (Date.now() - begun < limit) {
		const left = limit - (Date.now() - begun);
		const quiet = await page.evaluate(ANTON_STILL, { still: 500, max: left, min: Math.max(0, 500 - (Date.now() - begun)), idle: true }).catch(async () => {
			await page.waitForTimeout(Math.min(250, left));
			return false;
		});
		if (quiet && !(pending && pending())) return;
		if (quiet) await page.waitForTimeout(Math.min(100, Math.max(0, limit - (Date.now() - begun))));
	}
}

/** Requests a page sets off while something runs, but for live connections, which never end. */
function antonRequests(page) {
	const pending = new Map();
	const state = { last: Date.now() };
	const started = (request) => {
		state.last = Date.now();
		if (!['eventsource', 'websocket'].includes(request.resourceType())) pending.set(request, Date.now());
	};
	const ended = (request) => {
		state.last = Date.now();
		pending.delete(request);
	};
	page.on('request', started);
	page.on('requestfinished', ended);
	page.on('requestfailed', ended);
	return {
		// A request open over two seconds is taken for a live connection, which never ends.
		busy: () => {
			const now = Date.now();
			for (const at of pending.values()) if (now - at < 2000) return true;
			return false;
		},
		quietFor: () => Date.now() - state.last,
		stop: () => {
			page.off('request', started);
			page.off('requestfinished', ended);
			page.off('requestfailed', ended);
		},
	};
}

/** The page as an accessibility tree, and whether it has refs; a page too long to give whole is narrowed to its main content where it has one. */
async function antonDescribe(page, max) {
	let tree = await page.locator('body').ariaSnapshot({ mode: 'ai', timeout: 5000 }).catch(() => '');
	if (!/\\[ref=/.test(tree)) return { tree, refs: false };
	tree = antonTrimTree(tree);
	if (tree.length > max) {
		const main = page.locator('main, [role="main"]').first();
		const scoped = (await main.count().catch(() => 0)) ? antonTrimTree(await main.ariaSnapshot({ mode: 'ai', timeout: 5000 }).catch(() => '')) : '';
		if (scoped && scoped.length < tree.length * 0.8) tree = '(This page is long, so only its main content is described. Use run to read anything else on it.)\\n' + scoped;
	}
	return { tree, refs: true };
}

async function browserStep(page, command) {
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
	// A ref is Playwright's aria-ref; on an older Playwright, a control inside an iframe is named as frame=N >> its selector.
	const target = () => {
		if (!command.target) throw new Error('This action needs a target');
		const chosen = antonTarget(command.target);
		const inFrame = chosen.startsWith('frame=') ? chosen.indexOf(' >> ') : -1;
		if (inFrame === -1) return page.locator(chosen).first();
		const frame = page.locator('iframe').nth(Number(chosen.slice(6, inFrame)) || 0).contentFrame();
		return frame.locator(chosen.slice(inFrame + 4)).first();
	};
	// Requests the step sets off. Playwright's networkidle fires once per load, so after a click on a page that
	// already idled it answers at once, before what the click fetched is drawn; and on a page that keeps polling it
	// never fires, so every step there waited out the whole timeout.
	const requests = antonRequests(page);
	// The first look at a document leaves an observer in it that notes when its DOM last changed.
	await page.evaluate(ANTON_STILL, { still: 0, max: 0, min: 0, idle: false }).catch(() => false);
	// Settled once nothing it asked for is in flight and the network has been quiet a moment, for the page to draw
	// what came back; or, on a page whose polling keeps the network busy, once a second has passed and its DOM has
	// been still for half of one, waited for in the page itself.
	const settle = async () => {
		const begun = Date.now();
		while (Date.now() - begun < 5000) {
			const elapsed = Date.now() - begun;
			const busy = requests.busy();
			if (!busy && requests.quietFor() >= 300) return;
			if (!busy && elapsed >= 1000) {
				if (await page.evaluate(ANTON_STILL, { still: 500, max: Math.min(500, 5000 - elapsed), min: 0, idle: false }).catch(() => false)) return;
				continue;
			}
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
			case 'wait': await (command.target ? target().waitFor({ timeout: 15000 }) : antonWait(page, command.ms ?? 1000, requests.busy)); break;
		}
	} catch (error) {
		problem = String((error && error.message) || error).split('\\n')[0];
	}
	// Only a step that can load a page waits for it to settle; scrolling, hovering, waiting and looking answer at once.
	if (!['scroll', 'hover', 'wait', 'look'].includes(command.action)) await settle();
	requests.stop();
	const described = await antonDescribe(page, ANTON_MAX_SNAPSHOT);
	const snapshot = described.refs ? described.tree : described.tree + (await framesOf());
	// Where the page and its scrolled areas are, and its title, in one call.
	const { view, title } = await page
		.evaluate(() => {
			const at = [scrollX + ',' + scrollY];
			for (const element of document.querySelectorAll('*')) if (element.scrollTop || element.scrollLeft) at.push(element.scrollTop + ',' + element.scrollLeft);
			return { view: at.join(' '), title: document.title };
		})
		.catch(async () => ({ view: '', title: await page.title().catch(() => '') }));
	return { url: page.url(), title, status, problem, snapshot, view };
}

/** Values the facade sent as source, rebuilt: a RegExp, or a function that only ever runs in the web page (Playwright sends its source there). */
function antonDecode(value) {
	if (Array.isArray(value)) return value.map(antonDecode);
	if (value && typeof value === 'object') {
		if (Array.isArray(value.__regex)) return new RegExp(String(value.__regex[0]), String(value.__regex[1] || ''));
		if (typeof value.__function === 'string') {
			const source = value.__function;
			const inPage = function () {};
			inPage.toString = () => source;
			return inPage;
		}
		const out = {};
		for (const key of Object.keys(value)) out[key] = antonDecode(value[key]);
		return out;
	}
	return value;
}

/** What an element is called, for the check before a click: its label, text or value. Runs in the page. */
const ANTON_NAME = (element) => {
	if (!element) return '';
	const parts = [element.getAttribute && element.getAttribute('aria-label'), element.innerText || element.textContent, element.value, element.title, element.alt];
	return parts.filter(Boolean).map(String).join(' ').replace(/\\s+/g, ' ').trim().slice(0, 200);
};

const ANTON_CHAIN = new Set(['locator', 'getByRole', 'getByText', 'getByLabel', 'getByPlaceholder', 'getByTestId', 'getByTitle', 'getByAltText', 'first', 'last', 'nth', 'filter']);
/** Locator methods a run may call, with where each takes its options, so a wrong selector fails in seconds, not Playwright's 30. */
const ANTON_LOCATOR = {
	click: 0, dblclick: 0, check: 0, uncheck: 0, hover: 0, focus: 0, blur: 0, clear: 0, scrollIntoViewIfNeeded: 0, waitFor: 0,
	innerText: 0, textContent: 0, innerHTML: 0, inputValue: 0, isChecked: 0, isEnabled: 0, isDisabled: 0, isEditable: 0,
	fill: 1, press: 1, selectOption: 1, pressSequentially: 1, type: 1, setChecked: 1, getAttribute: 1,
	count: -1, isVisible: -1, isHidden: -1, allTextContents: -1, allInnerTexts: -1, boundingBox: 0, evaluate: -1, evaluateAll: -1, ariaSnapshot: -1,
};
const ANTON_PAGE = { goto: 1, goBack: 0, goForward: 0, reload: 0, title: -1, content: -1, evaluate: -1, $eval: -1, $$eval: -1, waitForTimeout: -1, waitForLoadState: 1, waitForURL: 1, waitForSelector: 1, waitForFunction: 2, snapshot: -1 };

/** A value as it goes back to the code: plain JSON, a response as its status and address, a handle as true. */
function antonPlain(value) {
	if (value === undefined) return null;
	if (value && typeof value === 'object' && typeof value.status === 'function' && typeof value.url === 'function') return { status: value.status(), url: value.url() };
	if (value && typeof value === 'object' && typeof value.dispose === 'function') {
		value.dispose().catch(() => {});
		return true;
	}
	try {
		return JSON.parse(JSON.stringify(value));
	} catch {
		return String(value);
	}
}

/** Asks before a click on something named with a risky word, once per name in a run; stops the run when the answer is no. */
async function antonGuard(name, run) {
	if (!ANTON_RISKY.test(name) || run.allowed.has(name)) return;
	if (await run.ask(name)) {
		run.allowed.add(name);
		return;
	}
	run.stopped = 'Not clicked: "' + name + '" may buy, send, post or delete something. Only if your brief explicitly asks for exactly this, run the code again with confirm set to its name; otherwise stop and report.';
	throw new Error(run.stopped);
}

/** One call the facade made, on the real page. */
async function antonOp(page, op, run) {
	if (run.stopped) throw new Error(run.stopped);
	const args = antonDecode(Array.isArray(op.args) ? op.args : []);
	const method = String(op.method);
	const timed = (at, ms) => {
		if (at < 0) return;
		while (args.length < at) args.push(undefined);
		const given = args[at] && typeof args[at] === 'object' ? args[at] : {};
		args[at] = { timeout: ms, ...given };
	};
	let value;
	if (Array.isArray(op.chain)) {
		let locator = page;
		for (const [name, ...rest] of op.chain) {
			if (!ANTON_CHAIN.has(name)) throw new Error(name + ' is not available in run');
			const parts = antonDecode(rest);
			if (name === 'locator' && typeof parts[0] === 'string') parts[0] = antonTarget(parts[0]);
			locator = locator[name](...parts);
		}
		if (!(method in ANTON_LOCATOR)) throw new Error('locator.' + method + ' is not available in run');
		if (method === 'click' || method === 'dblclick' || (method === 'press' && /^enter$/i.test(String(args[0])))) {
			await antonGuard(await locator.evaluate(ANTON_NAME, undefined, { timeout: 5000 }), run);
		}
		timed(ANTON_LOCATOR[method], method === 'waitFor' ? 10000 : 5000);
		value = method === 'ariaSnapshot' ? antonTrimTree(await locator.ariaSnapshot({ mode: 'ai', timeout: 5000 })) : await locator[method](...args);
	} else if (op.target === 'keyboard') {
		if (!['press', 'type', 'insertText', 'down', 'up'].includes(method)) throw new Error('keyboard.' + method + ' is not available in run');
		if ((method === 'press' || method === 'down') && /^enter$/i.test(String(args[0]))) await antonGuard(await page.evaluate(ANTON_NAME_FOCUSED), run);
		value = await page.keyboard[method](...args);
	} else if (op.target === 'mouse') {
		if (!['click', 'dblclick', 'move', 'wheel', 'down', 'up'].includes(method)) throw new Error('mouse.' + method + ' is not available in run');
		if (method === 'click' || method === 'dblclick') await antonGuard(await page.evaluate(ANTON_NAME_AT, [Number(args[0]) || 0, Number(args[1]) || 0]), run);
		value = await page.mouse[method](...args);
	} else {
		if (!(method in ANTON_PAGE)) throw new Error('page.' + method + ' is not available in run');
		if (method === 'snapshot') value = (await antonDescribe(page, ANTON_MAX_SNAPSHOT)).tree;
		else if (method === 'waitForTimeout') value = await antonWait(page, args[0], run.pending);
		else {
			if (method === 'waitForSelector' && typeof args[0] === 'string') args[0] = antonTarget(args[0]);
			timed(ANTON_PAGE[method], ['goto', 'goBack', 'goForward', 'reload'].includes(method) ? 30000 : 10000);
			value = await page[method](...args);
		}
	}
	return { value: antonPlain(value), url: page.url() };
}

/** The focused element's name, and the name of the element at a point, for the check before Enter or a click there. Each runs in the page. */
const ANTON_NAME_FOCUSED = () => {
	const element = document.activeElement;
	if (!element) return '';
	const parts = [element.getAttribute && element.getAttribute('aria-label'), element.innerText || element.textContent, element.value, element.title];
	const form = element.form || (element.closest && element.closest('form'));
	const submit = form && form.querySelector('[type=submit], button:not([type])');
	if (submit) parts.push(submit.innerText || submit.value);
	return parts.filter(Boolean).map(String).join(' ').replace(/\\s+/g, ' ').trim().slice(0, 200);
};
const ANTON_NAME_AT = ([x, y]) => {
	const element = document.elementFromPoint(x, y);
	const clickable = element && element.closest ? element.closest('a, button, [role], input, label') || element : element;
	if (!clickable) return '';
	const parts = [clickable.getAttribute && clickable.getAttribute('aria-label'), clickable.innerText || clickable.textContent, clickable.value, clickable.title];
	return parts.filter(Boolean).map(String).join(' ').replace(/\\s+/g, ' ').trim().slice(0, 200);
};

/** What the code returned, as text: a string as it is, anything else as JSON. */
function antonShow(value) {
	if (value === undefined || value === null) return '';
	if (typeof value === 'string') return value;
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

const ANTON_ASYNC = Object.getPrototypeOf(async function () {}).constructor;

/** Runs a run's code in this process, with the facade as \`page\` and its console kept: only where the code may run anyway, the sandbox's own. */
async function antonNodeExecute(code, call) {
	const logs = [];
	const log = (...items) => {
		logs.push(items.map((item) => (typeof item === 'string' ? item : JSON.stringify(item))).join(' '));
	};
	const body = new ANTON_ASYNC('__call', 'console', 'const page = (' + ANTON_PAGE_FACADE + ')(__call);\\n' + code);
	const value = await body(call, { log, info: log, warn: log, error: log, debug: log });
	return { value, logs };
}

async function browserRun(page, command, ask, execute) {
	const requests = antonRequests(page);
	const run = { ask: ask || (async () => true), allowed: new Set(), stopped: null, pending: requests.busy };
	let value = null;
	let logs = [];
	let problem = null;
	try {
		const out = await execute(String(command.code || ''), (op) => antonOp(page, op, run));
		value = out.value;
		logs = out.logs || [];
	} catch (error) {
		problem = 'The code failed: ' + String((error && error.message) || error).split('\\n')[0];
	} finally {
		requests.stop();
	}
	// Code that caught the stop still stopped.
	if (run.stopped) problem = run.stopped;
	await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
	const described = await antonDescribe(page, ANTON_MAX_SNAPSHOT);
	return { url: page.url(), title: await page.title().catch(() => ''), status: null, problem, snapshot: described.tree, result: antonShow(value), logs: logs.slice(0, 50) };
}
`;

export type BrowserCommand = Record<string, unknown>;
/** Runs a run's code: in this process (`antonNodeExecute`) or in a VM. `call` sends one facade call to the page. */
export type RunExecute = (code: string, call: (op: unknown) => Promise<unknown>) => Promise<{ value: unknown; logs?: string[] }>;

/** The shared source as functions in this process, for the Browser panel's browser and for tests. */
export function browserFunctions<Page = unknown>(): {
	browserStep: (page: Page, command: BrowserCommand) => Promise<StepResult>;
	browserRun: (page: Page, command: BrowserCommand, ask: ((name: string) => Promise<boolean>) | undefined, execute: RunExecute) => Promise<StepResult>;
	antonNodeExecute: RunExecute;
} {
	return new Function(`${BROWSER_SOURCE}\nreturn { browserStep, browserRun, antonNodeExecute };`)();
}

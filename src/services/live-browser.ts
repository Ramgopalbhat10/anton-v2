import { chromium, type Browser as PlaywrightBrowser, type Page } from 'playwright-core';
import { announce } from '../core/changes.ts';
import { CdpConnection, type CdpEvent } from '../core/cdp.ts';
import { ConflictError, InvalidInputError, NotFoundError } from '../core/errors.ts';
import { writeMachineFile } from '../core/machine-fs.ts';
import type { BrowserHost, HostedBrowser } from '../core/ports.ts';
import { quote } from '../core/shell.ts';
import { getSessionRecord } from '../db/sessions.ts';
import { getSetting, setSetting } from '../db/settings.ts';
import { getProviders } from '../providers/index.ts';
import type { BrowserInput, BrowserState } from './browser.ts';
import { addressToUrl, BROWSER_STEP, clipSnapshot, screenshotFile, type StepResult } from './browser-step.ts';
import { DESCRIBE_ELEMENT } from './describe-element.ts';
import { logProblem } from './log.ts';
import { liveMachine } from './workspace.ts';

/**
 * The Browser panel: a real browser on a hosted service (a `BrowserHost`,
 * Kernel today), one per task, that you see and use through its live view.
 * Anton drives the same browser over the Chrome DevTools Protocol for the
 * address bar, picking an element to send to the agent, and screenshots to
 * draw on. Opening it never starts the task's sandbox.
 */

/** How long a browser may sit unused before the host removes it. Idle time is not billed. */
const IDLE_SECONDS = 30 * 60;
const VIEWPORT = { width: 1280, height: 800 };

type Stored = HostedBrowser & { openedAt: string };

export type BrowserPage = { url: string; title: string; canGoBack: boolean; canGoForward: boolean };

export type BrowserView = {
	/** False without a browser host (no KERNEL_API_KEY). */
	available: boolean;
	browser: {
		liveViewUrl: string;
		viewport: { width: number; height: number };
		openedAt: string;
		page: BrowserPage | null;
		/** The agent is acting in this browser, or did a moment ago. */
		agentBusy: boolean;
	} | null;
};

/** What Anton read about an element you picked, for the agent. */
export type PickedElement = {
	tag: string;
	selector: string;
	text: string;
	html: string;
	rect: { x: number; y: number; width: number; height: number };
	styles: Record<string, string>;
	/** React components around it, nearest first, with where each is defined or used when the app is a development build. */
	components: Array<{ name: string; source: string | null }>;
	url: string;
	title: string;
	/** A PNG of the element as it looks, base64. */
	image: string | null;
};

export { addressToUrl };

const key = (id: string) => `browser.${id}`;
const changed = (id: string) => announce({ kind: 'task', id, what: 'browser' });

/** Whether there is a browser host to use: the panel works, and the agent can browse in it. */
export const sharedBrowserAvailable = (): boolean => Boolean(getProviders().browsers);

function host(): BrowserHost {
	const browsers = getProviders().browsers;
	if (!browsers) throw new InvalidInputError('Set KERNEL_API_KEY to use the Browser panel');
	return browsers;
}

async function requireTask(id: string) {
	if (!(await getSessionRecord(id))) throw new NotFoundError('Session not found');
}

/**
 * The task's browser, if it still exists. While Anton holds a connection to
 * it, it does; otherwise the host is asked, and one it removed is forgotten.
 */
async function storedBrowser(id: string): Promise<Stored | null> {
	const stored = await getSetting<Stored | null>(key(id), null);
	if (!stored) return null;
	const open = connections.get(id);
	if (open?.cdp.isOpen && open.browserId === stored.id) return stored;
	const live = await host()
		.get(stored.id)
		.catch((error: unknown) => {
			logProblem('warn', 'Could not check the browser', error, id);
			return stored;
		});
	if (live) return stored;
	await forget(id);
	return null;
}

/** The task's browser, opened at `url` when there is none yet. */
async function ensureBrowser(id: string, url?: string): Promise<Stored> {
	const existing = await storedBrowser(id);
	if (existing) return existing;
	const created: Stored = { ...(await host().create({ idleSeconds: IDLE_SECONDS, viewport: VIEWPORT, startUrl: url })), openedAt: new Date().toISOString() };
	await setSetting(key(id), created);
	changed(id);
	return created;
}

async function forget(id: string) {
	connections.get(id)?.cdp.close();
	connections.delete(id);
	await drivers.get(id)?.browser.close().catch(() => undefined);
	drivers.delete(id);
	await setSetting(key(id), null);
}

// ---- The page connection ----

type Connection = { browserId: string; cdp: CdpConnection; session: string; targetId: string };
const connections = new Map<string, Connection>();
const connecting = new Map<string, Promise<Connection>>();

type Target = { targetId: string; type: string; url?: string; openerId?: string };

async function attach(cdp: CdpConnection, targetId: string): Promise<string> {
	const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
	await Promise.all([cdp.send('Page.enable', {}, sessionId), cdp.send('DOM.enable', {}, sessionId), cdp.send('Overlay.enable', {}, sessionId)]);
	return sessionId;
}

/** A connection to the tab the live view shows, opened once and kept while the browser lives. */
async function connection(id: string, browser: Stored): Promise<Connection> {
	const open = connections.get(id);
	if (open?.cdp.isOpen && open.browserId === browser.id) return open;
	const pending = connecting.get(id);
	if (pending) return pending;
	const made = (async () => {
		const cdp = await CdpConnection.connect(browser.cdpUrl);
		const { targetInfos } = await cdp.send<{ targetInfos: Target[] }>('Target.getTargets');
		const page = targetInfos.filter((target) => target.type === 'page' && !target.url?.startsWith('devtools://')).pop();
		const targetId = page?.targetId ?? (await cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' })).targetId;
		const current: Connection = { browserId: browser.id, cdp, session: await attach(cdp, targetId), targetId };
		await cdp.send('Target.setDiscoverTargets', { discover: true });
		cdp.on((event) => void follow(id, current, event));
		cdp.onClose(() => {
			if (connections.get(id) === current) connections.delete(id);
		});
		connections.set(id, current);
		return current;
	})().finally(() => connecting.delete(id));
	connecting.set(id, made);
	return made;
}

/** Shows another tab in the live view and drives that one from now on. */
async function switchTo(id: string, current: Connection, targetId: string) {
	try {
		current.session = await attach(current.cdp, targetId);
		current.targetId = targetId;
		await current.cdp.send('Target.activateTarget', { targetId });
		changed(id);
	} catch (error) {
		logProblem('warn', 'Could not switch to another tab', error, id);
	}
}

/** Keeps the address bar current, and follows a page that opens a new tab, as the live view shows only one. */
async function follow(id: string, current: Connection, event: CdpEvent) {
	if (event.sessionId === current.session && (event.method === 'Page.navigatedWithinDocument' || (event.method === 'Page.frameNavigated' && !(event.params.frame as { parentId?: string } | undefined)?.parentId))) {
		changed(id);
	} else if (event.method === 'Target.targetCreated') {
		const info = event.params.targetInfo as Target;
		if (info.type === 'page' && info.openerId) await switchTo(id, current, info.targetId);
	} else if (event.method === 'Target.targetDestroyed' && event.params.targetId === current.targetId) {
		// The tab closed: go back to whichever is left.
		const { targetInfos } = await current.cdp.send<{ targetInfos: Target[] }>('Target.getTargets').catch(() => ({ targetInfos: [] as Target[] }));
		const left = targetInfos.filter((target) => target.type === 'page').pop();
		if (left) await switchTo(id, current, left.targetId);
	}
}

async function page(id: string): Promise<Connection> {
	const browser = await storedBrowser(id);
	if (!browser) throw new ConflictError('Open the browser first');
	return connection(id, browser);
}

type History = { currentIndex: number; entries: Array<{ id: number; url: string; title: string }> };
const history = ({ cdp, session }: Connection) => cdp.send<History>('Page.getNavigationHistory', {}, session);
const hideHighlight = ({ cdp, session }: Connection) => cdp.send('Overlay.hideHighlight', {}, session).catch(() => undefined);

/** The page's size in CSS pixels, less any scrollbar. */
async function viewportSize({ cdp, session }: Connection): Promise<{ width: number; height: number }> {
	const { cssVisualViewport: view } = await cdp.send<{ cssVisualViewport: { clientWidth: number; clientHeight: number } }>('Page.getLayoutMetrics', {}, session);
	return { width: view.clientWidth, height: view.clientHeight };
}

async function pageState(current: Connection): Promise<BrowserPage> {
	const { currentIndex, entries } = await history(current);
	const entry = entries[currentIndex];
	return { url: entry?.url ?? '', title: entry?.title ?? '', canGoBack: currentIndex > 0, canGoForward: currentIndex < entries.length - 1 };
}

// ---- What the routes call ----

async function viewOf(id: string, browser: Stored): Promise<BrowserView> {
	if (!browser.liveViewUrl) return { available: true, browser: null };
	const state = await connection(id, browser)
		.then(pageState)
		.catch((error: unknown) => {
			logProblem('warn', 'Could not read the browser page', error, id);
			return null;
		});
	return { available: true, browser: { liveViewUrl: browser.liveViewUrl, viewport: VIEWPORT, openedAt: browser.openedAt, page: state, agentBusy: agentBusy(id) } };
}

export async function browserView(id: string): Promise<BrowserView> {
	await requireTask(id);
	if (!sharedBrowserAvailable()) return { available: false, browser: null };
	const browser = await storedBrowser(id);
	return browser ? viewOf(id, browser) : { available: true, browser: null };
}

/** Opens the task's browser, or reuses the one it has, at `address` if given. */
export async function openBrowser(id: string, address?: string): Promise<BrowserView> {
	await requireTask(id);
	const url = address?.trim() ? addressToUrl(address) : undefined;
	const existing = await storedBrowser(id);
	const browser = existing ?? (await ensureBrowser(id, url));
	if (existing && url) await go(await connection(id, browser), { url });
	return viewOf(id, browser);
}

export async function closeBrowser(id: string): Promise<void> {
	const stored = await getSetting<Stored | null>(key(id), null);
	if (!stored) return;
	await forget(id);
	await host()
		.remove(stored.id)
		.catch((error: unknown) => logProblem('warn', 'Could not remove the browser', error, id));
	changed(id);
}

export type NavigateAction = { url: string } | { action: 'back' | 'forward' | 'reload' };

async function go(current: Connection, action: NavigateAction): Promise<BrowserPage> {
	const { cdp, session } = current;
	if ('url' in action) {
		const result = await cdp.send<{ errorText?: string }>('Page.navigate', { url: addressToUrl(action.url) }, session);
		if (result.errorText && result.errorText !== 'net::ERR_ABORTED') throw new InvalidInputError(`Could not open the page: ${result.errorText}`);
	} else if (action.action === 'reload') {
		await cdp.send('Page.reload', {}, session);
	} else {
		const { currentIndex, entries } = await history(current);
		const target = entries[currentIndex + (action.action === 'back' ? -1 : 1)];
		if (target) await cdp.send('Page.navigateToHistoryEntry', { entryId: target.id }, session);
	}
	return pageState(current);
}

export const navigate = async (id: string, action: NavigateAction): Promise<BrowserPage> => go(await page(id), action);

const HIGHLIGHT = {
	showInfo: true,
	contentColor: { r: 59, g: 172, b: 220, a: 0.22 },
	paddingColor: { r: 59, g: 172, b: 220, a: 0.12 },
	borderColor: { r: 59, g: 172, b: 220, a: 0.9 },
	marginColor: { r: 240, g: 180, b: 60, a: 0.12 },
};

/**
 * The element at a point of the page, in CSS pixels from its top left.
 * Highlights it in the live view; with `pick`, also reads it and takes its picture.
 */
export async function inspectAt(id: string, point: { x: number; y: number; pick: boolean }): Promise<PickedElement | null> {
	const current = await page(id);
	const { cdp, session } = current;
	const at = await cdp
		.send<{ backendNodeId: number }>('DOM.getNodeForLocation', { x: Math.round(point.x), y: Math.round(point.y), includeUserAgentShadowDOM: false, ignorePointerEventsNone: true }, session)
		.catch(() => null);
	if (at && !point.pick) {
		await cdp.send('Overlay.highlightNode', { highlightConfig: HIGHLIGHT, backendNodeId: at.backendNodeId }, session).catch(() => undefined);
		return null;
	}
	// Nothing there, or a pick: either way the highlight goes, so the picture is the page alone.
	await hideHighlight(current);
	if (!at) return null;
	const { object } = await cdp.send<{ object: { objectId?: string } }>('DOM.resolveNode', { backendNodeId: at.backendNodeId }, session);
	if (!object.objectId) return null;
	const described = await cdp.send<{ result: { value?: Omit<PickedElement, 'image'> | null } }>(
		'Runtime.callFunctionOn',
		{ objectId: object.objectId, functionDeclaration: DESCRIBE_ELEMENT, returnByValue: true },
		session,
	);
	void cdp.send('Runtime.releaseObject', { objectId: object.objectId }, session).catch(() => undefined);
	const element = described.result.value;
	return element ? { ...element, image: await elementImage(current, element.rect) } : null;
}

/** The element's box with a little room around it, kept inside the viewport. */
async function elementImage(current: Connection, rect: PickedElement['rect']): Promise<string | null> {
	const view = await viewportSize(current);
	const pad = 8;
	const x = Math.max(0, rect.x - pad);
	const y = Math.max(0, rect.y - pad);
	const width = Math.min(view.width, rect.x + rect.width + pad) - x;
	const height = Math.min(view.height, rect.y + rect.height + pad) - y;
	if (width < 2 || height < 2) return null;
	const shot = await current.cdp
		.send<{ data: string }>('Page.captureScreenshot', { format: 'png', clip: { x, y, width, height, scale: 1 } }, current.session)
		.catch(() => null);
	return shot?.data ?? null;
}

export const clearHighlight = async (id: string): Promise<void> => void (await hideHighlight(await page(id)));

/** The page as you see it, to draw on: a PNG, base64, at the page's CSS size. */
export async function browserScreenshot(id: string): Promise<{ data: string; width: number; height: number }> {
	const current = await page(id);
	const [view] = await Promise.all([viewportSize(current), hideHighlight(current)]);
	const { data } = await current.cdp.send<{ data: string }>('Page.captureScreenshot', { format: 'png' }, current.session, 30_000);
	return { data, ...view };
}

// ---- The agent in the same browser ----

/**
 * The agent's browser steps in this browser, through Playwright over the same
 * DevTools endpoint, on the tab the live view shows: you watch it work and
 * can take over (to sign in, say). Kept per task while the browser lives.
 */
type Driver = { browserId: string; browser: PlaywrightBrowser; errors: string[]; targets: WeakMap<Page, string> };
const drivers = new Map<string, Driver>();

/** The shared step, as a function on Anton's side; the sandbox's browser runs the same source. */
const browserStep = new Function(`return (${BROWSER_STEP})`)() as (page: Page, command: BrowserInput) => Promise<StepResult>;

async function driver(id: string, browser: Stored): Promise<Driver> {
	const open = drivers.get(id);
	if (open?.browser.isConnected() && open.browserId === browser.id) return open;
	const connected = await chromium.connectOverCDP(browser.cdpUrl, { timeout: 30_000 });
	const made: Driver = { browserId: browser.id, browser: connected, errors: [], targets: new WeakMap() };
	connected.on('disconnected', () => {
		if (drivers.get(id) === made) drivers.delete(id);
	});
	drivers.set(id, made);
	return made;
}

/** Each page's tab id, read once per page. */
async function targetOf(current: Driver, page: Page): Promise<string> {
	const known = current.targets.get(page);
	if (known) return known;
	const session = await page.context().newCDPSession(page);
	const { targetInfo } = await session.send('Target.getTargetInfo').catch(() => ({ targetInfo: { targetId: '' } }));
	void session.detach().catch(() => undefined);
	current.targets.set(page, targetInfo.targetId);
	// Console errors are read back with each step.
	page.on('console', (message) => message.type() === 'error' && current.errors.push(message.text()));
	page.on('pageerror', (error) => current.errors.push(String(error)));
	return targetInfo.targetId;
}

/** The Playwright page for the tab the live view shows. */
async function shownPage(id: string, browser: Stored, current: Driver): Promise<Page> {
	const { targetId } = await connection(id, browser);
	const pages = current.browser.contexts().flatMap((context) => context.pages());
	const ids = await Promise.all(pages.map((page) => targetOf(current, page)));
	const shown = pages[ids.indexOf(targetId)] ?? pages[pages.length - 1];
	if (shown) return shown;
	const page = await (current.browser.contexts()[0] ?? (await current.browser.newContext())).newPage();
	await targetOf(current, page);
	return page;
}

// While the agent acts, and for a few seconds after, the panel says it is browsing.
const BUSY_MS = 8_000;
const agentSteps = new Map<string, { running: number; at: number; quiet?: ReturnType<typeof setTimeout> }>();

export function agentBusy(id: string): boolean {
	const step = agentSteps.get(id);
	return Boolean(step && (step.running > 0 || Date.now() - step.at < BUSY_MS));
}

/** Runs one agent step with the panel told it is browsing: when the first step starts, and once more when the quiet spell after the last ends. */
async function asAgentStep<T>(id: string, run: () => Promise<T>): Promise<T> {
	const step = agentSteps.get(id) ?? { running: 0, at: 0 };
	clearTimeout(step.quiet);
	const wasBusy = agentBusy(id);
	step.running += 1;
	agentSteps.set(id, step);
	if (!wasBusy) changed(id);
	try {
		return await run();
	} finally {
		step.running -= 1;
		step.at = Date.now();
		if (step.running === 0) {
			step.quiet = setTimeout(() => {
				agentSteps.delete(id);
				changed(id);
			}, BUSY_MS + 100);
			step.quiet.unref?.();
		}
	}
}

/** Saves the page to the task's outputs, which live in its sandbox; without one running there is nowhere to keep it. */
async function saveScreenshot(id: string, page: Page, input: BrowserInput): Promise<string | null> {
	const machine = await liveMachine(id);
	if (!machine) return null;
	const file = screenshotFile(input.screenshot ?? 'page');
	await machine.exec(`mkdir -p ${quote(`${machine.root}/outputs/screenshots`)}`);
	await writeMachineFile(machine, `${machine.root}/outputs/${file}`, await page.screenshot({ fullPage: Boolean(input.fullPage) }));
	return `../outputs/${file}`;
}

/**
 * One agent step in the task's shared browser, opening it if needed: the same
 * step as the sandbox browser runs, so the agent uses both alike.
 */
export async function agentBrowse(id: string, input: BrowserInput): Promise<BrowserState> {
	await requireTask(id);
	host(); // Throws, saying how to set one up, when there is no browser host.
	return asAgentStep(id, async () => {
		const browser = await ensureBrowser(id);
		const current = await driver(id, browser);
		const page = await shownPage(id, browser, current);
		const result = await browserStep(page, { ...input, url: input.url && addressToUrl(input.url) });
		const screenshot = input.screenshot ? await saveScreenshot(id, page, input) : null;
		const missing = input.screenshot && !screenshot ? 'No screenshot: screenshots are saved in the sandbox, which is not running. The page is described below, and the user sees it in the Browser panel.' : null;
		return { ...result, problem: result.problem ?? missing, errors: current.errors.splice(0).slice(0, 20), screenshot, snapshot: clipSnapshot(result.snapshot) };
	});
}

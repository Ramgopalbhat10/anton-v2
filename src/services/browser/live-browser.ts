import { chromium, type Browser as PlaywrightBrowser, type Page } from 'playwright-core';
import { announce } from '../../core/changes.ts';
import { CdpConnection, type CdpEvent } from '../../core/cdp.ts';
import { ConflictError, InvalidInputError, NotFoundError } from '../../core/errors.ts';
import { writeMachineFile } from '../../core/machine-fs.ts';
import type { BrowserHost, HostedBrowser } from '../../core/ports.ts';
import { quote } from '../../core/shell.ts';
import { getSessionRecord } from '../../db/sessions.ts';
import { getSetting, setSetting } from '../../db/settings.ts';
import { getProviders } from '../../providers/index.ts';
import type { BrowserInput, BrowserState } from './browser.ts';
import { quickjsExecute } from './browser-run.ts';
import { addressToUrl, browserFunctions, clipSnapshot, screenshotFile } from './browser-step.ts';
import { saveOutput } from '../git/checkpoints.ts';
import { DESCRIBE_ELEMENT } from './describe-element.ts';
import { logProblem } from '../../core/log.ts';
import { liveMachine } from '../sandbox/workspace.ts';

/*
 * The Browser panel: a hosted browser per task (a `BrowserHost`), seen through its live view and driven by Anton over CDP.
 * Opening it never starts the task's sandbox.
 */

/** Standing by is not billed and keeps its pages and sign-ins. */
const IDLE_SECONDS = 30 * 60;
/** The host bills every second anything is connected, even silently, so connections go once nothing needs them (reopening takes under a second). */
const RELEASE_MS = Number(process.env.ANTON_BROWSER_RELEASE_MS) || 15_000;
/** The panel sends one every 20 seconds. */
const WATCH_MS = 45_000;
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
		agentBusy: boolean;
		needsYou: string | null;
	} | null;
};

export type PickedElement = {
	tag: string;
	selector: string;
	text: string;
	html: string;
	rect: { x: number; y: number; width: number; height: number };
	styles: Record<string, string>;
	components: Array<{ name: string; source: string | null }>;
	url: string;
	title: string;
	image: string | null;
};

export { addressToUrl };

const key = (id: string) => `browser.${id}`;
const changed = (id: string) => announce({ kind: 'task', id, what: 'browser' });

export const sharedBrowserAvailable = (): boolean => Boolean(getProviders().browsers);

function host(): BrowserHost {
	const browsers = getProviders().browsers;
	if (!browsers) throw new InvalidInputError('Set KERNEL_API_KEY to use the Browser panel');
	return browsers;
}

async function requireTask(id: string) {
	if (!(await getSessionRecord(id))) throw new NotFoundError('Session not found');
}

/** One the host removed is forgotten. */
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

async function ensureBrowser(id: string, url?: string): Promise<Stored> {
	const existing = await storedBrowser(id);
	if (existing) return existing;
	const created: Stored = { ...(await host().create({ idleSeconds: IDLE_SECONDS, viewport: VIEWPORT, startUrl: url })), openedAt: new Date().toISOString() };
	await setSetting(key(id), created);
	changed(id);
	return created;
}

const needsYou = new Map<string, { reason: string; url: string }>();

export function askTheUser(id: string, reason: string, url: string): void {
	needsYou.set(id, { reason, url });
	changed(id);
}

async function forget(id: string) {
	needsYou.delete(id);
	lastPage.delete(id);
	clearTimeout(uses.get(id)?.timer);
	uses.delete(id);
	await release(id);
	await setSetting(key(id), null);
}

// ---- Holding connections only while they are used ----

type Use = { running: number; at: number; watchedUntil: number; timer?: ReturnType<typeof setTimeout> };
const uses = new Map<string, Use>();

function useOf(id: string): Use {
	let use = uses.get(id);
	if (!use) {
		use = { running: 0, at: Date.now(), watchedUntil: 0 };
		uses.set(id, use);
	}
	return use;
}

async function using<T>(id: string, work: () => Promise<T>): Promise<T> {
	const use = useOf(id);
	use.running += 1;
	try {
		return await work();
	} finally {
		use.running -= 1;
		use.at = Date.now();
		releaseLater(id, use, RELEASE_MS);
	}
}

function releaseLater(id: string, use: Use, wait: number) {
	clearTimeout(use.timer);
	use.timer = setTimeout(() => void releaseIfIdle(id, use), wait);
	use.timer.unref?.();
}

async function releaseIfIdle(id: string, use: Use) {
	if (uses.get(id) !== use) return;
	const wait = use.running ? RELEASE_MS : Math.max(use.at + RELEASE_MS, use.watchedUntil) - Date.now();
	if (wait > 0) return releaseLater(id, use, wait);
	uses.delete(id);
	await release(id);
}

/** The browser stays, standing by, with its pages. */
async function release(id: string) {
	connections.get(id)?.cdp.close();
	connections.delete(id);
	const driven = drivers.get(id);
	drivers.delete(id);
	// Over the DevTools protocol, closing Playwright's browser only disconnects it.
	await driven?.browser.close().catch(() => undefined);
}

export const browserConnected = (id: string): boolean => Boolean(connections.get(id)?.cdp.isOpen || drivers.get(id)?.browser.isConnected());

/** So the panel never wakes the browser just to show its address. */
const lastPage = new Map<string, BrowserPage>();

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

/** Follows a page that opens a new tab, as the live view shows only one. */
async function follow(id: string, current: Connection, event: CdpEvent) {
	if (event.sessionId === current.session && (event.method === 'Page.navigatedWithinDocument' || (event.method === 'Page.frameNavigated' && !(event.params.frame as { parentId?: string } | undefined)?.parentId))) {
		// Leaving the page the agent stopped on (signed in, say) ends the ask.
		const url = String((event.params.frame as { url?: string } | undefined)?.url ?? event.params.url ?? '');
		const asked = needsYou.get(id);
		if (asked && url && url.replace(/#.*$/, '') !== asked.url.replace(/#.*$/, '')) needsYou.delete(id);
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

async function viewportSize({ cdp, session }: Connection): Promise<{ width: number; height: number }> {
	const { cssVisualViewport: view } = await cdp.send<{ cssVisualViewport: { clientWidth: number; clientHeight: number } }>('Page.getLayoutMetrics', {}, session);
	return { width: view.clientWidth, height: view.clientHeight };
}

async function pageState(id: string, current: Connection): Promise<BrowserPage> {
	const { currentIndex, entries } = await history(current);
	const entry = entries[currentIndex];
	const state = { url: entry?.url ?? '', title: entry?.title ?? '', canGoBack: currentIndex > 0, canGoForward: currentIndex < entries.length - 1 };
	lastPage.set(id, state);
	return state;
}

// ---- What the routes call ----

/** With `connect`, read fresh from the browser, else from a connection already open or as last seen. */
async function viewOf(id: string, browser: Stored, connect: boolean): Promise<BrowserView> {
	if (!browser.liveViewUrl) return { available: true, browser: null };
	const state =
		connect || connections.get(id)?.cdp.isOpen
			? await using(id, async () => pageState(id, await connection(id, browser))).catch((error: unknown) => {
					logProblem('warn', 'Could not read the browser page', error, id);
					return lastPage.get(id) ?? null;
				})
			: (lastPage.get(id) ?? null);
	return { available: true, browser: { liveViewUrl: browser.liveViewUrl, viewport: VIEWPORT, openedAt: browser.openedAt, page: state, agentBusy: agentBusy(id), needsYou: needsYou.get(id)?.reason ?? null } };
}

export async function browserView(id: string): Promise<BrowserView> {
	await requireTask(id);
	if (!sharedBrowserAvailable()) return { available: false, browser: null };
	const browser = await storedBrowser(id);
	return browser ? viewOf(id, browser, false) : { available: true, browser: null };
}

/** The browser is billed while its live view shows anyway, so Anton stays connected then. */
export async function watchBrowser(id: string): Promise<BrowserView> {
	await requireTask(id);
	if (!sharedBrowserAvailable()) return { available: false, browser: null };
	const browser = await storedBrowser(id);
	if (!browser) return { available: true, browser: null };
	useOf(id).watchedUntil = Date.now() + WATCH_MS;
	return viewOf(id, browser, true);
}

export async function openBrowser(id: string, address?: string): Promise<BrowserView> {
	await requireTask(id);
	const url = address?.trim() ? addressToUrl(address) : undefined;
	const existing = await storedBrowser(id);
	const browser = existing ?? (await ensureBrowser(id, url));
	if (existing && url) await using(id, async () => go(id, await connection(id, browser), { url }));
	return viewOf(id, browser, true);
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

async function go(id: string, current: Connection, action: NavigateAction): Promise<BrowserPage> {
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
	return pageState(id, current);
}

export const navigate = (id: string, action: NavigateAction): Promise<BrowserPage> => using(id, async () => go(id, await page(id), action));

const HIGHLIGHT = {
	showInfo: true,
	contentColor: { r: 59, g: 172, b: 220, a: 0.22 },
	paddingColor: { r: 59, g: 172, b: 220, a: 0.12 },
	borderColor: { r: 59, g: 172, b: 220, a: 0.9 },
	marginColor: { r: 240, g: 180, b: 60, a: 0.12 },
};

/** In CSS pixels from its top left. With `pick`, also reads it and takes its picture. */
export const inspectAt = (id: string, point: { x: number; y: number; pick: boolean }): Promise<PickedElement | null> => using(id, () => inspect(id, point));

async function inspect(id: string, point: { x: number; y: number; pick: boolean }): Promise<PickedElement | null> {
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

export const clearHighlight = (id: string): Promise<void> => using(id, async () => void (await hideHighlight(await page(id))));

export const browserScreenshot = (id: string): Promise<{ data: string; width: number; height: number }> =>
	using(id, async () => {
		const current = await page(id);
		const [view] = await Promise.all([viewportSize(current), hideHighlight(current)]);
		const { data } = await current.cdp.send<{ data: string }>('Page.captureScreenshot', { format: 'png' }, current.session, 30_000);
		return { data, ...view };
	});

// ---- The agent in the same browser ----

/** Playwright over the same DevTools endpoint, on the tab the live view shows, so you can watch and take over. */
type Driver = { browserId: string; browser: PlaywrightBrowser; errors: string[]; targets: WeakMap<Page, string> };
const drivers = new Map<string, Driver>();

/** A run's code runs in a QuickJS VM here, never in Anton's own process. */
const { browserStep, browserRun } = browserFunctions<Page>();

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

export function dropAgentDriver(id: string): void {
	const current = drivers.get(id);
	if (!current) return;
	drivers.delete(id);
	void current.browser.close().catch(() => undefined);
}

async function targetOf(current: Driver, page: Page): Promise<string> {
	const known = current.targets.get(page);
	if (known) return known;
	const session = await page.context().newCDPSession(page);
	const { targetInfo } = await session.send('Target.getTargetInfo').catch(() => ({ targetInfo: { targetId: '' } }));
	void session.detach().catch(() => undefined);
	current.targets.set(page, targetInfo.targetId);
	page.on('console', (message) => message.type() === 'error' && current.errors.push(message.text()));
	page.on('pageerror', (error) => current.errors.push(String(error)));
	return targetInfo.targetId;
}

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

const BUSY_MS = 8_000;
const agentSteps = new Map<string, { running: number; at: number; quiet?: ReturnType<typeof setTimeout> }>();

export function agentBusy(id: string): boolean {
	const step = agentSteps.get(id);
	return Boolean(step && (step.running > 0 || Date.now() - step.at < BUSY_MS));
}

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

/** In its sandbox when one runs (where the agent can read it back), else straight to storage. */
async function saveScreenshot(id: string, page: Page, input: BrowserInput): Promise<string> {
	const file = screenshotFile(input.screenshot ?? 'page');
	const png = await page.screenshot({ fullPage: Boolean(input.fullPage) });
	const machine = await liveMachine(id);
	if (machine) {
		await machine.exec(`mkdir -p ${quote(`${machine.root}/outputs/screenshots`)}`);
		await writeMachineFile(machine, `${machine.root}/outputs/${file}`, png);
	} else {
		await saveOutput(id, file, png, 'image/png');
		announce({ kind: 'task', id, what: 'files' });
	}
	return `../outputs/${file}`;
}

export async function agentBrowse(id: string, input: BrowserInput): Promise<BrowserState> {
	await requireTask(id);
	host(); // Throws, saying how to set one up, when there is no browser host.
	return asAgentStep(id, () =>
		using(id, async () => {
			const browser = await ensureBrowser(id);
			const current = await driver(id, browser);
			const page = await shownPage(id, browser, current);
			const { ask, ...command } = input;
			const result = input.action === 'run' ? await browserRun(page, command, ask, quickjsExecute) : await browserStep(page, { ...command, url: input.url && addressToUrl(input.url) });
			const screenshot = input.screenshot ? await saveScreenshot(id, page, input) : null;
			// Where the agent left the page, for the panel's address bar once the connection is let go.
			const shown = connections.get(id);
			if (shown?.cdp.isOpen) await pageState(id, shown).catch(() => undefined);
			return { ...result, errors: current.errors.splice(0).slice(0, 20), screenshot, snapshot: clipSnapshot(result.snapshot) };
		}),
	);
}

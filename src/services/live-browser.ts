import { announce } from '../core/changes.ts';
import { CdpConnection, type CdpEvent } from '../core/cdp.ts';
import { ConflictError, InvalidInputError, NotFoundError } from '../core/errors.ts';
import type { BrowserHost, HostedBrowser } from '../core/ports.ts';
import { getSessionRecord } from '../db/sessions.ts';
import { getSetting, setSetting } from '../db/settings.ts';
import { getProviders } from '../providers/index.ts';
import { DESCRIBE_ELEMENT } from './describe-element.ts';
import { logProblem } from './log.ts';

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
	browser: { liveViewUrl: string; viewport: { width: number; height: number }; openedAt: string; page: BrowserPage | null } | null;
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

const key = (id: string) => `browser.${id}`;

function host(): BrowserHost {
	const browsers = getProviders().browsers;
	if (!browsers) throw new InvalidInputError('Set KERNEL_API_KEY to use the Browser panel');
	return browsers;
}

async function requireTask(id: string) {
	if (!(await getSessionRecord(id))) throw new NotFoundError('Session not found');
}

/** The task's browser, if it still exists; one the host removed is forgotten. */
async function storedBrowser(id: string): Promise<Stored | null> {
	const stored = await getSetting<Stored | null>(key(id), null);
	if (!stored) return null;
	const live = await host().get(stored.id).catch((error: unknown) => {
		logProblem('warn', 'Could not check the browser', error, id);
		return stored;
	});
	if (live) return { ...stored, ...live, viewport: stored.viewport };
	await forget(id);
	return null;
}

async function forget(id: string) {
	connections.get(id)?.cdp.close();
	connections.delete(id);
	await setSetting(key(id), null);
}

// ---- The page connection ----

type Connection = { browserId: string; cdp: CdpConnection; session: string; targetId: string };
const connections = new Map<string, Connection>();
const connecting = new Map<string, Promise<Connection>>();

const changed = (id: string) => announce({ kind: 'task', id, what: 'browser' });

async function attach(cdp: CdpConnection, targetId: string): Promise<string> {
	const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
	await Promise.all([cdp.send('Page.enable', {}, sessionId), cdp.send('DOM.enable', {}, sessionId), cdp.send('Overlay.enable', {}, sessionId)]);
	return sessionId;
}

/** A connection to the tab the live view shows, opened once and kept while the browser lives. */
async function connection(id: string, browser: Stored): Promise<Connection> {
	const open = connections.get(id);
	if (open && open.cdp.isOpen && open.browserId === browser.id) return open;
	const pending = connecting.get(id);
	if (pending) return pending;
	const made = (async () => {
		const cdp = await CdpConnection.connect(browser.cdpUrl);
		const { targetInfos } = await cdp.send<{ targetInfos: Array<{ targetId: string; type: string; url: string }> }>('Target.getTargets');
		const page = targetInfos.filter((target) => target.type === 'page' && !target.url.startsWith('devtools://')).pop();
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

/** Keeps the address bar current, and follows a page that opens a new tab, as the live view shows only one. */
async function follow(id: string, current: Connection, event: CdpEvent) {
	if (event.method === 'Page.frameNavigated' && event.sessionId === current.session) {
		const frame = event.params.frame as { parentId?: string } | undefined;
		if (!frame?.parentId) changed(id);
		return;
	}
	if (event.method === 'Page.navigatedWithinDocument' && event.sessionId === current.session) return changed(id);
	if (event.method === 'Target.targetCreated') {
		const info = event.params.targetInfo as { targetId: string; type: string; openerId?: string };
		if (info.type !== 'page' || !info.openerId) return;
		try {
			current.session = await attach(current.cdp, info.targetId);
			current.targetId = info.targetId;
			await current.cdp.send('Target.activateTarget', { targetId: info.targetId });
			changed(id);
		} catch (error) {
			logProblem('warn', 'Could not follow a new tab', error, id);
		}
	}
	if (event.method === 'Target.targetDestroyed' && event.params.targetId === current.targetId) {
		// The tab closed: go back to whichever is left.
		const { targetInfos } = await current.cdp.send<{ targetInfos: Array<{ targetId: string; type: string }> }>('Target.getTargets').catch(() => ({ targetInfos: [] }));
		const left = targetInfos.filter((target) => target.type === 'page').pop();
		if (!left) return;
		current.session = await attach(current.cdp, left.targetId).catch(() => current.session);
		current.targetId = left.targetId;
		await current.cdp.send('Target.activateTarget', { targetId: left.targetId }).catch(() => undefined);
		changed(id);
	}
}

async function page(id: string): Promise<Connection> {
	const browser = await storedBrowser(id);
	if (!browser) throw new ConflictError('Open the browser first');
	return connection(id, browser);
}

async function pageState({ cdp, session }: Connection): Promise<BrowserPage> {
	const history = await cdp.send<{ currentIndex: number; entries: Array<{ url: string; title: string }> }>('Page.getNavigationHistory', {}, session);
	const entry = history.entries[history.currentIndex];
	return {
		url: entry?.url ?? '',
		title: entry?.title ?? '',
		canGoBack: history.currentIndex > 0,
		canGoForward: history.currentIndex < history.entries.length - 1,
	};
}

// ---- What the routes call ----

export async function browserView(id: string): Promise<BrowserView> {
	await requireTask(id);
	if (!getProviders().browsers) return { available: false, browser: null };
	const browser = await storedBrowser(id);
	if (!browser?.liveViewUrl) return { available: true, browser: null };
	const state = await connection(id, browser)
		.then(pageState)
		.catch((error: unknown) => {
			logProblem('warn', 'Could not read the browser page', error, id);
			return null;
		});
	return { available: true, browser: { liveViewUrl: browser.liveViewUrl, viewport: browser.viewport, openedAt: browser.openedAt, page: state } };
}

/** What you typed in the address bar as a URL: a host gets https, anything else is searched for. */
export function addressToUrl(input: string): string {
	const text = input.trim();
	if (!text) return 'about:blank';
	if (/^[a-z][a-z0-9+.-]*:/i.test(text) && !/^localhost:\d/i.test(text)) return text;
	if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(text)) return `http://${text}`;
	if (!/\s/.test(text) && /^[^/]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(text)) return `https://${text}`;
	return `https://www.google.com/search?q=${encodeURIComponent(text)}`;
}

/** Opens the task's browser, or reuses the one it has, at `address` if given. */
export async function openBrowser(id: string, address?: string): Promise<BrowserView> {
	await requireTask(id);
	const url = address?.trim() ? addressToUrl(address) : undefined;
	const existing = await storedBrowser(id);
	if (existing) {
		if (url) await navigate(id, { url });
		return browserView(id);
	}
	const created = await host().create({ idleSeconds: IDLE_SECONDS, viewport: VIEWPORT, startUrl: url });
	await setSetting(key(id), { ...created, openedAt: new Date().toISOString() } satisfies Stored);
	changed(id);
	return browserView(id);
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

export async function navigate(id: string, action: NavigateAction): Promise<BrowserPage> {
	const current = await page(id);
	const { cdp, session } = current;
	if ('url' in action) {
		const result = await cdp.send<{ errorText?: string }>('Page.navigate', { url: addressToUrl(action.url) }, session);
		if (result.errorText && result.errorText !== 'net::ERR_ABORTED') throw new InvalidInputError(`Could not open the page: ${result.errorText}`);
	} else if (action.action === 'reload') {
		await cdp.send('Page.reload', {}, session);
	} else {
		const history = await cdp.send<{ currentIndex: number; entries: Array<{ id: number }> }>('Page.getNavigationHistory', {}, session);
		const target = history.entries[history.currentIndex + (action.action === 'back' ? -1 : 1)];
		if (target) await cdp.send('Page.navigateToHistoryEntry', { entryId: target.id }, session);
	}
	return pageState(current);
}

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
	const { cdp, session } = await page(id);
	const at = await cdp
		.send<{ backendNodeId: number }>('DOM.getNodeForLocation', { x: Math.round(point.x), y: Math.round(point.y), includeUserAgentShadowDOM: false, ignorePointerEventsNone: true }, session)
		.catch(() => null);
	if (!at) {
		await cdp.send('Overlay.hideHighlight', {}, session).catch(() => undefined);
		return null;
	}
	if (!point.pick) {
		await cdp.send('Overlay.highlightNode', { highlightConfig: HIGHLIGHT, backendNodeId: at.backendNodeId }, session).catch(() => undefined);
		return null;
	}
	await cdp.send('Overlay.hideHighlight', {}, session).catch(() => undefined);
	const { object } = await cdp.send<{ object: { objectId?: string } }>('DOM.resolveNode', { backendNodeId: at.backendNodeId }, session);
	if (!object.objectId) return null;
	const described = await cdp.send<{ result: { value?: Omit<PickedElement, 'image'> | null }; exceptionDetails?: unknown }>(
		'Runtime.callFunctionOn',
		{ objectId: object.objectId, functionDeclaration: DESCRIBE_ELEMENT, returnByValue: true },
		session,
	);
	await cdp.send('Runtime.releaseObject', { objectId: object.objectId }, session).catch(() => undefined);
	const element = described.result.value;
	if (!element) return null;
	return { ...element, image: await elementImage(cdp, session, element.rect) };
}

/** The element's box with a little room around it, kept inside the viewport. */
async function elementImage(cdp: CdpConnection, session: string, rect: PickedElement['rect']): Promise<string | null> {
	const { cssVisualViewport: view } = await cdp.send<{ cssVisualViewport: { clientWidth: number; clientHeight: number } }>('Page.getLayoutMetrics', {}, session);
	const pad = 8;
	const x = Math.max(0, rect.x - pad);
	const y = Math.max(0, rect.y - pad);
	const width = Math.min(view.clientWidth, rect.x + rect.width + pad) - x;
	const height = Math.min(view.clientHeight, rect.y + rect.height + pad) - y;
	if (width < 2 || height < 2) return null;
	const shot = await cdp
		.send<{ data: string }>('Page.captureScreenshot', { format: 'png', clip: { x, y, width, height, scale: 1 } }, session)
		.catch(() => null);
	return shot?.data ?? null;
}

export async function clearHighlight(id: string): Promise<void> {
	const { cdp, session } = await page(id);
	await cdp.send('Overlay.hideHighlight', {}, session).catch(() => undefined);
}

/** The page as you see it, to draw on: a PNG, base64, at the page's CSS size. */
export async function browserScreenshot(id: string): Promise<{ data: string; width: number; height: number }> {
	const { cdp, session } = await page(id);
	await cdp.send('Overlay.hideHighlight', {}, session).catch(() => undefined);
	const { cssVisualViewport: view } = await cdp.send<{ cssVisualViewport: { clientWidth: number; clientHeight: number } }>('Page.getLayoutMetrics', {}, session);
	const { data } = await cdp.send<{ data: string }>('Page.captureScreenshot', { format: 'png' }, session, 30_000);
	return { data, width: view.clientWidth, height: view.clientHeight };
}

import { useRouter } from '@tanstack/react-router';
import { useEffect } from 'react';
import { api, type PushView } from '@/lib/api';

/**
 * Notifications with no Anton tab open: the service worker (public/sw.js)
 * takes what the server pushes and shows it, on a phone with Anton on its
 * home screen or in a browser in the background. This device turns them on
 * from Settings › Notifications, or by allowing notifications when asked.
 */

const OFF_KEY = 'anton.push.off';

export const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.userAgent.includes('Macintosh') && navigator.maxTouchPoints > 1);

/** Opened from the home screen, as an app, rather than in a browser tab. */
export const isInstalled = () =>
	window.matchMedia?.('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;

/**
 * Whether this browser can get pushed notifications: `install-first` on an
 * iPhone or iPad, which push only to an app added to the home screen;
 * `blocked` when notifications were refused in the browser's settings.
 */
export type PushSupport = 'ready' | 'install-first' | 'blocked' | 'unsupported';

export function pushSupport(): PushSupport {
	if (typeof window === 'undefined' || !('serviceWorker' in navigator) || !window.isSecureContext) return 'unsupported';
	if (!('PushManager' in window) || typeof Notification === 'undefined') return isIos() && !isInstalled() ? 'install-first' : 'unsupported';
	return Notification.permission === 'denied' ? 'blocked' : 'ready';
}

let registering: Promise<ServiceWorkerRegistration | null> | undefined;

/** Registers the service worker once per page; null where there is none. */
export function serviceWorker(): Promise<ServiceWorkerRegistration | null> {
	registering ??=
		typeof navigator !== 'undefined' && 'serviceWorker' in navigator && window.isSecureContext
			? navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => null)
			: Promise.resolve(null);
	return registering;
}

export async function currentSubscription(): Promise<PushSubscription | null> {
	const registration = await serviceWorker();
	return (await registration?.pushManager.getSubscription().catch(() => null)) ?? null;
}

/** What this device is called in the list, from its browser: "iPhone", "Android phone", "Chrome on Mac". */
export function deviceName(): string {
	const agent = navigator.userAgent;
	if (/iPhone/.test(agent)) return 'iPhone';
	if (/iPad/.test(agent) || (agent.includes('Macintosh') && navigator.maxTouchPoints > 1)) return 'iPad';
	if (/Android/.test(agent)) return /Mobile/.test(agent) ? 'Android phone' : 'Android tablet';
	const browser = /Edg\//.test(agent) ? 'Edge' : /Firefox\//.test(agent) ? 'Firefox' : /Chrome\//.test(agent) ? 'Chrome' : /Safari\//.test(agent) ? 'Safari' : 'Browser';
	const system = /Mac OS X/.test(agent) ? 'Mac' : /Windows/.test(agent) ? 'Windows' : /Linux/.test(agent) ? 'Linux' : 'this computer';
	return `${browser} on ${system}`;
}

/** The id the server lists this device under, from its endpoint as the server hashes it. */
export async function deviceIdOf(endpoint: string): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint)));
	return btoa(String.fromCharCode(...digest)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, 16);
}

const keyBytes = (base64url: string) => {
	const text = atob(base64url.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(base64url.length / 4) * 4, '='));
	return Uint8Array.from(text, (char) => char.charCodeAt(0));
};

const remember = (off: boolean) => {
	try {
		if (off) localStorage.setItem(OFF_KEY, '1');
		else localStorage.removeItem(OFF_KEY);
	} catch {
		// Only decides whether Anton turns notifications back on by itself.
	}
};

const turnedOff = () => {
	try {
		return localStorage.getItem(OFF_KEY) === '1';
	} catch {
		return false;
	}
};

/** Asks for permission if it has not been given, subscribes this device and tells the server. Must start from a tap or click. */
export async function turnOnPush(publicKey: string): Promise<PushView> {
	if (!publicKey) throw new Error('The server cannot send notifications.');
	const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
	if (permission !== 'granted') throw new Error(permission === 'denied' ? 'Notifications are blocked for Anton in this browser’s settings.' : 'Notifications were not allowed.');
	const registration = await serviceWorker();
	if (!registration) throw new Error('This browser cannot show notifications from Anton.');
	await navigator.serviceWorker.ready;
	const existing = await registration.pushManager.getSubscription();
	// A subscription made with another server key cannot be used; make a fresh one.
	const current = existing?.options.applicationServerKey;
	const sameKey = current && keyBytes(publicKey).every((byte, index) => new Uint8Array(current)[index] === byte);
	if (existing && !sameKey) await existing.unsubscribe();
	const subscription = existing && sameKey ? existing : await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
	const json = subscription.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
	remember(false);
	return api.addPushDevice({ endpoint: json.endpoint, keys: json.keys, name: deviceName() });
}

/** Stops notifications on this device, and keeps Anton from turning them back on by itself. */
export async function turnOffPush(): Promise<PushView> {
	const subscription = await currentSubscription();
	remember(true);
	if (!subscription) return api.push();
	const view = await api.removePushDevice(await deviceIdOf(subscription.endpoint));
	await subscription.unsubscribe().catch(() => undefined);
	return view;
}

/**
 * Turns notifications on for this device when it already allows them and
 * nobody turned them off here: a browser that said yes to the tab's
 * notifications gets them with the tab closed too. Run at each start, so the
 * server lists this device again if it forgot it, or the browser renewed it.
 */
export async function turnOnIfAllowed(): Promise<void> {
	if (pushSupport() !== 'ready' || Notification.permission !== 'granted' || turnedOff()) return;
	const view = await api.push().catch(() => null);
	if (view?.publicKey) await turnOnPush(view.publicKey).catch(() => undefined);
}

/** A tapped notification asks an open window to show its task, which moves there without reloading. */
export function useOpenFromNotifications(): void {
	const router = useRouter();
	useEffect(() => {
		if (!('serviceWorker' in navigator)) return;
		const onMessage = (event: MessageEvent) => {
			const data = event.data as { type?: string; url?: string } | null;
			if (data?.type !== 'anton-open' || !data.url) return;
			const url = new URL(data.url, window.location.origin);
			if (url.origin === window.location.origin) void router.navigate({ href: `${url.pathname}${url.search}` });
		};
		navigator.serviceWorker.addEventListener('message', onMessage);
		return () => navigator.serviceWorker.removeEventListener('message', onMessage);
	}, [router]);
}

/** How often a page in front of you says so; the server holds it for 75 seconds. */
const PRESENCE_EVERY_MS = 30_000;

const tell = (present: boolean) =>
	void fetch('/api/push/presence', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ present }), keepalive: true }).catch(() => undefined);

/** Tells the server while this page is on screen and focused, so your phone stays quiet while you are at Anton. */
export function usePresence(): void {
	useEffect(() => {
		let timer: ReturnType<typeof setInterval> | undefined;
		// Only changes are told, so a page opened in the background does not speak over one in front of you.
		let last = false;
		const update = () => {
			const present = document.visibilityState === 'visible' && document.hasFocus();
			if (present === last) return;
			last = present;
			clearInterval(timer);
			timer = undefined;
			tell(present);
			if (present) timer = setInterval(() => tell(true), PRESENCE_EVERY_MS);
		};
		update();
		const events = ['visibilitychange', 'focus', 'blur', 'pagehide'] as const;
		for (const name of events) (name === 'visibilitychange' ? document : window).addEventListener(name, update);
		return () => {
			clearInterval(timer);
			for (const name of events) (name === 'visibilitychange' ? document : window).removeEventListener(name, update);
		};
	}, []);
}

type InstallPrompt = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> };

/** Chrome and Edge offer to install the app with this event; kept so Settings can offer it again from a button. */
let installPrompt: InstallPrompt | null = null;
const installListeners = new Set<() => void>();
if (typeof window !== 'undefined') {
	window.addEventListener('beforeinstallprompt', (event) => {
		installPrompt = event as InstallPrompt;
		for (const listener of installListeners) listener();
	});
	window.addEventListener('appinstalled', () => {
		installPrompt = null;
		for (const listener of installListeners) listener();
	});
}

export const canPromptInstall = () => installPrompt !== null;

export function onInstallChange(listener: () => void): () => void {
	installListeners.add(listener);
	return () => void installListeners.delete(listener);
}

/** Shows the browser's own install dialog; true when Anton was installed. */
export async function promptInstall(): Promise<boolean> {
	const prompt = installPrompt;
	if (!prompt) return false;
	installPrompt = null;
	await prompt.prompt();
	const choice = await prompt.userChoice;
	for (const listener of installListeners) listener();
	return choice.outcome === 'accepted';
}


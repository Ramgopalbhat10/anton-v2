/**
 * Anton's service worker: shows the notifications the server pushes when a
 * task needs you, fails or finishes, and opens the task when one is tapped.
 * It caches nothing, so the app is always the one the server serves.
 */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

/** A window of Anton's that is on screen and focused: it already shows what the notice would say. */
async function inFront() {
	const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
	return windows.some((client) => client.visibilityState === 'visible' && client.focused);
}

self.addEventListener('push', (event) => {
	let notice;
	try {
		notice = event.data ? event.data.json() : null;
	} catch {
		notice = null;
	}
	if (!notice || typeof notice.title !== 'string') return;
	event.waitUntil(
		(async () => {
			if (notice.kind !== 'test' && (await inFront())) return;
			await self.registration.showNotification(notice.title, {
				body: notice.body,
				tag: notice.tag,
				// A task that needs you again sounds again; the same tag replaces its older notice.
				renotify: notice.kind === 'needs-you' || notice.kind === 'plan' || notice.kind === 'failed',
				icon: '/icons/icon-192.png?v=1df47b80',
				badge: '/icons/badge-96.png?v=1df47b80',
				data: { url: notice.url },
			});
		})(),
	);
});

self.addEventListener('notificationclick', (event) => {
	event.notification.close();
	const url = new URL(event.notification.data?.url || '/', self.location.origin).href;
	event.waitUntil(
		(async () => {
			const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
			const open = windows.find((client) => client.url === url) ?? windows[0];
			if (!open) return void (await self.clients.openWindow(url));
			await open.focus();
			// The page moves to the task itself, without reloading the app.
			if (open.url !== url) open.postMessage({ type: 'anton-open', url });
		})(),
	);
});

// A browser that renews its subscription tells the server, so notifications keep arriving.
self.addEventListener('pushsubscriptionchange', (event) => {
	const options = event.oldSubscription?.options;
	if (!options) return;
	event.waitUntil(
		(async () => {
			const subscription = event.newSubscription ?? (await self.registration.pushManager.subscribe(options));
			await fetch('/api/push/devices', {
				method: 'POST',
				credentials: 'include',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ ...subscription.toJSON(), replaces: event.oldSubscription?.endpoint }),
			});
		})(),
	);
});

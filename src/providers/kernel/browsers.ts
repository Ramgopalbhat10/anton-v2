import type { BrowserHost, HostedBrowser } from '../../core/ports.ts';

type KernelBrowser = {
	session_id: string;
	cdp_ws_url: string;
	browser_live_view_url?: string | null;
	viewport?: { width: number; height: number } | null;
	deleted_at?: string | null;
};

const DEFAULT_VIEWPORT = { width: 1280, height: 800 };

function toBrowser(browser: KernelBrowser): HostedBrowser {
	return {
		id: browser.session_id,
		cdpUrl: browser.cdp_ws_url,
		liveViewUrl: browser.browser_live_view_url ?? null,
		viewport: browser.viewport ?? DEFAULT_VIEWPORT,
	};
}

/**
 * Kernel's hosted Chromium (kernel.sh), over its REST API. Browsers are
 * headful, for the live view, and in kiosk mode, so the live view is the page
 * alone and Anton draws the address bar. Billing stops while a browser is idle.
 */
export function kernelBrowsers({ apiUrl, apiKey }: { apiUrl: string; apiKey: string }): BrowserHost {
	async function call<T>(method: string, path: string, body?: unknown): Promise<T | null> {
		const response = await fetch(`${apiUrl}${path}`, {
			method,
			headers: { authorization: `Bearer ${apiKey}`, ...(body ? { 'content-type': 'application/json' } : {}) },
			body: body ? JSON.stringify(body) : undefined,
		});
		if (response.status === 404) return null;
		if (!response.ok) {
			const detail = await response.text().catch(() => '');
			throw new Error(`Kernel ${method} ${path} failed (${response.status})${detail ? `: ${detail.slice(0, 300)}` : ''}`);
		}
		return response.status === 204 ? null : ((await response.json().catch(() => null)) as T | null);
	}

	return {
		name: 'kernel',
		async create({ idleSeconds, viewport, startUrl }) {
			const browser = await call<KernelBrowser>('POST', '/browsers', {
				headless: false,
				kiosk_mode: true,
				timeout_seconds: idleSeconds,
				viewport,
				...(startUrl ? { start_url: startUrl } : {}),
			});
			if (!browser) throw new Error('Kernel did not return a browser');
			return toBrowser({ ...browser, viewport: browser.viewport ?? viewport });
		},
		async get(id) {
			const browser = await call<KernelBrowser>('GET', `/browsers/${encodeURIComponent(id)}`);
			return browser && !browser.deleted_at ? toBrowser(browser) : null;
		},
		async remove(id) {
			await call('DELETE', `/browsers/${encodeURIComponent(id)}`);
		},
	};
}

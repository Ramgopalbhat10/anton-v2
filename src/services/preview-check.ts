import { isLocalAddress } from './browser-step.ts';
import { fetchForPage, type PageRequest, type PageResponse } from './page-fetch.ts';
import { previewsView, type Preview } from './previews.ts';

/** An HTTP check from Anton's server, not a browser or a guarantee that an iframe can render. */
export async function checkPreviewResponse(
	preview: Preview,
	fetcher: (request: PageRequest) => Promise<PageResponse> = (request) => fetchForPage(request, { timeoutMs: 10_000, maxBytes: 1024 * 1024 }),
) {
	if (!preview.url) return { ...preview, check: 'unavailable' as const, detail: 'This port has no Preview URL; it may not have been exposed when the sandbox started.' };
	if (isLocalAddress(preview.url))
		return { ...preview, check: 'local' as const, detail: 'This URL is localhost on the viewer’s computer. An external reachability check cannot establish that it reaches the sandbox.' };
	try {
		const response = await fetcher({ url: preview.url, method: 'GET', headers: [], body: null });
		const headers = response.headers.filter(([name]) => /^(content-type|content-security-policy|x-frame-options)$/i.test(name));
		return {
			...preview,
			check: 'http' as const,
			status: response.status,
			finalUrl: response.url,
			headers,
			// Vite and proxies often explain refusals in their response. Do not return the full page.
			...(response.status >= 400 ? { detail: new TextDecoder().decode(response.body).slice(0, 1500) } : {}),
		};
	} catch (error) {
		return { ...preview, check: 'failed' as const, detail: error instanceof Error ? error.message : String(error) };
	}
}

/** The configured port and its exact Preview URL, checked without starting the task's machine. */
export async function checkPreview(id: string, port: number) {
	const view = await previewsView(id);
	if (!view.live) return { live: false as const, detail: 'The sandbox is not running; checking Preview does not start it.' };
	const preview = view.previews.find((item) => item.port === port);
	if (!preview) return { live: true as const, detail: `Port ${port} is not configured for Preview.`, ports: view.previews.map((item) => item.port) };
	return { live: true as const, ...(await checkPreviewResponse(preview)) };
}

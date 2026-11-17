/** Statuses a proxy in front of Anton answers with when Anton took too long or could not be reached. */
const GATEWAY = new Set([502, 503, 504, 522, 524]);

/** A failed request in words a toast can show; a proxy in front of Anton (Cloudflare closes at 100 s) answers with an HTML page, never shown as is. */
export function errorMessage(status: number, statusText: string, body: string): string {
	try {
		const error = (JSON.parse(body) as { error?: unknown }).error;
		if (typeof error === 'string' && error) return error;
	} catch {
		// Not JSON: a proxy's page, or plain text.
	}
	const page = /^\s*</.test(body);
	if (GATEWAY.has(status)) return `Anton took too long to answer (${status}). It may still finish; check again in a moment.`;
	if (page || !body.trim()) return `Request failed (${status}${statusText ? ` ${statusText}` : ''}).`;
	const text = body.trim();
	return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

export async function request(input: string, init?: RequestInit): Promise<Response> {
	const response = await fetch(input, {
		...init,
		headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
	});
	if (!response.ok) throw new Error(errorMessage(response.status, response.statusText, await response.text()));
	return response;
}

export const json = async <T,>(input: string, init?: RequestInit) => (await request(input, init)).json() as Promise<T>;
export const post = <T,>(input: string, body?: unknown) => json<T>(input, { method: 'POST', body: JSON.stringify(body ?? {}) });

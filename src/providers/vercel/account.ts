import type { GatewayAccount, PlanWindow } from '../../core/ports.ts';

export type VercelAccountOptions = { apiUrl: string };

const TIMEOUT_MS = 15_000;

type Credits = { balance?: unknown; total_used?: unknown };

/** A dollar amount the gateway sends as a decimal string ("95.50"), or as a number. */
const amount = (value: unknown): number | null => {
	const parsed = typeof value === 'string' ? Number(value) : value;
	return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : null;
};

/** The team's credits from `GET /v1/credits`, as how much of all it bought is spent. */
export function toCredits(body: unknown): PlanWindow | null {
	const balance = amount((body as Credits | null)?.balance);
	const used = amount((body as Credits | null)?.total_used);
	if (balance === null || used === null || balance + used <= 0) return null;
	return { label: `Credits · $${balance.toFixed(2)} left`, usedPercent: Math.max(0, Math.min(100, (used / (balance + used)) * 100)), resetsAt: null, limited: balance <= 0 };
}

/**
 * The Vercel team a key belongs to (vercel.com/docs/ai-gateway/sdks-and-apis/rest-api):
 * `GET /v1/credits` checks the key and says what is left of the team's credits.
 */
export function vercelAccount({ apiUrl }: VercelAccountOptions): GatewayAccount {
	async function credits(key: string): Promise<unknown> {
		const response = await fetch(`${apiUrl}/v1/credits`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
		if (response.status === 401 || response.status === 403) throw new Error('Vercel did not accept that key. Make one under AI Gateway › API Keys in your Vercel dashboard.');
		if (!response.ok) throw new Error(`Vercel AI Gateway answered ${response.status} for /v1/credits`);
		return response.json();
	}

	return {
		id: 'vercel',
		name: 'Vercel AI Gateway',
		gateway: 'vercel',
		keyPage: 'https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai-gateway%2Fapi-keys',
		envVar: 'AI_GATEWAY_API_KEY',
		check: async (key) => {
			await credits(key);
			return { email: null };
		},
		windows: async (key) => {
			const spent = toCredits(await credits(key));
			return spent ? [spent] : [];
		},
	};
}

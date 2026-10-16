import type { GatewayAccount, PlanWindow } from '../../core/ports.ts';

export type OpenRouterAccountOptions = { apiUrl: string };

const TIMEOUT_MS = 15_000;

/** One of the spending limits on a key or its workspace, as `GET /key` lists them. */
type Budget = { scope?: unknown; limit_usd?: unknown; spend_usd?: unknown; remaining_usd?: unknown; reset_interval?: unknown; resets_at?: unknown };
type KeyInfo = { data?: { limit?: unknown; usage?: unknown; limit_remaining?: unknown; limit_reset?: unknown; budgets?: Budget[] } };
type Credits = { data?: { total_credits?: unknown; total_usage?: unknown } };

const SCOPES: Record<string, string> = { key_limit: 'Key', workspace: 'Workspace' };
const INTERVALS: Record<string, string> = { daily: 'daily', weekly: 'weekly', monthly: 'monthly' };

const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const percent = (used: number, limit: number) => Math.max(0, Math.min(100, (used / limit) * 100));

/** "Key limit", "Workspace daily": whose limit it is, and how often it starts again. */
function labelOf(scope: unknown, interval: unknown): string {
	const who = typeof scope === 'string' ? (SCOPES[scope] ?? scope.charAt(0).toUpperCase() + scope.slice(1).replace(/_/g, ' ')) : 'Key';
	return `${who} ${(typeof interval === 'string' && INTERVALS[interval]) || 'limit'}`;
}

/** The key's spending limits from `GET /key`: its budgets where listed, else its one limit. Unlimited ones are left out. */
export function toWindows(body: unknown): PlanWindow[] {
	const data = (body as KeyInfo | null)?.data ?? {};
	if (Array.isArray(data.budgets)) {
		return data.budgets.flatMap((budget) => {
			const limit = num(budget.limit_usd);
			const spent = num(budget.spend_usd);
			if (!limit || limit <= 0 || spent === null) return [];
			const remaining = num(budget.remaining_usd) ?? limit - spent;
			return [
				{
					label: labelOf(budget.scope, budget.reset_interval),
					usedPercent: percent(spent, limit),
					resetsAt: typeof budget.resets_at === 'string' ? budget.resets_at : null,
					limited: remaining <= 0,
				},
			];
		});
	}
	const limit = num(data.limit);
	const usage = num(data.usage);
	if (!limit || limit <= 0 || usage === null) return [];
	return [{ label: labelOf('key_limit', data.limit_reset), usedPercent: percent(usage, limit), resetsAt: null, limited: (num(data.limit_remaining) ?? limit - usage) <= 0 }];
}

/** The account's prepaid credits from `GET /credits`, as how much of them is spent. */
export function toCredits(body: unknown): PlanWindow | null {
	const data = (body as Credits | null)?.data ?? {};
	const total = num(data.total_credits);
	const used = num(data.total_usage);
	if (!total || total <= 0 || used === null) return null;
	return { label: 'Credits', usedPercent: percent(used, total), resetsAt: null, limited: used >= total };
}

/**
 * The OpenRouter account a key belongs to (openrouter.ai/docs/api-reference):
 * `GET /key` checks the key and lists its spending limits, and `GET /credits`
 * says how much of the account's credit is spent.
 */
export function openRouterAccount({ apiUrl }: OpenRouterAccountOptions): GatewayAccount {
	async function get(path: string, key: string): Promise<unknown> {
		const response = await fetch(`${apiUrl}${path}`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
		if (response.status === 401) throw new Error('OpenRouter did not accept that key. Copy it again from openrouter.ai/settings/keys.');
		if (!response.ok) throw new Error(`OpenRouter answered ${response.status} for ${path}`);
		return response.json();
	}

	return {
		id: 'openrouter',
		name: 'OpenRouter',
		gateway: 'openrouter',
		keyPage: 'https://openrouter.ai/settings/keys',
		envVar: 'OPENROUTER_API_KEY',
		check: async (key) => {
			await get('/key', key);
			return { email: null };
		},
		windows: async (key) => {
			const [limits, credits] = await Promise.all([get('/key', key), get('/credits', key).catch(() => null)]);
			const spent = toCredits(credits);
			return [...toWindows(limits), ...(spent ? [spent] : [])];
		},
	};
}

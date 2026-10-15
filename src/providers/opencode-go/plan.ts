import { getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import { OPENCODE_GO_MODELS } from '@earendil-works/pi-ai/providers/opencode-go.models';
import { type KeyPlan, type PlanWindow, REASONING_LEVELS, type SubscriptionModel } from '../../core/ports.ts';

/**
 * OpenCode Go (opencode.ai/docs/go): a monthly plan of open coding models,
 * used with an API key from the OpenCode Console. OpenCode documents it for
 * "OpenCode and other coding agents", asking each client to name itself and
 * send a session id per conversation; the agents' calls go through pi's
 * OpenAI and Anthropic APIs (`src/flue/opencode-go-models.ts`).
 */
export type OpenCodeGoOptions = { apiUrl: string };

export const OPENCODE_GO_DEFAULTS: OpenCodeGoOptions = { apiUrl: 'https://opencode.ai/inference/go/v1' };

const GATEWAY = 'opencode-go';
const TIMEOUT_MS = 15_000;

type PiEntry = (typeof OPENCODE_GO_MODELS)[keyof typeof OPENCODE_GO_MODELS];
const catalog = Object.values(OPENCODE_GO_MODELS) as PiEntry[];

/** Gemini models are served only through Google's own API shape, which Anton does not route to OpenCode. */
const UNROUTED = /^gemini-/;

const WINDOWS: Record<string, string> = { rolling: '5 hours', weekly: 'Week', monthly: 'Month' };

/** "glm-5.3-flash" as "GLM 5.3 Flash", for a model pi does not know yet. */
export function nameOf(id: string): string {
	const upper = new Set(['glm', 'gpt', 'hy']);
	return id
		.split('-')
		.map((part) => (upper.has(part) ? part.toUpperCase() : /^\d/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1)))
		.join(' ')
		.replace(/^(GLM|GPT|HY|Kimi|Qwen\S*|Grok|MiniMax|MiMo|DeepSeek) (\d)/, '$1-$2');
}

const vendorOf = (id: string): string =>
	[
		['claude', 'Anthropic'],
		['deepseek', 'DeepSeek'],
		['glm', 'Z.ai'],
		['gpt', 'OpenAI'],
		['grok', 'xAI'],
		['hy', 'Tencent'],
		['kimi', 'Moonshot AI'],
		['longcat', 'Meituan'],
		['mimo', 'Xiaomi'],
		['minimax', 'MiniMax'],
		['muse', 'Meta'],
		['qwen', 'Qwen'],
		['step', 'StepFun'],
	].find(([prefix]) => id.startsWith(prefix))?.[1] ?? 'OpenCode';

/** One of the plan's models, filled in from pi's catalog where pi knows it. */
export function toSubscriptionModel(id: string): SubscriptionModel {
	const pi = catalog.find((model) => model.id === id);
	// A model pi does not know yet gets no effort levels, so no reasoning field is sent that it might refuse.
	const levels: string[] = pi?.reasoning ? getSupportedThinkingLevels(pi) : [];
	const reasoning = REASONING_LEVELS.filter((level) => levels.includes(level));
	return {
		id: `${GATEWAY}/${id}`,
		name: pi?.name ?? nameOf(id),
		vendor: vendorOf(id),
		description: 'Runs on your OpenCode Go plan.',
		createdAt: 0,
		contextLength: pi?.contextWindow ?? 200_000,
		maxOutput: pi?.maxTokens ?? null,
		vision: pi?.input.includes('image') ?? false,
		reasoning,
		defaultReasoning: reasoning.includes('high') ? 'high' : (reasoning.findLast((level) => level !== 'off') ?? 'off'),
		listPrice: pi ? { input: pi.cost.input, output: pi.cost.output, cacheRead: pi.cost.cacheRead, cacheWrite: pi.cost.cacheWrite } : null,
	};
}

/** The usage answer's windows, in the order the plan's limits run: five hours, week, month. */
export function toWindows(body: unknown): PlanWindow[] {
	const usage = (body as { usage?: Record<string, { status?: unknown; percent?: unknown; resetsAt?: unknown }> } | null)?.usage ?? {};
	return Object.entries(WINDOWS).flatMap(([key, label]) => {
		const window = usage[key];
		if (!window || typeof window.percent !== 'number') return [];
		return [
			{
				label,
				usedPercent: Math.max(0, Math.min(100, window.percent)),
				resetsAt: typeof window.resetsAt === 'string' ? window.resetsAt : null,
				limited: window.status === 'rate-limited',
			},
		];
	});
}

export function openCodeGoPlan(options: OpenCodeGoOptions = OPENCODE_GO_DEFAULTS): KeyPlan {
	async function get(path: string, key: string): Promise<unknown> {
		const response = await fetch(`${options.apiUrl}${path}`, {
			headers: { Authorization: `Bearer ${key}`, 'User-Agent': 'anton', 'x-opencode-client': 'anton' },
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
		if (response.status === 401) throw new Error('OpenCode did not accept that key. Copy it again from the OpenCode Console.');
		if (response.status === 403) throw new Error('That key’s workspace has no OpenCode Go subscription.');
		if (!response.ok) throw new Error(`OpenCode answered ${response.status} for ${path}`);
		return response.json();
	}

	return {
		id: GATEWAY,
		name: 'OpenCode Go',
		gateway: GATEWAY,
		keyPage: 'https://opencode.ai/auth',
		// The usage call is the one that needs a Go plan: the model list answers any key, or none.
		check: async (key) => {
			await get('/usage', key);
			return { email: null };
		},
		listModels: async (key) => {
			const body = (await get('/models', key)) as { data?: Array<{ id?: unknown }> };
			const ids = (body.data ?? []).map((model) => model.id).filter((id): id is string => typeof id === 'string' && !UNROUTED.test(id));
			return [...new Set(ids)].map(toSubscriptionModel);
		},
		windows: async (key) => toWindows(await get('/usage', key)),
	};
}

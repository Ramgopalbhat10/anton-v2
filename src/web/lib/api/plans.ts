import { json, post } from './http';

export type { ModelRoute, RouteSort } from '../../../core/model-route';

export const REASONING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Reasoning = (typeof REASONING_LEVELS)[number];

export type ModelInfo = {
	id: string;
	name: string;
	vendor: string;
	description: string;
	createdAt: number;
	contextLength: number;
	maxOutput: number | null;
	/** US dollars per million tokens. */
	price: { input: number; output: number };
	vision: boolean;
	reasoning: Reasoning[];
	defaultReasoning: Reasoning;
	/** The plan its calls bill, such as "ChatGPT", when it runs on a subscription rather than per token. */
	subscription?: string;
	/** Set on a plan model's larger context or fast mode: the model it is a variant of, which the picker lists it under. */
	variant?: { of: string; context: string | null; fast: boolean };
};

export type ModelEndpoint = {
	slug: string;
	name: string;
	price: { input: number; output: number };
	contextLength: number;
	/** Median seconds to the first token, tokens a second and percent of calls answered, recently, where the gateway says. */
	latency: number | null;
	throughput: number | null;
	uptime: number | null;
};

/** Null reasoning runs the model's default. */
export type ModelChoice = { model: string; reasoning: Reasoning | null };

/** `enabled` offers the plan's models in the picker; `countAtApiPrices` counts their calls toward the caps at API prices. */
export type SubscriptionOptions = { enabled: boolean; countAtApiPrices: boolean };
/** The sign-in itself never leaves the server. */
export type Subscription = {
	id: string;
	name: string;
	/**
	 * `oauth`: Anton signs in and holds the token. `runtime`: the vendor's own program signs in on the server (`signIn`).
	 * `key`: a key made on the vendor's dashboard (`keyPage`), kept on the server.
	 * `gateway`: OpenRouter, billed per token, with a key pasted here or set on the server (`keySource`).
	 */
	kind: 'oauth' | 'runtime' | 'key' | 'gateway';
	gateway: string;
	state: 'connected' | 'expired' | 'signed-out';
	email: string | null;
	connectedAt: string | null;
	problem: string | null;
	expiresAt: string | null;
	options: SubscriptionOptions;
	/** Tokens each model used on the plan this month; `options` names its larger context and fast mode ("1M", "Fast"); a gateway's also carry vendor and price. */
	models: Array<
		Pick<ModelInfo, 'id' | 'name' | 'contextLength' | 'vision' | 'reasoning' | 'defaultReasoning'> & {
			tokens: number;
			options?: string[];
			vendor?: string;
			price?: Pick<ModelInfo['price'], 'input' | 'output'>;
		}
	>;
	monthTokens: number;
	modelsAt: string | null;
	/** A sign-in waiting for the address the browser is sent back to; `listening` when Anton catches it itself. */
	login: { url: string; redirectUri: string; listening: boolean; startedAt: string } | null;
	/** A runtime's plan as it names it (`max`), its version, and the command that signs it in on the server. */
	plan: string | null;
	version: string | null;
	signIn: string | null;
	limitHitAt: string | null;
	/** When the vendor last said the plan's limit ran out and calls now bill paid extra usage. */
	extraUsageAt: string | null;
	/** A key plan's dashboard, the key's last four characters, and what the vendor says is used of the plan's own limits. */
	keyPage?: string | null;
	keyHint?: string | null;
	windows?: PlanWindow[] | null;
	/** Where the gateway's key comes from: pasted here, or the server's own (`envVar`). */
	keySource?: 'settings' | 'environment' | null;
	envVar?: string | null;
	/** Runtimes whose agent container placement is configurable: 'sidecar' shares one anchor sandbox, 'sandbox' is dedicated per conversation. */
	isolation?: 'sidecar' | 'sandbox' | null;
};
export type PlanWindow = { label: string; usedPercent: number; resetsAt: string | null; limited: boolean };

export type ImageModelInfo = { id: string; name: string; vendor: string; description: string; references: number; aspectRatios: string[]; transparent: boolean };

export const plansApi = {
	/** `pinned` are the models you pinned to the top of the picker, in the order you pinned them. */
	models: () => json<{ models: ModelInfo[]; default: string; pinned?: string[] }>('/api/models'),
	imageModels: () => json<{ models: ImageModelInfo[]; default: string; available: boolean }>('/api/image-models'),
	modelEndpoints: (model: string) => json<{ endpoints: ModelEndpoint[] }>(`/api/models/endpoints?model=${encodeURIComponent(model)}`),
	setPinnedModels: (pinned: string[]) => json<{ pinned: string[] }>('/api/models/pinned', { method: 'PUT', body: JSON.stringify({ pinned }) }),
	subscriptions: () => json<{ subscriptions: Subscription[] }>('/api/subscriptions'),
	setSubscriptionOptions: (id: string, options: SubscriptionOptions) =>
		json<Subscription>(`/api/subscriptions/${id}`, { method: 'PUT', body: JSON.stringify(options) }),
	beginSubscriptionLogin: (id: string) => post<Subscription>(`/api/subscriptions/${id}/login`),
	cancelSubscriptionLogin: (id: string) => json<Subscription>(`/api/subscriptions/${id}/login`, { method: 'DELETE' }),
	finishSubscriptionLogin: (id: string, callbackUrl: string) => post<Subscription>(`/api/subscriptions/${id}/login/complete`, { callbackUrl }),
	importSubscriptionLogin: (id: string, credential: string) => post<Subscription>(`/api/subscriptions/${id}/import`, { credential }),
	connectSubscriptionKey: (id: string, key: string) => json<Subscription>(`/api/subscriptions/${id}/key`, { method: 'PUT', body: JSON.stringify({ key }) }),
	refreshSubscriptionModels: (id: string) => post<Subscription>(`/api/subscriptions/${id}/models/refresh`),
	disconnectSubscription: (id: string) => json<Subscription>(`/api/subscriptions/${id}`, { method: 'DELETE' }),
};

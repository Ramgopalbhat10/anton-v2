import { json, post } from './http';
import type { Reasoning } from './plans';

/** Where tasks can run: the sandbox provider's name, and whether this server is a choice of its own. */
export type RunnersView = { sandbox: string; host: boolean };

/** A sealed secret: the agent can use it in http_request but never read it. */
export type SealedSecret = { name: string; hosts: string[]; proxy: string | null; readsDirect: boolean; source: { by: 'you' } | { by: 'task'; taskId: string }; updatedAt: string };
export type SealedSecretChange = { value?: string | null; hosts: string[]; proxy?: string | null; readsDirect?: boolean | null };

/** A problem from background work, newest first. */
export type LogEntry = { at: string; level: 'warn' | 'error'; message: string; detail: string | null; sessionId: string | null };

/** Spending caps in US dollars; null means no cap. */
export type Limits = { dailyUsd: number | null; taskUsd: number | null };
export type Budget = { limits: Limits; today: number; task: number | null; blocked: string | null };
/** Spend this month by one key; `key` is null for a removed repository or spend logged before it was recorded. */
export type SpendRow = { key: string | null; tokens: number; cost: number };
/** One model's spend on one of the last 30 days (`YYYY-MM-DD`, server time); days with nothing spent are left out. */
export type DailySpend = { day: string; model: string | null; tokens: number; cost: number };
/** A plan's use as Anton saw it, priced at API rates; the vendor does not say how much is left, `usagePage` does. */
export type PlanUsage = {
	id: string;
	name: string;
	gateway: string;
	connected: boolean;
	tokens: { today: number; week: number; month: number };
	calls: number;
	/** Null when no API price is known for the plan's models. */
	apiValue: number | null;
	daily: Array<{ day: string; model: string; tokens: number }>;
	limitHitAt: string | null;
	usagePage: string | null;
};

export type UsageView = { since: string; today: number; month: number; byRepo: SpendRow[]; byModel: SpendRow[]; daily: DailySpend[]; plans?: PlanUsage[] };
export type Connection = { id: string; name: string; provider: string; detail: string; state: 'ok' | 'set' | 'off' | 'failing' };
/** One value a connection needs: where it comes from now, and the value itself unless it is a secret, whose last four characters stand in. */
export type SetupField = { env: string; label: string; secret: boolean; optional: boolean; fallback: string | null; source: 'saved' | 'environment' | null; value: string | null; hint: string | null };
export type SetupOption = { id: string; label: string; fields: SetupField[] };
/** A slot of Settings › Connections: `provider` is the one the next start uses; `restart` says it differs from what runs now. */
export type SetupSlot = { id: string; name: string; required: boolean; live: boolean; provider: string | null; restart: boolean; saved: boolean; options: SetupOption[] };
export type SetupView = { slots: SetupSlot[]; plans: string[]; canRunTasks: boolean };
export type SetupInput = { provider: string; values: Record<string, string> };

export type RunningTask = { id: string; title: string; repo: string; createdAt: string };
export type ComputeView = { provider: string; app: string | null; running: RunningTask[]; others: number };
export type SandboxSettings = {
	cpu: number;
	memoryMiB: number;
	idleMinutes: number;
	lifetimeHours: number;
	region: 'us' | 'eu' | 'ap' | null;
	allowedDomains: string[];
	baseImage: string | null;
	warmImageDays: number;
};
export type SandboxView = { settings: SandboxSettings; defaultBaseImage: string; provider: string };
/** How a new task starts when the launcher does not say; null model is the server's default. */
export type GeneralSettings = {
	model: string | null;
	reasoning: Reasoning | null;
	planMode: boolean;
	reviewPullRequests: boolean;
	codeMode: boolean;
	/** How much the agent draws its replies (cards, charts, pages) rather than writing them. */
	visualReplies: 'off' | 'some' | 'more';
	/** Pages the agent writes can call web APIs, through Anton. */
	pageNetwork: boolean;
	imageModel: string | null;
	/** The OpenRouter model that names tasks and routines; null is the server's default. */
	titleModel: string | null;
	titleModelDefault?: string;
	/** Each helper agent's own model; null uses the task's. */
	agentModels: Record<HelperAgent, { model: string; reasoning: Reasoning | null } | null>;
	/** The context in tokens past which a conversation is compacted, if the window has not filled first; null waits for the window. */
	compactAt: 100_000 | 200_000 | 400_000 | null;
	/** The same for Claude Code's models, which run on the plan's limits. */
	claudeCodeCompactAt: 100_000 | 200_000 | 400_000 | null;
	backgroundModels: Record<BackgroundTask, string | null>;
	backgroundReasoning: Record<BackgroundTask, Reasoning | null>;
};
/** Work Anton has a model do behind the agents: reading long web results, seeing the screen, summarizing on compaction. */
export type BackgroundTask = 'webDigest' | 'vision' | 'compaction';

export type HelperAgent = 'explorer' | 'tester' | 'browser' | 'computer' | 'reviewer';
export type Guardrails = { hideSecrets: boolean };
/** Variable names only; values never leave the server. */
export type SecretsView = { shared: string[]; repos: Array<{ projectId: string; repo: string; names: string[] }> };

export type CleanupResult = { at: string; removed: number; freedBytes: number };
export type StorageView = { objects: number; bytes: number; lastCleanup: CleanupResult | null };

export const settingsApi = {
	health: () =>
		json<{ ok: boolean; openRouter: boolean; providers: { sandbox: string; store: string; git: string } }>('/api/health'),
	budget: (sessionId?: string) => json<Budget>(`/api/budget${sessionId ? `?session=${encodeURIComponent(sessionId)}` : ''}`),
	usage: () => json<UsageView>('/api/usage'),
	connections: () => json<{ connections: Connection[] }>('/api/connections'),
	setup: () => json<SetupView>('/api/setup'),
	testSetup: (slot: string, input: SetupInput) => json<{ detail: string }>(`/api/setup/${slot}/test`, { method: 'POST', body: JSON.stringify(input) }),
	saveSetup: (slot: string, input: SetupInput) => json<{ detail: string; restart: boolean }>(`/api/setup/${slot}`, { method: 'PUT', body: JSON.stringify(input) }),
	clearSetup: (slot: string, provider: string) => json<{ ok: true }>(`/api/setup/${slot}?provider=${encodeURIComponent(provider)}`, { method: 'DELETE' }),
	compute: () => json<ComputeView>('/api/compute'),
	sandboxSettings: () => json<SandboxView>('/api/settings/sandbox'),
	saveSandboxSettings: (settings: SandboxSettings) =>
		json<SandboxView>('/api/settings/sandbox', { method: 'PUT', body: JSON.stringify(settings) }),
	generalSettings: () => json<GeneralSettings>('/api/settings/general'),
	backgroundModelDefaults: () => json<{ defaults: Record<BackgroundTask, string | null> }>('/api/settings/background-models'),
	saveGeneralSettings: (settings: GeneralSettings) =>
		json<GeneralSettings>('/api/settings/general', { method: 'PUT', body: JSON.stringify(settings) }),
	guardrails: () => json<Guardrails>('/api/settings/guardrails'),
	saveGuardrails: (guardrails: Guardrails) => json<Guardrails>('/api/settings/guardrails', { method: 'PUT', body: JSON.stringify(guardrails) }),
	secrets: () => json<SecretsView>('/api/secrets'),
	saveSharedEnv: (env: Record<string, string | null>) => json<SecretsView>('/api/secrets/shared', { method: 'PUT', body: JSON.stringify({ env }) }),
	sealedSecrets: () => json<{ secrets: SealedSecret[] }>('/api/secrets/sealed'),
	saveSealedSecret: (name: string, change: SealedSecretChange) =>
		json<{ secrets: SealedSecret[] }>(`/api/secrets/sealed/${encodeURIComponent(name)}`, { method: 'PUT', body: JSON.stringify(change) }),
	deleteSealedSecret: (name: string) => json<{ secrets: SealedSecret[] }>(`/api/secrets/sealed/${encodeURIComponent(name)}`, { method: 'DELETE' }),
	runners: () => json<RunnersView>('/api/runners'),
	stopAllSandboxes: () => post<{ stopped: number }>('/api/compute/stop-all'),
	setLimits: (limits: Limits) => json<Budget>('/api/settings/limits', { method: 'PUT', body: JSON.stringify(limits) }),
	storage: () => json<StorageView>('/api/storage'),
	cleanUpStorage: () => post<CleanupResult>('/api/storage/cleanup'),
	profile: () => json<{ name: string | null }>('/api/profile'),
	logs: () => json<{ logs: LogEntry[] }>('/api/logs'),
};

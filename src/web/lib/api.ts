import type { AgentNow } from '../../core/agent-now';
import type { AttachedFile } from '../../core/attachments';
import type { ModelRoute } from '../../core/model-route';
import type { Schedule } from '../../core/schedule';
export type { ModelRoute, RouteSort } from '../../core/model-route';
export type SessionStatus = 'starting' | 'running' | 'stopped' | 'error';

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

/** One provider a gateway can send a model's calls to, which a task's route can name. */
export type ModelEndpoint = {
	slug: string;
	name: string;
	/** US dollars per million tokens through this provider. */
	price: { input: number; output: number };
	contextLength: number;
	/** Median seconds to the first token, tokens a second and percent of calls answered, recently, where the gateway says. */
	latency: number | null;
	throughput: number | null;
	uptime: number | null;
};

/** A task's model and reasoning level; null reasoning runs the model's default. */
export type ModelChoice = { model: string; reasoning: Reasoning | null };

export type Session = {
	id: string;
	/** The repository the task works on; null for a chat, which has none. */
	projectId: string | null;
	/** `owner/name`; empty for a chat. */
	repo: string;
	title: string;
	model: string;
	reasoning: Reasoning | null;
	/** Where the gateway sends the task's calls: one provider first, or a sort; null leaves it to the gateway. Missing from older servers. */
	route?: ModelRoute | null;
	branch: string;
	baseBranch: string;
	baseSha: string;
	status: SessionStatus;
	/** The agent is working on a message right now. */
	working: boolean;
	/** The task has had a machine; until then it reads the repo without a sandbox, clone or branch. */
	workspace: boolean;
	/** The agent proposes a plan and changes nothing until it is approved. */
	planMode: boolean;
	prUrl: string | null;
	errorMessage: string | null;
	checkpointAt: string | null;
	createdAt: string;
	/** When the task was pinned to the top of the sidebar; null when it is not. */
	pinnedAt: string | null;
	/** Its pull request as last read from GitHub; `checks` sums up the head commit's checks. */
	pullRequest: {
		state: 'open' | 'draft' | 'merged' | 'closed';
		checks: 'passed' | 'failed' | 'pending' | null;
		runs: Array<{ name: string; status: 'pending' | 'passed' | 'failed'; url: string }>;
		/** Approved on GitHub and not changed since. */
		approved?: boolean;
		/** It cannot merge until its conflicts with the base branch are resolved. */
		conflicts?: boolean;
	} | null;
	/** Model tokens and cost (US dollars) across every finished response. */
	usage: Usage;
	/** The latest message the task was given (by you, a follow-up or an automation), and when; null for tasks from before Anton kept it. */
	lastInput?: string | null;
	lastInputAt?: string | null;
	/** What the agent's last reply asks you, until you send a message. */
	asking?: string | null;
	/** The plan the agent's last reply proposed in plan mode, waiting for your approval. */
	plan?: string | null;
	/** The project the task is a thread of; null for a task of its own. */
	spaceId?: string | null;
	/** Where the task stands, the same for a project's thread and a task of its own (src/core/thread-state.ts). */
	threadState?: ThreadState | null;
	/** When the task was marked done. */
	resolvedAt?: string | null;
	/** The brief a queued thread starts with once a slot frees. */
	brief?: string | null;
	/** The start of the thread's latest reply. */
	lastReply?: string | null;
	/** Someone else's pull request (`prUrl`) the task reviews; null for a task doing its own work. */
	review?: { number: number; author: string; trusted: boolean; reviewedHead: string | null; automatic: boolean } | null;
	/** The routine that started the task; null for one started by you or the coordinator. */
	automationId?: string | null;
};

/** Where a task stands, in the order a project lists its threads (src/core/thread-state.ts). */
export const THREAD_STATES = ['waiting', 'working', 'queued', 'review', 'landing', 'idle', 'resolved'] as const;
export type ThreadState = (typeof THREAD_STATES)[number];

export type Autonomy = 'start' | 'propose';
export type SpaceState = 'active' | 'paused' | 'archived';

/** A project: a coordinator conversation over parallel threads, each a task on one of its repositories. */
export type Space = {
	id: string;
	name: string;
	icon: string | null;
	goal: string;
	instructions: string;
	memory: string;
	coordinatorModel: string | null;
	coordinatorReasoning: Reasoning | null;
	threadModel: string | null;
	threadReasoning: Reasoning | null;
	maxParallel: number;
	autonomy: Autonomy;
	state: SpaceState;
	repoIds: string[];
	repos: Array<{ id: string; repoFullName: string; defaultBranch: string }>;
	counts: Record<ThreadState, number>;
	threads: number;
	activeAt: string;
	createdAt: string;
	updatedAt: string;
};

export type SpaceInput = { name: string; icon?: string | null; goal?: string; repoIds?: string[]; instructions?: string; autonomy?: Autonomy; maxParallel?: number };
export type SpaceChange = Partial<
	Pick<Space, 'name' | 'icon' | 'goal' | 'instructions' | 'memory' | 'coordinatorModel' | 'coordinatorReasoning' | 'threadModel' | 'threadReasoning' | 'maxParallel' | 'autonomy' | 'state' | 'repoIds'>
>;
/** `projectId` null starts a thread with no repository, a chat. */
export type ThreadInput = { title?: string; brief: string; projectId?: string | null; repo?: string; model?: string; reasoning?: Reasoning; planMode?: boolean };
export type SpaceFile = { path: string; size: number; modifiedAt: string };
export type SpaceUsage = {
	today: number;
	month: number;
	byThread: Array<{ id: string; title: string; tokens: number; cost: number }>;
	byModel: Array<{ key: string | null; tokens: number; cost: number }>;
	daily: Array<{ day: string; tokens: number; cost: number }>;
};

/** `inputTokens` counts every input token, cached ones too; `cachedTokens` is the part read from the provider's cache. */
export type Usage = { inputTokens: number; outputTokens: number; cost: number; cachedTokens?: number };
/** One side of a reply's usage, the agent's own calls or its subagents', as the reply's metadata carries it. */
export type UsagePart = Usage & { calls: number };

/** A problem from background work, newest first. */
export type LogEntry = { at: string; level: 'warn' | 'error'; message: string; detail: string | null; sessionId: string | null };

/** A saved prompt, typed as `/name` in the composer. */
export type Command = { name: string; prompt: string };

/** Where a plugin lives on GitHub; a null ref is the repository's default branch. */
export type PluginSource = { repo: string; path: string; ref: string | null };

/** An installed plugin: skills every task's agent can use, kept as they were when installed. */
export type Plugin = {
	id: string;
	name: string;
	description: string;
	source: PluginSource;
	sha: string;
	marketplace: string | null;
	/** A skill is inactive when its plugin is off, or an earlier plugin has a skill by that name. */
	skills: Array<{ name: string; description: string; active: boolean }>;
	/** MCP servers the plugin declares; Anton does not run them. */
	mcpServers: string[];
	skipped: string[];
	enabled: boolean;
	installedAt: string;
	/** Where it was installed from, so it can be installed again to update it. */
	pick: PluginPick | null;
};

/** What to install or look at: a marketplace's plugin, a GitHub address, or an installed plugin by its id. */
export type PluginPick = { marketplace: string; name: string } | { address: string } | { plugin: string };

/** A plugin as installing it would save it, with every file in its folder. */
export type PluginPreview = {
	id: string;
	name: string;
	description: string;
	/** Its repository and folder, at the commit shown. */
	source: PluginSource;
	sha: string;
	marketplace: string | null;
	pick: PluginPick;
	skills: Array<{ name: string; description: string; folder: string; license: string | null }>;
	mcpServers: string[];
	skipped: string[];
	files: string[];
	truncated: boolean;
	readme: string | null;
	installed: { sha: string; enabled: boolean } | null;
	/** A newer commit of an installed plugin. */
	update: string | null;
};

export type GitHubSkill = { address: string; repo: string; name: string; description: string };
export type GitHubRepo = { address: string; description: string; stars: number };
export type GitHubSearch = { skills: GitHubSkill[]; repos: GitHubRepo[]; problems: string[] };

export type CatalogItem = { id: string; name: string; description: string; source: PluginSource; skills: string[] | null; bundle?: string; browseable?: boolean; installed: boolean };

export type SkillSummary = { name: string; description: string };

/** One distinct state of the task's files, newest first in the timeline. */
export type CheckpointSummary = { at: string; files: number; added: number | null; removed: number | null; commit: string | null };

/** How a server's OAuth sign-in stands; `clientId` is a client you pasted for a server that lets no app register itself. */
export type McpSignIn = { state: 'signed-in' | 'needed' | 'none'; since: string | null; problem: string | null; clientId: string | null; pastedClient: boolean };
/**
 * An MCP server, on or off for every task; the agent finds and calls its tools on demand. Its token is never sent
 * back, only whether it has one. `codeMode: false` keeps run_script's programs from calling it.
 */
export type McpServer = { name: string; url: string; tools: string[]; hasAuth: boolean; signIn: McpSignIn; codeMode?: boolean; enabled: boolean; addedAt: string };
/** A server as saved: a token left null keeps the stored one, and an empty one removes it. */
export type McpServerInput = { name: string; url: string; tools: string[]; codeMode?: boolean; auth?: string | null };

/** An account the agent's tools reach (Google), signed in to on your own OAuth client; its secret and tokens never leave the server. */
export type ConnectorAccount = {
	id: string;
	name: string;
	client: { clientId: string; fromEnv: boolean } | null;
	email: string | null;
	connectedAt: string | null;
	scopes: string[];
	problem: string | null;
	/** Where the vendor sends the browser back, on Anton's own address. */
	callbackPath: string;
};
export type MailboxOptions = { enabled: boolean; draft: boolean; send: boolean };
/** A mailbox on an account (Gmail), on or off for every task (`options.enabled`); `access` is what the agent may do now, null when it is off or not connected. */
export type ConnectorMailbox = {
	id: string;
	name: string;
	account: string;
	options: MailboxOptions;
	canDraft: boolean;
	access: { read: true; draft: boolean; send: boolean } | null;
};
export type ConnectorsView = { accounts: ConnectorAccount[]; mailboxes: ConnectorMailbox[]; mcpServers: McpServer[] };
/** An email the agent asked to send, waiting for your Send in the thread or already decided. */
export type MailApproval = {
	id: string;
	connector: string;
	draftId: string;
	to: string[];
	cc: string[];
	bcc: string[];
	subject: string;
	body: string;
	state: 'pending' | 'sending' | 'sent' | 'declined' | 'changed';
	decidedAt: string | null;
};

/** Repo settings every new sandbox for it gets. Variable values never leave the server, only their names. */
export type ProjectSettings = {
	envKeys: string[];
	setupScript: string;
	previewPorts: number[];
	baseImage: string | null;
	/** Whether the agent hears about failed checks, merge conflicts and new comments on its pull requests. */
	followUps: boolean;
	/** Whether Anton reviews the pull requests people open on the repo, and again after their pushes. */
	reviewOthers: boolean;
	/** Tasks run in a full virtual machine (Docker, FUSE, their own kernel) rather than a container. */
	fullVm: boolean;
};

export type Project = {
	id: string;
	repoFullName: string;
	defaultBranch: string;
	/** Notes every task's agent reads, one per line. */
	memory: string;
	/** When the image new tasks start from (repo cloned, dependencies installed) was built; null when there is none. */
	warmedAt: string | null;
} & ProjectSettings;

/** A settings save: a variable set to null keeps its stored value and one left out is removed. */
export type SettingsChange = Omit<ProjectSettings, 'envKeys'> & {
	env: Record<string, string | null>;
};

/** A way tasks start on their own: from issues with a label, or on a schedule. */
export type Automation = {
	id: string;
	projectId: string;
	kind: 'issues' | 'schedule';
	label: string | null;
	/** When it runs (kind `schedule`), on its time zone's clock. */
	schedule: Schedule | null;
	/** When a schedule runs next; null until the server works it out. */
	nextRunAt: string | null;
	prompt: string;
	model: string | null;
	reasoning: Reasoning | null;
	/** Its tasks start in plan mode and wait for approval. */
	planFirst: boolean;
	enabled: boolean;
	lastRunAt: string | null;
	lastError: string | null;
	seen: number[];
	/** The project its tasks start in, as threads. */
	spaceId?: string | null;
	createdAt: string;
};

export type AutomationInput = Pick<Automation, 'kind' | 'label' | 'schedule' | 'prompt' | 'model' | 'reasoning' | 'planFirst'> & { spaceId?: string | null };

/** Where a view's data came from: the running machine, the last checkpoint, or the starting commit. */
export type Source = 'live' | 'saved' | 'base';

export type FileChange = { path: string; status: 'A' | 'M' | 'D' };

export type FilesPayload = { source: Source; at: string | null; paths: string[]; changes: FileChange[] };

export type ChangesPayload = {
	source: Source;
	at: string | null;
	branch: string;
	baseBranch: string;
	patch: string;
	log: Array<{ sha: string; subject: string; at: string }>;
};

export type PullRequest = { url: string; state: 'open' | 'draft' | 'merged' | 'closed' | null };

export type Preview = { port: number; url: string | null; listening: boolean };
export type PreviewsPayload = { live: boolean; previews: Preview[] };

/** Spending caps in US dollars; null means no cap. */
export type Limits = { dailyUsd: number | null; taskUsd: number | null };
export type Budget = { limits: Limits; today: number; task: number | null; blocked: string | null };
/** Spend this month by one key; `key` is null for a removed repository or spend logged before it was recorded. */
export type SpendRow = { key: string | null; tokens: number; cost: number };
/** One model's spend on one of the last 30 days (`YYYY-MM-DD`, server time); days with nothing spent are left out. */
export type DailySpend = { day: string; model: string | null; tokens: number; cost: number };
/**
 * A plan's use as Anton saw it: tokens and calls on its models, and what they would have cost at API prices.
 * The vendor does not say how much of the plan is left; `usagePage` is where it shows that.
 */
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
/** The parts of a task's context window, as the last model call measured them. */
export type ContextPart = 'messages' | 'tools' | 'systemPrompt' | 'skills' | 'mcpTools';
export type ContextView = {
	model: string | null;
	window: number;
	used: number;
	/** Where the agent compacts older turns: the window less room kept for the next reply. */
	autocompactAt: number;
	parts: Array<{ key: ContextPart; tokens: number }>;
	at: string | null;
	/** Every model call the task made and the tokens they processed in all; each call re-reads the conversation, so this outgrows `used`. */
	task?: { calls: number; tokens: number };
};
export type UsageView = { since: string; today: number; month: number; byRepo: SpendRow[]; byModel: SpendRow[]; daily: DailySpend[]; plans?: PlanUsage[] };
export type Connection = { id: string; name: string; provider: string; detail: string; state: 'ok' | 'set' | 'off' | 'failing' };
/** `enabled` offers the plan's models in the picker; `countAtApiPrices` counts their calls toward the caps at API prices. */
export type SubscriptionOptions = { enabled: boolean; countAtApiPrices: boolean };
/** A plan you can sign in to; the sign-in itself never leaves the server. */
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
	/** When the current access token lapses; Anton renews it a few minutes before. */
	expiresAt: string | null;
	options: SubscriptionOptions;
	/** The account's models, each with the tokens it used on the plan this month. */
	/** `options` names the model's larger context and fast mode ("1M", "Fast"), whose tokens count toward it. */
	/** A gateway's models also carry their vendor and price per million tokens. */
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
};
/** One of a plan's own limits as the vendor reports it: five hours, a week, a month. */
export type PlanWindow = { label: string; usedPercent: number; resetsAt: string | null; limited: boolean };
export type RunningTask = { id: string; title: string; repo: string; createdAt: string };
export type ComputeView = { provider: string; app: string | null; running: RunningTask[]; others: number };
/** What every new sandbox gets; see Settings › Sandboxes and Images. */
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
	/** The model generate_image draws with; null is the server's default. */
	imageModel: string | null;
	/** Each helper agent's own model; null uses the task's. */
	agentModels: Record<HelperAgent, { model: string; reasoning: Reasoning | null } | null>;
};
/** A model the agent's generate_image tool can draw with. */
export type ImageModelInfo = { id: string; name: string; vendor: string; description: string; references: number; aspectRatios: string[]; transparent: boolean };
export type HelperAgent = 'explorer' | 'tester' | 'browser' | 'computer' | 'reviewer';
export type Guardrails = { hideSecrets: boolean };
/** Variable names only; values never leave the server. */
export type SecretsView = { shared: string[]; repos: Array<{ projectId: string; repo: string; names: string[] }> };
/** A pull request the agent opened or reviews, grouped by who it waits on. */
export type ReviewGroup = 'failing' | 'checking' | 'ready' | 'merged' | 'closed' | 'unknown';
export type ReviewItem = {
	sessionId: string;
	title: string;
	repo: string;
	url: string;
	group: ReviewGroup;
	draft: boolean;
	/** Someone else's pull request, which the task reviews; its author's login. */
	reviewing: string | null;
	conflicts: boolean;
	checks: { passed: number; failed: number; pending: number };
	comments: number;
	createdAt: string;
};
export type CleanupResult = { at: string; removed: number; freedBytes: number };
export type StorageView = { objects: number; bytes: number; lastCleanup: CleanupResult | null };

export type BrowserPage = { url: string; title: string; canGoBack: boolean; canGoForward: boolean };
export type BrowserView = {
	/** False until KERNEL_API_KEY is set. */
	available: boolean;
	browser: {
		liveViewUrl: string;
		viewport: { width: number; height: number };
		openedAt: string;
		page: BrowserPage | null;
		/** The agent is acting in this browser, or did a moment ago. */
		agentBusy: boolean;
		/** Why the agent stopped for you here (a sign-in or a human check), until the page moves on. */
		needsYou: string | null;
	} | null;
};
/** The desktop inside the task's sandbox, as the Computer panel shows it. */
export type ComputerView = {
	/** The task's sandbox runs. */
	live: boolean;
	/** Its desktop runs. */
	running: boolean;
	screen: { width: number; height: number };
	/** The agent is using the computer, or did a moment ago. */
	agentBusy: boolean;
	/** You took over: the agent's steps wait until you hand it back. */
	userControl: boolean;
};

/** The view with a short-lived address to connect to. */
export type ComputerConnection = ComputerView & { url: string };

/** An element picked in the Browser panel, as the page described it. */
export type PickedElement = {
	tag: string;
	selector: string;
	text: string;
	html: string;
	rect: { x: number; y: number; width: number; height: number };
	styles: Record<string, string>;
	components: Array<{ name: string; source: string | null }>;
	url: string;
	title: string;
	/** PNG, base64. */
	image: string | null;
};

/** One tool call a subagent made, as the Agents panel shows it. */
/** What a browser step the decision model drove did inside it: each action, how sure the model was, and what it cost. */
/** One call a run_script program made, as the thread lists it. */
export type ScriptCall = { tool: string; input: string; state: 'running' | 'done' | 'failed'; durationMs: number | null };
export type StepDetail = { outcome: string | null; actions: Array<{ what: string; p: number | null; failed?: boolean }>; decisions: number; cost: number; script?: boolean };
export type SubagentStep = { id: string; tool: string; input: unknown; state: 'running' | 'done' | 'failed'; at: string; durationMs: number | null; detail?: StepDetail };
/** One piece of work the agent handed to a subagent: its brief, steps, use, and answer. */
/** The agent's latest todo list for a task (src/services/todos.ts); each one it writes replaces the last. */
export type TodoStatus = 'pending' | 'in_progress' | 'completed';
export type Todo = { content: string; status: TodoStatus };
export type TodoList = { todos: Todo[]; updatedAt: string };

/** Where the agent read a message sent while it worked: after which tool call of its reply, and whether the reply had already said its last words (src/services/joins.ts). */
export type Join = { text: string; afterTool: string; final: boolean; at: string };
/** What the agent is doing this moment (src/services/agent-now.ts). */
export type { AgentNow };

export type SubagentRun = {
	id: string;
	agent: string;
	prompt: string;
	description: string | null;
	toolCallId: string | null;
	/** Stopped: the user stopped it, alone or with the whole reply. */
	status: 'running' | 'done' | 'failed' | 'stopped';
	startedAt: string;
	durationMs: number | null;
	model: string | null;
	tokens: number;
	calls: number;
	steps: SubagentStep[];
	writing: string | null;
	result: string | null;
};

/** A device that gets notifications with no Anton tab open (src/services/push.ts). */
export type PushDevice = { id: string; name: string; addedAt: string; lastSentAt: string | null; lastError: string | null };
/** `publicKey` is empty when the server cannot send notifications. */
export type PushView = { publicKey: string; devices: PushDevice[]; finished: boolean };
export type PushSubscriptionJson = { endpoint: string; keys: { p256dh: string; auth: string } };

export type Output = { path: string; size: number; mtimeMs: number };
/** Something the agent made in a task, for the Artifacts page (src/services/artifacts.ts). */
export type Artifact = Output & { sessionId: string; title: string; task: { title: string; spaceId: string | null; chat: boolean } };
export type OutputsPayload = { source: Source; at: string | null; outputs: Output[]; /** Files you deleted from the Library, which replies show as deleted. */ deleted: string[] };

async function request(input: string, init?: RequestInit): Promise<Response> {
	const response = await fetch(input, {
		...init,
		headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
	});
	if (!response.ok) {
		const body = await response.text();
		const message = (() => {
			try {
				return (JSON.parse(body) as { error?: string }).error;
			} catch {
				return undefined;
			}
		})();
		throw new Error(message || body || response.statusText);
	}
	return response;
}

const json = async <T,>(input: string, init?: RequestInit) => (await request(input, init)).json() as Promise<T>;
const post = <T,>(input: string, body?: unknown) => json<T>(input, { method: 'POST', body: JSON.stringify(body ?? {}) });

export const outputUrl = (id: string, path: string) => `/api/sessions/${id}/output?path=${encodeURIComponent(path)}`;

export const api = {
	health: () =>
		json<{ ok: boolean; openRouter: boolean; providers: { sandbox: string; store: string; git: string } }>('/api/health'),
	budget: (sessionId?: string) => json<Budget>(`/api/budget${sessionId ? `?session=${encodeURIComponent(sessionId)}` : ''}`),
	usage: () => json<UsageView>('/api/usage'),
	connections: () => json<{ connections: Connection[] }>('/api/connections'),
	compute: () => json<ComputeView>('/api/compute'),
	sandboxSettings: () => json<SandboxView>('/api/settings/sandbox'),
	saveSandboxSettings: (settings: SandboxSettings) =>
		json<SandboxView>('/api/settings/sandbox', { method: 'PUT', body: JSON.stringify(settings) }),
	rebuildPreparedImage: (projectId: string) => post<Project>(`/api/projects/${projectId}/prepared-image/rebuild`),
	generalSettings: () => json<GeneralSettings>('/api/settings/general'),
	saveGeneralSettings: (settings: GeneralSettings) =>
		json<GeneralSettings>('/api/settings/general', { method: 'PUT', body: JSON.stringify(settings) }),
	push: () => json<PushView>('/api/push'),
	addPushDevice: (subscription: PushSubscriptionJson & { name: string }) => post<PushView>('/api/push/devices', subscription),
	removePushDevice: (id: string) => json<PushView>(`/api/push/devices/${encodeURIComponent(id)}`, { method: 'DELETE' }),
	testPush: (device?: string) => post<{ sent: number }>('/api/push/test', device ? { device } : {}),
	savePushOptions: (options: { finished: boolean }) => json<PushView>('/api/push/options', { method: 'PUT', body: JSON.stringify(options) }),
	guardrails: () => json<Guardrails>('/api/settings/guardrails'),
	saveGuardrails: (guardrails: Guardrails) => json<Guardrails>('/api/settings/guardrails', { method: 'PUT', body: JSON.stringify(guardrails) }),
	secrets: () => json<SecretsView>('/api/secrets'),
	saveSharedEnv: (env: Record<string, string | null>) => json<SecretsView>('/api/secrets/shared', { method: 'PUT', body: JSON.stringify({ env }) }),
	reviews: () => json<{ reviews: ReviewItem[] }>('/api/reviews'),
	reviewAnyPullRequest: (url: string) => post<Session>('/api/reviews', { url }),
	stopAllSandboxes: () => post<{ stopped: number }>('/api/compute/stop-all'),
	setLimits: (limits: Limits) => json<Budget>('/api/settings/limits', { method: 'PUT', body: JSON.stringify(limits) }),
	storage: () => json<StorageView>('/api/storage'),
	cleanUpStorage: () => post<CleanupResult>('/api/storage/cleanup'),
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
	connectors: () => json<ConnectorsView>('/api/connectors'),
	setConnectorClient: (account: string, client: { clientId: string; clientSecret: string | null }) =>
		json<Omit<ConnectorsView, 'mcpServers'>>(`/api/connectors/accounts/${account}/client`, { method: 'PUT', body: JSON.stringify(client) }),
	disconnectAccount: (account: string) => json<Omit<ConnectorsView, 'mcpServers'>>(`/api/connectors/accounts/${account}`, { method: 'DELETE' }),
	/** The vendor's consent page, which comes back to Anton and then to Settings › Connectors. */
	connectMailbox: (id: string, access: 'read' | 'draft') => post<{ url: string }>(`/api/connectors/mailboxes/${id}/connect`, { origin: window.location.origin, access }),
	setMailboxOptions: (id: string, options: MailboxOptions) =>
		json<Omit<ConnectorsView, 'mcpServers'>>(`/api/connectors/mailboxes/${id}`, { method: 'PUT', body: JSON.stringify(options) }),
	addMcpServer: (server: McpServerInput) => post<{ mcpServers: McpServer[] }>('/api/mcp-servers', server),
	updateMcpServer: ({ name, ...server }: McpServerInput) =>
		json<{ mcpServers: McpServer[] }>(`/api/mcp-servers/${encodeURIComponent(name)}`, { method: 'PUT', body: JSON.stringify(server) }),
	setMcpServerEnabled: (name: string, enabled: boolean) =>
		json<{ mcpServers: McpServer[] }>(`/api/mcp-servers/${encodeURIComponent(name)}`, { method: 'PATCH', body: JSON.stringify({ enabled }) }),
	removeMcpServer: (name: string) => json<{ mcpServers: McpServer[] }>(`/api/mcp-servers/${encodeURIComponent(name)}`, { method: 'DELETE' }),
	mcpServerTools: (name: string) => json<{ tools: Array<{ name: string; description?: string }> }>(`/api/mcp-servers/${encodeURIComponent(name)}/tools`),
	/** Starts a server's sign-in: the address to send the browser to, or null when it signed in without one. */
	signInMcpServer: (name: string, client?: { clientId: string; clientSecret: string | null } | null) =>
		post<{ url: string | null; mcpServers: McpServer[] }>(`/api/mcp-servers/${encodeURIComponent(name)}/sign-in`, { origin: window.location.origin, client: client ?? null }),
	signOutMcpServer: (name: string) => json<{ mcpServers: McpServer[] }>(`/api/mcp-servers/${encodeURIComponent(name)}/sign-in`, { method: 'DELETE' }),
	mailApprovals: (sessionId: string) => json<{ approvals: MailApproval[] }>(`/api/sessions/${sessionId}/mail`),
	decideMail: (sessionId: string, approval: string, send: boolean) => post<MailApproval>(`/api/sessions/${sessionId}/mail/${approval}`, { send }),
	profile: () => json<{ name: string | null }>('/api/profile'),
	projects: () => json<{ projects: Project[] }>('/api/projects'),
	addableRepos: () => json<{ repos: string[] }>('/api/repos'),
	addProject: (repo: string) => post<Project>('/api/projects', { repo }),
	removeProject: async (id: string) => void (await request(`/api/projects/${id}`, { method: 'DELETE' })),
	logs: () => json<{ logs: LogEntry[] }>('/api/logs'),
	plugins: () => json<{ plugins: Plugin[]; marketplaces: string[] }>('/api/plugins'),
	saveMarketplaces: (marketplaces: string[]) =>
		json<{ marketplaces: string[] }>('/api/settings/marketplaces', { method: 'PUT', body: JSON.stringify({ marketplaces }) }),
	catalog: (repo: string, bundle?: string) => json<{ entries: CatalogItem[] }>(`/api/marketplaces/catalog?repo=${encodeURIComponent(repo)}${bundle ? `&bundle=${encodeURIComponent(bundle)}` : ''}`),
	installPlugin: (input: PluginPick) => post<{ plugins: Plugin[] }>('/api/plugins', input),
	previewPlugin: (pick: PluginPick) => json<PluginPreview>(`/api/plugins/preview?${new URLSearchParams(pick)}`),
	pluginFile: async (repo: string, sha: string, path: string) =>
		new Uint8Array(await (await request(`/api/plugins/file?${new URLSearchParams({ repo, sha, path })}`)).arrayBuffer()),
	searchGitHub: (q: string, signal?: AbortSignal) => json<GitHubSearch>(`/api/skills/search?q=${encodeURIComponent(q)}`, { signal }),
	setPluginEnabled: (id: string, enabled: boolean) =>
		json<{ plugins: Plugin[] }>(`/api/plugins/${id}`, { method: 'PATCH', body: JSON.stringify({ enabled }) }),
	removePlugin: (id: string) => json<{ plugins: Plugin[] }>(`/api/plugins/${id}`, { method: 'DELETE' }),
	sessionSkills: (id: string) => json<{ skills: SkillSummary[] }>(`/api/sessions/${id}/skills`),
	commands: () => json<{ commands: Command[] }>('/api/settings/commands'),
	saveCommands: (commands: Command[]) =>
		json<{ commands: Command[] }>('/api/settings/commands', { method: 'PUT', body: JSON.stringify({ commands }) }),
	saveMemory: (id: string, memory: string) =>
		json<{ memory: string }>(`/api/projects/${id}/memory`, { method: 'PUT', body: JSON.stringify({ memory }) }),
	updateProjectSettings: (id: string, change: SettingsChange) =>
		json<Project>(`/api/projects/${id}/settings`, { method: 'PUT', body: JSON.stringify(change) }),
	automations: (projectId: string) => json<{ automations: Automation[] }>(`/api/projects/${projectId}/automations`),
	addAutomation: (projectId: string, input: AutomationInput) => post<Automation>(`/api/projects/${projectId}/automations`, input),
	setAutomationEnabled: (id: string, enabled: boolean) =>
		json<Automation>(`/api/automations/${id}`, { method: 'PATCH', body: JSON.stringify({ enabled }) }),
	/** Changes what an automation does; `projectId` picks a project routine's repository (null for chats). */
	editAutomation: (id: string, input: Omit<AutomationInput, 'spaceId'> & { projectId?: string | null }) =>
		json<Automation>(`/api/automations/${id}`, { method: 'PUT', body: JSON.stringify(input) }),
	runAutomation: (id: string) => post<Automation>(`/api/automations/${id}/run`),
	deleteAutomation: async (id: string) => void (await request(`/api/automations/${id}`, { method: 'DELETE' })),
	branches: (projectId: string) => json<{ branches: string[] }>(`/api/projects/${projectId}/branches`),
	projectFiles: (projectId: string, branch?: string) =>
		json<{ paths: string[] }>(`/api/projects/${projectId}/files${branch ? `?branch=${encodeURIComponent(branch)}` : ''}`),
	sessions: () => json<{ sessions: Session[] }>('/api/sessions'),
	/** `titleFrom` is the first message: a fast model names the task from it in a moment, in place of `title`. */
	createSession: (body: { projectId?: string; branch?: string; title?: string; titleFrom?: string; model?: string; reasoning?: Reasoning; route?: ModelRoute | null; planMode?: boolean }) =>
		post<Session>('/api/sessions', body),
	session: (id: string) => json<Session>(`/api/sessions/${id}`),
	stopSession: (id: string) => post<Session>(`/api/sessions/${id}/stop`),
	resumeSession: (id: string) => post<Session>(`/api/sessions/${id}/resume`),
	forkSession: (id: string) => post<Session>(`/api/sessions/${id}/fork`),
	editSession: (id: string, change: Partial<ModelChoice> & { route?: ModelRoute | null; title?: string; planMode?: boolean; pinned?: boolean; resolved?: boolean; spaceId?: string | null }) =>
		json<Session>(`/api/sessions/${id}`, { method: 'PATCH', body: JSON.stringify(change) }),
	deleteSession: async (id: string) => void (await request(`/api/sessions/${id}`, { method: 'DELETE' })),
	checkpoints: (id: string) => json<{ checkpoints: CheckpointSummary[] }>(`/api/sessions/${id}/checkpoints`),
	checkpoint: (id: string, at: string) => json<{ at: string; patch: string | null }>(`/api/sessions/${id}/checkpoints/${encodeURIComponent(at)}`),
	revertFile: async (id: string, path: string) => void (await post(`/api/sessions/${id}/revert`, { path })),
	restoreCheckpoint: (id: string, at: string) =>
		post<{ at: string; skipped: string[] }>(`/api/sessions/${id}/checkpoints/${encodeURIComponent(at)}/restore`),
	previews: (id: string) => json<PreviewsPayload>(`/api/sessions/${id}/previews`),
	context: (id: string) => json<ContextView>(`/api/sessions/${id}/context`),
	subagents: (id: string) => json<{ runs: SubagentRun[] }>(`/api/sessions/${id}/subagents`),
	/** Stops one running subagent; the agent is told what it had done and carries on. */
	stopSubagent: async (id: string, runId: string) => void (await post(`/api/sessions/${id}/subagents/${encodeURIComponent(runId)}/stop`)),
	scripts: (id: string) => json<{ scripts: Record<string, ScriptCall[]> }>(`/api/sessions/${id}/scripts`),
	todos: (id: string) => json<{ list: TodoList | null }>(`/api/sessions/${id}/todos`),
	joins: (id: string) => json<{ joins: Join[] }>(`/api/sessions/${id}/joins`),
	now: (id: string) => json<{ now: AgentNow | null }>(`/api/sessions/${id}/now`),
	browser: (id: string) => json<BrowserView>(`/api/sessions/${id}/browser`),
	openBrowser: (id: string, url?: string) => post<BrowserView>(`/api/sessions/${id}/browser`, { url }),
	closeBrowser: async (id: string) => void (await request(`/api/sessions/${id}/browser`, { method: 'DELETE' })),
	navigateBrowser: (id: string, to: { url: string } | { action: 'back' | 'forward' | 'reload' }) => post<BrowserPage>(`/api/sessions/${id}/browser/navigate`, to),
	inspectBrowser: (id: string, point: { x: number; y: number; pick: boolean }) =>
		post<{ element: PickedElement | null }>(`/api/sessions/${id}/browser/inspect`, point),
	clearBrowserHighlight: async (id: string) => void (await post(`/api/sessions/${id}/browser/highlight/clear`)),
	browserScreenshot: (id: string) => post<{ data: string; width: number; height: number }>(`/api/sessions/${id}/browser/screenshot`),
	watchBrowser: (id: string) => post<BrowserView>(`/api/sessions/${id}/browser/watch`),
	computer: (id: string) => json<ComputerView>(`/api/sessions/${id}/computer`),
	/** Starts the sandbox if it is not running, then its desktop. */
	startComputer: (id: string) => post<ComputerConnection>(`/api/sessions/${id}/computer`),
	connectComputer: (id: string) => post<ComputerConnection>(`/api/sessions/${id}/computer/connect`),
	stopComputer: (id: string) => post<ComputerView>(`/api/sessions/${id}/computer/stop`),
	setComputerControl: (id: string, driver: 'user' | 'agent') => post<ComputerView>(`/api/sessions/${id}/computer/control`, { driver }),
	computerScreenshot: (id: string) => post<{ data: string; width: number; height: number }>(`/api/sessions/${id}/computer/screenshot`),
	pullRequest: (id: string) => json<PullRequest | null>(`/api/sessions/${id}/pull-request`),
	reviewPullRequest: (id: string) => post<{ started: boolean }>(`/api/sessions/${id}/review`),
	/** Stops the agent's current turn and anything queued behind it. */
	stopAgent: async (id: string) => void (await request(`/api/agents/coder/${id}/abort`, { method: 'POST' })),
	changes: (id: string) => json<ChangesPayload>(`/api/sessions/${id}/changes`),
	files: (id: string) => json<FilesPayload>(`/api/sessions/${id}/files`),
	file: async (id: string, path: string) =>
		new Uint8Array(await (await request(`/api/sessions/${id}/file?path=${encodeURIComponent(path)}`)).arrayBuffer()),
	outputs: (id: string) => json<OutputsPayload>(`/api/sessions/${id}/outputs`),
	artifacts: () => json<{ artifacts: Artifact[] }>('/api/artifacts'),
	outputText: async (id: string, path: string) => (await request(outputUrl(id, path))).text(),
	/** Adds a file to the task's Library, under uploads/. */
	uploadOutput: (id: string, file: File) =>
		json<{ path: string }>(`/api/sessions/${id}/outputs?name=${encodeURIComponent(file.name)}`, {
			method: 'POST',
			body: file,
			headers: { 'Content-Type': file.type || 'application/octet-stream' },
		}),
	/** A file attached to a message: saved to the task's Library and read as text for the message. */
	attachToTask: (id: string, file: File) =>
		json<AttachedFile>(`/api/sessions/${id}/attachments?name=${encodeURIComponent(file.name)}`, {
			method: 'POST',
			body: file,
			headers: { 'Content-Type': file.type || 'application/octet-stream' },
		}),
	deleteOutput: async (id: string, path: string) => void (await request(outputUrl(id, path), { method: 'DELETE' })),
	spaces: () => json<{ spaces: Space[] }>('/api/spaces'),
	space: (id: string) => json<Space>(`/api/spaces/${id}`),
	createSpace: (input: SpaceInput) => post<Space>('/api/spaces', input),
	editSpace: (id: string, change: SpaceChange) => json<Space>(`/api/spaces/${id}`, { method: 'PATCH', body: JSON.stringify(change) }),
	deleteSpace: async (id: string) => void (await request(`/api/spaces/${id}`, { method: 'DELETE' })),
	startThread: (id: string, input: ThreadInput) => post<Session>(`/api/spaces/${id}/threads`, input),
	nudgeThread: (id: string, threadId: string, text: string) => post<Session>(`/api/spaces/${id}/threads/${threadId}/nudge`, { text }),
	spaceUsage: (id: string) => json<SpaceUsage>(`/api/spaces/${id}/usage`),
	spaceAutomations: (id: string) => json<{ automations: Automation[] }>(`/api/spaces/${id}/automations`),
	/** A routine of the project: on one of its repositories, or with `projectId` null on none, starting chats. */
	addSpaceAutomation: (id: string, input: AutomationInput & { projectId: string | null }) => post<Automation>(`/api/spaces/${id}/automations`, input),
	spaceFiles: (id: string) => json<{ files: SpaceFile[] }>(`/api/spaces/${id}/files`),
	uploadSpaceFile: (id: string, file: File) =>
		json<SpaceFile>(`/api/spaces/${id}/files?name=${encodeURIComponent(file.name)}`, {
			method: 'POST',
			body: file,
			headers: { 'Content-Type': file.type || 'application/octet-stream' },
		}),
	/** A file attached to a message to the coordinator or a new thread's brief: saved to the project's Library. */
	attachToProject: (id: string, file: File) =>
		json<AttachedFile>(`/api/spaces/${id}/attachments?name=${encodeURIComponent(file.name)}`, {
			method: 'POST',
			body: file,
			headers: { 'Content-Type': file.type || 'application/octet-stream' },
		}),
	deleteSpaceFile: async (id: string, path: string) => void (await request(spaceFileUrl(id, path), { method: 'DELETE' })),
	spaceFileText: async (id: string, path: string) => (await request(spaceFileUrl(id, path))).text(),
	/** Stops the coordinator's current turn. */
	stopCoordinator: async (id: string) => void (await request(`/api/agents/coordinator/${id}/abort`, { method: 'POST' })),
};

export const spaceFileUrl = (id: string, path: string) => `/api/spaces/${id}/file?path=${encodeURIComponent(path)}`;

/**
 * Pages refetch when the server says something changed (see live-updates.ts).
 * Polling is only a safety net, for changes nobody announces: a sandbox
 * stopping when idle, or files edited from the terminal.
 */
export const SAFETY_NET_MS = 60_000;

/** A live sandbox can change under the terminal, so its views are checked more often. */
export const refreshFor = (source: Source | undefined) => (source === 'live' ? 15_000 : SAFETY_NET_MS);

/** A chat: a task with no repository, which answers, browses and uses a scratch sandbox. */
export const isChat = (session: Pick<Session, 'projectId'>) => session.projectId === null;

/** The branch a task works on, or the one it reads from while it has no workspace; a chat's scratch sandbox has neither. */
export const branchLabel = (session: Session) =>
	isChat(session) ? (session.workspace ? 'scratch sandbox' : 'no sandbox') : session.workspace ? session.branch : `${session.baseBranch} (read-only)`;

/** The repository's short name, or Chat for a task without one. */
export const repoShort = (session: Pick<Session, 'projectId' | 'repo'>) => (isChat(session) ? 'Chat' : (session.repo.split('/').pop() ?? session.repo));

/** Where a task works, in a line: repository and branch, or Chat and whether it has a sandbox. */
export const placeLabel = (session: Session) => `${isChat(session) ? 'Chat' : session.repo} · ${branchLabel(session)}`;

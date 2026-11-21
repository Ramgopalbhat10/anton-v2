// Generic ACP agent runtime. One implementation drives any vendor agent that
// speaks Agent Client Protocol over stdio (`devin acp`, `agy acp`, …). Three
// pieces meet here: the AcpAgent descriptor (what differs per vendor), the
// AcpAccount (sign-in, models, quota: Settings only, never a container) and the
// AcpCompute that runs the process (Modal in production, a fake in tests).

import type {
	AgentRuntime,
	AgentRuntimeStatus,
	OAuthClientSlot,
	RuntimeContent,
	RuntimeConversation,
	RuntimeConversationOptions,
	RuntimeEvent,
	RuntimeSignIn,
	RuntimeTool,
	RuntimeToolOutput,
	RuntimeUsage,
	SubscriptionModel,
	PlanWindow,
} from '../../core/ports.ts';
import { AcpClient, INITIALIZE, type AcpTransport } from './client.ts';
import { mcpServer } from './mcp.ts';
import { SERVED_CAPABILITIES, WorkspaceBridge } from './workspace-bridge.ts';
import { channel } from '../../core/channel.ts';

/** A downloadable agent build: version plus where its image install fetches it. */
export type AcpRelease = { version: string; url: string; sha256?: string; sha512?: string };

/**
 * Where an agent's jailed process runs: `sidecar` shares one anchor sandbox per host
 * (cheap, experimental API); `sandbox` gives each conversation its own Modal sandbox
 * (standard API, billed per sandbox).
 */
export type AcpIsolation = 'sidecar' | 'sandbox';

/** The settings-table key holding an agent's isolation choice; the host and the settings API share it. */
export const acpIsolationKey = (agentId: string) => `acp.isolation.${agentId}`;

/** Everything vendor-specific about one ACP agent. The engine never branches on it. */
export type AcpAgent = {
	id: string;
	name: string;
	gateway: string;
	/** Display name of the plan, e.g. 'Devin'. */
	plan: string;
	/** What Settings shows for manual sign-in, e.g. 'devin auth login'. */
	signInCommand: string;
	/** Container image: base ref plus dockerfileCommands run after it; `release` is the resolved agent build, null for static installs. */
	image: { base: string; commands: (release: AcpRelease | null) => string[] };
	/** When set, the host resolves the newest agent build before each image build; `floor` is never gone below. `platform` is 'linux/x64'-style — image builds always pass the container's, host installs pass the host's. */
	release?: { floor: string; latest(platform: string): Promise<AcpRelease | null> };
	/**
	 * Host-side CLI bootstrap: when `command[0]` is not on PATH, `fetch` downloads
	 * the release and leaves the runnable CLI at `join(dir, command[0])`. `fallback`
	 * is used when `release.latest()` is unavailable, and returns null on platforms
	 * the vendor ships no build for. Absent means a missing CLI is a hard error
	 * (manual install required).
	 */
	install?: { fallback(platform: string): AcpRelease | null; fetch(release: AcpRelease, dir: string): Promise<void> };
	/** Domains the jailed agent may reach; its API and nothing else. */
	egress: string[];
	/** Inside the container: where the agent works and where link scripts live. */
	workdir: string;
	linkDir: string;
	linkPort: number;
	/** argv that starts the ACP server inside the container. */
	command: string[];
	/** Extra argv presetting the model for each new session (e.g. devin acp --model), so session/new skips set_config_option. The session's config option still wins when it differs. */
	modelArgs?: (model: string) => string[];
	/** Name the agent sees its Anton tools under (tools appear as mcp__<name>__*). */
	mcpServerName: string;
	/** configOptions id carrying the model list in session/new. */
	modelConfigId: string;
	/** _meta key on model options that marks image support; absent means assume every model has it. */
	modelMetaImages?: string;
	/** configOptions id carrying reasoning effort (e.g. agy's thought_level); `effort` from the conversation maps through `effortMap` first, then passes through when the option accepts it. */
	effortConfigId?: string;
	effortMap?: Record<string, string>;
	/** configOptions set once per session after session/new when they differ (e.g. agy's mode: 'auto', so native tools don't stall on permission prompts inside the jail). */
	sessionConfig?: Record<string, string>;
	/** Enrich a listed model from the session's own metadata (e.g. agy's models.availableModels variants → reasoning levels). */
	modelInfo?(value: string, session: SessionInfo): Partial<Pick<SubscriptionModel, 'reasoning' | 'defaultReasoning' | 'contextLength' | 'vision'>>;
	/** The plan's usage windows (5-hour/weekly quota) when the vendor exposes them outside ACP. */
	windows?(): Promise<PlanWindow[] | null>;
	/** Optional vendor command (e.g. `devin models list`) whose text output enriches model ids with context and list price. */
	catalog?: {
		command: string[];
		parse(text: string): Map<string, { contextLength: number; listPrice: SubscriptionModel['listPrice'] }>;
	};
	/** Host-side probe overrides for agents whose data dir is not the default (e.g. agy --gemini-dir). `command` is the fallback. */
	probeCommand?: (workDir: string) => string[];
	probeEnv?: (workDir: string) => Record<string, string>;
	/** Write the credential into the probe's data dir before authenticate (agents that read a token file, not _meta). */
	probeSeed?(token: string, workDir: string): Promise<void>;
	/** Vendor-specific notifications (e.g. Devin's `_cognition.ai/*` turn stats); the engine ignores what it doesn't handle. */
	notification?: (method: string, params: unknown) => void;
	/** The vendor's `_meta` namespace (Devin's `cognition.ai`): its usage counters and permission rules are read from `<namespace>/<key>` first. */
	metaNamespace?: string;
	auth: AcpAuth;
	/** The OAuth client `auth.login` signs in on, when Settings may change it. */
	oauthClient?: OAuthClientSlot;
};

/**
 * How an agent signs in. `cli`: the vendor CLI's own login writes a credential file on this host, and the key rides
 * in authenticate's params (Devin). `token-file`: Anton runs the sign-in and keeps the vendor's token file, which the
 * agent reads from its data dir, so authenticate takes no params (Antigravity).
 */
export type AcpAuth =
	| {
			kind: 'cli';
			/** ACP authenticate methodId advertised by the agent. */
			methodId: string;
			/** authenticate params for the key; secrets ride here, never env. */
			params(token: string): Record<string, unknown>;
			/** The CLI's credential file on this host (`~` expands to home). */
			credentialFile: string;
			/** TOML key inside credentialFile holding the key. */
			credentialKey: string;
			loginCommand: string[];
			logoutCommand?: string[];
			/** First URL the login command prints; complete() feeds it the user's code. */
			loginUrl: RegExp;
			provision?(proc: AcpProcess, token: string): Promise<void>;
	  }
	| {
			kind: 'token-file';
			methodId: string;
			/** The whole file is the credential. */
			credentialFile: string;
			login(): Promise<RuntimeSignIn>;
			/** Steps beyond deleting credentialFile, such as revoking the token. */
			logout(): Promise<void>;
			/** Writes the token where the agent reads it inside its container, before authenticate. */
			provision(proc: AcpProcess, token: string): Promise<void>;
	  };

/** What authenticate takes for this agent and credential. */
export const authParams = (auth: AcpAuth, token: string): Record<string, unknown> => ({
	methodId: auth.methodId,
	...(auth.kind === 'cli' ? auth.params(token) : {}),
});

/**
 * One `session/update` payload: a flat object where each variant sets only its own
 * fields (`content` is a text block on chunks, a content array on tool_call_update).
 * Fields stay optional and guards remain — vendors deviate from the spec.
 */
type SessionUpdate = {
	sessionUpdate?: string;
	content?: { type?: string; text?: string } | unknown[];
	text?: string;
	_meta?: Record<string, unknown>;
	toolCallId?: string;
	title?: string;
	kind?: string;
	status?: string;
	[key: string]: unknown;
};

/** A `session/new` configOptions entry; `currentValue` is the option's value as the agent reports it. */
export type ConfigOption = {
	id?: string;
	configId?: string;
	currentValue?: unknown;
	options?: { value?: string; name?: string; description?: string; _meta?: Record<string, unknown> }[];
};

/** The parts of a `session/new` result listModels reads: configOptions plus whatever model metadata the agent adds (agy's models.availableModels). */
export type SessionInfo = {
	sessionId?: string;
	configOptions?: ConfigOption[];
	models?: { availableModels?: { modelId?: string; name?: string }[] };
};

/** `session/request_permission` params. */
type PermissionParams = {
	toolCall?: { title?: string; name?: string; _meta?: Record<string, unknown> };
	_meta?: Record<string, unknown>;
	options?: { optionId?: string; kind?: string; name?: string }[];
};

/** One jailed agent process plus its MCP link, inside the vendor's container. */
export type AcpProcess = {
	/** ACP stdio channel: devin acp. */
	acp: AcpTransport;
	/** MCP channel: linkd's stdio, where the host is the MCP server. */
	mcp: AcpTransport;
	writeFile(path: string, content: string): Promise<void>;
	/** Kill the whole container: both execs and the agent die together. */
	close(): Promise<void>;
	/** Last stderr lines from either exec, for error messages. */
	stderrTail(): string;
};

/** One vendor account: sign-in, models and quota. What Settings reads; it never starts a container. */
export interface AcpAccount {
	signedIn(): Promise<{ signedIn: boolean; problem: string | null }>;
	/** The token authenticate() takes; null when signed out. */
	credential(): Promise<string | null>;
	signIn(): Promise<RuntimeSignIn>;
	signOut(): Promise<void>;
	listModels(): Promise<SubscriptionModel[]>;
	/** The plan's usage windows when the vendor reports them; absent means the plan shows none. */
	windows?(): Promise<PlanWindow[] | null>;
}

/** Where agent processes run. Every container it starts belongs to one conversation, or is its warm slot. Modal in production. */
export interface AcpCompute {
	/** Start one container for one conversation; `model` lets compute preset it where the agent allows. Closing the process ends the container. */
	spawn(model?: string): Promise<AcpProcess>;
	/** Warm-up after sign-in: build the agent image and resolve its release in the background. */
	prepare?(): Promise<void>;
	/** The isolation mode new spawns use; present only where there is a choice. */
	isolation?(): Promise<AcpIsolation>;
	/** Ends containers kept for later (a warm slot); signed out, they could not authenticate. */
	drain?(): void;
}

const ZERO_USAGE: RuntimeUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** Setup calls should answer in seconds; a silent agent here is wedged, not slow. */
const HANDSHAKE_MS = 90_000;
/** A turn this quiet is dead. Anton tool calls pause the watchdog while they run. */
const STALL_MS = 5 * 60_000;

const toAcpPrompt = (content: RuntimeContent[]) =>
	content.map((part) =>
		part.type === 'text'
			? { type: 'text' as const, text: part.text }
			: { type: 'image' as const, data: part.data, mimeType: part.mimeType },
	);

/** Flue calls the model once per step; the agent pauses at each Anton tool call. Each pause closes one synthetic message. */
class AcpConversation implements RuntimeConversation {
	private readonly eventsOut = channel<RuntimeEvent>();
	private readonly options: RuntimeConversationOptions;
	private readonly agent: AcpAgent;
	private readonly account: AcpAccount;
	private readonly compute: AcpCompute;
	private proc: AcpProcess | null = null;
	private acp: AcpClient | null = null;
	private mcp: { close(): void; toolsChanged(): void } | null = null;
	/** The live tool list the MCP server and callTool validation read; setTools swaps it mid-session. */
	private tools: RuntimeTool[];
	private sessionId: string | null = null;
	private ready: Promise<void> | null = null;
	private queue: Promise<void> = Promise.resolve();
	private messageSeq = 0;
	private toolSeq = 0;
	private seg = { open: false, block: null as 'text' | 'thinking' | null, index: 0 };
	private closed = false;
	private stepSeq = 0;
	private spawnMs = 0;
	private setupMs = 0;
	private promptAt = 0;
	private ttftMs: number | null = null;
	/** The agent's own tool calls, for failure lines; Anton's calls already stream as tool_use blocks. */
	private nativeTools = new Map<string, { title: string; kind: string }>();
	/** Last sign of life from the agent; the stall watchdog fires only after this goes quiet. */
	private lastActivity = 0;
	/** Anton tool calls in flight; the agent legitimately waits silently while they run. */
	private parkedTools = 0;
	/** Of those, the calls the agent made through MCP: only their results can carry the user's words back. */
	private parkedMcp = 0;
	/** The agent reported a model call's own counters during this turn, so its summed total must not be booked again. */
	private turnMeasured = false;
	/** What this turn's closed steps booked, and what the open step holds, so the turn's total can settle the difference. */
	private turnBooked: RuntimeUsage = { ...ZERO_USAGE };
	private segUsage: RuntimeUsage | null = null;
	/** The context of this session's last model call, the prefix the next call can read from the model's cache. */
	private lastContext = 0;
	/** The last turn total, for the step log line. */
	private lastTotal: RuntimeUsage | null = null;
	/** What the user wrote while the agent waited on an Anton tool; it rides back with that tool's result. */
	private steering: string[] = [];
	/** The agent's native file and shell requests, run as Anton's own tools on the task's sandbox. */
	private readonly workspace: WorkspaceBridge;
	/** Anton's instructions lead the session's first prompt. */
	private instructionsSent = false;

	constructor(agent: AcpAgent, account: AcpAccount, compute: AcpCompute, options: RuntimeConversationOptions) {
		this.agent = agent;
		this.account = account;
		this.compute = compute;
		this.options = options;
		this.tools = options.tools;
		this.workspace = new WorkspaceBridge(
			(name, args) => this.handleToolCall(name, args, false),
			(name) => this.tools.some((tool) => tool.name === name),
			agent.workdir,
		);
	}

	readonly events: AsyncIterable<RuntimeEvent> = this.eventsOut;

	send(content: RuntimeContent[]): void {
		if (this.closed) return;
		// ACP has no way into a running turn, and a new prompt waits for the whole turn to end, so a message sent
		// while the agent waits on a tool goes back with that tool's result, where the agent reads it at once.
		if (this.parkedMcp > 0 && content.every((part) => part.type === 'text')) {
			this.steering.push(...content.map((part) => (part.type === 'text' ? part.text : '')).filter(Boolean));
			return;
		}
		this.queue = this.queue.then(() => this.prompt(content)).catch((error) => this.push({ type: 'error', message: error instanceof Error ? error.message : String(error), limit: false }));
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		if (this.sessionId) this.acp?.notify('session/cancel', { sessionId: this.sessionId });
		this.acp?.close();
		this.mcp?.close();
		void this.proc?.close();
		this.eventsOut.close();
	}

	setTools(tools: RuntimeTool[]): void {
		this.tools = tools;
		this.mcp?.toolsChanged();
	}

	// ---- event emission -------------------------------------------------

	private push(event: RuntimeEvent): void {
		if (!this.closed) this.eventsOut.push(event);
	}

	private ensureSegment(): void {
		if (this.seg.open) return;
		this.seg = { open: true, block: null, index: 0 };
		this.segUsage = null;
		this.push({ type: 'message_start', id: `acp-${++this.messageSeq}`, usage: { ...ZERO_USAGE } });
	}

	private closeBlock(): void {
		if (!this.seg.block) return;
		this.push({ type: 'block_stop', index: this.seg.index - 1 });
		this.seg.block = null;
	}

	private chunk(kind: 'text' | 'thinking', text: string): void {
		if (!text) return;
		if (this.promptAt && this.ttftMs === null) this.ttftMs = Date.now() - this.promptAt;
		this.ensureSegment();
		if (this.seg.block !== kind) {
			this.closeBlock();
			this.push({ type: 'block_start', index: this.seg.index, block: kind === 'text' ? { type: 'text' } : { type: 'thinking' } });
			this.seg.block = kind;
			this.seg.index += 1;
		}
		this.push(kind === 'text' ? { type: 'block_delta', index: this.seg.index - 1, text } : { type: 'block_delta', index: this.seg.index - 1, thinking: text });
	}

	private closeSegment(stopReason: string | null, usage: Partial<RuntimeUsage> = {}): void {
		if (!this.seg.open) return;
		this.closeBlock();
		this.push({ type: 'message_delta', stopReason, usage });
		this.push({ type: 'message_stop' });
		this.seg.open = false;
		this.book({ ...(this.segUsage ?? ZERO_USAGE), ...usage });
	}

	private book(usage: RuntimeUsage): void {
		for (const key of USAGE_KEYS) this.turnBooked[key] += usage[key];
		this.segUsage = null;
	}

	// ---- ACP side -------------------------------------------------------

	private onUpdate(params: { sessionId?: string; update?: SessionUpdate }): void {
		if (params.sessionId !== this.sessionId || !params.update) return;
		this.lastActivity = Date.now();
		const update = params.update;
		switch (update.sessionUpdate) {
			case 'agent_message_chunk':
				this.chunk('text', textOf(update));
				return;
			case 'agent_thought_chunk':
				this.chunk('thinking', textOf(update));
				return;
			case 'usage_update':
				this.pushUsage(update);
				return;
			case 'tool_call': {
				// The agent's own tools run inside its jail; they never become Anton tool_use
				// blocks (Flue would try to run them). They ride the thinking stream instead,
				// so a long silent stretch still shows what the agent is doing.
				const title = typeof update.title === 'string' && update.title ? update.title : null;
				const kind = typeof update.kind === 'string' && update.kind ? update.kind : 'tool';
				const id = typeof update.toolCallId === 'string' ? update.toolCallId : null;
				if (id && title && !this.isAntonTool(update)) this.nativeTools.set(id, { title, kind });
				if (title && !this.isAntonTool(update)) this.chunk('thinking', `\n[${kind}] ${title}\n`);
				return;
			}
			case 'tool_call_update': {
				const id = typeof update.toolCallId === 'string' ? update.toolCallId : '';
				const tool = this.nativeTools.get(id);
				if (tool && update.status === 'failed') this.chunk('thinking', `\n[${tool.kind}] ${tool.title} failed\n`);
				return;
			}
			default:
				// Plans, mode changes, session info: the agent's own business inside the jail.
				return;
		}
	}

	/**
	 * Vendors namespace Anton's MCP tools their own way — Devin marks permission rules
	 * `mcp__anton__tool`, agy names calls `mcp_anton_tool` and titles them "Run mcp_anton_tool".
	 * The thinking filter and the permission gate must agree on this or a vendor's own
	 * tools get shown as Anton's, or Anton's get refused (agy did exactly that).
	 */
	private isAntonToolRef(
		ref: { name?: unknown; title?: unknown; _meta?: Record<string, unknown> } | undefined,
		meta?: Record<string, unknown>,
	): boolean {
		const srv = this.agent.mcpServerName;
		const ruleKey = this.agent.metaNamespace ? `${this.agent.metaNamespace}/permissionRule` : 'permissionRule';
		const rule = String(meta?.[ruleKey] ?? ref?._meta?.[ruleKey] ?? '');
		const name = String(ref?.name ?? '');
		const title = String(ref?.title ?? '');
		const mcp = `mcp__${srv}`;
		// A bare `anton_<tool>` counts only as a whole word naming one of Anton's tools: a file such as anton_config.ts is not one.
		const bare = new Set(this.tools.map((tool) => `${srv}_${tool.name}`));
		const words = title.split(/[^A-Za-z0-9_.-]+/);
		return (
			rule.startsWith(mcp) ||
			name.startsWith(`${mcp}__`) ||
			name.startsWith(`mcp_${srv}_`) ||
			bare.has(name) ||
			title.includes(`${mcp}__`) ||
			title.includes(`mcp_${srv}_`) ||
			words.some((word) => bare.has(word))
		);
	}

	private isAntonTool(update: SessionUpdate): boolean {
		return this.isAntonToolRef(update);
	}

	/**
	 * One model call's usage, which is the step's context as Flue measures it. An agent reports it as the call starts,
	 * before any of its output: it opens the call's step, or the step's start would reset it to zero.
	 *
	 * A report of the context alone (Antigravity) does not say how much of it the cache served; the turn's total does,
	 * once the turn ends, after these steps are closed. The step books the part it shares with the session's previous
	 * call as read from the cache, since that prefix is what the model caches, and `settle` squares the turn with the
	 * total. Booked all as uncached, the cache could land only on the last step and a turn read as a quarter cached.
	 */
	private pushUsage(update: SessionUpdate): void {
		const usage = readUsage({ ...update, ...update._meta }, this.agent.metaNamespace);
		if (!usage) return;
		if (!usage.occupancy) this.turnMeasured = true;
		const cached = usage.occupancy ? Math.min(this.lastContext, usage.input) : 0;
		if (usage.occupancy) this.lastContext = usage.input;
		const counters = { input: usage.input - cached, output: usage.output, cacheRead: usage.cacheRead + cached, cacheWrite: usage.cacheWrite };
		this.ensureSegment();
		this.segUsage = counters;
		this.push({ type: 'message_delta', stopReason: null, usage: counters });
	}

	private async onRequest(method: string, params: unknown, id: number | string): Promise<unknown> {
		this.lastActivity = Date.now();
		if (method === 'session/request_permission') {
			// Allowed: Anton's own tools, and the agent's native ones, whose files and commands come back to Anton as
			// fs/ and terminal/ requests and run as Anton's tools. Whatever does not stays inside the jail.
			const options = (params as PermissionParams)?.options ?? [];
			const optionId = options.find((o) => /allow/.test(`${o.kind ?? ''} ${o.name ?? ''}`))?.optionId;
			return optionId ? { outcome: { outcome: 'selected', optionId } } : { outcome: { outcome: 'cancelled' } };
		}
		const served = this.workspace.handle(method, params);
		if (served) return served;
		throw new Error(`unsupported agent request: ${method}`);
	}

	// ---- MCP side -------------------------------------------------------

	/** `steer`: a result the agent reads as a tool result, which can carry the user's words; a file's content cannot. */
	private async handleToolCall(rawName: string, args: unknown, steer = true): Promise<RuntimeToolOutput> {
		// Some agents namespace MCP tools (mcp__anton__bash, mcp_anton_bash, anton_bash); Anton's name is the suffix.
		const name = this.tools.some((tool) => tool.name === rawName)
			? rawName
			: rawName
					.replace(/^mcp__[^_]+__/, '')
					.replace(new RegExp(`^mcp_${this.agent.mcpServerName}_`), '')
					.replace(new RegExp(`^${this.agent.mcpServerName}_`), '');
		if (!this.tools.some((tool) => tool.name === name)) {
			return { content: [{ type: 'text', text: `Unknown tool: ${rawName}` }], isError: true };
		}
		const toolUseId = `acp-call-${++this.toolSeq}`;
		this.ensureSegment();
		this.closeBlock();
		this.push({ type: 'block_start', index: this.seg.index, block: { type: 'tool_use', id: toolUseId, name } });
		this.seg.index += 1;
		this.push({ type: 'block_delta', index: this.seg.index - 1, json: JSON.stringify(args ?? {}) });
		this.push({ type: 'block_stop', index: this.seg.index - 1 });
		// The agent is blocked on this call: its model step is over until Flue delivers the result.
		this.push({ type: 'message_delta', stopReason: 'tool_use', usage: {} });
		this.push({ type: 'message_stop' });
		this.seg.open = false;
		this.book(this.segUsage ?? ZERO_USAGE);
		this.parkedTools += 1;
		if (steer) this.parkedMcp += 1;
		try {
			const output = await this.options.callTool(toolUseId, name);
			if (!steer) return output;
			// The bridge delivers results before the user's words, so wait a tick for them.
			await Promise.resolve();
			const said = this.steering.splice(0);
			if (!said.length) return output;
			const note = `<user_message>\nThe user wrote this while you were working. Read it now and follow it:\n${said.join('\n\n')}\n</user_message>`;
			return { ...output, content: [...output.content, { type: 'text', text: note }] };
		} finally {
			this.parkedTools -= 1;
			if (steer) this.parkedMcp -= 1;
			// The agent gets a fresh quiet window to answer once the result lands.
			this.lastActivity = Date.now();
		}
	}

	// ---- lifecycle ------------------------------------------------------

	private async setup(): Promise<void> {
		const t0 = Date.now();
		// The spawn+handshake window emits nothing else; one honest line keeps the UI from sitting blank.
		this.chunk('thinking', `\n[${this.agent.name}] starting session…\n`);
		const proc = await this.compute.spawn(this.options.model);
		this.spawnMs = Date.now() - t0;
		// close() during the spawn could not reach this container; nothing else will end it.
		if (this.closed) {
			await proc.close().catch(() => undefined);
			throw new Error('The conversation was closed.');
		}
		this.proc = proc;
		this.mcp = mcpServer(proc.mcp, () => this.tools, (name, args) => this.handleToolCall(name, args));
		this.acp = new AcpClient(proc.acp, {
			onNotification: (method, params) => {
				this.agent.notification?.(method, params);
				if (method === 'session/update') this.onUpdate(params as { sessionId?: string; update?: SessionUpdate });
			},
			onRequest: (method, params, id) => this.onRequest(method, params, id),
		});
		this.acp.start();
		await this.acp.request('initialize', { ...INITIALIZE, clientCapabilities: SERVED_CAPABILITIES }, HANDSHAKE_MS);
		const token = await this.account.credential();
		if (!token) throw new Error(`${this.agent.name} is not signed in`);
		// Some agents read credentials from files in their own data dir, not from authenticate params.
		await this.agent.auth.provision?.(proc, token);
		await this.acp.request('authenticate', authParams(this.agent.auth, token), HANDSHAKE_MS);
		const session = (await this.acp.request('session/new', {
			cwd: this.agent.workdir,
			mcpServers: [
				{
					name: this.agent.mcpServerName,
					command: 'node',
					args: [`${this.agent.linkDir}/link.mjs`, String(this.agent.linkPort)],
					env: [],
				},
			],
		}, HANDSHAKE_MS)) as SessionInfo;
		if (!session.sessionId) throw new Error(`${this.agent.name} opened no session`);
		this.sessionId = session.sessionId;
		await this.applyModel(session.configOptions);
		await this.applySessionConfig(session.configOptions);
		this.setupMs = Date.now() - t0 - this.spawnMs;
		this.chunk('thinking', `\n[${this.agent.name}] session ready in ${((this.spawnMs + this.setupMs) / 1000).toFixed(1)}s\n`);
	}

	private async applyModel(configOptions: ConfigOption[] | undefined): Promise<void> {
		const model = this.options.model;
		if (!model || !Array.isArray(configOptions)) return;
		await this.setOption(configOptions, this.agent.modelConfigId, model);
	}

	/** effort (mapped through the descriptor's effortMap) and sessionConfig entries, each only when the option exists, accepts the value and differs. */
	private async applySessionConfig(configOptions: ConfigOption[] | undefined): Promise<void> {
		if (!Array.isArray(configOptions)) return;
		const wanted: [string, string | undefined][] = [];
		const effort = this.options.effort;
		if (effort && this.agent.effortConfigId) wanted.push([this.agent.effortConfigId, this.agent.effortMap?.[effort] ?? effort]);
		for (const [id, value] of Object.entries(this.agent.sessionConfig ?? {})) wanted.push([id, value]);
		for (const [id, value] of wanted) if (value) await this.setOption(configOptions, id, value);
	}

	private async setOption(configOptions: ConfigOption[], id: string, value: string): Promise<void> {
		const option = configOptions.find((o) => (o.id ?? o.configId) === id);
		if (!option) return;
		const values = option.options ?? [];
		if (values.length && !values.some((v) => v.value === value)) return;
		// The option already reports the value in use; setting it again makes the agent
		// reconfigure the session (seconds on Devin), so only send the RPC when it differs.
		if (option.currentValue === value) return;
		await this.acp!.request(
			'session/set_config_option',
			{
				sessionId: this.sessionId,
				configId: option.id ?? option.configId,
				value,
			},
			HANDSHAKE_MS,
		);
	}

	/** The repo's own AGENTS.md now reads through to the task's sandbox, so Anton's instructions open the first prompt instead. */
	private withInstructions(content: RuntimeContent[]): RuntimeContent[] {
		const instructions = this.options.instructions.trim();
		if (this.instructionsSent || !instructions) return content;
		this.instructionsSent = true;
		// Reads, writes and commands reach the repo; the agent's own file search runs in its empty container and finds nothing.
		const searching = 'Your file search and listing tools cannot see the repository; search with shell commands such as rg, find and ls, or with the grep and glob tools.';
		return [{ type: 'text', text: `<instructions>\n${instructions}\n\n${searching}\n</instructions>` }, ...content];
	}

	private async prompt(content: RuntimeContent[]): Promise<void> {
		this.ready ??= this.setup();
		try {
			await this.ready;
		} catch (error) {
			this.push({ type: 'error', message: error instanceof Error ? error.message : String(error), limit: false });
			// A half-set-up session holds a container; close() ends it along with the event stream.
			this.close();
			return;
		}
		const t0 = Date.now();
		this.promptAt = t0;
		this.ttftMs = null;
		this.turnMeasured = false;
		this.turnBooked = { ...ZERO_USAGE };
		this.lastTotal = null;
		this.lastActivity = t0;
		let stalled = false;
		let stallTimer: ReturnType<typeof setInterval> | undefined;
		const stall = new Promise<never>((_, reject) => {
			stallTimer = setInterval(() => {
				if (this.parkedTools === 0 && Date.now() - this.lastActivity > STALL_MS) {
					stalled = true;
					this.acp?.notify('session/cancel', { sessionId: this.sessionId });
					reject(new Error(`${this.agent.name} stopped responding`));
				}
			}, 5_000);
			stallTimer.unref?.();
		});
		try {
			const result = (await Promise.race([
				this.acp!.request('session/prompt', {
					sessionId: this.sessionId,
					prompt: toAcpPrompt(this.withInstructions(content)),
				}),
				stall,
			])) as { stopReason?: string; usage?: Record<string, unknown> };
			// The turn's total sums every model call in it. An agent that counted each call has booked it already; one
			// that reported only each call's context (Antigravity) gets the rest of the total on the last step.
			const total = this.turnMeasured ? null : readUsage(result?.usage ?? {}, this.agent.metaNamespace);
			// A turn that ends right after a tool result still answers that step, if only with nothing.
			this.ensureSegment();
			const last = total && !total.occupancy ? settle(total, this.turnBooked) : null;
			this.lastTotal = total;
			// What the cache could not have served was not covered by any report: the last call's context.
			if (last && this.lastContext) this.lastContext = Math.max(this.lastContext, last.input + last.cacheRead + last.cacheWrite);
			this.closeSegment(result?.stopReason ?? 'end_turn', last ?? {});
			this.push({ type: 'turn_end' });
		} catch (error) {
			this.closeSegment(null);
			this.push({ type: 'error', message: error instanceof Error ? error.message : String(error), limit: false });
			this.push({ type: 'turn_end' });
			// A silent agent does not recover; the next message gets a fresh spawn either way.
			if (stalled) this.close();
		} finally {
			if (stallTimer) clearInterval(stallTimer);
		}
		console.error(
			`[acp:${this.agent.id}] step ${++this.stepSeq}: spawn=${this.spawnMs}ms setup=${this.setupMs}ms ttft=${this.ttftMs ?? '—'}ms prompt=${Date.now() - t0}ms model=${this.options.model}${this.lastTotal ? ` total=${JSON.stringify(this.lastTotal)}` : ''}`,
		);
	}
}

const num = (v: unknown): number => (typeof v === 'number' ? v : typeof v === 'string' ? Number(v) || 0 : 0);

const USAGE_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite'] as const;

/**
 * The last step's share of a turn total, so the turn's steps add up to it. The context the steps did not book is the
 * last step's; the cache the total has beyond what they booked comes first in it, and the rest is uncached input. The
 * steps' cache was the prefix each shared with the call before, so where that was not served the sum still runs over.
 */
export function settle(total: RuntimeUsage, booked: RuntimeUsage): RuntimeUsage {
	const context = (u: RuntimeUsage) => u.input + u.cacheRead + u.cacheWrite;
	const pool = Math.max(0, context(total) - context(booked));
	const cacheRead = Math.min(pool, Math.max(0, total.cacheRead - booked.cacheRead));
	const cacheWrite = Math.min(pool - cacheRead, Math.max(0, total.cacheWrite - booked.cacheWrite));
	return { input: pool - cacheRead - cacheWrite, output: Math.max(0, total.output - booked.output), cacheRead, cacheWrite };
}

/**
 * ACP usage (a `usage_update`, its `_meta`, or `session/prompt`'s total) in pi's shape, where `input` is the uncached
 * part only. Vendors count cached tokens inside their input total (Devin does: summing them again showed 343K of a
 * 262K window when the call held 171K), so they are taken out of it. An agent that reports only the spec's `used`
 * occupancy gets that as input, marked `occupancy`. Null when nothing was measured.
 */
export function readUsage(fields: Record<string, unknown>, namespace?: string): (RuntimeUsage & { occupancy?: true }) | null {
	const first = (key: string, short: string) => {
		for (const name of [namespace ? `${namespace}/${key}` : '', key, short]) if (name && fields[name] !== undefined) return num(fields[name]);
		return 0;
	};
	const total = first('inputTokens', 'input');
	const written = first('outputTokens', 'output');
	const thought = first('thoughtTokens', 'thought');
	const cacheRead = first('cachedReadTokens', 'cacheRead');
	const cacheWrite = first('cachedWriteTokens', 'cacheWrite');
	const sum = first('totalTokens', 'total');
	// Reasoning is paid as output. Gemini counts it apart from the answer; a grand total smaller than both together already has it inside.
	const output = thought && (!sum || sum >= total + written + thought) ? written + thought : written;
	if (total || output || cacheRead || cacheWrite) {
		const input = total >= cacheRead + cacheWrite ? total - cacheRead - cacheWrite : total;
		return { input, output, cacheRead, cacheWrite };
	}
	// The spec's `used` is the call's whole context, with no split into cached and uncached or any output.
	const used = num(fields.used);
	return used ? { input: used, output: 0, cacheRead: 0, cacheWrite: 0, occupancy: true } : null;
}

const textOf = (update: SessionUpdate): string => {
	const content = update.content;
	const text = content && !Array.isArray(content) ? content.text : undefined;
	return typeof text === 'string' ? text : typeof update.text === 'string' ? update.text : '';
};

export function acpRuntime(agent: AcpAgent, account: AcpAccount, compute: AcpCompute): AgentRuntime {
	return {
		id: agent.id,
		name: agent.name,
		gateway: agent.gateway,
		signInCommand: agent.signInCommand,
		signIn: async () => {
			const started = await account.signIn();
			return {
				...started,
				complete: async (code) => {
					await started.complete(code);
					// Connection setup is the warm-up point: build the image and check the agent's latest release off the reply path.
					void compute.prepare?.().catch(() => undefined);
				},
			};
		},
		signOut: async () => {
			await account.signOut();
			compute.drain?.();
		},
		...(compute.isolation ? { isolation: () => compute.isolation!() } : {}),
		...(agent.oauthClient ? { oauthClient: agent.oauthClient } : {}),
		status: async (): Promise<AgentRuntimeStatus> => {
			const s = await account.signedIn();
			return { signedIn: s.signedIn, email: null, plan: agent.plan, version: null, problem: s.problem };
		},
		listModels: () => account.listModels(),
		...(account.windows ? { windows: () => account.windows!() } : {}),
		open: (options) => new AcpConversation(agent, account, compute, options),
	};
}

// Generic ACP agent runtime. One implementation drives any vendor agent that
// speaks Agent Client Protocol over stdio (`devin acp`, `agy acp`, …); what
// differs per vendor is the AcpAgent descriptor and the AcpHost that runs the
// process — Modal sidecars in production, a fake in tests.

import type {
	AgentRuntime,
	AgentRuntimeStatus,
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
import { AcpClient, type AcpTransport } from './client.ts';
import { mcpServer } from './mcp.ts';

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
	/** When set, the host resolves the newest agent build before each image build; `floor` is never gone below. */
	release?: { floor: string; latest(): Promise<AcpRelease | null> };
	/**
	 * Host-side CLI bootstrap: when `command[0]` is not on PATH, `fetch` downloads
	 * the release and leaves the runnable CLI at `join(dir, command[0])`. `fallback`
	 * is used when `release.latest()` is unavailable. Absent means a missing CLI
	 * is a hard error (manual install required).
	 */
	install?: { fallback: AcpRelease; fetch(release: AcpRelease, dir: string): Promise<void> };
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
	auth: {
		/** ACP authenticate methodId advertised by the agent. */
		methodId: string;
		/** authenticate params for a token; secrets ride here, never env. */
		params: (token: string) => Record<string, unknown>;
		/** The agent CLI's credential file on this host (`~` expands to home); Anton reads the key for per-session auth. */
		credentialFile: string;
		/** TOML key inside credentialFile; empty means the whole file is the credential (JSON token stores like agy's). */
		credentialKey: string;
		loginCommand: string[];
		logoutCommand?: string[];
		/** First URL the login command prints; complete() feeds it the user's code. */
		loginUrl: RegExp;
		/** Replaces the PTY login flow for agents whose sign-in is not a CLI prompt (e.g. Anton-run OAuth). */
		customLogin?: () => Promise<RuntimeSignIn>;
		/** Extra sign-out steps beyond deleting credentialFile (e.g. token revocation). */
		customLogout?: () => Promise<void>;
		/** Files the agent needs inside its container before authenticate — agy's token file lives in its app-data dir. */
		provision?(proc: AcpProcess, token: string): Promise<void>;
	};
};

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

/** Where agent processes run and how credentials are kept. Modal in production. */
export interface AcpHost {
	signedIn(): Promise<{ signedIn: boolean; problem: string | null }>;
	/** The token authenticate() takes; null when signed out. Read per use, not cached. */
	credential(): Promise<string | null>;
	signIn(): Promise<RuntimeSignIn>;
	signOut(): Promise<void>;
	listModels(): Promise<SubscriptionModel[]>;
	/** The plan's usage windows when the vendor reports them; absent means the plan shows none. */
	windows?(): Promise<PlanWindow[] | null>;
	/** Warm-up after sign-in: build the agent image and resolve its release in the background. */
	prepare?(): Promise<void>;
	/** The isolation mode new spawns use; present only on hosts that offer a choice. */
	isolation?(): Promise<AcpIsolation>;
	/** Spawn one container for one conversation; `model` lets the host preset it where the agent allows. */
	spawn(model?: string): Promise<AcpProcess>;
}

function channel<T>() {
	const queue: T[] = [];
	const waiters: ((value: IteratorResult<T>) => void)[] = [];
	let done = false;
	return {
		push(value: T) {
			const waiter = waiters.shift();
			if (waiter) waiter({ value, done: false });
			else queue.push(value);
		},
		close() {
			done = true;
			for (const waiter of waiters.splice(0)) waiter({ value: undefined as T, done: true });
		},
		get closed() {
			return done;
		},
		async *[Symbol.asyncIterator](): AsyncGenerator<T> {
			for (;;) {
				const value = queue.shift();
				if (value !== undefined) {
					yield value;
					continue;
				}
				if (done) return;
				const next = await new Promise<IteratorResult<T>>((resolve) => waiters.push(resolve));
				if (next.done) return;
				yield next.value;
			}
		},
	};
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
	private readonly host: AcpHost;
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

	constructor(agent: AcpAgent, host: AcpHost, options: RuntimeConversationOptions) {
		this.agent = agent;
		this.host = host;
		this.options = options;
		this.tools = options.tools;
	}

	readonly events = this.eventsOut[Symbol.asyncIterator]();

	send(content: RuntimeContent[]): void {
		if (this.closed) return;
		this.queue = this.queue.then(() => this.prompt(content)).catch((error) => this.push({ type: 'error', message: error instanceof Error ? error.message : String(error), limit: false }));
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.acp?.notify('session/cancel', { sessionId: this.sessionId });
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
		const rule = String(meta?.['cognition.ai/permissionRule'] ?? ref?._meta?.['cognition.ai/permissionRule'] ?? '');
		const name = String(ref?.name ?? '');
		const title = String(ref?.title ?? '');
		const mcp = `mcp__${srv}`;
		return (
			rule.startsWith(mcp) ||
			name.startsWith(`${mcp}__`) ||
			name.startsWith(`mcp_${srv}_`) ||
			title.includes(`${mcp}__`) ||
			title.includes(`mcp_${srv}_`) ||
			title.includes(`${srv}_`)
		);
	}

	private isAntonTool(update: SessionUpdate): boolean {
		return this.isAntonToolRef(update);
	}

	private pushUsage(update: SessionUpdate): void {
		const meta = update._meta ?? {};
		const num = (...keys: string[]) => {
			for (const key of keys) {
				const v = meta[key] ?? update[key];
				if (typeof v === 'number') return v;
			}
			return 0;
		};
		const usage = {
			input: num('cognition.ai/inputTokens', 'inputTokens', 'input'),
			output: num('cognition.ai/outputTokens', 'outputTokens', 'output'),
			cacheRead: num('cognition.ai/cachedReadTokens', 'cachedReadTokens', 'cacheRead'),
			cacheWrite: num('cognition.ai/cachedWriteTokens', 'cachedWriteTokens', 'cacheWrite'),
		};
		if (usage.input || usage.output || usage.cacheRead || usage.cacheWrite) {
			this.push({ type: 'message_delta', stopReason: null, usage });
		}
	}

	private async onRequest(method: string, params: unknown, id: number | string): Promise<unknown> {
		this.lastActivity = Date.now();
		if (method === 'session/request_permission') {
			const p = params as PermissionParams;
			const options = p?.options ?? [];
			const antonTool = this.isAntonToolRef(p?.toolCall, p?._meta);
			const pick = (match: RegExp) => options.find((o) => match.test(`${o.kind ?? ''} ${o.name ?? ''}`))?.optionId;
			const optionId = antonTool ? pick(/allow/) : pick(/reject|deny/);
			return optionId ? { outcome: { outcome: 'selected', optionId } } : { outcome: { outcome: 'cancelled' } };
		}
		throw new Error(`unsupported agent request: ${method}`);
	}

	// ---- MCP side -------------------------------------------------------

	private async handleToolCall(rawName: string, args: unknown): Promise<RuntimeToolOutput> {
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
		this.parkedTools += 1;
		try {
			return await this.options.callTool(toolUseId, name);
		} finally {
			this.parkedTools -= 1;
			// The agent gets a fresh quiet window to answer once the result lands.
			this.lastActivity = Date.now();
		}
	}

	// ---- lifecycle ------------------------------------------------------

	private async setup(): Promise<void> {
		const t0 = Date.now();
		// The spawn+handshake window emits nothing else; one honest line keeps the UI from sitting blank.
		this.chunk('thinking', `\n[${this.agent.name}] starting session…\n`);
		const proc = await this.host.spawn(this.options.model);
		this.spawnMs = Date.now() - t0;
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
		await this.acp.request(
			'initialize',
			{
				protocolVersion: 1,
				clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
				clientInfo: { name: 'anton', version: '1.0.0' },
			},
			HANDSHAKE_MS,
		);
		const token = await this.host.credential();
		if (!token) throw new Error(`${this.agent.name} is not signed in`);
		// Some agents read credentials from files in their own data dir, not from authenticate params.
		await this.agent.auth.provision?.(proc, token);
		await this.acp.request('authenticate', { methodId: this.agent.auth.methodId, ...this.agent.auth.params(token) }, HANDSHAKE_MS);
		// The agent reads project instructions itself; Anton's system prompt rides along as AGENTS.md.
		if (this.options.instructions.trim()) {
			await proc.writeFile(`${this.agent.workdir}/AGENTS.md`, `${this.options.instructions}\n`);
		}
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

	private async prompt(content: RuntimeContent[]): Promise<void> {
		this.ready ??= this.setup();
		try {
			await this.ready;
		} catch (error) {
			this.push({ type: 'error', message: error instanceof Error ? error.message : String(error), limit: false });
			this.eventsOut.close();
			return;
		}
		const t0 = Date.now();
		this.promptAt = t0;
		this.ttftMs = null;
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
					prompt: toAcpPrompt(content),
				}),
				stall,
			])) as { stopReason?: string; usage?: Record<string, unknown> };
			const usage = result?.usage ?? {};
			this.closeSegment(result?.stopReason ?? 'end_turn', {
				input: num(usage.inputTokens ?? usage.input),
				output: num(usage.outputTokens ?? usage.output),
				cacheRead: num(usage.cachedReadTokens ?? usage.cacheRead),
				cacheWrite: num(usage.cachedWriteTokens ?? usage.cacheWrite),
			});
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
			`[acp:${this.agent.id}] step ${++this.stepSeq}: spawn=${this.spawnMs}ms setup=${this.setupMs}ms ttft=${this.ttftMs ?? '—'}ms prompt=${Date.now() - t0}ms model=${this.options.model}`,
		);
	}
}

const num = (v: unknown): number => (typeof v === 'number' ? v : typeof v === 'string' ? Number(v) || 0 : 0);

const textOf = (update: SessionUpdate): string => {
	const content = update.content;
	const text = content && !Array.isArray(content) ? content.text : undefined;
	return typeof text === 'string' ? text : typeof update.text === 'string' ? update.text : '';
};

export function acpRuntime(agent: AcpAgent, host: AcpHost): AgentRuntime {
	return {
		id: agent.id,
		name: agent.name,
		gateway: agent.gateway,
		signInCommand: agent.signInCommand,
		signIn: async () => {
			const started = await host.signIn();
			return {
				...started,
				complete: async (code) => {
					await started.complete(code);
					// Connection setup is the warm-up point: build the image and check the agent's latest release off the reply path.
					void host.prepare?.().catch(() => undefined);
				},
			};
		},
		signOut: () => host.signOut(),
		...(host.isolation ? { isolation: () => host.isolation!() } : {}),
		status: async (fresh): Promise<AgentRuntimeStatus> => {
			const s = await host.signedIn();
			return { signedIn: s.signedIn, email: null, plan: agent.plan, version: null, problem: s.problem };
		},
		listModels: () => host.listModels(),
		...(host.windows ? { windows: () => host.windows!() } : {}),
		open: (options) => new AcpConversation(agent, host, options),
	};
}

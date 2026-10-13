import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { type ModelInfo as ClaudeModel, type Options, type SDKMessage, type SDKUserMessage, query } from '@anthropic-ai/claude-agent-sdk';
import { ANTHROPIC_MODELS } from '@earendil-works/pi-ai/providers/anthropic.models';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import {
	type AgentRuntime,
	type AgentRuntimeStatus,
	REASONING_LEVELS,
	type Reasoning,
	type RuntimeContent,
	type RuntimeConversation,
	type RuntimeConversationOptions,
	type RuntimeEvent,
	type RuntimeUsage,
	type SubscriptionModel,
} from '../../core/ports.ts';

/**
 * Claude Code, run through the Claude Agent SDK, as a model for Anton's own
 * agents (docs/claude-code-subscription.md). The program runs unmodified on
 * Anton's server with its built-in tools off: it can only call Anton's tools,
 * over an in-process MCP server, and Anton runs each call. It signs in through
 * its own flow (`claude auth login`) into its own config directory, and Anton
 * never reads its token. This is the only file that imports the SDK.
 */
export type ClaudeCodeOptions = {
	/** Claude Code's own config directory (`CLAUDE_CONFIG_DIR`), where its sign-in lives. */
	configDir: string;
	/** A `claude` executable to run instead of the one the SDK bundles. */
	executable?: string;
};

const GATEWAY = 'claude-code';
/** Claude Code names Anton's tools `mcp__anton__<tool>`. */
const SERVER = 'anton';
const TOOL_PREFIX = `mcp__${SERVER}__`;
/** Claude Code stamps each tools/call with the tool_use block it came from, which pairs the call with its result. */
const TOOL_USE_ID_META = 'claudecode/toolUseId';
const STATUS_TTL_MS = 5 * 60_000;

/** Usage-limit wording from the SDK's USAGE_LIMIT_ERROR_PREFIXES, and the notices it gives when a plan spills into paid extra usage. */
const LIMIT_PREFIXES = ["You've hit your", "You've reached your", "You're out of usage credits", "You're out of extra usage", 'Fable 5 requires usage credits'];
const EXTRA_USAGE_PREFIXES = ["You're now using extra usage", 'Now using extra usage', "You're now using usage credits", 'Now using usage credits'];

/** Only what Claude Code needs to start and reach Anthropic; none of Anton's own keys or tokens. */
const PASSED_ENV = ['PATH', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR'];

/**
 * The child's environment. `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` and
 * `CLAUDE_CODE_OAUTH_TOKEN` are never passed, so calls bill the plan Claude Code signed in to and
 * nothing else; auto-compaction is off because Flue compacts the conversation itself.
 */
export function childEnv(configDir: string, from: NodeJS.ProcessEnv = process.env): Record<string, string> {
	const env: Record<string, string> = {};
	for (const name of PASSED_ENV) if (from[name]) env[name] = from[name];
	return {
		...env,
		HOME: configDir,
		CLAUDE_CONFIG_DIR: configDir,
		CLAUDE_AGENT_SDK_CLIENT_APP: 'anton',
		DISABLE_AUTOUPDATER: '1',
		DISABLE_AUTO_COMPACT: '1',
		CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
		ENABLE_CLAUDEAI_MCP_SERVERS: '0',
		ENABLE_TOOL_SEARCH: 'false',
	};
}

/** The `claude` the SDK bundles for this platform, for the sign-in command. */
function bundledExecutable(): string | null {
	const require = createRequire(import.meta.url);
	const arch = `${process.platform}-${process.arch}`;
	for (const name of [`@anthropic-ai/claude-agent-sdk-${arch}`, `@anthropic-ai/claude-agent-sdk-${arch}-musl`]) {
		try {
			return path.join(path.dirname(require.resolve(`${name}/package.json`)), process.platform === 'win32' ? 'claude.exe' : 'claude');
		} catch {
			// Not installed for this platform.
		}
	}
	return null;
}

/** A single-reader queue: what the SDK reads Anton's messages from, and what Anton reads its events from. */
function channel<T>() {
	const items: T[] = [];
	let waiting: ((result: IteratorResult<T>) => void) | null = null;
	let closed = false;
	return {
		push(item: T) {
			if (closed) return;
			if (waiting) {
				const wake = waiting;
				waiting = null;
				wake({ value: item, done: false });
			} else items.push(item);
		},
		close() {
			closed = true;
			waiting?.({ value: undefined, done: true });
			waiting = null;
		},
		[Symbol.asyncIterator](): AsyncIterator<T> {
			return {
				next: () => {
					if (items.length) return Promise.resolve({ value: items.shift()!, done: false });
					if (closed) return Promise.resolve({ value: undefined, done: true });
					return new Promise((resolve) => (waiting = resolve));
				},
			};
		},
	};
}

const usageOf = (usage: Record<string, unknown> | undefined): RuntimeUsage => ({
	input: Number(usage?.input_tokens ?? 0),
	output: Number(usage?.output_tokens ?? 0),
	cacheRead: Number(usage?.cache_read_input_tokens ?? 0),
	cacheWrite: Number(usage?.cache_creation_input_tokens ?? 0),
});

const textOf = (content: unknown): string =>
	Array.isArray(content)
		? content
				.filter((block): block is { type: 'text'; text: string } => block?.type === 'text' && typeof block.text === 'string')
				.map((block) => block.text)
				.join('\n')
		: typeof content === 'string'
			? content
			: '';

const isLimit = (text: string) => LIMIT_PREFIXES.some((prefix) => text.includes(prefix));

/** Turns one SDK message into Anton's runtime events. Subagent messages never occur: Claude Code has no Task tool here. */
export function toRuntimeEvents(message: SDKMessage, state: { limited: boolean; failed: boolean }): RuntimeEvent[] {
	if ('parent_tool_use_id' in message && message.parent_tool_use_id) return [];
	switch (message.type) {
		case 'stream_event': {
			const event = message.event;
			switch (event.type) {
				case 'message_start':
					state.failed = false;
					return [{ type: 'message_start', id: event.message.id, usage: usageOf(event.message.usage as unknown as Record<string, unknown>) }];
				case 'content_block_start': {
					const block = event.content_block;
					if (block.type === 'text') return [{ type: 'block_start', index: event.index, block: { type: 'text' } }];
					if (block.type === 'thinking') return [{ type: 'block_start', index: event.index, block: { type: 'thinking' } }];
					if (block.type === 'tool_use') {
						const name = block.name.startsWith(TOOL_PREFIX) ? block.name.slice(TOOL_PREFIX.length) : block.name;
						return [{ type: 'block_start', index: event.index, block: { type: 'tool_use', id: block.id, name } }];
					}
					return [];
				}
				case 'content_block_delta': {
					const delta = event.delta;
					if (delta.type === 'text_delta') return [{ type: 'block_delta', index: event.index, text: delta.text }];
					if (delta.type === 'thinking_delta') return [{ type: 'block_delta', index: event.index, thinking: delta.thinking }];
					if (delta.type === 'signature_delta') return [{ type: 'block_delta', index: event.index, signature: delta.signature }];
					if (delta.type === 'input_json_delta') return [{ type: 'block_delta', index: event.index, json: delta.partial_json }];
					return [];
				}
				case 'content_block_stop':
					return [{ type: 'block_stop', index: event.index }];
				case 'message_delta': {
					const usage = event.usage as unknown as Record<string, unknown> | undefined;
					return [
						{
							type: 'message_delta',
							stopReason: event.delta.stop_reason ?? null,
							usage: {
								output: Number(usage?.output_tokens ?? 0),
								...(usage?.input_tokens ? { input: Number(usage.input_tokens) } : {}),
								...(usage?.cache_read_input_tokens ? { cacheRead: Number(usage.cache_read_input_tokens) } : {}),
								...(usage?.cache_creation_input_tokens ? { cacheWrite: Number(usage.cache_creation_input_tokens) } : {}),
							},
						},
					];
				}
				case 'message_stop':
					return [{ type: 'message_stop' }];
				default:
					return [];
			}
		}
		case 'assistant': {
			// A model call Claude Code gave up on arrives as a whole message with `error` set, and no stream events.
			if (!message.error) return [];
			const text = textOf(message.message.content) || `Claude Code could not reach Claude (${message.error}).`;
			state.failed = true;
			return [{ type: 'error', message: text, limit: state.limited || message.error === 'rate_limit' || isLimit(text) }];
		}
		case 'rate_limit_event': {
			const info = message.rate_limit_info;
			if (info.status === 'rejected') state.limited = true;
			return [];
		}
		case 'result': {
			const events: RuntimeEvent[] = [];
			if (message.is_error && !state.failed) {
				const text = message.subtype === 'success' ? message.result : message.errors.join('\n') || `Claude Code stopped: ${message.subtype}`;
				events.push({ type: 'error', message: text, limit: state.limited || isLimit(text) });
			}
			state.failed = false;
			state.limited = false;
			events.push({ type: 'turn_end' });
			return events;
		}
		default:
			return [];
	}
}

/** Whether a notice from Claude Code says the plan's limit ran out and calls now bill paid extra usage. */
export function isExtraUsageNotice(message: SDKMessage): boolean {
	if (message.type === 'rate_limit_event') return Boolean(message.rate_limit_info.isUsingOverage || message.rate_limit_info.overageInUse);
	if (message.type === 'system' && message.subtype === 'informational') return EXTRA_USAGE_PREFIXES.some((prefix) => message.content.startsWith(prefix));
	if (message.type === 'system' && message.subtype === 'notification') return EXTRA_USAGE_PREFIXES.some((prefix) => message.text.startsWith(prefix));
	return false;
}

type PiAnthropic = (typeof ANTHROPIC_MODELS)[keyof typeof ANTHROPIC_MODELS];
const piModels = Object.values(ANTHROPIC_MODELS) as PiAnthropic[];

/** pi's entry for the model, else the newest entry of its family (`claude-opus-…`) for a model pi does not know yet. */
function piEntry(id: string): PiAnthropic | undefined {
	const exact = piModels.find((model) => model.id === id);
	if (exact) return exact;
	const family = id.match(/^claude-[a-z]+-/)?.[0];
	return family ? piModels.filter((model) => model.id.startsWith(family) && !/\d{8}$/.test(model.id)).at(-1) : undefined;
}

/**
 * Plan models are given a 200K context: Claude Code serves 1M only on some plans and only when asked
 * by a `[1m]` name, and a conversation that outgrows what the plan serves fails. Flue compacts at this size.
 */
const PLAN_CONTEXT = 200_000;

/** `claude-opus-4-7` as "Claude Opus 4.7"; a dated snapshot drops its date. */
export function nameOf(id: string): string {
	const [, family = '', ...version] = id.replace(/-\d{8}$/, '').split('-');
	return `Claude ${family.charAt(0).toUpperCase()}${family.slice(1)} ${version.join('.')}`.trim();
}

/** One of the models Claude Code offers the account, as Anton lists it. Aliases such as `default` are left out. */
export function toSubscriptionModel(listed: ClaudeModel, gateway = GATEWAY): SubscriptionModel | null {
	const id = listed.resolvedModel ?? listed.value;
	if (!id.startsWith('claude-')) return null;
	const pi = piEntry(id);
	// Claude Code describes a model as "Opus 4.7 · Best for everyday tasks", or with the second part only.
	const parts = listed.description.split(' · ');
	const description = parts.length > 1 ? parts.slice(1).join(' · ') : listed.description;
	const efforts = (listed.supportedEffortLevels ?? []) as Reasoning[];
	const levels: Reasoning[] = listed.supportsAdaptiveThinking || efforts.length ? ['off', ...efforts] : [];
	const reasoning = REASONING_LEVELS.filter((level) => levels.includes(level));
	return {
		id: `${gateway}/${id}`,
		name: nameOf(id),
		vendor: 'Anthropic',
		description: description || 'Runs on your Claude plan through Claude Code.',
		createdAt: 0,
		contextLength: Math.min(PLAN_CONTEXT, pi?.contextWindow ?? PLAN_CONTEXT),
		maxOutput: pi?.maxTokens ?? null,
		vision: pi?.input.includes('image') ?? true,
		reasoning,
		defaultReasoning: reasoning.includes('high') ? 'high' : (reasoning.findLast((level) => level !== 'off') ?? 'off'),
		listPrice: pi ? { input: pi.cost.input, output: pi.cost.output, cacheRead: pi.cost.cacheRead, cacheWrite: pi.cost.cacheWrite } : null,
	};
}

export function toModels(listed: ClaudeModel[], gateway = GATEWAY): SubscriptionModel[] {
	const models = new Map<string, SubscriptionModel>();
	for (const entry of listed) {
		const model = toSubscriptionModel(entry, gateway);
		if (model && !models.has(model.id)) models.set(model.id, model);
	}
	// A dated snapshot listed beside its undated name is the same model twice.
	return [...models.values()].filter((model) => !/-\d{8}$/.test(model.id) || !models.has(model.id.replace(/-\d{8}$/, '')));
}

type Account = { email?: string; subscriptionType?: string; tokenSource?: string; apiKeySource?: string; apiProvider?: string };

/** What the account says about the sign-in. An API key or a cloud provider would bill something other than the plan. */
export function statusFrom(account: Account, version: string | null): AgentRuntimeStatus {
	const plan = account.subscriptionType && account.subscriptionType !== 'Claude API' ? account.subscriptionType : null;
	const base = { email: account.email ?? null, plan, version };
	if (account.apiProvider && account.apiProvider !== 'firstParty') {
		return { ...base, signedIn: false, problem: `Claude Code is set up for ${account.apiProvider}, not a Claude plan.` };
	}
	if (account.apiKeySource && account.apiKeySource !== 'none') {
		return { ...base, signedIn: false, problem: `Claude Code is using an API key (${account.apiKeySource}), which bills per token instead of your plan.` };
	}
	const signedIn = Boolean(account.email || plan || (account.tokenSource && account.tokenSource !== 'none'));
	return { ...base, signedIn, problem: null };
}

/** The in-process MCP server that offers Anton's tools, served with their JSON Schemas as they are. */
function toolServer(options: RuntimeConversationOptions) {
	const server = new McpServer({ name: SERVER, version: '1.0.0' }, { capabilities: { tools: {} } });
	const names = new Set(options.tools.map((tool) => tool.name));
	server.server.setRequestHandler(ListToolsRequestSchema, () => ({
		tools: options.tools.map((tool) => ({
			name: tool.name,
			description: tool.description,
			inputSchema: { ...tool.inputSchema, type: 'object' as const },
			// Every tool up front: Claude Code has no tool search here to find a deferred one.
			_meta: { 'anthropic/alwaysLoad': true },
		})),
	}));
	server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
		const name = request.params.name;
		if (!names.has(name)) throw new Error(`Unknown tool: ${name}`);
		const toolUseId = request.params._meta?.[TOOL_USE_ID_META];
		if (typeof toolUseId !== 'string') throw new Error(`${name}: the call carries no tool_use id, so its result cannot be paired with it`);
		const output = await options.callTool(toolUseId, name);
		return { content: output.content, isError: output.isError };
	});
	return { type: 'sdk' as const, name: SERVER, instance: server };
}

const userMessage = (content: RuntimeContent[]): SDKUserMessage => ({
	type: 'user',
	parent_tool_use_id: null,
	message: {
		role: 'user',
		content: content.map((part) =>
			part.type === 'text'
				? { type: 'text' as const, text: part.text }
				: { type: 'image' as const, source: { type: 'base64' as const, media_type: part.mimeType as 'image/png', data: part.data } },
		),
	},
});

export function claudeCodeRuntime(options: ClaudeCodeOptions): AgentRuntime {
	// An empty folder outside any repository: Claude Code has no tools to touch it, and no project to read.
	const workDir = path.join(options.configDir, 'work');
	const executable = options.executable || bundledExecutable();

	function baseOptions(): Options {
		mkdirSync(workDir, { recursive: true });
		return {
			cwd: workDir,
			env: childEnv(options.configDir),
			tools: [],
			settingSources: [],
			strictMcpConfig: true,
			persistSession: false,
			settings: { includeGitInstructions: false, autoMemoryEnabled: false },
			...(options.executable ? { pathToClaudeCodeExecutable: options.executable } : {}),
		};
	}

	let probed: { at: number; result: Promise<{ status: AgentRuntimeStatus; models: SubscriptionModel[] }> } | null = null;

	/** Starts Claude Code without sending anything, to read its sign-in and models; no model call is made. */
	async function probe(): Promise<{ status: AgentRuntimeStatus; models: SubscriptionModel[] }> {
		const idle = channel<SDKUserMessage>();
		const session = query({ prompt: idle, options: baseOptions() });
		try {
			const [account, init] = await Promise.all([session.accountInfo(), session.initializationResult()]);
			const status = statusFrom(account, init.claude_code_version ?? null);
			return { status, models: status.signedIn ? toModels(await session.supportedModels()) : [] };
		} finally {
			idle.close();
			session.close();
		}
	}

	function probeCached(fresh = false) {
		if (fresh || !probed || Date.now() - probed.at > STATUS_TTL_MS) {
			const result = probe();
			probed = { at: Date.now(), result };
			result.catch(() => probed?.result === result && (probed = null));
		}
		return probed.result;
	}

	return {
		id: 'claude',
		name: 'Claude',
		gateway: GATEWAY,
		signInCommand: `CLAUDE_CONFIG_DIR=${options.configDir} ${executable ?? 'claude'} auth login`,
		status: async (fresh) => {
			try {
				return (await probeCached(fresh)).status;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { signedIn: false, email: null, plan: null, version: null, problem: `Claude Code did not start: ${message}` };
			}
		},
		listModels: async () => (await probeCached(true)).models,
		open(conversation: RuntimeConversationOptions): RuntimeConversation {
			const input = channel<SDKUserMessage>();
			const effort = conversation.effort && conversation.effort !== 'off' ? (conversation.effort as Options['effort']) : undefined;
			const session = query({
				prompt: input,
				options: {
					...baseOptions(),
					model: conversation.model,
					// Claude Code's own prompt stays; Anton's instructions follow it.
					systemPrompt: { type: 'preset', preset: 'claude_code', append: conversation.instructions },
					mcpServers: { [SERVER]: toolServer(conversation) },
					allowedTools: [`mcp__${SERVER}`],
					// Anything else Claude Code might ask to run is refused without asking.
					permissionMode: 'dontAsk',
					includePartialMessages: true,
					thinking: conversation.effort === 'off' ? { type: 'disabled' } : { type: 'adaptive', display: 'summarized' },
					...(effort ? { effort } : {}),
				},
			});
			const state = { limited: false, failed: false };
			async function* events(): AsyncGenerator<RuntimeEvent> {
				try {
					for await (const message of session) {
						if (isExtraUsageNotice(message)) yield { type: 'extra_usage' };
						yield* toRuntimeEvents(message, state);
					}
				} finally {
					input.close();
				}
			}
			return {
				send: (content) => input.push(userMessage(content)),
				events: events(),
				close: () => {
					input.close();
					session.close();
				},
			};
		},
	};
}

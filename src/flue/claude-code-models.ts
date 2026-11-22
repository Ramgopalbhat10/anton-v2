import { createHash, randomUUID } from 'node:crypto';
import {
	type AssistantMessage,
	type AssistantMessageEventStream,
	calculateCost,
	clampThinkingLevel,
	type Context,
	createAssistantMessageEventStream,
	createProvider,
	type Message,
	type Model,
	parseStreamingJson,
	type Provider,
	type SimpleStreamOptions,
	type ToolCall,
} from '@earendil-works/pi-ai';
import { type AgentRuntime, type ModelInfo, REASONING_LEVELS, type RuntimeContent, type RuntimeConversation, type RuntimeEvent, type RuntimeTool, type RuntimeToolOutput } from '../core/ports.ts';

/** Flue's tool shape to the runtime's; schemas are deep-copied so a later mutation cannot leak in. */
const runtimeTools = (tools: Context['tools']): RuntimeTool[] =>
	(tools ?? []).map((tool) => ({ name: tool.name, description: tool.description, inputSchema: JSON.parse(JSON.stringify(tool.parameters)) }));

/**
 * Flue calls the model once per step and runs the tools itself; the vendor's agent runs a whole loop. The bridge meets
 * them at tool calls: a step ends when the model asks for tools, and the next step hands the agent Flue's results.
 * A conversation stays open while the context Flue sends only grows; otherwise a new one replays it as text.
 */
export type ClaudeCodeHooks = {
	onLimit?(): void;
	onExtraUsage?(): void;
	maxOpen?: number;
};

export type RuntimePlan = {
	/** The `<gateway>` its models are named under, and pi's provider and API id. */
	gateway: string;
	name: string;
	program: string;
	plan: string;
	/** A level left out is passed as it is. */
	efforts?: Record<string, string>;
	/** The runtime reports usage once when its turn ends (ACP's `session/prompt`), so a step without usage is unmeasured, not zero: estimating it would count the whole context as fresh uncached input on every step. */
	turnUsage?: boolean;
	/** How long an idle conversation stays open; IDLE_MS (Claude Code's cache lifetime) when left out. */
	idleMs?: number;
};

export type RuntimeOpener = Pick<AgentRuntime, 'open'>;

/**
 * Claude Code caches a plan's conversation for an hour, and a closed one is replayed as text that nothing cached
 * matches: a long thread that closed after ten idle minutes sent its whole context again uncached.
 */
export const IDLE_MS = 55 * 60_000;
const MAX_OPEN = 3;

type RuntimeModel = Model<string>;

const CLAUDE_CODE: RuntimePlan = {
	gateway: 'claude-code',
	name: 'Claude (Claude Code)',
	program: 'Claude Code',
	plan: 'Claude',
	// `minimal` has no counterpart in Claude Code, so it runs at `low`.
	efforts: { minimal: 'low' },
};

/** Cursor maps Anton's levels to each model's own values (`src/providers/cursor/plan.ts`). */
const CURSOR: RuntimePlan = { gateway: 'cursor', name: 'Cursor (Cursor SDK)', program: 'Cursor', plan: 'Cursor' };

function toPiModel(info: ModelInfo, plan: RuntimePlan): RuntimeModel {
	return {
		id: info.id.slice(`${plan.gateway}/`.length),
		name: info.name,
		api: plan.gateway,
		provider: plan.gateway,
		baseUrl: `${plan.gateway}:`,
		reasoning: info.reasoning.length > 0,
		// Levels the plan does not offer are null, so Flue moves a task's level to the nearest one it does.
		thinkingLevelMap: Object.fromEntries(
			REASONING_LEVELS.map((level) => [level, info.reasoning.includes(level) ? (level === 'off' ? 'off' : (plan.efforts?.[level] ?? level)) : null]),
		),
		input: info.vision ? ['text', 'image'] : ['text'],
		cost: info.price,
		contextWindow: info.contextLength,
		maxTokens: info.maxOutput ?? 64_000,
	};
}

/** Flue stores and rebuilds messages, so this leaves out what it may not keep (such as response ids). */
export function fingerprint(message: Message): string {
	const hash = (value: unknown) => createHash('sha1').update(JSON.stringify(value)).digest('base64url');
	if (message.role === 'toolResult') return `r:${message.toolCallId}`;
	if (message.role === 'user') return `u:${hash(message.content)}`;
	const parts = message.content.map((block) => (block.type === 'toolCall' ? `t:${block.id}` : block.type === 'text' ? `x:${hash(block.text)}` : ''));
	return `a:${parts.filter(Boolean).join(',')}`;
}

const asContent = (content: Message['content']): RuntimeContent[] =>
	typeof content === 'string'
		? [{ type: 'text', text: content }]
		: content.flatMap((part): RuntimeContent[] =>
				part.type === 'text' ? [{ type: 'text', text: part.text }] : part.type === 'image' ? [{ type: 'image', data: part.data, mimeType: part.mimeType }] : [],
			);

const plainText = (content: Message['content']): string =>
	typeof content === 'string'
		? content
		: content.map((part) => (part.type === 'text' ? part.text : part.type === 'image' ? '[image]' : part.type === 'thinking' ? '' : '')).join('\n');

/**
 * What a new session is handed of the conversation it takes over, in characters. Antigravity kept only the first ~140 KB of
 * a 1.9 MB replay and cut the rest, the newest part with the user's latest message in it; past this the oldest go first.
 */
export const REPLAY_CHARS = 100_000;
/** Of that, what the newest messages may fill whole before older tool results and arguments shrink to a line. */
const WHOLE_SHARE = 0.6;
const ARGS_CHARS = 240;
const OLD_USER_CHARS = 4_000;
/** Small, and the list the user follows: a write of it is never shortened. */
const KEPT_WHOLE = new Set(['update_todos']);

const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max)}… [${(text.length - max).toLocaleString('en-US')} more characters left out]`);

function renderLine(message: Message, short: boolean): string {
	if (message.role === 'user') return `[user]\n${short ? clip(plainText(message.content), OLD_USER_CHARS) : plainText(message.content)}`;
	if (message.role === 'toolResult') {
		const text = plainText(message.content);
		const head = `[result of ${message.toolName}${message.isError ? ', failed' : ''}]`;
		return short && !KEPT_WHOLE.has(message.toolName)
			? `${head} ${text.length.toLocaleString('en-US')} characters, left out of this replay: call the tool again if you need it.`
			: `${head}\n${text}`;
	}
	const text = message.content.flatMap((block) => (block.type === 'text' ? [block.text] : []));
	const calls = message.content.flatMap((block) => {
		if (block.type !== 'toolCall') return [];
		const args = JSON.stringify(block.arguments);
		return [`[called ${block.name} ${short && !KEPT_WHOLE.has(block.name) ? clip(args, ARGS_CHARS) : args}]`];
	});
	return `[assistant]\n${[...text, ...calls].join('\n')}`;
}

/**
 * Newest first: messages go in whole while they fit the whole share, then each as a line (a tool result as its size, a
 * call with its arguments cut), and what still does not fit is left out from the oldest end.
 */
function replayLines(history: Message[], budget: number): { lines: string[]; omitted: number; full: number } {
	const kept: string[] = [];
	let used = 0;
	let whole = true;
	let full = 0;
	let omitted = 0;
	for (let index = history.length - 1; index >= 0; index--) {
		const long = renderLine(history[index], false);
		full += long.length;
		if (omitted) {
			omitted++;
			continue;
		}
		if (whole && used + long.length <= budget * WHOLE_SHARE) {
			kept.push(long);
			used += long.length;
			continue;
		}
		whole = false;
		const line = renderLine(history[index], true);
		if (used + line.length > budget) {
			omitted++;
			continue;
		}
		kept.push(line);
		used += line.length;
	}
	kept.reverse();
	if (omitted) kept.unshift(`[${omitted} older message${omitted === 1 ? '' : 's'} left out of this replay]`);
	return { lines: kept, omitted, full };
}

export type ReplayNote = { full: number; sent: number; omitted: number };

/**
 * A new session takes over a conversation as text. The user's latest message always goes whole and on its own, after
 * the history before it; mid-turn, the work done since follows it and the agent carries on from the last tool result.
 */
export function transcript(messages: Message[], budget = REPLAY_CHARS, note?: (replay: ReplayNote) => void): RuntimeContent[] {
	const lastUser = messages.findLastIndex((message) => message.role === 'user');
	const last = messages[lastUser];
	if (lastUser === 0 && messages.length === 1) return asContent(last.content);
	const ended = lastUser === messages.length - 1;
	const before = lastUser < 0 ? messages : messages.slice(0, lastUser);
	const since = lastUser < 0 || ended ? [] : messages.slice(lastUser + 1);
	// The work since the latest message is the newest, so it is fitted first (leaving room for the earlier requests) and the history before gets the rest.
	const work = replayLines(since, before.length ? budget * 0.7 : budget);
	const workChars = work.lines.reduce((sum, line) => sum + line.length, 0);
	const past = replayLines(before, budget - workChars);
	const sent = workChars + past.lines.reduce((sum, line) => sum + line.length, 0);
	if (sent < past.full + work.full) note?.({ full: past.full + work.full, sent, omitted: past.omitted + work.omitted });
	const parts: RuntimeContent[] = [];
	if (past.lines.length)
		parts.push({
			type: 'text',
			text: `<conversation_so_far>\nThis conversation began before this session. Here it is, oldest first; you made the tool calls, and their results follow them. Older tool results and arguments may be shortened to a line.\n\n${past.lines.join('\n\n')}\n</conversation_so_far>`,
		});
	if (ended) return [...parts, ...asContent(last.content)];
	if (last) parts.push({ type: 'text', text: 'The user’s latest message, which you are working on:' }, ...asContent(last.content));
	if (work.lines.length) parts.push({ type: 'text', text: `<work_since_that_message>\n${work.lines.join('\n\n')}\n</work_since_that_message>` });
	parts.push({ type: 'text', text: 'Carry on from the last tool result.' });
	return parts;
}

const emptyUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });

/** As the runtime counts an image when it estimates. */
const IMAGE_CHARS = 4800;

function charsOf(content: Message['content']): number {
	if (typeof content === 'string') return content.length;
	let chars = 0;
	for (const part of content as Array<Exclude<Message['content'], string>[number]>) {
		if (part.type === 'text') chars += part.text.length;
		else if (part.type === 'thinking') chars += part.thinking.length;
		else if (part.type === 'toolCall') chars += part.name.length + JSON.stringify(part.arguments).length;
		else if (part.type === 'image') chars += IMAGE_CHARS;
	}
	return chars;
}

/**
 * By the runtime's rule of thumb (four characters a token). Cursor counts a whole run at its end, so its sum would read
 * as a context far past the window and the runtime would compact after every long reply.
 */
export function estimatedUsage(context: Context, written: AssistantMessage['content']): { input: number; output: number } {
	const sent = (context.systemPrompt ?? '').length + JSON.stringify(context.tools ?? []).length + context.messages.reduce((sum, message) => sum + charsOf(message.content), 0);
	return { input: Math.ceil(sent / 4), output: Math.ceil(charsOf(written) / 4) };
}

type Settings = { model: string; instructions: string; tools: string; effort: string };

class Bridged {
	readonly conversation: RuntimeConversation;
	readonly events: AsyncIterator<RuntimeEvent>;
	seen: string[] = [];
	awaiting = new Set<string>();
	/** Turns that ended for Flue whose `turn_end` is still to come. */
	turnsToDrain = 0;
	busy = false;
	usedAt = Date.now();
	closed = false;
	private readonly results = new Map<string, RuntimeToolOutput>();
	private readonly parked = new Map<string, (output: RuntimeToolOutput) => void>();

	readonly settings: Settings;

	constructor(runtime: RuntimeOpener, settings: Settings, tools: Context['tools']) {
		this.settings = settings;
		this.conversation = runtime.open({
			model: settings.model,
			instructions: settings.instructions,
			effort: settings.effort,
			tools: runtimeTools(tools),
			callTool: (toolUseId) => {
				const ready = this.results.get(toolUseId);
				if (ready) {
					this.results.delete(toolUseId);
					return Promise.resolve(ready);
				}
				return new Promise((resolve) => this.parked.set(toolUseId, resolve));
			},
		});
		this.events = this.conversation.events[Symbol.asyncIterator]();
	}

	deliver(toolCallId: string, output: RuntimeToolOutput): void {
		this.awaiting.delete(toolCallId);
		const waiting = this.parked.get(toolCallId);
		if (waiting) {
			this.parked.delete(toolCallId);
			waiting(output);
		} else this.results.set(toolCallId, output);
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		for (const resolve of this.parked.values()) resolve({ content: [{ type: 'text', text: 'The conversation was closed.' }], isError: true });
		this.parked.clear();
		this.conversation.close();
	}
}

const sameSettings = (a: Settings, b: Settings) => a.model === b.model && a.instructions === b.instructions && a.tools === b.tools && a.effort === b.effort;

/** Null when they do not fit, and a new conversation is needed. */
export function continuation(
	added: Message[],
	awaiting: ReadonlySet<string>,
): { results: Array<Extract<Message, { role: 'toolResult' }>>; user: RuntimeContent[] } | null {
	const results = added.filter((message) => message.role === 'toolResult');
	const users = added.filter((message) => message.role === 'user');
	if (results.length + users.length !== added.length) return null;
	if (awaiting.size) {
		if (results.length !== awaiting.size || results.some((result) => !awaiting.has(result.toolCallId))) return null;
	} else if (results.length || !users.length) return null;
	return { results, user: users.flatMap((message) => asContent(message.content)) };
}

/** Shared by all agents, so each plan's cap counts them all. */
const conversations = new Map<string, Map<string, Bridged>>();
const idleLimits = new Map<string, number>();
let sweeping: ReturnType<typeof setInterval> | undefined;

const openFor = (gateway: string): Map<string, Bridged> => {
	let open = conversations.get(gateway);
	if (!open) conversations.set(gateway, (open = new Map()));
	return open;
};

/** Waiting on tools counts, such as a subagent that works for longer than any idle limit. */
const working = (bridged: Bridged) => bridged.busy || bridged.awaiting.size > 0;

export function sweepIdle(now = Date.now()): void {
	for (const [gateway, open] of conversations) {
		const idleMs = idleLimits.get(gateway) ?? IDLE_MS;
		for (const [key, bridged] of open) {
			if (!working(bridged) && now - bridged.usedAt > idleMs) {
				bridged.close();
				open.delete(key);
			}
		}
	}
}

/** Busy ones, and ones waiting on tools, are never closed. */
function makeRoom(open: Map<string, Bridged>, maxOpen: number): void {
	const idle = [...open].filter(([, bridged]) => !working(bridged)).sort(([, a], [, b]) => a.usedAt - b.usedAt);
	while (open.size >= maxOpen && idle.length) {
		const [key, bridged] = idle.shift()!;
		bridged.close();
		open.delete(key);
	}
}

export function closeClaudeCodeConversations(): void {
	for (const open of conversations.values()) {
		for (const bridged of open.values()) bridged.close();
		open.clear();
	}
}

export function claudeCodeProvider(live: () => readonly ModelInfo[], runtime: () => AgentRuntime | undefined, hooks: ClaudeCodeHooks = {}): Provider {
	return runtimeProvider(CLAUDE_CODE, live, runtime, hooks);
}

export function cursorProvider(live: () => readonly ModelInfo[], runtime: () => Promise<RuntimeOpener | undefined>, hooks: ClaudeCodeHooks = {}): Provider {
	return runtimeProvider(CURSOR, live, runtime, hooks);
}

export function runtimeProvider(
	plan: RuntimePlan,
	live: () => readonly ModelInfo[],
	runtime: () => RuntimeOpener | undefined | Promise<RuntimeOpener | undefined>,
	hooks: ClaudeCodeHooks = {},
): Provider {
	const maxOpen = Math.max(1, hooks.maxOpen ?? MAX_OPEN);
	const open = openFor(plan.gateway);
	if (plan.idleMs) idleLimits.set(plan.gateway, plan.idleMs);
	if (!sweeping) {
		sweeping = setInterval(sweepIdle, 60_000);
		sweeping.unref();
	}

	async function run(model: RuntimeModel, context: Context, options: SimpleStreamOptions | undefined, stream: AssistantMessageEventStream): Promise<void> {
		const output: AssistantMessage = {
			role: 'assistant',
			content: [],
			api: plan.gateway,
			provider: plan.gateway,
			model: model.id,
			usage: emptyUsage(),
			stopReason: 'pending',
			timestamp: Date.now(),
		};
		const fail = (reason: 'error' | 'aborted', message: string) => {
			output.stopReason = reason;
			output.errorMessage = message;
			stream.push({ type: 'error', reason, error: output });
			stream.end();
		};
		let agent: RuntimeOpener | undefined;
		try {
			agent = await runtime();
		} catch (error) {
			return fail('error', error instanceof Error ? error.message : String(error));
		}
		if (!agent) return fail('error', `${plan.program} is not set up on this server.`);

		const key = options?.sessionId ?? `once-${randomUUID()}`;
		const mapped = options?.reasoning ? model.thinkingLevelMap?.[clampThinkingLevel(model, options.reasoning)] : undefined;
		const settings: Settings = {
			model: model.id,
			instructions: context.systemPrompt ?? '',
			tools: JSON.stringify((context.tools ?? []).map((tool) => [tool.name, tool.description, tool.parameters])),
			effort: mapped && mapped !== 'off' ? mapped : 'off',
		};
		const prints = context.messages.map(fingerprint);
		let bridged = open.get(key);
		let fits =
			bridged &&
			!bridged.closed &&
			!bridged.busy &&
			bridged.settings.model === settings.model &&
			bridged.settings.instructions === settings.instructions &&
			bridged.settings.effort === settings.effort &&
			bridged.seen.length < prints.length &&
			bridged.seen.every((print, index) => prints[index] === print);
		// A changed tool list does not cost a session when the runtime can swap it live;
		// model, instructions and effort still do.
		if (fits && bridged!.settings.tools !== settings.tools) {
			if (typeof bridged!.conversation.setTools === 'function') {
				bridged!.conversation.setTools(runtimeTools(context.tools));
				bridged!.settings.tools = settings.tools;
			} else fits = false;
		}
		const next = fits ? continuation(context.messages.slice(bridged!.seen.length), bridged!.awaiting) : null;
		if (bridged && next) {
			for (const result of next.results) bridged.deliver(result.toolCallId, { content: asContent(result.content), isError: result.isError });
			if (next.user.length) bridged.conversation.send(next.user);
		} else {
			if (bridged) {
				// Why the last conversation could not take this one; a respawn costs a fresh agent session.
				const reason = !fits
					? bridged.closed
						? 'closed'
						: bridged.busy
							? 'busy'
							: !sameSettings(bridged.settings, settings)
								? `settings ${(['model', 'instructions', 'tools', 'effort'] as const).filter((f) => bridged!.settings[f] !== settings[f]).join('+') || '?'}`
								: bridged.seen.length >= prints.length
									? 'history-not-longer'
									: 'history-diverged'
					: 'messages-do-not-continue';
				console.error(`[flue:${plan.gateway}] conversation respawns for new messages: ${reason}`);
			}
			if (bridged && !bridged.busy) bridged.close();
			open.delete(key);
			makeRoom(open, maxOpen);
			bridged = new Bridged(agent, settings, context.tools);
			open.set(key, bridged);
			bridged.conversation.send(
				transcript(context.messages, REPLAY_CHARS, (replay) =>
					console.error(
						`[flue:${plan.gateway}] replay to a new session cut to ${replay.sent} of ${replay.full} characters (${replay.omitted} oldest messages left out)`,
					),
				),
			);
		}
		const current = bridged;
		current.seen = prints;
		current.busy = true;
		current.usedAt = Date.now();

		const abandon = () => {
			current.close();
			if (open.get(key) === current) open.delete(key);
		};
		const onAbort = () => abandon();
		options?.signal?.addEventListener('abort', onAbort, { once: true });

		const blocks = new Map<number, { at: number; json: string }>();
		let started = false;
		try {
			stream.push({ type: 'start', partial: output });
			for (;;) {
				if (options?.signal?.aborted) return fail('aborted', 'Request was aborted');
				const { value: event, done } = await current.events.next();
				if (options?.signal?.aborted) return fail('aborted', 'Request was aborted');
				if (done) {
					abandon();
					return fail('error', `${plan.program} stopped unexpectedly.`);
				}
				switch (event.type) {
					case 'message_start':
						started = true;
						output.responseId = event.id;
						Object.assign(output.usage, event.usage);
						break;
					case 'block_start': {
						const at = output.content.length;
						blocks.set(event.index, { at, json: '' });
						if (event.block.type === 'text') {
							output.content.push({ type: 'text', text: '' });
							stream.push({ type: 'text_start', contentIndex: at, partial: output });
						} else if (event.block.type === 'thinking') {
							output.content.push({ type: 'thinking', thinking: '', thinkingSignature: '' });
							stream.push({ type: 'thinking_start', contentIndex: at, partial: output });
						} else {
							output.content.push({ type: 'toolCall', id: event.block.id, name: event.block.name, arguments: {} });
							stream.push({ type: 'toolcall_start', contentIndex: at, partial: output });
						}
						break;
					}
					case 'block_delta': {
						const entry = blocks.get(event.index);
						const block = entry && output.content[entry.at];
						if (!entry || !block) break;
						if (block.type === 'text' && event.text) {
							block.text += event.text;
							stream.push({ type: 'text_delta', contentIndex: entry.at, delta: event.text, partial: output });
						} else if (block.type === 'thinking' && (event.thinking || event.signature)) {
							if (event.signature) block.thinkingSignature = (block.thinkingSignature ?? '') + event.signature;
							if (event.thinking) {
								block.thinking += event.thinking;
								stream.push({ type: 'thinking_delta', contentIndex: entry.at, delta: event.thinking, partial: output });
							}
						} else if (block.type === 'toolCall' && event.json) {
							entry.json += event.json;
							block.arguments = parseStreamingJson(entry.json);
							stream.push({ type: 'toolcall_delta', contentIndex: entry.at, delta: event.json, partial: output });
						}
						break;
					}
					case 'block_stop': {
						const entry = blocks.get(event.index);
						const block = entry && output.content[entry.at];
						if (!entry || !block) break;
						if (block.type === 'text') stream.push({ type: 'text_end', contentIndex: entry.at, content: block.text, partial: output });
						else if (block.type === 'thinking') stream.push({ type: 'thinking_end', contentIndex: entry.at, content: block.thinking, partial: output });
						else {
							block.arguments = parseStreamingJson(entry.json);
							stream.push({ type: 'toolcall_end', contentIndex: entry.at, toolCall: block, partial: output });
						}
						break;
					}
					case 'message_delta':
						Object.assign(output.usage, event.usage);
						if (event.stopReason) output.rawStopReason = event.stopReason;
						break;
					case 'message_stop': {
						if (!started) break;
						const calls = output.content.filter((block): block is ToolCall => block.type === 'toolCall');
						const { input, output: written, cacheRead, cacheWrite } = output.usage;
						if (!input && !written && !cacheRead && !cacheWrite && !plan.turnUsage) Object.assign(output.usage, estimatedUsage(context, output.content));
						output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
						calculateCost(model, output.usage);
						if (calls.length) {
							// The agent now calls each of Anton's tools and waits; Flue runs them and the next step delivers the results.
							current.awaiting = new Set(calls.map((call) => call.id));
							output.stopReason = 'toolUse';
						} else {
							current.awaiting = new Set();
							current.turnsToDrain += 1;
							output.stopReason = output.rawStopReason === 'max_tokens' ? 'length' : 'stop';
						}
						current.seen = [...prints, fingerprint(output)];
						stream.push({ type: 'done', reason: output.stopReason, message: output });
						stream.end();
						return;
					}
					case 'extra_usage':
						hooks.onExtraUsage?.();
						break;
					case 'error':
						if (event.limit) hooks.onLimit?.();
						abandon();
						return fail('error', event.limit ? `${plan.plan} plan limit reached: ${event.message}` : event.message);
					case 'turn_end':
						if (current.turnsToDrain > 0) {
							current.turnsToDrain -= 1;
							break;
						}
						// The turn ended without a model call this step could report.
						abandon();
						return fail('error', `${plan.program} ended the turn without answering.`);
				}
			}
		} catch (error) {
			abandon();
			return fail(options?.signal?.aborted ? 'aborted' : 'error', error instanceof Error ? error.message : String(error));
		} finally {
			current.busy = false;
			current.usedAt = Date.now();
			options?.signal?.removeEventListener('abort', onAbort);
			// A step for the same conversation that started meanwhile replaced this one; nothing will continue it.
			if (open.get(key) !== current) current.close();
			// Nor a call made outside any conversation, such as compaction's summary: its agent would sit open, taking a place.
			else if (!options?.sessionId) abandon();
		}
	}

	const streamSimple = (model: Model<never>, context: Context, options?: SimpleStreamOptions) => {
		const stream = createAssistantMessageEventStream();
		void run(model as unknown as RuntimeModel, context, options, stream);
		return stream;
	};

	const base = createProvider<string>({
		id: plan.gateway,
		name: plan.name,
		auth: {
			apiKey: {
				name: `${plan.program} sign-in`,
				// The agent signs in on its own, or `runtime` hands it its key; pi passes none.
				resolve: async () => ({ auth: { apiKey: plan.gateway }, source: plan.program }),
			},
		},
		models: [],
		api: { stream: streamSimple, streamSimple },
	});
	let memo: { from: readonly ModelInfo[]; models: RuntimeModel[] } | undefined;
	function getModels(): RuntimeModel[] {
		const current = live();
		if (memo?.from !== current) memo = { from: current, models: current.filter((info) => info.id.startsWith(`${plan.gateway}/`)).map((info) => toPiModel(info, plan)) };
		return memo.models;
	}
	return { ...base, getModels } as Provider;
}

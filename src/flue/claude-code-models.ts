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
import { type AgentRuntime, type ModelInfo, REASONING_LEVELS, type RuntimeContent, type RuntimeConversation, type RuntimeEvent, type RuntimeToolOutput } from '../core/ports.ts';

/**
 * Models on a plan that only runs inside the vendor's own agent: Claude Code for
 * a Claude plan (docs/claude-code-subscription.md), and Cursor's SDK for a Cursor
 * plan. Flue calls the model once per step and runs the tools itself; the
 * vendor's agent runs a whole loop and calls tools as it goes. The bridge meets
 * them at tool calls: a step ends when the model asks for tools, the agent waits
 * on Anton's tools meanwhile, and the next step hands it Flue's results and
 * streams on.
 *
 * Each Flue conversation keeps one of the agent's conversations open while the
 * context Flue sends only grows. When it does not (compaction, an edit, a new
 * system prompt or tool list, a restart), the bridge starts a new one and
 * replays the conversation so far as text.
 */
export type ClaudeCodeHooks = {
	/** The plan's usage limit stopped a call. */
	onLimit?(): void;
	/** The plan's limit ran out and the account now pays for extra usage. */
	onExtraUsage?(): void;
	/** At most this many Claude Code conversations stay open; the longest idle closes first. */
	maxOpen?: number;
};

/** Which plan and agent a bridge serves, for its model ids and what it says when something goes wrong. */
export type RuntimePlan = {
	/** The `<gateway>` its models are named under, and pi's provider and API id. */
	gateway: string;
	/** The provider as pi lists it: "Claude (Claude Code)". */
	name: string;
	/** The agent, as errors name it: "Claude Code". */
	program: string;
	/** The plan, as errors name it: "Claude". */
	plan: string;
	/** Anton's reasoning levels as the agent's own; a level left out is passed as it is. */
	efforts?: Record<string, string>;
};

/** The part of an agent the bridge uses: opening conversations. */
export type RuntimeOpener = Pick<AgentRuntime, 'open'>;

const IDLE_MS = 10 * 60_000;
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

/** Cursor takes Anton's levels as they are and maps them to each model's own values (`src/providers/cursor/plan.ts`). */
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

/**
 * A message as the bridge recognises it again on the next step: Flue stores and
 * rebuilds messages, so this leaves out what it may not keep (such as response ids).
 */
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
 * The conversation so far, for a new Claude Code conversation that did not see
 * it: earlier turns as text, then the latest user message as it was sent.
 */
export function transcript(messages: Message[]): RuntimeContent[] {
	const lastUser = messages.findLastIndex((message) => message.role === 'user');
	const last = messages[lastUser];
	if (lastUser === 0 && messages.length === 1) return asContent(last.content);
	// Rebuilt mid-turn, the latest user message is part of the history and Claude carries on from the last tool result.
	const ended = lastUser === messages.length - 1;
	const history = ended ? messages.slice(0, lastUser) : messages;
	const lines: string[] = [];
	for (const message of history) {
		if (message.role === 'user') lines.push(`[user]\n${plainText(message.content)}`);
		else if (message.role === 'toolResult') lines.push(`[result of ${message.toolName}${message.isError ? ', failed' : ''}]\n${plainText(message.content)}`);
		else {
			const text = message.content.flatMap((block) => (block.type === 'text' ? [block.text] : []));
			const calls = message.content.flatMap((block) => (block.type === 'toolCall' ? [`[called ${block.name} ${JSON.stringify(block.arguments)}]`] : []));
			lines.push(`[assistant]\n${[...text, ...calls].join('\n')}`);
		}
	}
	const intro = {
		type: 'text' as const,
		text: `<conversation_so_far>\nThis conversation began before this session. Here it is, oldest first; you made the tool calls, and their results follow them.\n\n${lines.join('\n\n')}\n</conversation_so_far>`,
	};
	return ended ? [intro, ...asContent(last.content)] : [intro, { type: 'text', text: 'Carry on from the last tool result.' }];
}

const emptyUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });

/** An image, in characters, as the runtime counts one when it estimates. */
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
 * The tokens of a model call the agent did not count, by the runtime's rule of
 * thumb (four characters a token): the context it was sent, and what it wrote.
 * Cursor counts a whole run at its end, every call in it together, so its sum
 * would read as a context far past the window: the runtime would compact (or
 * find nothing to cut) after every long reply, and the context meter would
 * show the run's total.
 */
export function estimatedUsage(context: Context, written: AssistantMessage['content']): { input: number; output: number } {
	const sent = (context.systemPrompt ?? '').length + JSON.stringify(context.tools ?? []).length + context.messages.reduce((sum, message) => sum + charsOf(message.content), 0);
	return { input: Math.ceil(sent / 4), output: Math.ceil(charsOf(written) / 4) };
}

type Settings = { model: string; instructions: string; tools: string; effort: string };

/** One of the agent's conversations behind one Flue conversation. */
class Bridged {
	readonly conversation: RuntimeConversation;
	readonly events: AsyncIterator<RuntimeEvent>;
	/** Fingerprints of the Flue messages this conversation has seen, in order. */
	seen: string[] = [];
	/** Tool calls the last step asked for, whose results Claude Code is waiting on. */
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
			tools: (tools ?? []).map((tool) => ({ name: tool.name, description: tool.description, inputSchema: JSON.parse(JSON.stringify(tool.parameters)) })),
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

	/** Hands the agent a tool's result, now if it is waiting for it, or when it asks. */
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

/**
 * What the new messages ask of a conversation that has seen the rest: results
 * for the tools it waits on, then any messages the user sent meanwhile; or the
 * user's next message. Null when they do not fit, and a new conversation is needed.
 */
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

/** Every open conversation in this process, by gateway and then Flue session, shared by all agents so each plan's cap counts them all. */
const conversations = new Map<string, Map<string, Bridged>>();
let sweeping: ReturnType<typeof setInterval> | undefined;

const openFor = (gateway: string): Map<string, Bridged> => {
	let open = conversations.get(gateway);
	if (!open) conversations.set(gateway, (open = new Map()));
	return open;
};

/** Closes the conversations idle for ten minutes; a later step starts a new one with the conversation so far. */
function sweepIdle(): void {
	for (const open of conversations.values()) {
		for (const [key, bridged] of open) {
			if (!bridged.busy && Date.now() - bridged.usedAt > IDLE_MS) {
				bridged.close();
				open.delete(key);
			}
		}
	}
}

/** Makes room for one more conversation by closing the longest idle ones; busy ones are never closed. */
function makeRoom(open: Map<string, Bridged>, maxOpen: number): void {
	const idle = [...open].filter(([, bridged]) => !bridged.busy).sort(([, a], [, b]) => a.usedAt - b.usedAt);
	while (open.size >= maxOpen && idle.length) {
		const [key, bridged] = idle.shift()!;
		bridged.close();
		open.delete(key);
	}
}

/** Closes every conversation; for tests and shutdown. */
export function closeClaudeCodeConversations(): void {
	for (const open of conversations.values()) {
		for (const bridged of open.values()) bridged.close();
		open.clear();
	}
}

export function claudeCodeProvider(live: () => readonly ModelInfo[], runtime: () => AgentRuntime | undefined, hooks: ClaudeCodeHooks = {}): Provider {
	return runtimeProvider(CLAUDE_CODE, live, runtime, hooks);
}

/** Models on a Cursor plan, run by Cursor's SDK with the plan's key. */
export function cursorProvider(live: () => readonly ModelInfo[], runtime: () => Promise<RuntimeOpener | undefined>, hooks: ClaudeCodeHooks = {}): Provider {
	return runtimeProvider(CURSOR, live, runtime, hooks);
}

/**
 * The bridge for any agent behind the `AgentRuntime` conversation shape.
 * `runtime` may look the agent up as it is needed, such as with a key from Settings.
 */
export function runtimeProvider(
	plan: RuntimePlan,
	live: () => readonly ModelInfo[],
	runtime: () => RuntimeOpener | undefined | Promise<RuntimeOpener | undefined>,
	hooks: ClaudeCodeHooks = {},
): Provider {
	const maxOpen = Math.max(1, hooks.maxOpen ?? MAX_OPEN);
	const open = openFor(plan.gateway);
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
		const fits =
			bridged &&
			!bridged.closed &&
			!bridged.busy &&
			sameSettings(bridged.settings, settings) &&
			bridged.seen.length < prints.length &&
			bridged.seen.every((print, index) => prints[index] === print);
		const next = fits ? continuation(context.messages.slice(bridged!.seen.length), bridged!.awaiting) : null;
		if (bridged && next) {
			for (const result of next.results) bridged.deliver(result.toolCallId, { content: asContent(result.content), isError: result.isError });
			if (next.user.length) bridged.conversation.send(next.user);
		} else {
			if (bridged && !bridged.busy) bridged.close();
			open.delete(key);
			makeRoom(open, maxOpen);
			bridged = new Bridged(agent, settings, context.tools);
			open.set(key, bridged);
			bridged.conversation.send(transcript(context.messages));
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

		/** Content blocks of the current model call by Claude's block index, with their place in `output`. */
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
						if (!input && !written && !cacheRead && !cacheWrite) Object.assign(output.usage, estimatedUsage(context, output.content));
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

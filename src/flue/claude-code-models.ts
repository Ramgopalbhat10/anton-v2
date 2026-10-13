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
 * Models on a Claude plan, run by Claude Code (docs/claude-code-subscription.md).
 * Flue calls the model once per step and runs the tools itself; Claude Code runs
 * a whole loop and calls tools as it goes. The bridge meets them at tool calls:
 * a step ends when Claude asks for tools, Claude Code waits on Anton's MCP tool
 * server meanwhile, and the next step hands it Flue's results and streams on.
 *
 * Each Flue conversation keeps one Claude Code conversation open while the
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

const GATEWAY = 'claude-code';
const API = 'claude-code';
const IDLE_MS = 10 * 60_000;
const MAX_OPEN = 3;

type ClaudeModel = Model<typeof API>;

/** Anton's reasoning levels as Claude Code's efforts; `minimal` has no counterpart, so it runs at `low`. */
const EFFORTS: Record<string, string> = { minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' };

function toPiModel(info: ModelInfo): ClaudeModel {
	return {
		id: info.id.slice(`${GATEWAY}/`.length),
		name: info.name,
		api: API,
		provider: GATEWAY,
		baseUrl: 'claude-code:',
		reasoning: info.reasoning.length > 0,
		// Levels the plan does not offer are null, so Flue moves a task's level to the nearest one it does.
		thinkingLevelMap: Object.fromEntries(REASONING_LEVELS.map((level) => [level, info.reasoning.includes(level) ? (level === 'off' ? 'off' : EFFORTS[level]) : null])),
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

type Settings = { model: string; instructions: string; tools: string; effort: string };

/** One Claude Code conversation behind one Flue conversation. */
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

	constructor(runtime: AgentRuntime, settings: Settings, tools: Context['tools']) {
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

	/** Hands Claude Code a tool's result, now if it is waiting for it, or when it asks. */
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

/** Every open Claude Code conversation in this process, by Flue session, shared by all agents so the cap counts them all. */
const open = new Map<string, Bridged>();
let sweeping: ReturnType<typeof setInterval> | undefined;

/** Closes the conversations idle for ten minutes; a later step starts a new one with the conversation so far. */
function sweepIdle(): void {
	for (const [key, bridged] of open) {
		if (!bridged.busy && Date.now() - bridged.usedAt > IDLE_MS) {
			bridged.close();
			open.delete(key);
		}
	}
}

/** Makes room for one more conversation by closing the longest idle ones; busy ones are never closed. */
function makeRoom(maxOpen: number): void {
	const idle = [...open].filter(([, bridged]) => !bridged.busy).sort(([, a], [, b]) => a.usedAt - b.usedAt);
	while (open.size >= maxOpen && idle.length) {
		const [key, bridged] = idle.shift()!;
		bridged.close();
		open.delete(key);
	}
}

/** Closes every conversation; for tests and shutdown. */
export function closeClaudeCodeConversations(): void {
	for (const bridged of open.values()) bridged.close();
	open.clear();
}

export function claudeCodeProvider(live: () => readonly ModelInfo[], runtime: () => AgentRuntime | undefined, hooks: ClaudeCodeHooks = {}): Provider {
	const maxOpen = Math.max(1, hooks.maxOpen ?? MAX_OPEN);
	if (!sweeping) {
		sweeping = setInterval(sweepIdle, 60_000);
		sweeping.unref();
	}

	async function run(model: ClaudeModel, context: Context, options: SimpleStreamOptions | undefined, stream: AssistantMessageEventStream): Promise<void> {
		const output: AssistantMessage = {
			role: 'assistant',
			content: [],
			api: API,
			provider: GATEWAY,
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
		const agent = runtime();
		if (!agent) return fail('error', 'Claude Code is not set up on this server.');

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
			makeRoom(maxOpen);
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
					return fail('error', 'Claude Code stopped unexpectedly.');
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
						output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
						calculateCost(model, output.usage);
						if (calls.length) {
							// Claude Code now calls each tool on Anton's MCP server and waits; Flue runs them and the next step delivers the results.
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
						return fail('error', event.limit ? `Claude plan limit reached: ${event.message}` : event.message);
					case 'turn_end':
						if (current.turnsToDrain > 0) {
							current.turnsToDrain -= 1;
							break;
						}
						// The turn ended without a model call this step could report.
						abandon();
						return fail('error', 'Claude Code ended the turn without answering.');
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
		}
	}

	const streamSimple = (model: Model<never>, context: Context, options?: SimpleStreamOptions) => {
		const stream = createAssistantMessageEventStream();
		void run(model as unknown as ClaudeModel, context, options, stream);
		return stream;
	};

	const base = createProvider<typeof API>({
		id: GATEWAY,
		name: 'Claude (Claude Code)',
		auth: {
			apiKey: {
				name: 'Claude Code sign-in',
				// Claude Code signs in on its own; Anton holds no key for it.
				resolve: async () => ({ auth: { apiKey: 'claude-code' }, source: 'Claude Code' }),
			},
		},
		models: [],
		api: { stream: streamSimple, streamSimple },
	});
	let memo: { from: readonly ModelInfo[]; models: ClaudeModel[] } | undefined;
	function getModels(): ClaudeModel[] {
		const current = live();
		if (memo?.from !== current) memo = { from: current, models: current.filter((info) => info.id.startsWith(`${GATEWAY}/`)).map(toPiModel) };
		return memo.models;
	}
	return { ...base, getModels } as Provider;
}

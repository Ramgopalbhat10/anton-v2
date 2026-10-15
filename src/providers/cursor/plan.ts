import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type {
	InteractionUpdate,
	LocalAgentStore,
	ModelListItem,
	ModelSelection,
	Run,
	SDKAgent,
	SDKCustomTool,
	SDKCustomToolResult,
	SDKUserMessage,
} from '@cursor/sdk';
import {
	type KeyPlan,
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
 * A Cursor plan, through Cursor's own TypeScript SDK (cursor.com/docs/api/sdk/typescript):
 * a user API key "bills to that user's plan", and the SDK is Cursor's supported
 * way to use it outside its editor. Cursor has no plain model endpoint, so each
 * conversation is a local Cursor agent on Anton's server with its built-in tools
 * off (`tools: ['mcp']`): Anton's tools are its only ones, offered as SDK custom
 * tools, and each call waits until Flue has run the tool in the sandbox, the
 * way the Claude Code bridge works (`src/flue/claude-code-models.ts`). This is
 * the only file that imports the SDK.
 */
export type CursorOptions = {
	/** Where the agents' working folder and Cursor's run store live. */
	dir: string;
	/** The SDK, swapped for a fake in tests. */
	sdk?: () => Promise<CursorSdk>;
};

type CursorSdk = Pick<typeof import('@cursor/sdk'), 'Agent' | 'Cursor' | 'JsonlLocalAgentStore'>;

const GATEWAY = 'cursor';
/** Tool calls made this close together are one model response asking for several tools. */
const BATCH_MS = 40;
const MODELS_TTL_MS = 10 * 60_000;
/** Cursor names a model's effort under one of these, with values such as `extra-high` for Anton's `xhigh`. */
const EFFORT_PARAMS = ['effort', 'reasoning_effort', 'reasoning'];
const LEVELS: Record<string, Reasoning> = { none: 'off', minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', 'extra-high': 'xhigh', max: 'max' };
const DEFAULT_CONTEXT = 200_000;
const LIMIT = /usage limit|spend(ing)? limit|out of (usage|requests|credits)|quota|rate.?limit/i;

const VENDORS: Array<[RegExp, string]> = [
	[/^claude-/, 'Anthropic'],
	[/^gpt-/, 'OpenAI'],
	[/^gemini-/, 'Google'],
	[/^grok-/, 'xAI'],
	[/^kimi-/, 'Moonshot AI'],
	[/^glm-/, 'Z.ai'],
	[/^muse-/, 'Meta'],
];

/** "300k" as 300000 and "1m" as 1000000. */
function sizeOf(value: string): number | null {
	const match = value.match(/^(\d+(?:\.\d+)?)([km])$/i);
	return match ? Math.round(Number(match[1]) * (match[2].toLowerCase() === 'm' ? 1_000_000 : 1_000)) : null;
}

/** The smallest context a model offers: larger ones bill as Max Mode. */
function contextParam(item: ModelListItem): { value: string; size: number } | null {
	const sizes = (item.parameters?.find((param) => param.id === 'context')?.values ?? [])
		.map((option) => ({ value: option.value, size: sizeOf(option.value) }))
		.filter((option): option is { value: string; size: number } => option.size !== null)
		.sort((a, b) => a.size - b.size);
	return sizes[0] ?? null;
}

/** The levels a model takes, from its effort parameter and its thinking switch. */
export function levelsOf(item: ModelListItem): Reasoning[] {
	const params = item.parameters ?? [];
	const effort = params.find((param) => EFFORT_PARAMS.includes(param.id));
	const thinking = params.find((param) => param.id === 'thinking');
	const levels = new Set<Reasoning>();
	for (const option of effort?.values ?? []) {
		const level = LEVELS[option.value];
		if (level) levels.add(level);
	}
	if (thinking?.values.some((option) => option.value === 'false')) levels.add('off');
	// Thinking that only switches on runs at the model's own effort, shown as `high`.
	if (thinking && !effort && thinking.values.some((option) => option.value === 'true')) levels.add('high');
	return REASONING_LEVELS.filter((level) => levels.has(level));
}

/** One of the models Cursor offers the account, as Anton lists it. `default` is an alias and is left out. */
export function toSubscriptionModel(item: ModelListItem): SubscriptionModel | null {
	if (item.id === 'default') return null;
	const reasoning = levelsOf(item);
	return {
		id: `${GATEWAY}/${item.id}`,
		name: item.displayName || item.id,
		vendor: VENDORS.find(([pattern]) => pattern.test(item.id))?.[1] ?? 'Cursor',
		description: item.description || 'Runs on your Cursor plan through the Cursor SDK.',
		createdAt: 0,
		contextLength: contextParam(item)?.size ?? DEFAULT_CONTEXT,
		maxOutput: null,
		vision: true,
		reasoning,
		defaultReasoning: reasoning.includes('high') ? 'high' : (reasoning.findLast((level) => level !== 'off') ?? 'off'),
		listPrice: null,
	};
}

/**
 * The model and its parameters for a conversation at `effort`: the effort value
 * that names it, thinking on unless it is `off`, and the smallest context.
 * Parameters left out take the model's first value, as the SDK does.
 */
export function selectionFor(id: string, item: ModelListItem | undefined, effort: string | null): ModelSelection {
	const params: Array<{ id: string; value: string }> = [];
	const level = effort ?? null;
	for (const param of item?.parameters ?? []) {
		if (EFFORT_PARAMS.includes(param.id) && level) {
			const value = param.values.find((option) => LEVELS[option.value] === level)?.value;
			if (value) params.push({ id: param.id, value });
		} else if (param.id === 'thinking' && level) {
			const value = level === 'off' ? 'false' : 'true';
			if (param.values.some((option) => option.value === value)) params.push({ id: param.id, value });
		} else if (param.id === 'context') {
			const context = contextParam(item!);
			if (context) params.push({ id: param.id, value: context.value });
		}
	}
	return params.length ? { id, params } : { id };
}

/** A single-reader queue of the conversation's events. */
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

const zero = (): RuntimeUsage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

/** Anton's instructions lead the first message: Cursor keeps its own system prompt, and replacing it is not open to every account. */
const preamble = (instructions: string) =>
	[
		'You are working for Anton, a coding agent host. Cursor’s own file, shell and search tools are switched off here: use only the tools of the `custom-user-tools` MCP server, which run in the task’s sandbox. After calling a tool, wait for its result.',
		instructions ? `<instructions>\n${instructions}\n</instructions>` : '',
	]
		.filter(Boolean)
		.join('\n\n');

function toMessage(content: RuntimeContent[], lead: string | null): SDKUserMessage {
	const text = content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n\n');
	const images = content.flatMap((part) => (part.type === 'image' ? [{ data: part.data, mimeType: part.mimeType }] : []));
	return { text: lead ? `${lead}\n\n${text}` : text, ...(images.length ? { images } : {}) };
}

const toolResult = (output: { content: RuntimeContent[]; isError: boolean }): SDKCustomToolResult => ({
	content: output.content.map((part) => (part.type === 'text' ? { type: 'text' as const, text: part.text } : { type: 'image' as const, data: part.data, mimeType: part.mimeType })),
	isError: output.isError,
});

type Start = { sdk: CursorSdk; key: string; store: LocalAgentStore; workDir: string; model: (id: string) => Promise<ModelListItem | undefined> };

/**
 * One Cursor agent behind one Flue conversation. Cursor streams text and
 * thinking and calls tools as it goes; this cuts its output into model calls
 * in the shape of Anthropic's Messages stream, as the bridge reads them: one
 * ends at each batch of tool calls, and the last when the run finishes.
 */
export function cursorConversation(start: Start, options: RuntimeConversationOptions): RuntimeConversation {
	const events = channel<RuntimeEvent>();
	let agent: Promise<SDKAgent> | null = null;
	let run: Run | null = null;
	let busy = false;
	let closed = false;
	let first = true;
	/** Messages the running turn did not take; they start the next run, in the same model call. */
	const queued: SDKUserMessage[] = [];
	const steering: Array<Promise<unknown>> = [];

	// The model call being streamed out: whether one is open, its blocks, and its usage so far.
	let open = false;
	let nextIndex = 0;
	let block: { index: number; kind: 'text' | 'thinking' } | null = null;
	let usage = zero();
	let carried = zero();
	let flush: ReturnType<typeof setTimeout> | null = null;

	const begin = () => {
		if (open) return;
		open = true;
		nextIndex = 0;
		block = null;
		usage = carried;
		carried = zero();
		events.push({ type: 'message_start', id: `cursor-${randomUUID()}`, usage: { ...usage } });
	};
	const closeBlock = () => {
		if (block) events.push({ type: 'block_stop', index: block.index });
		block = null;
	};
	const end = (stopReason: string) => {
		if (flush) clearTimeout(flush);
		flush = null;
		if (!open) return;
		closeBlock();
		events.push({ type: 'message_delta', stopReason, usage: { ...usage } });
		events.push({ type: 'message_stop' });
		open = false;
	};
	/** Leaves the model call unfinished: an error ends the step instead. */
	const drop = () => {
		if (flush) clearTimeout(flush);
		flush = null;
		open = false;
		block = null;
	};
	const write = (kind: 'text' | 'thinking', text: string) => {
		if (!text || closed) return;
		// Output after a batch of tool calls belongs to the next model call.
		if (flush) end('tool_use');
		begin();
		if (block?.kind !== kind) {
			closeBlock();
			block = { index: nextIndex++, kind };
			events.push({ type: 'block_start', index: block.index, block: { type: kind } });
		}
		events.push({ type: 'block_delta', index: block.index, ...(kind === 'text' ? { text } : { thinking: text }) });
	};

	function onDelta(update: InteractionUpdate): void {
		if (update.type === 'text-delta') write('text', update.text);
		else if (update.type === 'thinking-delta') write('thinking', update.text);
		else if (update.type === 'turn-ended' && update.usage) {
			const add = { input: update.usage.inputTokens, output: update.usage.outputTokens, cacheRead: update.usage.cacheReadTokens, cacheWrite: update.usage.cacheWriteTokens };
			// Usage that lands after its model call ended counts toward the next one.
			const into = open && !flush ? usage : carried;
			into.input += add.input;
			into.output += add.output;
			into.cacheRead += add.cacheRead;
			into.cacheWrite += add.cacheWrite;
			if (into === usage) events.push({ type: 'message_delta', stopReason: null, usage: { ...usage } });
		}
	}

	const tools: Record<string, SDKCustomTool> = Object.fromEntries(
		options.tools.map((tool) => [
			tool.name,
			{
				description: tool.description,
				inputSchema: { ...tool.inputSchema, type: 'object' } as SDKCustomTool['inputSchema'],
				execute: async (args, context) => {
					const id = context.toolCallId || `call_${randomUUID()}`;
					begin();
					closeBlock();
					const index = nextIndex++;
					events.push({ type: 'block_start', index, block: { type: 'tool_use', id, name: tool.name } });
					events.push({ type: 'block_delta', index, json: JSON.stringify(args ?? {}) });
					events.push({ type: 'block_stop', index });
					if (flush) clearTimeout(flush);
					flush = setTimeout(() => end('tool_use'), BATCH_MS);
					return toolResult(await options.callTool(id, tool.name));
				},
			} satisfies SDKCustomTool,
		]),
	);

	async function create(): Promise<SDKAgent> {
		mkdirSync(start.workDir, { recursive: true });
		return start.sdk.Agent.create({
			apiKey: start.key,
			name: 'Anton',
			model: selectionFor(options.model, await start.model(options.model), options.effort),
			// Only MCP, which carries Anton's tools: no shell, edits, reads or web on this server.
			tools: ['mcp'],
			local: { cwd: start.workDir, settingSources: [], customTools: tools, store: start.store },
		});
	}

	const fail = (error: unknown) => {
		const message = error instanceof Error ? error.message : String(error);
		events.push({ type: 'error', message: `Cursor: ${message}`, limit: (error as { name?: string })?.name === 'RateLimitError' || LIMIT.test(message) });
	};

	async function runFrom(message: SDKUserMessage): Promise<void> {
		busy = true;
		try {
			for (let next: SDKUserMessage | undefined = message; next && !closed; next = queued.shift()) {
				const handle = await (agent ??= create());
				if (closed) return;
				const current = await handle.send(next, { onDelta: ({ update }) => onDelta(update) });
				run = current;
				const result = await current.wait();
				run = null;
				await Promise.allSettled(steering.splice(0));
				if (closed) return;
				if (result.status === 'error') {
					drop();
					queued.length = 0;
					return fail(new Error(result.error?.message ?? 'the run failed'));
				}
				if (result.status === 'cancelled') {
					queued.length = 0;
					break;
				}
			}
			// The run's last model call ends here; one that wrote nothing still answers the step.
			begin();
			end('end_turn');
			events.push({ type: 'turn_end' });
		} catch (error) {
			if (!closed) {
				drop();
				fail(error);
			}
		} finally {
			run = null;
			busy = false;
		}
	}

	return {
		send(content) {
			if (closed) return;
			const message = toMessage(content, first ? preamble(options.instructions) : null);
			first = false;
			if (!busy) {
				void runFrom(message);
				return;
			}
			// A message while Cursor works: given to the running turn when it takes it, else run right after it.
			const current = run;
			if (current?.steer && !message.images) {
				steering.push(
					current.steer(message.text).then(
						(outcome) => outcome === 'complete_delivered' || queued.push(message),
						() => queued.push(message),
					),
				);
			} else queued.push(message);
		},
		events: { [Symbol.asyncIterator]: () => events[Symbol.asyncIterator]() },
		close() {
			if (closed) return;
			closed = true;
			if (flush) clearTimeout(flush);
			run?.cancel().catch(() => {});
			void agent?.then((handle) => handle.close()).catch(() => {});
			events.close();
		},
	};
}

export function cursorPlan(options: CursorOptions): KeyPlan {
	const load = options.sdk ?? (() => import('@cursor/sdk'));
	const workDir = path.join(options.dir, 'work');
	let store: LocalAgentStore | null = null;
	/** The last listing per key, for each conversation's model parameters. */
	let listed: { key: string; at: number; items: ModelListItem[] } | null = null;

	async function list(key: string): Promise<ModelListItem[]> {
		if (listed?.key === key && Date.now() - listed.at < MODELS_TTL_MS) return listed.items;
		const items = await (await load()).Cursor.models.list({ apiKey: key });
		listed = { key, at: Date.now(), items };
		return items;
	}

	return {
		id: GATEWAY,
		name: 'Cursor',
		gateway: GATEWAY,
		keyPage: 'https://cursor.com/dashboard/api',
		check: async (key) => {
			const me = await (await load()).Cursor.me({ apiKey: key });
			return { email: me.userEmail ?? null };
		},
		listModels: async (key) => {
			listed = null;
			return (await list(key)).flatMap((item) => toSubscriptionModel(item) ?? []);
		},
		open(key, conversation) {
			const ready = load().then((sdk) => {
				store ??= new sdk.JsonlLocalAgentStore(path.join(options.dir, 'agents'));
				return { sdk, key, store, workDir, model: async (id: string) => (await list(key).catch(() => [])).find((item) => item.id === id) };
			});
			// The SDK loads on first use; until then messages wait in order.
			let opened: RuntimeConversation | null = null;
			const pending: RuntimeContent[][] = [];
			let closed = false;
			const events = (async function* (): AsyncGenerator<RuntimeEvent> {
				try {
					opened = cursorConversation(await ready, conversation);
				} catch (error) {
					yield { type: 'error', message: `Cursor: ${error instanceof Error ? error.message : String(error)}`, limit: false };
					return;
				}
				if (closed) return opened.close();
				for (const content of pending.splice(0)) opened.send(content);
				yield* opened.events;
			})();
			return {
				send: (content) => (opened ? opened.send(content) : pending.push(content)),
				events,
				close: () => {
					closed = true;
					opened?.close();
				},
			};
		},
	};
}

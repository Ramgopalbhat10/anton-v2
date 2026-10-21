import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import type {
	InteractionUpdate,
	LocalAgentDocument,
	LocalAgentRunDocument,
	LocalAgentRunEventDocument,
	LocalAgentStore,
	ModelListItem,
	ModelSelection,
	Run,
	SDKAgent,
	SDKCustomTool,
	SDKCustomToolResult,
	SDKUserMessage,
} from '@cursor/sdk';
import { linkVariants, parseVariant, sizeOf, withVariants } from '../../core/model-variants.ts';
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
	/** Where the agents' working folder lives. */
	dir: string;
	/** The SDK, swapped for a fake in tests. */
	sdk?: () => Promise<CursorSdk>;
};

type CursorSdk = Pick<typeof import('@cursor/sdk'), 'Agent' | 'Cursor' | 'paginateAgentDocuments' | 'paginateRunDocuments' | 'paginateCheckpointBlobIds'>;

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

/** The model's context sizes, smallest first: any larger than the first bills as Max Mode. */
function contextSizes(item: ModelListItem): Array<{ value: string; size: number }> {
	return (item.parameters?.find((param) => param.id === 'context')?.values ?? [])
		.map((option) => ({ value: option.value, size: sizeOf(option.value) }))
		.filter((option): option is { value: string; size: number } => option.size !== null)
		.sort((a, b) => a.size - b.size);
}

/** The smallest context a model offers: larger ones bill as Max Mode. */
function contextParam(item: ModelListItem): { value: string; size: number } | null {
	return contextSizes(item)[0] ?? null;
}

const offersFast = (item: ModelListItem | undefined) =>
	Boolean(item?.parameters?.find((param) => param.id === 'fast')?.values.some((option) => option.value === 'true'));

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
 * The model and the variants Cursor offers beside it: its largest context
 * (`[1m]`, Max Mode, billed by the token from the plan's usage), fast mode
 * (`[fast]`), and both.
 */
export function toSubscriptionModels(item: ModelListItem): SubscriptionModel[] {
	const model = toSubscriptionModel(item);
	if (!model) return [];
	const largest = contextSizes(item).at(-1);
	return withVariants(model, {
		context: largest
			? { tag: largest.value, tokens: largest.size, description: `Max Mode, up to ${largest.value.toUpperCase()} of context, billed by the token from your plan's usage.` }
			: null,
		fast: offersFast(item) ? { description: "Fast mode answers sooner and uses more of your plan's usage." } : null,
	});
}

/** The context of the variant Cursor runs when none is named. */
const defaultContext = (item: ModelListItem | undefined) =>
	(item?.variants?.find((variant) => variant.isDefault) ?? item?.variants?.[0])?.params.find((param) => param.id === 'context')?.value;

/**
 * The model and its parameters for a conversation at `effort`: the effort value
 * that names it, thinking on unless it is `off`, the variant's context or else
 * the smallest, and fast mode for a `[fast]` variant. Parameters left out take
 * the model's default variant's value. The context that variant has is left
 * out too: Grok 4.7 refuses it named ("Invalid parameters for registry model")
 * and runs it when it is not.
 */
export function selectionFor(model: string, item: ModelListItem | undefined, effort: string | null): ModelSelection {
	const { base: id, context, fast } = parseVariant(model);
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
			const chosen = (context && param.values.find((option) => option.value === context)?.value) || contextParam(item!)?.value;
			if (chosen && chosen !== defaultContext(item)) params.push({ id: param.id, value: chosen });
		} else if (param.id === 'fast' && fast && offersFast(item)) {
			params.push({ id: param.id, value: 'true' });
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

/**
 * Cursor writes a tool result whose text passes 40,000 bytes to a file in its
 * own folder on Anton's server and hands the model only its path, which none
 * of Anton's tools can read: an activated skill's instructions or a long file
 * never reached it. So a longer result goes back in parts under that size,
 * the rest read with `read_tool_output`, which Anton answers itself.
 */
const PART_BYTES = 32_000;
const MORE_TOOL = 'read_tool_output';
/** The long results a conversation keeps for `read_tool_output`, the oldest dropped first. */
const KEEP_LONG = 20;

/** The text from `offset` that fits in a part, cut on a character. */
export function partAt(text: string, offset: number): string {
	let part = text.slice(offset, offset + PART_BYTES);
	for (let excess = Buffer.byteLength(part) - PART_BYTES; excess > 0; excess = Buffer.byteLength(part) - PART_BYTES) part = part.slice(0, part.length - excess);
	// Never half of a surrogate pair.
	if (/[\uD800-\uDBFF]$/.test(part)) part = part.slice(0, -1);
	return part;
}

const partNote = (id: string, total: number, end: number) =>
	end < total
		? `\n\n[Characters ${end.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} shown. Call ${MORE_TOOL} with id "${id}" and offset ${end} for the rest.]`
		: '';

/**
 * Where a Cursor agent keeps its conversation state and run log, in memory for
 * as long as Anton's conversation with it lasts. The SDK records every streamed
 * update before it takes the next, and its JSONL store reads its whole file to
 * add one line: a file shared by every run Anton ever made, so the more Cursor
 * had been used, the longer each word of a reply waited (over a second at
 * 40 MB, which a few long replies reach). Anton never resumes
 * a Cursor agent (a new one is given the conversation so far), so nothing here
 * needs to outlive it.
 */
export function memoryStore(sdk: Pick<CursorSdk, 'paginateAgentDocuments' | 'paginateRunDocuments' | 'paginateCheckpointBlobIds'>): LocalAgentStore {
	const agents = new Map<string, LocalAgentDocument>();
	const runs = new Map<string, LocalAgentRunDocument>();
	const blobs = new Map<string, Uint8Array>();
	const events = new Map<string, LocalAgentRunEventDocument[]>();
	const blobKey = (agentId: string, blobId: string) => `${agentId}\n${blobId}`;
	const runMatches = (run: LocalAgentRunDocument, filter?: { agentIds?: readonly string[]; runIds?: readonly string[] }) =>
		(!filter?.agentIds?.length || filter.agentIds.includes(run.agentId)) && (!filter?.runIds?.length || filter.runIds.includes(run.runId));
	const blobMatches = (key: string, filter?: { agentIds?: readonly string[]; blobIds?: readonly string[] }) => {
		const [agentId, blobId] = key.split('\n');
		return (!filter?.agentIds?.length || filter.agentIds.includes(agentId)) && (!filter?.blobIds?.length || filter.blobIds.includes(blobId));
	};
	return {
		agents: {
			get: async ({ agentId }) => agents.get(agentId) ?? null,
			create: async ({ agent }) => {
				if (agents.has(agent.agentId)) throw new Error(`Agent ${agent.agentId} already exists`);
				agents.set(agent.agentId, agent);
				return agent;
			},
			update: async ({ agent }) => {
				if (!agents.has(agent.agentId)) throw new Error(`Agent ${agent.agentId} not found`);
				agents.set(agent.agentId, agent);
				return agent;
			},
			delete: async ({ filter }) => {
				for (const agent of [...agents.values()])
					if ((!filter.agentIds?.length || filter.agentIds.includes(agent.agentId)) && (filter.cwd === undefined || filter.cwd === agent.cwd)) agents.delete(agent.agentId);
			},
			list: async (input) => sdk.paginateAgentDocuments([...agents.values()], input?.filter),
		},
		runs: {
			get: async ({ agentId, runId }) => {
				const run = runs.get(runId);
				return run?.agentId === agentId ? run : null;
			},
			create: async ({ run }) => {
				if (runs.has(run.runId)) throw new Error(`Run ${run.runId} already exists`);
				runs.set(run.runId, run);
				return run;
			},
			update: async ({ run }) => {
				if (runs.get(run.runId)?.agentId !== run.agentId) throw new Error(`Run ${run.runId} not found for agent ${run.agentId}`);
				runs.set(run.runId, run);
				return run;
			},
			delete: async ({ filter }) => {
				for (const run of [...runs.values()]) if (runMatches(run, filter)) runs.delete(run.runId);
			},
			list: async (input) => sdk.paginateRunDocuments([...runs.values()].filter((run) => runMatches(run, input?.filter)), input?.filter),
		},
		checkpoints: {
			get: async ({ agentId, blobId }) => blobs.get(blobKey(agentId, blobId)) ?? null,
			create: async ({ agentId, blobId, data }) => {
				if (blobs.has(blobKey(agentId, blobId))) throw new Error(`Checkpoint blob ${blobId} already exists for agent ${agentId}`);
				blobs.set(blobKey(agentId, blobId), data);
			},
			update: async ({ agentId, blobId, data }) => {
				if (!blobs.has(blobKey(agentId, blobId))) throw new Error(`Checkpoint blob ${blobId} not found for agent ${agentId}`);
				blobs.set(blobKey(agentId, blobId), data);
			},
			delete: async ({ filter }) => {
				for (const key of [...blobs.keys()]) if (blobMatches(key, filter)) blobs.delete(key);
			},
			list: async (input) =>
				sdk.paginateCheckpointBlobIds(
					[...blobs.keys()].filter((key) => blobMatches(key, input?.filter)).map((key) => key.split('\n')[1]),
					input?.filter,
				),
		},
		runEvents: {
			append: async ({ runId, eventType, payload, payloadRef, idempotencyKey }) => {
				let list = events.get(runId);
				if (!list) events.set(runId, (list = []));
				const seq = list.length ? list[list.length - 1].seq + 1 : 1;
				const event = { runId, seq, offset: String(seq), eventType, payload, payloadRef: payloadRef ?? null, idempotencyKey: idempotencyKey ?? null, createdAt: Date.now() };
				list.push(event);
				return event;
			},
			list: async ({ runId, afterOffset, limit }) => {
				const after = Number(afterOffset ?? 0) || 0;
				const rest = (events.get(runId) ?? []).filter((event) => event.seq > after);
				const items = limit && limit > 0 ? rest.slice(0, limit) : rest;
				return items.length < rest.length ? { items, nextOffset: items.at(-1)!.offset } : { items };
			},
			delete: async ({ filter }) => {
				if (!filter.runIds?.length) events.clear();
				else for (const runId of filter.runIds) events.delete(runId);
			},
		},
	};
}

type Start = { sdk: CursorSdk; key: string; workDir: string; model: (id: string) => Promise<ModelListItem | undefined> };

/**
 * One Cursor agent behind one Flue conversation. Cursor streams text and
 * thinking and calls tools as it goes; this cuts its output into model calls
 * in the shape of Anthropic's Messages stream, as the bridge reads them: one
 * ends at each batch of tool calls, and the last when the run finishes.
 */
export function cursorConversation(start: Start, options: RuntimeConversationOptions): RuntimeConversation {
	const events = channel<RuntimeEvent>();
	const store = memoryStore(start.sdk);
	let agent: Promise<SDKAgent> | null = null;
	let run: Run | null = null;
	let busy = false;
	let closed = false;
	let first = true;
	/** Messages the running turn did not take; they start the next run, in the same model call. */
	const queued: SDKUserMessage[] = [];
	const steering: Array<Promise<unknown>> = [];

	// The model call being streamed out: whether one is open, and its blocks.
	let open = false;
	let nextIndex = 0;
	let block: { index: number; kind: 'text' | 'thinking' } | null = null;
	let flush: ReturnType<typeof setTimeout> | null = null;

	// Cursor counts tokens once per run, at its end, for every model call in it together: no one call's count,
	// and far more than any one call holds. Each call goes out uncounted, and the bridge counts it by its context.
	const begin = () => {
		if (open) return;
		open = true;
		nextIndex = 0;
		block = null;
		events.push({ type: 'message_start', id: `cursor-${randomUUID()}`, usage: zero() });
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
		events.push({ type: 'message_delta', stopReason, usage: {} });
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
	}

	const long = new Map<string, string>();
	/** The result as Cursor takes it whole: a text too long for that is kept, and its first part goes back. */
	const fitted = (output: { content: RuntimeContent[]; isError: boolean }): SDKCustomToolResult => {
		const text = output.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n\n');
		if (Buffer.byteLength(text) <= PART_BYTES) return toolResult(output);
		const id = randomUUID().slice(0, 8);
		long.set(id, text);
		if (long.size > KEEP_LONG) long.delete(long.keys().next().value!);
		const first = partAt(text, 0);
		const images = output.content.filter((part) => part.type === 'image');
		return toolResult({ content: [{ type: 'text', text: first + partNote(id, text.length, first.length) }, ...images], isError: output.isError });
	};
	const more: SDKCustomTool = {
		description: 'Reads more of a tool result too long to be handed back whole, from the id and offset its note gives.',
		inputSchema: {
			type: 'object',
			properties: { id: { type: 'string', description: 'The id the note gives.' }, offset: { type: 'number', description: 'The character to start from.' } },
			required: ['id', 'offset'],
		} as SDKCustomTool['inputSchema'],
		execute: (args) => {
			const id = String(args?.id ?? '');
			const text = long.get(id);
			if (text === undefined) return { content: [{ type: 'text', text: `No tool result "${id}" is kept; call the tool again.` }], isError: true };
			const offset = Math.max(0, Math.min(text.length, Math.floor(Number(args?.offset) || 0)));
			const part = partAt(text, offset);
			return { content: [{ type: 'text', text: part + partNote(id, text.length, offset + part.length) }], isError: false };
		},
	};

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
					return fitted(await options.callTool(id, tool.name));
				},
			} satisfies SDKCustomTool,
		]),
	);
	if (!tools[MORE_TOOL]) tools[MORE_TOOL] = more;

	async function create(): Promise<SDKAgent> {
		mkdirSync(start.workDir, { recursive: true });
		return start.sdk.Agent.create({
			apiKey: start.key,
			name: 'Anton',
			model: selectionFor(options.model, await start.model(options.model), options.effort),
			// Only MCP, which carries Anton's tools: no shell, edits, reads or web on this server.
			tools: ['mcp'],
			local: { cwd: start.workDir, settingSources: [], customTools: tools, store },
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
				// Its streamed updates are read back by nothing once it is done.
				await store.runEvents.delete({ filter: { runIds: [current.id] } }).catch(() => {});
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
			long.clear();
			run?.cancel().catch(() => {});
			void agent?.then((handle) => handle.close()).catch(() => {});
			events.close();
		},
	};
}

export function cursorPlan(options: CursorOptions): KeyPlan {
	const load = options.sdk ?? (() => import('@cursor/sdk'));
	const workDir = path.join(options.dir, 'work');
	// The JSONL run log earlier versions kept, which only grew: nothing reads it.
	try {
		rmSync(path.join(options.dir, 'agents'), { recursive: true, force: true });
	} catch {}
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
			return linkVariants((await list(key)).flatMap(toSubscriptionModels));
		},
		open(key, conversation) {
			const ready = load().then((sdk) => ({
				sdk,
				key,
				workDir,
				model: async (id: string) => (await list(key).catch(() => [])).find((item) => item.id === parseVariant(id).base),
			}));
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

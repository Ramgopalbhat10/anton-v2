/**
 * Stands in for `@flue/sdk` in the profiling build: `createFlueClient` serves
 * a scripted conversation instead of the runtime's durable stream. Updates
 * keep the SDK's structural sharing (an unchanged message keeps its object;
 * the one being written gets a new one per chunk), so React sees the same
 * identities it sees in production. The real `@flue/react` runs on top.
 */
import { answerText, DELTA_MS, LOREM, PHASES } from './scenario.ts';

type Part = Record<string, unknown> & { type: string };
type Message = { id: string; role: string; purpose: string; display: string; submissionId?: string; parts: Part[]; metadata?: Record<string, unknown> };
type Conversation = { conversationId: string; messages: Message[]; settlements: Array<{ submissionId: string; outcome: string }> };

const HISTORY_TURNS = 6;

function historyTurn(index: number): Message[] {
	const tools: Part[] = Array.from({ length: 14 }, (_, step) => {
		const toolName = ['read', 'bash', 'grep', 'edit', 'read', 'bash', 'write'][step % 7];
		return {
			type: 'dynamic-tool',
			toolName,
			toolCallId: `h${index}-t${step}`,
			state: 'output-available',
			input: toolName === 'bash' ? { command: `npm run test -- step ${step}` } : { path: `src/web/components/part-${step}.tsx` },
			output: toolName === 'bash' ? { output: `ok ${step}\n`.repeat(20) } : 'done',
		};
	});
	return [
		{ id: `u${index}`, role: 'user', purpose: 'user', display: 'visible', submissionId: `s${index}`, parts: [{ type: 'text', text: `Earlier request number ${index}: tidy the panels.`, state: 'done' }] },
		{
			id: `a${index}`,
			role: 'assistant',
			purpose: 'assistant',
			display: 'visible',
			submissionId: `s${index}`,
			parts: [{ type: 'reasoning', text: LOREM, state: 'done' }, ...tools, { type: 'text', text: answerText(1800), state: 'done' }],
			metadata: {
				durationMs: 42_000,
				usage: { inputTokens: 52_000, outputTokens: 2400, cost: 0.03, cachedTokens: 38_000 },
				usageParts: {
					main: { inputTokens: 34_000, outputTokens: 1500, cost: 0.019, cachedTokens: 28_000, calls: 14 },
					subagents: { inputTokens: 18_000, outputTokens: 900, cost: 0.011, cachedTokens: 10_000, calls: 9 },
				},
				billing: 'api',
			},
		},
	];
}

function initial(): Conversation {
	return {
		conversationId: 'perf',
		messages: Array.from({ length: HISTORY_TURNS }, (_, index) => historyTurn(index)).flat(),
		settlements: Array.from({ length: HISTORY_TURNS }, (_, index) => ({ submissionId: `s${index}`, outcome: 'completed' })),
	};
}

/** The SDK's reducer, for the chunks the scenario sends. */
function updateMessage(state: Conversation, id: string, update: (message: Message) => Message): Conversation {
	const index = state.messages.findIndex((message) => message.id === id);
	if (index < 0) return state;
	const messages = [...state.messages];
	messages[index] = update(messages[index]);
	return { ...state, messages };
}

function delta(state: Conversation, id: string, kind: 'text' | 'reasoning', text: string): Conversation {
	return updateMessage(state, id, (message) => {
		const parts = [...message.parts];
		const last = parts[parts.length - 1];
		if (last && last.type === kind && last.state === 'streaming') parts[parts.length - 1] = { ...last, text: `${last.text}${text}` };
		else {
			if (last && (last.type === 'text' || last.type === 'reasoning') && last.state === 'streaming') parts[parts.length - 1] = { ...last, state: 'done' };
			parts.push({ type: kind, text, state: 'streaming' });
		}
		return { ...message, parts };
	});
}

function toolInput(state: Conversation, id: string, toolCallId: string, toolName: string, input: unknown): Conversation {
	return updateMessage(state, id, (message) => {
		const parts = message.parts.map((part, index) =>
			index === message.parts.length - 1 && (part.type === 'text' || part.type === 'reasoning') && part.state === 'streaming' ? { ...part, state: 'done' } : part,
		);
		return { ...message, parts: [...parts, { type: 'dynamic-tool', toolName, toolCallId, state: 'input-available', input }] };
	});
}

function toolOutput(state: Conversation, id: string, toolCallId: string, output: unknown): Conversation {
	return updateMessage(state, id, (message) => ({
		...message,
		parts: message.parts.map((part) => (part.type === 'dynamic-tool' && part.toolCallId === toolCallId ? { ...part, state: 'output-available', output } : part)),
	}));
}

/** The scripted chunks, each as a time and a state change. */
function script(): Array<[number, (state: Conversation) => Conversation]> {
	const id = 'live-reply';
	const steps: Array<[number, (state: Conversation) => Conversation]> = [
		[0, (state) => ({ ...state, messages: [...state.messages, { id: 'live-user', role: 'user', purpose: 'user', display: 'visible', submissionId: 'live', parts: [{ type: 'text', text: 'Make the app fast while agents stream.', state: 'done' }] }] })],
		[PHASES.reasoning[0], (state) => ({ ...state, messages: [...state.messages, { id, role: 'assistant', purpose: 'assistant', display: 'visible', submissionId: 'live', parts: [] }] })],
	];
	const stream = (from: number, to: number, kind: 'text' | 'reasoning', text: string) => {
		const count = Math.floor((to - from) / DELTA_MS);
		const size = Math.ceil(text.length / count);
		for (let index = 0; index < count; index++) {
			const piece = text.slice(index * size, (index + 1) * size);
			if (piece) steps.push([from + index * DELTA_MS, (state) => delta(state, id, kind, piece)]);
		}
	};
	stream(PHASES.reasoning[0] + 10, PHASES.reasoning[1], 'reasoning', LOREM.repeat(2));
	stream(PHASES.intro[0], PHASES.intro[1], 'text', answerText(900));
	for (const which of [0, 1, 2]) {
		const agent = ['explorer', 'tester', 'flue-general'][which];
		steps.push([PHASES.subagents[0] + which * 5, (state) => toolInput(state, id, `task-${which}`, 'task', { agent, prompt: 'Look at src/web and report what you find.', description: ['Map the render path of the thread', 'Run the UI tests and report failures', 'Audit the file tree for slow paths'][which] })]);
		steps.push([PHASES.subagents[1] + which * 5, (state) => toolOutput(state, id, `task-${which}`, `Found things.\n\n${LOREM}`)]);
	}
	// The answer, with a tool call every two seconds between its paragraphs.
	const answer = answerText(9000);
	const chunks = 4;
	const span = (PHASES.answer[1] - PHASES.answer[0]) / chunks;
	for (let chunk = 0; chunk < chunks; chunk++) {
		const from = PHASES.answer[0] + chunk * span;
		stream(from + 300, from + span, 'text', answer.slice((chunk * answer.length) / chunks, ((chunk + 1) * answer.length) / chunks));
		const call = `answer-tool-${chunk}`;
		steps.push([from + 10, (state) => toolInput(state, id, call, chunk % 2 ? 'read' : 'bash', chunk % 2 ? { path: 'src/web/components/thread.tsx' } : { command: 'npm run check:types' })]);
		steps.push([from + 250, (state) => toolOutput(state, id, call, { output: 'ok\n'.repeat(30) })]);
	}
	steps.push([
		PHASES.answer[1],
		(state) =>
			updateMessage(state, id, (message) => ({
				...message,
				parts: message.parts.map((part) => (part.type === 'text' || part.type === 'reasoning' ? { ...part, state: 'done' } : part)),
				metadata: {
					durationMs: 26_000,
					usage: { inputTokens: 80_000, outputTokens: 5200, cost: 0.05, cachedTokens: 52_000 },
					usageParts: {
						main: { inputTokens: 48_000, outputTokens: 3400, cost: 0.03, cachedTokens: 36_000, calls: 6 },
						subagents: { inputTokens: 32_000, outputTokens: 1800, cost: 0.02, cachedTokens: 16_000, calls: 41 },
					},
					billing: 'api',
				},
			})),
	]);
	steps.push([PHASES.end, (state) => ({ ...state, settlements: [...state.settlements, { submissionId: 'live', outcome: 'completed' }] })]);
	return steps.sort((a, b) => a[0] - b[0]);
}

declare global {
	interface Window {
		__perfGo?: () => void;
	}
}

export function createFlueClient(_options: { url: string }) {
	let conversation = initial();
	const listeners = new Set<() => void>();
	let snapshot = { conversation, offset: '0', phase: 'live', error: undefined as Error | undefined };
	const publish = () => {
		snapshot = { conversation, offset: '0', phase: 'live', error: undefined };
		for (const listener of listeners) listener();
	};
	window.__perfGo = () => {
		void fetch('/__perf/start', { method: 'POST' });
		const started = performance.now();
		for (const [at, apply] of script()) {
			setTimeout(() => {
				conversation = apply(conversation);
				publish();
			}, Math.max(0, at - (performance.now() - started)));
		}
	};
	return {
		observe: () => ({
			subscribe: (listener: () => void) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			getSnapshot: () => snapshot,
			refresh: () => undefined,
			close: () => listeners.clear(),
		}),
		send: async () => ({ submissionId: 'perf-send' }),
	};
}

/**
 * The profiled scenario, shared by the fake conversation stream (in the page)
 * and the mock API (in Vite): an agent reply that thinks, writes, hands work
 * to three subagents at once, waits on them while they work, then streams a
 * long answer with a few tool calls between paragraphs.
 *
 * Times are in milliseconds from the moment the page calls `__perfGo()`.
 */

export const SESSION_ID = 'perf-task';

export const PHASES = {
	reasoning: [200, 2200],
	intro: [2200, 4000],
	subagents: [4000, 16000],
	answer: [16000, 26000],
	end: 26500,
} as const;

/** One stream chunk every this many milliseconds while text streams. */
export const DELTA_MS = 20;

export const AGENTS = [
	{ agent: 'explorer', description: 'Map the render path of the thread', period: 650 },
	{ agent: 'tester', description: 'Run the UI tests and report failures', period: 800 },
	{ agent: 'flue-general', description: 'Audit the file tree for slow paths', period: 720 },
] as const;

const TOOLS = ['read', 'grep', 'bash', 'read', 'glob', 'edit', 'read', 'bash'] as const;

export const LOREM =
	'The thread renders every message on each streamed token, so the cost of a token grows with the length of the conversation. ' +
	'Memoizing finished messages keeps that cost flat. The workspace panels sit beside the thread and re-render with it, ' +
	'which is why the file tree and the open file feel slow while the agent writes. ';

/** A long Markdown answer, with headings, lists, a table and code, as an agent writes them. */
export function answerText(length: number): string {
	const blocks = [
		'## What I found\n\n',
		`${LOREM}\n\n`,
		'- `Thread` re-renders on every chunk\n- `VmPanel` re-renders with it\n- `FileView` re-highlights each refetch\n\n',
		'| Component | Renders | Cost |\n| --- | --- | --- |\n| Thread | 1200 | high |\n| FilesTab | 1200 | high |\n| Composer | 1200 | medium |\n\n',
		'```ts\nconst Message = memo(function Message({ message }: Props) {\n\treturn <Markdown text={message.text} />;\n});\n```\n\n',
		`${LOREM}${LOREM}\n\n`,
	];
	let text = '';
	for (let index = 0; text.length < length; index++) text += blocks[index % blocks.length];
	return text.slice(0, length);
}

export type MockStep = { id: string; tool: string; input: unknown; state: 'running' | 'done' | 'failed'; at: string; durationMs: number | null };

/** The subagent runs as the server would report them `elapsed` ms into the scenario. */
export function runsAt(elapsed: number, startedAt: number) {
	if (elapsed < PHASES.subagents[0]) return [];
	return AGENTS.map((spec, which) => {
		const begun = startedAt + PHASES.subagents[0] + which * 120;
		const finished = elapsed >= PHASES.subagents[1];
		const local = Math.min(elapsed, PHASES.subagents[1]) - PHASES.subagents[0] - which * 120;
		const count = Math.max(0, Math.floor(local / spec.period));
		const steps: MockStep[] = Array.from({ length: count + 1 }, (_, index) => {
			const tool = TOOLS[(index + which) % TOOLS.length];
			const running = !finished && index === count;
			return {
				id: `${spec.agent}-${index}`,
				tool,
				input: tool === 'bash' ? { command: `npm test -- --run tests/ui/case-${index}.test.tsx` } : tool === 'grep' ? { pattern: 'useQuery', path: 'src/web' } : { path: `src/web/components/file-${index}.tsx` },
				state: running ? 'running' : 'done',
				at: new Date(begun + index * spec.period).toISOString(),
				durationMs: running ? null : spec.period - 40,
			};
		});
		const writing = finished ? null : LOREM.slice(0, 40 + ((local / 50) % 300));
		return {
			id: `run-${which}`,
			agent: spec.agent,
			prompt: `${spec.description}.\n\nLook at src/web and report what you find.`,
			description: spec.description,
			toolCallId: `task-${which}`,
			status: finished ? 'done' : 'running',
			startedAt: new Date(begun).toISOString(),
			durationMs: finished ? PHASES.subagents[1] - PHASES.subagents[0] - which * 120 : null,
			model: 'openrouter/~deepseek/deepseek-flash-latest',
			tokens: 1200 + count * 900,
			calls: count + 1,
			steps,
			writing,
			result: finished ? `Found ${count} places to look at.\n\n${LOREM}` : null,
		};
	});
}

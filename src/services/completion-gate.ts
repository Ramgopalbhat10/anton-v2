import { createHash } from 'node:crypto';
import { config } from '../config.ts';
import { isIncognitoId } from '../core/incognito.ts';
import { decide, yesOf } from './decisions.ts';
import { reopenFinishReview, requestFor, taskPatch } from './finish-review.ts';
import { logProblem } from './log.ts';
import { replyEnding } from './reply-check.ts';
import { elapsedText, hoursText, replyElapsed } from './reply-clock.ts';
import { type TodoList, todoReminded, todosFor } from './todos.ts';

/*
 * The last check before a reply ends: whether it ends with work the request
 * asked for left undone. A model that judged a job too large stopped and said
 * so ("The requested implementation is not complete. No source files were
 * changed."), minutes into a reply that may run hours, and every other check
 * let it end: the todo reminder had fired, the agent's own check of its change
 * had found the work missing and said so, and an empty diff was never
 * reviewed. Six of eleven failures in a benchmark run were such replies, not
 * wrong answers. So a reply that says work is open, for a reason other than
 * something only the user can give, is sent back to do it.
 *
 * The decision model reads the reply's end, the request and the open todo
 * steps; without one (or when it fails), a plain rule does: the reply worked,
 * and its last words declare the work incomplete or the todo list was left
 * open after its reminder, and it neither ends on a question nor names
 * something it needs from the user. A few rounds at most, and from the second
 * on only while the last round changed something, so a reply that cannot go
 * on is never held in a loop.
 */

/** Rounds a reply may be sent back, at most; the runtime fails a reply past 32 finish cycles. */
export const MAX_ROUNDS = 3;
/** How sure the decision model must be that the reply leaves work undone. */
const UNDONE = 0.6;
/** The tools that work in the sandbox; their count is a chat's progress, as it has no diff. */
const SANDBOX_TOOLS = new Set(['bash', 'write', 'edit']);
/** Tools that show a reply did work, not only read and answer. */
const WORK_TOOLS = new Set([...SANDBOX_TOOLS, 'update_todos', 'start_workspace', 'open_pull_request', 'task']);
/** What the decision model reads of the request and the reply. */
const REQUEST_CHARS = 2_000;
const REPLY_CHARS = 3_000;

/** Words that declare requested work not done. Narrow on purpose: a final line such as "the pull request remains open" is not one. */
const INCOMPLETE = new RegExp(
	[
		String.raw`\bnot (?:yet )?(?:been )?(?:complete|completed|finished|implemented)\b`,
		String.raw`\b(?:is|are|was|were|remains?|still|left)\s+incomplete\b`,
		String.raw`\b(?:did not|didn['’]t|could not|couldn['’]t|was not able to|wasn['’]t able to|were not able to|weren['’]t able to|unable to) (?:implement|complete|finish)\b`,
		String.raw`\bwasn['’]t able to\b`,
		String.raw`\bremains? (?:unimplemented|undone|to be (?:done|implemented))\b`,
		String.raw`\b(?:work|steps?|items?|parts?|pieces?|tasks?|requirements?)\s+(?:that\s+)?(?:remains?|are still|is still)\s+open\b`,
		String.raw`\b(?:still|left) unimplemented\b`,
		String.raw`\bno (?:code|source files?|files?) (?:was |were )?(?:changed|modified)\b`,
	].join('|'),
	'i',
);
/** Words that name something only the user can give, which a reply may rightly stop for. */
const NEEDS_USER = new RegExp(
	[
		String.raw`\b(?:needs?|requires?|waiting (?:on|for)|blocked (?:on|by)|depends on) (?:you|your)\b`,
		String.raw`\bonce you (?:provide|confirm|decide|give|grant|share|send|add|approve|choose)\b`,
		String.raw`\byour (?:approval|credentials?|decision|confirmation|access|api key|token|password)\b`,
	].join('|'),
	'i',
);

type Call = { tool: string };
type Round = { rounds: number; mark: string };
export type GateContext = {
	/** A task with no repository: its progress is its sandbox work, as it has no diff. */
	chat: boolean;
	/** Whether the task has a sandbox now; a chat without one only answered and is never sent back. */
	workspace: boolean;
	signal?: AbortSignal;
};
type Deps = {
	patch: (id: string) => Promise<string | null>;
	todos: (id: string) => Promise<TodoList | null>;
	ending: (id: string) => string;
	reminded: (id: string) => boolean;
	request: (id: string) => string | undefined;
	elapsed: (id: string) => number | null;
	limitMs: number;
};

const defaults: Deps = { patch: taskPatch, todos: todosFor, ending: replyEnding, reminded: todoReminded, request: requestFor, elapsed: (id) => replyElapsed(id), limitMs: config.replyTimeoutMs };

/** Each task's rounds in the reply in hand, and what its work stood at when last sent back. */
const rounds = new Map<string, Round>();
const KEEP_TASKS = 200;

/** A new reply may be sent back again. */
export function startCompletionGate(id: string): void {
	rounds.delete(id);
}

/** Whether the reply's last words end on a question, as a reply that asks the user something does. */
const endsAsking = (text: string) => /\?[\s*_`)"'’”]*$/.test(text);

/**
 * The plain rule, for when no decision model answers: a reply that worked, and says the work is not done or left its
 * list open after the reminder, without ending on a question or naming something it needs from the user. A reply that
 * only read and answered is left alone, as an answer may well say what some code does not do.
 */
export function undoneByRule(text: string, open: number, reminded: boolean, worked: boolean): boolean {
	if (!worked || endsAsking(text) || NEEDS_USER.test(text)) return false;
	return INCOMPLETE.test(text) || (reminded && open > 0);
}

/** The decision model's verdict, or null when there is none or it failed. */
async function undoneByModel(id: string, request: string | undefined, text: string, open: string[]): Promise<boolean | null> {
	const answers = await decide(
		id,
		{ request: request?.slice(0, REQUEST_CHARS) ?? '', reply: text.slice(-REPLY_CHARS), openTodoSteps: open.join('\n') },
		{
			undone: {
				type: 'yes-no',
				instructions:
					"This is the end of a coding agent's reply to the request. Does it say, or do its open todo steps show, that work the request asked for was not done, is only partly done or remains open, for a reason other than needing the user to decide, provide or do something? " +
					'A report of the work done, an answer to a question, an offer of optional extras, or a stop for something only the user can give is no.',
			},
		},
	);
	const yes = yesOf(answers?.undone);
	return yes === null ? null : yes >= UNDONE;
}

/** What the agent is told when sent back. No scolding and no request again: the agent has it, and the finish review repeats it where it must. */
export function carryOn(elapsed: number | null, limitMs: number, open: number): string {
	const time =
		elapsed === null ? `A reply may run for up to ${hoursText(limitMs)}` : `This reply has run ${elapsedText(elapsed)} of the ${hoursText(limitMs)} it may run`;
	return (
		`Your reply ended with work the request asked for not done${open ? ` (your todo list has ${open} step${open === 1 ? '' : 's'} open)` : ''}. ` +
		`${time}, so there is time to do it in full. Carry on and do the work now, starting with the smallest piece that works, and check each piece as you go. ` +
		'End your reply only when the request is done, or when what remains needs something only the user can give; then name exactly what that is.'
	);
}

/**
 * At the end of a reply that ends with requested work left undone, and not for something only the user can give:
 * what to tell the agent so it carries on; null otherwise. Never on a reply ending on `ask` or `propose_plan`, an
 * aborted one, an incognito chat or a chat that has no sandbox. At most `MAX_ROUNDS` a reply, and from the second
 * round on only when the last one changed the task's diff (a chat's: its sandbox work). Each round lets the finish
 * review read the change again, once it is a change it has not read. Plan mode and review tasks are left out by the caller.
 */
export async function completionGate(id: string, calls: readonly Call[], context: GateContext, deps: Partial<Deps> = {}): Promise<string | null> {
	const d = { ...defaults, ...deps };
	const { chat, workspace, signal } = context;
	if (signal?.aborted || isIncognitoId(id) || (chat && !workspace)) return null;
	const last = calls[calls.length - 1]?.tool;
	if (last === 'ask' || last === 'propose_plan') return null;
	const round = rounds.get(id);
	if (round && round.rounds >= MAX_ROUNDS) return null;
	try {
		const text = d.ending(id);
		const list = await d.todos(id);
		const open = list?.todos.filter((todo) => todo.status !== 'completed').map((todo) => todo.content) ?? [];
		// A todo list from an earlier reply is the agent's, but only this reply's open steps say anything of this reply.
		const wrote = calls.some((call) => call.tool === 'update_todos');
		const steps = wrote ? open : [];
		if (!text && !steps.length) return null;
		const worked = calls.some((call) => WORK_TOOLS.has(call.tool));
		const verdict = (await undoneByModel(id, d.request(id), text, steps)) ?? undoneByRule(text, steps.length, d.reminded(id), worked);
		if (!verdict || signal?.aborted) return null;
		const mark = chat ? `calls:${calls.filter((call) => SANDBOX_TOOLS.has(call.tool)).length}` : `diff:${createHash('sha256').update((await d.patch(id))?.trim() ?? '').digest('hex')}`;
		// A round that changed nothing will not be followed by one that does.
		if (round && round.mark === mark) return null;
		rounds.delete(id);
		rounds.set(id, { rounds: (round?.rounds ?? 0) + 1, mark });
		if (rounds.size > KEEP_TASKS) rounds.delete(rounds.keys().next().value!);
		reopenFinishReview(id);
		return carryOn(d.elapsed(id), d.limitMs, steps.length);
	} catch (error) {
		if (!signal?.aborted) logProblem('warn', 'Could not check whether the reply finished its work', error, id);
		return null;
	}
}

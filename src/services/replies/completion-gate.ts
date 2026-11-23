import { createHash } from 'node:crypto';
import { config } from '../../config.ts';
import { isIncognitoId } from '../../core/incognito.ts';
import { FILE_CHANGE_TOOLS } from '../../core/tool-profile.ts';
import { decide, yesOf } from '../models/decisions.ts';
import { reopenFinishReview, requestFor, taskPatch } from './finish-review.ts';
import { changeGate, gate, loadGate } from './gate-state.ts';
import { logProblem } from '../../core/log.ts';
import { replyEnding, replyMessages } from './reply-check.ts';
import { lastSendBack } from './send-backs.ts';
import { elapsedText, hoursText, replyElapsed } from './reply-clock.ts';
import { type TodoList, todoReminded, todosFor } from './todos.ts';
import { endsOnUser } from './asks.ts';

/*
 * Sends back a reply that says requested work is left undone, for a reason other than something only the user can give.
 * Six of eleven failures in a benchmark run were such replies, not wrong answers. The decision model judges; without one a
 * plain rule does. From the second round on only while the last round changed something, so it never loops.
 */

/** The runtime fails a reply past 32 finish cycles. */
export const MAX_ROUNDS = 3;
const UNDONE = 0.6;
/** A chat has no diff, so its sandbox tool calls are its progress. */
const SANDBOX_TOOLS = new Set(['bash', 'run_in_background', ...FILE_CHANGE_TOOLS]);
/** A repository task has no start_workspace (its first command starts its sandbox); chats and reviews still do. Reading is not work. */
const WORK_TOOLS = new Set([...SANDBOX_TOOLS, 'update_todos', 'start_workspace', 'open_pull_request', 'task']);
const REQUEST_CHARS = 2_000;
const REPLY_CHARS = 3_000;
const REVIEW_CHARS = 2_000;

/** Narrow on purpose: a final line such as "the pull request remains open" is not one. */
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
const NEEDS_USER = new RegExp(
	[
		String.raw`\b(?:needs?|requires?|waiting (?:on|for)|blocked (?:on|by)|depends on) (?:you|your)\b`,
		String.raw`\bonce you (?:provide|confirm|decide|give|grant|share|send|add|approve|choose)\b`,
		String.raw`\byour (?:approval|credentials?|decision|confirmation|access|api key|token|password)\b`,
	].join('|'),
	'i',
);

type Call = { tool: string };
export type GateContext = {
	chat: boolean;
	/** A chat without a sandbox only answered and is never sent back. */
	workspace: boolean;
	signal?: AbortSignal;
};
type Deps = {
	patch: (id: string) => Promise<string | null>;
	todos: (id: string) => Promise<TodoList | null>;
	ending: (id: string, from: number) => string;
	messages: (id: string) => number;
	reminded: (id: string) => boolean;
	request: (id: string) => string | undefined;
	elapsed: (id: string) => number | null;
	reviewed: (id: string) => Reviewed | null;
	limitMs: number;
};

type Reviewed = { points: string; before: string };

function lastReview(id: string): Reviewed | null {
	const last = lastSendBack(id);
	return last?.gate === 'review' ? { points: last.points ?? '', before: last.before ?? '' } : null;
}

const defaults: Deps = { patch: taskPatch, todos: todosFor, ending: replyEnding, messages: replyMessages, reminded: todoReminded, request: requestFor, elapsed: (id) => replyElapsed(id), reviewed: lastReview, limitMs: config.replyTimeoutMs };

export function startCompletionGate(id: string): void {
	changeGate(id, (state) => {
		state.round = undefined;
	});
}

const endsAsking = (text: string) => /\?[\s*_`)"'’”]*$/.test(text);

/** A reply that only read and answered is left alone, as an answer may well say what some code does not do. */
export function undoneByRule(text: string, open: number, reminded: boolean, worked: boolean): boolean {
	if (!worked || endsAsking(text) || NEEDS_USER.test(text)) return false;
	return INCOMPLETE.test(text) || (reminded && open > 0);
}

async function undoneByModel(id: string, request: string | undefined, text: string, open: string[], reviewed: Reviewed | null): Promise<boolean | null> {
	const answers = await decide(
		id,
		{
			request: request?.slice(0, REQUEST_CHARS) ?? '',
			reply: text.slice(-REPLY_CHARS),
			openTodoSteps: open.join('\n'),
			// A reply the finish review sent back ends on its answer to the reviewer, so what it reported before the review is read
			// with it; otherwise a live run's finished reply that turned down a reviewer's point was judged as work undone.
			...(reviewed ? { reviewerPoints: reviewed.points.slice(0, REVIEW_CHARS), replyBeforeReview: reviewed.before.slice(-REPLY_CHARS) } : {}),
		},
		{
			undone: {
				type: 'yes-no',
				instructions:
					"This is the end of a coding agent's reply to the request. Does it say, or do its open todo steps show, that work the request asked for was not done, is only partly done or remains open, for a reason other than needing the user to decide, provide or do something? " +
					'A report of the work done, an answer to a question, an offer of optional extras, or a stop for something only the user can give is no. ' +
					(reviewed
						? "Here a reviewer sent the reply back with reviewerPoints, and the reply's end answers them; replyBeforeReview is what it reported before. " +
							'Judge the whole request from both. Fixing a point, or explaining why a point is wrong or not asked for, is not work left undone.'
						: ''),
			},
		},
	);
	const yes = yesOf(answers?.undone);
	return yes === null ? null : yes >= UNDONE;
}

/** No scolding and no request again: the agent has it, and the finish review repeats it where it must. */
export function carryOn(elapsed: number | null, limitMs: number, open: number): string {
	const time =
		elapsed === null ? `A reply may run for up to ${hoursText(limitMs)}` : `This reply has run ${elapsedText(elapsed)} of the ${hoursText(limitMs)} it may run`;
	return (
		`Your reply ended with work the request asked for not done${open ? ` (your todo list has ${open} step${open === 1 ? '' : 's'} open)` : ''}. ` +
		`${time}, so there is time to do it in full. Carry on and do the work now, starting with the smallest piece that works, and check each piece as you go. ` +
		'End your reply only when the request is done, or when what remains needs something only the user can give; then name exactly what that is.'
	);
}

/** Never on `ask` or `propose_plan`, an aborted reply, an incognito chat or a chat without a sandbox. Plan mode and review tasks are left out by the caller. */
export async function completionGate(id: string, calls: readonly Call[], context: GateContext, deps: Partial<Deps> = {}): Promise<string | null> {
	const d = { ...defaults, ...deps };
	const { chat, workspace, signal } = context;
	if (signal?.aborted || isIncognitoId(id) || (chat && !workspace)) return null;
	if (endsOnUser(id, calls)) return null;
	await loadGate(id);
	const round = gate(id).round;
	if (round && round.rounds >= MAX_ROUNDS) return null;
	try {
		// After a send-back, what the reply said before it is stale: a short "Done." would otherwise be read with the earlier "not done".
		const text = d.ending(id, round?.seen ?? 0);
		const list = await d.todos(id);
		const open = list?.todos.filter((todo) => todo.status !== 'completed').map((todo) => todo.content) ?? [];
		// A todo list from an earlier reply is the agent's, but only this reply's open steps say anything of this reply.
		const wrote = calls.some((call) => call.tool === 'update_todos');
		const steps = wrote ? open : [];
		if (!text && !steps.length) return null;
		const worked = calls.some((call) => WORK_TOOLS.has(call.tool));
		const verdict = (await undoneByModel(id, d.request(id), text, steps, d.reviewed(id))) ?? undoneByRule(text, steps.length, d.reminded(id), worked);
		if (!verdict || signal?.aborted) return null;
		const mark = chat ? `calls:${calls.filter((call) => SANDBOX_TOOLS.has(call.tool)).length}` : `diff:${createHash('sha256').update((await d.patch(id))?.trim() ?? '').digest('hex')}`;
		// A round that changed nothing will not be followed by one that does.
		if (round && round.mark === mark) return null;
		const next = { rounds: (round?.rounds ?? 0) + 1, mark, seen: d.messages(id) };
		changeGate(id, (state) => {
			state.round = next;
		});
		reopenFinishReview(id);
		return carryOn(d.elapsed(id), d.limitMs, steps.length);
	} catch (error) {
		if (!signal?.aborted) logProblem('warn', 'Could not check whether the reply finished its work', error, id);
		return null;
	}
}

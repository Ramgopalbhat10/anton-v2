import { createHash } from 'node:crypto';
import { FILE_CHANGE_TOOLS } from '../core/tool-profile.ts';
import { getSessionRecord } from '../db/sessions.ts';
import { getProviders } from '../providers/index.ts';
import { changesView } from './files.ts';
import { otherRepoChanges } from './git.ts';
import { logProblem } from './log.ts';
import { modelFor } from './sessions.ts';
import { recordUsage } from './usage.ts';
import { liveMachine } from './workspace.ts';

/*
 * A second look at a change before the reply that made it ends. A model that
 * has worked through a long conversation reads the request it started from
 * as one message among hundreds, and most tasks that fall short do so by a
 * case the request named and the change missed. So the task's own model reads
 * only the request and the diff, with nothing else in view, and lists what the
 * request asks that the change does not do. When it finds something, the agent
 * is sent back once to check those points; when it finds nothing, the reply
 * ends as it would have. One short call, on a context of the request and the
 * diff, never the conversation, and without reasoning, which on a long diff can
 * use up any budget before the list is written.
 *
 * A model only a plan runs (ChatGPT, OpenCode Go, Claude, Cursor) cannot be
 * called on its own here, and a reviewer billed on another key would cost
 * where the plan did not. The agent itself is then given the request again,
 * whole, and asked to make that check, on its own plan.
 *
 * A chat's job often leaves no diff at all: its work is files in a folder
 * that is no repository (a report, a dataset, a script and its results), so
 * there is nothing for a reviewer to read. A reply that did real work there
 * (`WORKED` commands and file writes or more) gets the same check from the
 * agent itself, against what it made rather than a diff. Without it such a
 * job ended on the agent's first belief that it was done, and most that fell
 * short did so by one named detail the request spelled out.
 *
 * The diff read is the whole change the task made since it began, pushed or
 * not. The agent opens its pull request as soon as the change works, so what
 * is left unpushed at the end of that reply is most often nothing, and a
 * review of only that was skipped in the normal flow. A reply that leaves the
 * change as it found it (a question answered on a task whose pull request is
 * open) is not reviewed: it changed nothing to review.
 */

/** A request is kept up to this long; a task's whole brief fits. */
const MAX_REQUEST = 30_000;
/** The diff the reviewer reads; past this its start is read, with a note. */
const MAX_PATCH = 60_000;
/**
 * Room for the list. The reviewer answers without reasoning: at low effort DeepSeek still spent 6,000 tokens thinking
 * on a real task and wrote nothing, while without it the same review took 33 seconds and half a cent.
 */
const MAX_TOKENS = 4_000;
/** Past this the reply ends without the review rather than keep the user waiting. */
const REVIEW_MS = 120_000;
/** The list the agent is given back, at most. */
const MAX_FINDINGS = 3_000;
/** The request as the agent is shown it again for its own check; a brief past this is cut, with a note. */
const MAX_SELF_REQUEST = 12_000;

/** A chat reply with at least this many commands and file writes did a job, not a lookup, and is checked though it left no diff. */
const WORKED = 5;
/** The tools that work in the sandbox. */
const SANDBOX_TOOLS = new Set(['bash', 'run_in_background', ...FILE_CHANGE_TOOLS]);

/** Each task's latest request, whole: the latest input kept on the task is cut for its card. */
const requests = new Map<string, string>();
/** Tasks whose reply in hand was reviewed already, so a reply is reviewed once. */
const reviewed = new Set<string>();
/** The diff each task's last review read, so a later reply that changed nothing is not reviewed again. */
const lastPatch = new Map<string, string>();
/** Each task's change as the review last read it, by hash, whether or not it was reviewed. */
const seenPatch = new Map<string, string>();
/** The change as the reply in hand found it, when known: a reply that ends with the same one changed no code. */
const startPatch = new Map<string, string>();
const KEEP_TASKS = 200;

const remember = <T>(map: Map<string, T>, id: string, value: T) => {
	map.delete(id);
	map.set(id, value);
	if (map.size > KEEP_TASKS) map.delete(map.keys().next().value!);
};

/** Keeps the message the user gave the task, whole. */
export function noteRequest(id: string, text: string): void {
	const request = text.trim();
	if (request) remember(requests, id, request.slice(0, MAX_REQUEST));
}

/** The request the reply in hand answers, whole, or undefined when none was seen since the server started. */
export const requestFor = (id: string): string | undefined => requests.get(id);

/** A new reply may be reviewed again. */
export function startFinishReview(id: string): void {
	reviewed.delete(id);
	const seen = seenPatch.get(id);
	if (seen === undefined) startPatch.delete(id);
	else remember(startPatch, id, seen);
}

/**
 * The reply in hand may be reviewed once more, on a change it has not reviewed: after it was sent back to finish
 * work it had left undone (`completion-gate.ts`), the change it then makes is read like any other.
 */
export function reopenFinishReview(id: string): void {
	reviewed.delete(id);
}

/** The diff as the reviewer reads it: binary files as one line each, and cut past `MAX_PATCH`. */
export function reviewPatch(patch: string): string {
	const text = patch.replace(/GIT binary patch\n[\s\S]*?(?=\ndiff --git |$)/g, '[binary file]');
	return text.length > MAX_PATCH ? `${text.slice(0, MAX_PATCH)}\n[The diff goes on for ${(text.length - MAX_PATCH).toLocaleString('en-US')} more characters.]` : text;
}

export const reviewPrompt = (request: string, patch: string) =>
	[
		'A coding agent was given the request below and made the change below. You check the change against the request, with fresh eyes.',
		'',
		'<request>',
		request,
		'</request>',
		'',
		'<diff>',
		patch,
		'</diff>',
		'',
		'Find each thing the request asks for that the change does not do, or does differently from what the request says: a named function, option, flag, field, message, output format, default or edge case.',
		'Write each as one line starting with MISSING: and saying what the request asks and what the change does instead. Only what the request itself asks: no style, naming, refactoring or extra features, and nothing you are unsure the request asks.',
		'Do not list what the change already does. If it does everything the request asks, answer with the single word NONE.',
	].join('\n');

/** What the reviewer found, its MISSING: lines, or null when it found nothing. Anything else it wrote is left out. */
export function findingsOf(answer: string): string | null {
	const lines = answer
		.split('\n')
		.map((line) => /^\W*MISSING\W*:[\s*_]*(.+)$/i.exec(line.trim())?.[1]?.replace(/[*_]+$/, '').trim())
		.filter((line): line is string => Boolean(line))
		.map((line) => `- ${line}`);
	if (!lines.length) return null;
	const text = lines.join('\n');
	return text.length > MAX_FINDINGS ? `${text.slice(0, MAX_FINDINGS)}…` : text;
}

const again = (request: string) => [
	'<request>',
	request.length > MAX_SELF_REQUEST ? `${request.slice(0, MAX_SELF_REQUEST)}\n[The request goes on; read it whole in the conversation.]` : request,
	'</request>',
];

/** A doubt the agent would hand back as a footnote is the likeliest thing to be wrong, and it is the one who can still settle it. */
const SETTLE =
	'If you are about to report a caveat or a judgement call (a reading of the request you chose, a convention you assumed, a weakness you know of), settle it first from what you have: ' +
	'the data, documents, examples, existing code and tests, trying each reading against them where that can decide it. Report as open only what nothing there settles.';

/** What the agent is asked when no reviewer can read the change: the request again, whole, and the check the reviewer would make. */
export const selfCheck = (request: string) =>
	[
		'Before you end, check your change against the request with fresh eyes. Here it is again:',
		'',
		...again(request),
		'',
		'Read your diff (git diff, new files included) against it, item by item: each named function, option, flag, field, message, output format, default, error or fallback path and edge case. ' +
			`Do whatever is missing or done differently from what the request says, and run the tests that cover it. ${SETTLE} If the change already does everything, end your reply without repeating your answer.`,
	].join('\n');

/** The same check for work that left no diff: files and results in a folder that is no repository. */
export const selfCheckWork = (request: string) =>
	[
		'Before you end, check your work against the request with fresh eyes. Here it is again:',
		'',
		...again(request),
		'',
		'Go through what you are handing back (each file, output and value, where the request says it goes) against it, item by item: each named path, file name, format, field, unit, rounding, option, default, limit, error or fallback path and edge case. ' +
			`Do whatever is missing or done differently from what the request says, and run the check that covers it again. ${SETTLE} If the work already does everything, end your reply without repeating your answer.`,
	].join('\n');

type Call = { tool: string };
/** `chat` says whether the task is one whose work can sit outside any repository; a repository task's is its diff. */
type Deps = { patch: (id: string) => Promise<string | null>; chat?: (id: string) => Promise<boolean> };

const isChat = async (id: string): Promise<boolean> => {
	const session = await getSessionRecord(id);
	return Boolean(session && !session.projectId);
};

/**
 * A task's change since it began, pushed or not (null without a running machine, which is never started for this);
 * a chat's is what it changed in repositories it worked in, not the files it made in its scratch folder, which are
 * its deliverables rather than a change to code.
 */
export async function taskPatch(id: string): Promise<string | null> {
	const machine = await liveMachine(id);
	if (!machine) return null;
	const session = await getSessionRecord(id);
	if (session && !session.projectId) return otherRepoChanges(machine, new Date(session.createdAt));
	return (await changesView(id, 'branch')).patch;
}

/**
 * At the end of a reply that changed the code: what to tell the agent when a fresh read of the request and the diff
 * finds something the request asks that the change does not do; null otherwise. Once a reply (unless reopened), never
 * on a reply that ends asking the user or proposing a plan, nor on a diff already reviewed or one the reply left as it
 * was. The review counts on the task's spend.
 * On a model no reviewer here runs, the agent is sent back once with the request to make that check itself.
 * So is a chat whose reply worked in its sandbox and left no diff, against what it made (`selfCheckWork`).
 */
export async function finishReview(id: string, calls: readonly Call[], signal?: AbortSignal, deps: Deps = { patch: taskPatch, chat: isChat }): Promise<string | null> {
	const request = requests.get(id);
	if (!request || reviewed.has(id)) return null;
	const last = calls[calls.length - 1]?.tool;
	if (last === 'ask' || last === 'propose_plan') return null;
	const writer = getProviders().text;
	const { model } = modelFor(id);
	const own = writer?.runs(model) ? writer : null;
	reviewed.add(id);
	try {
		const patch = await deps.patch(id);
		// A machine that is not running says nothing of the change, so what was seen last stands.
		const change = patch === null ? null : createHash('sha256').update(patch.trim()).digest('hex');
		if (change) remember(seenPatch, id, change);
		if (!patch?.trim()) {
			const worked = calls.filter((call) => SANDBOX_TOOLS.has(call.tool)).length >= WORKED;
			return worked && (await deps.chat?.(id)) ? selfCheckWork(request) : null;
		}
		if (startPatch.get(id) === change) return null;
		const digest = createHash('sha256').update(request).update(patch).digest('hex');
		if (lastPatch.get(id) === digest) return null;
		remember(lastPatch, id, digest);
		if (!own) return selfCheck(request);
		const answer = await own.write({ model, prompt: reviewPrompt(request, reviewPatch(patch)), maxTokens: MAX_TOKENS, reasoning: 'off', timeoutMs: REVIEW_MS }, signal);
		void recordUsage(id, { inputTokens: answer.inputTokens, outputTokens: answer.outputTokens, cost: answer.cost }, model);
		const findings = findingsOf(answer.text);
		if (!findings) return null;
		return (
			'A reviewer who read only the request and your diff thinks the change misses these points:\n\n' +
			`${findings}\n\n` +
			'Check each one against the request and the code. Fix those that are real, and run the tests that cover them; skip any that are wrong. Then end your reply.'
		);
	} catch (error) {
		if (!signal?.aborted) logProblem('warn', 'The change was not reviewed', error, id);
		return null;
	}
}

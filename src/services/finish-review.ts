import { createHash } from 'node:crypto';
import { FILE_CHANGE_TOOLS } from '../core/tool-profile.ts';
import { getSessionRecord } from '../db/sessions.ts';
import { getProviders } from '../providers/index.ts';
import { changesView } from './files.ts';
import { changeGate, type GateState, gate, loadGate } from './gate-state.ts';
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
/**
 * Reviews a reply may have, each on a change it has not had reviewed: the first, and one more on what the agent
 * changes after it is sent back. A review is a model call of up to two minutes the user waits through.
 */
export const MAX_REVIEWS = 2;
/** The request-and-change pairs a task remembers having had reviewed, so none is reviewed twice. */
const KEEP_REVIEWED = 20;
/** The files whose diffs a task keeps a hash of, to tell what the reply in hand changed; one past these counts as changed. */
const KEEP_FILES = 500;

/*
 * What the review knows of each task (its request, the change as last read and as the reply in hand found it, and
 * what it reviewed) is kept with the task's checks (`gate-state.ts`), so a reply resumed after a restart is reviewed
 * as it would have been.
 */

/** Keeps the message the user gave the task, whole. */
export function noteRequest(id: string, text: string): void {
	const request = text.trim().slice(0, MAX_REQUEST);
	if (request)
		changeGate(id, (state) => {
			state.request = request;
		});
}

/** The request the reply in hand answers, whole, or undefined when the task has none. */
export const requestFor = (id: string): string | undefined => gate(id).request;

/** A new reply may be reviewed again, from the change as the last reply left it. */
export function startFinishReview(id: string): void {
	changeGate(id, ({ review }) => {
		review.reviews = 0;
		review.extra = 0;
		review.selfChecked = false;
		review.workChecked = false;
		review.start = review.seen;
		review.startFiles = review.files;
	});
}

/**
 * The reply in hand may be reviewed once more, on a change it has not reviewed: after it was sent back to finish
 * work it had left undone (`completion-gate.ts`), the change it then makes is read like any other, though the reply
 * has had its `MAX_REVIEWS`, and the agent's own check (on a plan model, or of a chat's work) may be asked again.
 */
export function reopenFinishReview(id: string): void {
	changeGate(id, ({ review }) => {
		review.extra = Math.max(review.extra, review.reviews + 1 - MAX_REVIEWS);
		review.selfChecked = false;
		review.workChecked = false;
	});
}

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

/** The path a file's section of a diff names: the new one of a rename, the old one of a deletion. */
function pathOf(section: string): string {
	const line = section.split('\n', 1)[0];
	const at = Math.max(line.lastIndexOf(' b/'), line.lastIndexOf(' "b/'));
	return at < 0 ? line : line.slice(at + (line[at + 1] === '"' ? 4 : 3)).replace(/"$/, '');
}

/** A diff's files, each its `diff --git` section, in the diff's order. */
export function patchFiles(patch: string): Array<{ path: string; text: string }> {
	const starts = [...patch.matchAll(/^diff --git /gm)].map((match) => match.index);
	return starts.map((start, index) => {
		const text = patch.slice(start, starts[index + 1] ?? patch.length);
		return { path: pathOf(text), text };
	});
}

/** Each file's diff by hash, for the first `KEEP_FILES` files. */
function fileHashes(patch: string): Record<string, string> {
	const files: Record<string, string> = {};
	for (const file of patchFiles(patch).slice(0, KEEP_FILES)) files[file.path] = sha(file.text).slice(0, 16);
	return files;
}

/** The diff as the reviewer reads it: binary files as one line each, and cut past `MAX_PATCH`. */
export function reviewPatch(patch: string, _changed?: (path: string) => boolean): string {
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
 * finds something the request asks that the change does not do; null otherwise. A change is reviewed when it is one
 * this task has not had reviewed for this request, up to `MAX_REVIEWS` a reply (more once the completion gate reopens
 * it), so what the agent changes after a review sent it back is read too. Never on a reply that ends asking the user
 * or proposing a plan, nor on a change the reply left as it found it. The change is read at every end that gets here,
 * reviewed or not, so the next reply starts from it as this one really left it. A reply with no diff spends nothing.
 * The review counts on the task's spend.
 * On a model no reviewer here runs, the agent is sent back once a reply with the request to make that check itself.
 * So is a chat whose reply worked in its sandbox and left no diff, against what it made (`selfCheckWork`).
 */
export async function finishReview(id: string, calls: readonly Call[], signal?: AbortSignal, deps: Deps = { patch: taskPatch, chat: isChat }): Promise<string | null> {
	const last = calls[calls.length - 1]?.tool;
	if (last === 'ask' || last === 'propose_plan') return null;
	await loadGate(id);
	const { request, review } = gate(id);
	if (!request) return null;
	const writer = getProviders().text;
	const { model } = modelFor(id);
	const own = writer?.runs(model) ? writer : null;
	try {
		const patch = await deps.patch(id);
		// A machine that is not running says nothing of the change, so what was seen last stands.
		const change = patch === null ? null : sha(patch.trim());
		const files = patch === null ? {} : fileHashes(patch);
		if (change !== null)
			changeGate(id, (state) => {
				state.review.seen = change;
				state.review.files = files;
			});
		if (!patch?.trim()) {
			if (review.workChecked) return null;
			const worked = calls.filter((call) => SANDBOX_TOOLS.has(call.tool)).length >= WORKED;
			if (!worked || !(await deps.chat?.(id))) return null;
			changeGate(id, (state) => {
				state.review.workChecked = true;
			});
			return selfCheckWork(request);
		}
		if (review.start === change) return null;
		const digest = createHash('sha256').update(request).update(patch).digest('hex');
		if (review.reviewed.includes(digest)) return null;
		const remember = (state: GateState) => {
			state.review.reviewed = [...state.review.reviewed.filter((kept) => kept !== digest), digest].slice(-KEEP_REVIEWED);
		};
		if (!own) {
			if (review.selfChecked) return null;
			changeGate(id, (state) => {
				state.review.selfChecked = true;
				remember(state);
			});
			return selfCheck(request);
		}
		if (review.reviews >= MAX_REVIEWS + review.extra) return null;
		// A file whose diff is not the one the reply found, or that it did not have, is the reply's own; on a task's first reply, every file.
		const before = review.startFiles;
		const changed = (path: string) => !before?.[path] || before[path] !== files[path];
		let answer: Awaited<ReturnType<typeof own.write>>;
		try {
			answer = await own.write({ model, prompt: reviewPrompt(request, reviewPatch(patch, changed)), maxTokens: MAX_TOKENS, reasoning: 'off', timeoutMs: REVIEW_MS }, signal);
		} finally {
			// Counted once it has run or failed, not before: a review a restart cut short runs again when the reply's end is checked again.
			changeGate(id, (state) => {
				state.review.reviews += 1;
				remember(state);
			});
		}
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

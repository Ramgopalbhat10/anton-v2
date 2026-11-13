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
/** The diff the reviewer reads whole; past this, every file by name and the diffs that fit (`largePatch`). */
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

/** Whether a message is the task's request as kept: the one that started the reply in hand, not one that joined it. */
export const isRequest = (id: string, text: string): boolean => gate(id).request === text.trim().slice(0, MAX_REQUEST);

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

/** Files a person does not write: lock files, and generated, minified, snapshot and vendored ones. Their diffs are read last. */
const MADE = [
	/(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|go\.sum)$/,
	/\.lock$/,
	/\.min\.[^/]+$/,
	/\.snap$/,
	/(?:^|\/)(?:dist|vendor|node_modules|__snapshots__)\//,
];
/** The list of files is given up to this share of the room; past it, how many more there are. */
const LIST_SHARE = 0.25;
/** A file's diff is given up to this share of what is left for diffs, so one large file does not crowd out the rest. */
const FILE_SHARE = 0.25;
/** A file's diff is not cut shorter than this to fit; it is left out and named instead. */
const MIN_PART = 1_500;
/** Room kept for the line naming the files whose diffs were left out. */
const CLOSING = 1_000;

const lineCount = (text: string) => text.split('\n').length - (text.endsWith('\n') ? 1 : 0);

/** A file's diff cut to about `size`: its header, its first hunks and its last, and a line saying how much was left out. */
function cutFile(text: string, size: number): string {
	const lines = text.replace(/\n$/, '').split('\n');
	const first = lines.findIndex((line) => line.startsWith('@@'));
	const header = first < 0 ? lines.slice(0, 1) : lines.slice(0, first);
	const body = lines.slice(header.length);
	// Whole hunks where they fit, else lines: the first two thirds of the room from the start, the rest from the end.
	const hunks: string[][] = [];
	for (const line of body) {
		if (line.startsWith('@@') || !hunks.length) hunks.push([]);
		hunks[hunks.length - 1].push(line);
	}
	const sizeOf = (part: string[]) => part.reduce((sum, line) => sum + line.length + 1, 0);
	let room = size - sizeOf(header);
	const keep = (units: string[][]) => {
		const head: string[][] = [];
		const tail: string[][] = [];
		let left = room;
		let start = 0;
		for (; start < units.length && sizeOf(units[start]) <= left - room / 3; start++) {
			head.push(units[start]);
			left -= sizeOf(units[start]);
		}
		for (let end = units.length - 1; end >= start && sizeOf(units[end]) <= left; end--) {
			tail.unshift(units[end]);
			left -= sizeOf(units[end]);
		}
		return { head: head.flat(), tail: tail.flat() };
	};
	let kept = keep(hunks);
	// A first hunk too long to keep whole (a new file is one hunk) is cut by lines, so the diff's start is always read.
	if (!kept.head.length) {
		room = Math.max(room, 0);
		kept = keep(body.map((line) => [line]));
	}
	const left = body.length - kept.head.length - kept.tail.length;
	return [...header, ...kept.head, `[${left.toLocaleString('en-US')} lines of this file's diff left out]`, ...kept.tail].join('\n') + '\n';
}

/**
 * A diff past `MAX_PATCH`, read in the same room: every file it changes by name with its lines added and removed,
 * then each file's diff, the files `changed` names (the reply in hand's) first and, in each group, files a person
 * writes before lock files and generated ones; a long diff cut to its first hunks and its last, and the files whose
 * diffs did not fit named at the end. Cut from the start alone, a large change hid its last files whole, and on a
 * later reply of a task whose branch was already large, often the very files that reply changed.
 */
function largePatch(text: string, files: Array<{ path: string; text: string }>, changed: (path: string) => boolean): string {
	const order = files
		.map((file, index) => ({ ...file, index, mine: changed(file.path), made: MADE.some((pattern) => pattern.test(file.path)) }))
		.sort((a, b) => Number(!a.mine) - Number(!b.mine) || Number(a.made) - Number(b.made) || a.index - b.index);
	const counts = (file: { text: string }) => {
		if (/^\[binary file\]$/m.test(file.text)) return 'binary';
		const body = file.text.split('\n').slice(1);
		const start = body.findIndex((line) => line.startsWith('@@'));
		const hunks = start < 0 ? [] : body.slice(start);
		return `+${hunks.filter((line) => line.startsWith('+')).length} -${hunks.filter((line) => line.startsWith('-')).length}`;
	};
	const intro = `[This diff runs to ${text.length.toLocaleString('en-US')} characters, more than is read whole. Every file it changes is listed first, with its lines added and removed; then each file's diff, long ones cut.]`;
	const listed: string[] = [];
	let listSize = 0;
	for (const file of order) {
		const line = `${file.path} ${counts(file)}`;
		if (listSize + line.length + 1 > MAX_PATCH * LIST_SHARE) {
			listed.push(`[and ${(order.length - listed.length).toLocaleString('en-US')} more files]`);
			break;
		}
		listed.push(line);
		listSize += line.length + 1;
	}
	const head = [intro, 'Files changed:', ...listed, ''].join('\n');
	const room = MAX_PATCH - head.length - CLOSING;
	const cap = Math.max(MIN_PART, Math.floor(room * FILE_SHARE));
	// Each file gets its share first, in order; what is left then goes to the files that were cut, in the same order.
	const given = new Map<number, number>();
	let left = room;
	for (const file of order) {
		const want = Math.min(file.text.length, cap);
		if (want <= left) given.set(file.index, want);
		else if (left >= MIN_PART) given.set(file.index, left);
		else continue;
		left -= given.get(file.index)!;
	}
	for (const file of order) {
		const share = given.get(file.index);
		if (share === undefined || share >= file.text.length || left <= 0) continue;
		const more = Math.min(file.text.length - share, left);
		given.set(file.index, share + more);
		left -= more;
	}
	const diffs = order.flatMap((file) => {
		const share = given.get(file.index);
		if (share === undefined) return [];
		return [share >= file.text.length ? file.text : cutFile(file.text, share)];
	});
	const out = order.filter((file) => !given.has(file.index)).map((file) => file.path);
	let closing = '';
	if (out.length) {
		const names: string[] = [];
		for (const name of out) {
			if (names.join(', ').length + name.length > CLOSING - 200) break;
			names.push(name);
		}
		const rest = out.length - names.length;
		closing = `[Diffs left out for room, of files listed above: ${names.join(', ')}${rest ? ` and ${rest.toLocaleString('en-US')} more` : ''}.]`;
	}
	return `${head}\n${diffs.map((diff) => (diff.endsWith('\n') ? diff : `${diff}\n`)).join('')}${closing}`.replace(/\n$/, '');
}

/**
 * The diff as the reviewer reads it: binary files as one line each. Within `MAX_PATCH` it is the diff itself, as the
 * benchmark results were measured on; past it, every file by name and the diffs that fit (`largePatch`), the reply in
 * hand's files first, as `changed` says (every file when not given).
 */
export function reviewPatch(patch: string, changed: (path: string) => boolean = () => true): string {
	const text = patch.replace(/GIT binary patch\n[\s\S]*?(?=\ndiff --git |$)/g, '[binary file]');
	if (text.length <= MAX_PATCH) return text;
	const files = patchFiles(text);
	if (!files.length) return `${text.slice(0, MAX_PATCH)}\n[The diff goes on for ${(text.length - MAX_PATCH).toLocaleString('en-US')} more characters.]`;
	return largePatch(text, files, changed);
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
		// A live run's reviewer sent back a reply asked to run the suite and report its failures, because no diff can show a
		// report; and one that read "format it like '07:05' does" as "return '07:05'" where the change followed the plain reading.
		'Judge only what a diff can show. A request to run commands or tests, report results, explain or answer something is not missing from the change. Where the request can be read more than one way and the change follows a reasonable reading, it is not missing.',
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

/** The request between tags, as the agent is shown it again: past `MAX_SELF_REQUEST` its start, with `note` saying so. */
export const requestLines = (request: string, note = '[The request goes on; read it whole in the conversation.]') => [
	'<request>',
	request.length > MAX_SELF_REQUEST ? `${request.slice(0, MAX_SELF_REQUEST)}\n${note}` : request,
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
		...requestLines(request),
		'',
		'Read your diff (git diff, new files included) against it, item by item: each named function, option, flag, field, message, output format, default, error or fallback path and edge case. ' +
			`Do whatever is missing or done differently from what the request says, and run the tests that cover it. ${SETTLE} If the change already does everything, end your reply without repeating your answer.`,
	].join('\n');

/** The same check for work that left no diff: files and results in a folder that is no repository. */
export const selfCheckWork = (request: string) =>
	[
		'Before you end, check your work against the request with fresh eyes. Here it is again:',
		'',
		...requestLines(request),
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

import { createHash } from 'node:crypto';
import { getSessionRecord } from '../db/sessions.ts';
import { changesView } from './files.ts';
import { otherRepoChanges } from './git.ts';
import { logProblem } from './log.ts';
import { liveMachine } from './workspace.ts';

/*
 * A check of a change, by running it, before the reply that made it ends. A
 * model that has worked through a long conversation reads the request it
 * started from as one message among hundreds, and most changes that fall
 * short do so by a case the request named that the change missed, or built
 * but never reached the way a user would reach it. Reading its own diff again
 * in the same conversation, the agent tends to see what it meant to write.
 *
 * So the agent is sent back to hand the change to the verifier subagent: its
 * own conversation, with only the request and the sandbox in view, which
 * lists what the request names and exercises each one through the command,
 * API, endpoint or end state a user would meet, then reports pass or fail with
 * what it ran. A subagent runs on the task's model, so on a plan model it is
 * billed to the plan like the rest of the task. When the agent changes the
 * code after a report, the result is verified once more; a small change, a
 * reply that ends asking the user, and a diff already verified end as they are.
 */

/** A request is kept up to this long; a task's whole brief fits. */
const MAX_REQUEST = 30_000;
/** Times one reply is sent back to verify: the change, and the change once more after fixing what the verifier found. */
const MAX_ROUNDS = 2;
/** A change of fewer added and removed lines than this ends without a verifier: a one-line fix needs no second agent. */
const MIN_CHANGED_LINES = 20;

/** Each task's latest request, whole: the latest input kept on the task is cut for its card. */
const requests = new Map<string, string>();
/** How many times the reply in hand was sent back to verify. */
const rounds = new Map<string, number>();
/** The diff each task's last verification was asked for, so a later reply that changed nothing is not verified again. */
const lastPatch = new Map<string, string>();
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

/** The task's latest request, whole, as the verifier reads it. */
export function requestFor(id: string): string | null {
	return requests.get(id) ?? null;
}

/** A new reply may be sent back to verify again. */
export function startFinishReview(id: string): void {
	rounds.delete(id);
}

/** Lines the diff adds or removes, not counting its file headers. */
export function changedLines(patch: string): number {
	return patch.split('\n').filter((line) => /^[+-]/.test(line) && !/^(\+\+\+|---) /.test(line)).length;
}

/** The verifier's instructions: the request, and how to check a change against it by running it. */
export const verifierPrompt = (request: string | null) =>
	[
		'You are the verifier. Another agent changed the code in this sandbox to do what the user asked. You did not write the change, and you see neither its conversation nor its reasoning: only the request and the code.',
		'Your job is to find out, by running things, whether the change does what the request asks.',
		'',
		'<request>',
		request ?? '(The request was not kept; take it from your brief.)',
		'</request>',
		'',
		'1. List the behaviour the request names: each function, command, option, flag, field, message, output format, default, error and fallback path, edge case and end state.',
		'2. Read the change (git status and git diff, new files included) to find where each one lives and how a user reaches it.',
		'3. Check each one the way it will be used: run the command, call the public API from a short script, request the endpoint, or look at the files, services or state the request says should result. Write any script under /tmp, never in the repository.',
		'4. Run the existing tests that cover the changed code once, and note any that fail.',
		'Change, stage and commit nothing in the repository, and fix nothing: report. When something cannot be checked here (it needs the user, a browser or a network), say so rather than guess.',
		'Finish with one line per behaviour, failures first: PASS, FAIL or UNCHECKED, the behaviour in the request\'s words, and the command you ran with the line of its output that shows it. ' +
			'Then a last line: VERDICT: PASS when every behaviour passed and no test failed, otherwise VERDICT: FAIL.',
	].join('\n');

/** What the agent is told when it is sent back to verify, the first time in a reply and after fixing. */
export const verifyReminder = (round: number) =>
	round === 0
		? 'Before you end, have the change verified by someone who did not write it: call the verifier subagent. It already has the request; brief it with how to build, run and test the project and where the change lives, not with what you think works. ' +
			'Then fix each FAIL it reports that is real, and run what covers it; skip one that misreads the request, saying why. Then end your reply.'
		: 'You changed the code after the verifier reported. Call the verifier once more to check the result, fix what it still finds that is real, then end your reply.';

type Call = { tool: string };
type Deps = { patch: (id: string) => Promise<string | null> };

/**
 * A task's change; a chat's is what it changed in repositories it worked in, not the files it made in its scratch
 * folder, which are its deliverables rather than a change to code.
 */
async function livePatch(id: string): Promise<string | null> {
	const machine = await liveMachine(id);
	if (!machine) return null;
	const session = await getSessionRecord(id);
	if (session && !session.projectId) return otherRepoChanges(machine, new Date(session.createdAt));
	return (await changesView(id)).patch;
}

/**
 * At the end of a reply that changed the code: what to tell the agent so the verifier checks the change, null
 * otherwise. Never on a reply that ends asking the user or proposing a plan, on a small change, on a diff already
 * verified, or past `MAX_ROUNDS` in one reply.
 */
export async function finishReview(id: string, calls: readonly Call[], signal?: AbortSignal, deps: Deps = { patch: livePatch }): Promise<string | null> {
	const request = requests.get(id);
	const round = rounds.get(id) ?? 0;
	if (!request || round >= MAX_ROUNDS) return null;
	const last = calls[calls.length - 1]?.tool;
	if (last === 'ask' || last === 'propose_plan') return null;
	try {
		const patch = await deps.patch(id);
		if (!patch?.trim() || changedLines(patch) < MIN_CHANGED_LINES) return null;
		const digest = createHash('sha256').update(request).update(patch).digest('hex');
		if (lastPatch.get(id) === digest) return null;
		remember(lastPatch, id, digest);
		rounds.set(id, round + 1);
		return verifyReminder(round);
	} catch (error) {
		if (!signal?.aborted) logProblem('warn', 'The change was not verified', error, id);
		return null;
	}
}

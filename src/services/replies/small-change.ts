import { decide, yesOf } from '../models/decisions.ts';

/*
 * Prod, Nov 2026: a one-class padding change took 72 agent steps and 5.35M tokens, about 1.3M of them on the reply-end
 * self-check and the pre-push reviewer, and neither found anything. A small diff the decision model is sure of skips the
 * round that would not change it; anything larger, or anything it is unsure of, is checked as before.
 */

/** Added and removed lines, about what one screen of diff shows. */
export const SMALL_CHANGE_LINES = 20;
/** Its probability of the answer that would have kept the check: 10%, as `documentationOnly` in code-review.ts. */
const UNSURE = 0.1;
/** Well inside the decision model's 32k-token window. */
const MAX_REQUEST_CHARS = 8_000;

/** Lines added or removed inside the hunks, so file headers do not count. */
export function changedLines(patch: string): number {
	let count = 0;
	let inHunk = false;
	for (const line of patch.split('\n')) {
		if (line.startsWith('diff --git ')) inHunk = false;
		else if (line.startsWith('@@')) inHunk = true;
		else if (inHunk && (line.startsWith('+') || line.startsWith('-'))) count += 1;
	}
	return count;
}

export const isSmallChange = (patch: string) => changedLines(patch) <= SMALL_CHANGE_LINES;

const BEHAVIOUR =
	'Could this change alter what the program does, beyond how it looks or the text it shows? ' +
	'Yes if it changes logic, data, state, events, control flow, interfaces, types, configuration, dependencies or the build, or removes or adds an element other code or tests rely on. ' +
	'No only if it changes nothing but styling, layout values, CSS classes or copy, and tests that check those.';

/** A small diff of styling or copy alone, as the decision model is sure; false without one. */
export async function cosmeticChange(id: string, patch: string): Promise<boolean> {
	if (!isSmallChange(patch)) return false;
	const answers = await decide(id, { diff: patch }, { behaviour: { type: 'yes-no', instructions: BEHAVIOUR } });
	return (yesOf(answers?.behaviour) ?? 1) <= UNSURE;
}

const COVERS =
	'Does this diff do everything the request asks for, each part of it, with nothing it names missing or done differently? ' +
	'Judge only what a diff can show: a request to run commands, report or explain is not missing from it.';

/** A small diff the decision model is sure does all the request asks; false without one. */
export async function coversRequest(id: string, request: string, patch: string): Promise<boolean> {
	if (!isSmallChange(patch)) return false;
	const answers = await decide(id, { request: request.slice(0, MAX_REQUEST_CHARS), diff: patch }, { covers: { type: 'yes-no', instructions: COVERS } });
	return 1 - (yesOf(answers?.covers) ?? 0) <= UNSURE;
}

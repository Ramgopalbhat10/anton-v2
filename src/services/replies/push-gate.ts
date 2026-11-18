import { InvalidInputError } from '../../core/errors.ts';
import { logProblem } from '../../core/log.ts';
import { updateSession } from '../../db/sessions.ts';
import { openPullRequest, preparePullRequest } from '../git/pull-requests.ts';
import { changeGate, gate, loadGate } from './gate-state.ts';

/*
 * One push a reply, at its end. `open_pull_request` commits in the sandbox and leaves the title and description here; the
 * branch is pushed and the pull request opened or updated once every other check at the reply's end has passed, so the
 * host's checks and Anton's Reviewer run once on the finished change. In a task that pushed as it went, the PR was pushed
 * three times in one reply and the Reviewer read it three times. Kept with the task's checks, so a restart keeps it.
 */

/** A failed push goes back to the agent this many times a reply; past it the user is told, and the next reply tries again. */
const MAX_TRIES = 2;

export type QueuedPullRequest = { title: string; body: string };
export type Opened = { url: string; title: string };

type Deps = {
	prepare: (id: string, input: QueuedPullRequest) => Promise<void>;
	open: (id: string, input: QueuedPullRequest) => Promise<string>;
	fail: (id: string, message: string | null) => Promise<void>;
};

const defaults: Deps = {
	prepare: preparePullRequest,
	open: openPullRequest,
	fail: async (id, message) => {
		await updateSession(id, { errorMessage: message });
	},
};

/** What the reply in hand pushed, for its message's pull request card. */
const opened = new Map<string, Opened>();

export async function queuePullRequest(id: string, input: QueuedPullRequest, deps: Deps = defaults): Promise<string> {
	await deps.prepare(id, input);
	await loadGate(id);
	const again = Boolean(gate(id).pullRequest);
	changeGate(id, (state) => {
		state.pullRequest = { title: input.title, body: input.body };
	});
	return (
		`Committed in the sandbox${again ? ', and the title and description replaced' : ''}. ` +
		'Anton pushes the branch and opens or updates the pull request once, when your reply ends; the thread shows its link then. ' +
		'Commit further fixes as you go and finish the checks you have left: there is no need to call this again unless the title or description changes. ' +
		'Do not write a link to the pull request yourself.'
	);
}

export function startPushGate(id: string): void {
	opened.delete(id);
	changeGate(id, (state) => {
		state.pushTries = 0;
	});
}

/** Null once the queued pull request is pushed, or when none is queued; else what to send back. */
export async function pushGate(id: string, deps: Deps = defaults): Promise<string | null> {
	await loadGate(id);
	const queued = gate(id).pullRequest;
	if (!queued) return null;
	try {
		const url = await deps.open(id, queued);
		const failedBefore = gate(id).pushFailed;
		changeGate(id, (state) => {
			state.pullRequest = undefined;
			state.pushFailed = undefined;
		});
		if (failedBefore) await deps.fail(id, null).catch(() => undefined);
		opened.set(id, { url, title: queued.title });
		return null;
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		const tries = (gate(id).pushTries ?? 0) + 1;
		changeGate(id, (state) => {
			state.pushTries = tries;
		});
		// Nothing to push is settled, not failed: the change is already on the host or was undone.
		if (error instanceof InvalidInputError && /no changes/i.test(reason)) {
			changeGate(id, (state) => {
				state.pullRequest = undefined;
			});
			return null;
		}
		if (tries > MAX_TRIES) {
			logProblem('warn', 'The pull request was not pushed', error, id);
			changeGate(id, (state) => {
				state.pushFailed = true;
			});
			await deps.fail(id, `The pull request could not be pushed: ${reason}`).catch(() => undefined);
			return null;
		}
		return `Your reply ended, and Anton could not push the branch and open the pull request: ${reason}\nFix what stops it (commit or resolve what it names), then end your reply again; it is pushed then. Call open_pull_request only to change its title or description.`;
	}
}

export const openedThisReply = (id: string): Opened | undefined => opened.get(id);

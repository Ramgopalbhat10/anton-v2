import { createHash } from 'node:crypto';
import { getSessionRecord } from '../../db/sessions.ts';
import { changesView } from '../artifacts/files.ts';
import { settleFetchedBase } from '../git/base-merge.ts';
import { generalSettings } from '../models/general.ts';
import { liveMachine } from '../sandbox/workspace.ts';
import { patchFiles } from './finish-review.ts';
import { changeGate, gate, loadGate } from './gate-state.ts';
import { reviewerRan, startReviewerRuns } from './reviewer-runs.ts';

/*
 * Anton's pull request reviewer used to be the first to ask what a change breaks, after the push. Each finding then cost a
 * fix round, which resumes the agent's whole conversation: on five production pull requests (Nov 2026) a fix reply took
 * about 4M input tokens against about 0.4M for a review, and 9 of 19 findings were in the first push. So once a reply, when
 * it is about to push, the agent has its reviewer subagent read the change with fresh eyes. After a push it reads only the
 * commits since, so a fix is checked for what it breaks without the whole change read again.
 */

/** Documentation alone is not reviewed after a push either (`documentationOnly` in code-review.ts). */
const PROSE = /(?:^|\/)docs?\/|\.(?:md|mdx|markdown|txt|rst|adoc)$/i;

/** The task's whole change, and where the review starts: the commit last pushed when the sandbox has it, else the task's base. */
type Change = { patch: string; from: string; pushed: boolean };

type Deps = {
	change: (id: string) => Promise<Change | null>;
	reviews: () => Promise<boolean>;
};

/** Null without a running machine, which is never started for this. */
async function taskChange(id: string): Promise<Change | null> {
	const machine = await liveMachine(id);
	if (!machine) return null;
	await settleFetchedBase(id, machine);
	const session = await getSessionRecord(id);
	if (!session?.projectId) return null;
	const view = await changesView(id, 'branch');
	return { patch: view.patch, from: view.pushedSha ?? session.baseSha, pushed: Boolean(view.pushedSha) };
}

const defaults: Deps = {
	change: taskChange,
	reviews: async () => (await generalSettings()).reviewPullRequests,
};

export function startPrePushReview(id: string): void {
	startReviewerRuns(id);
	changeGate(id, (state) => {
		state.bugsAsked = false;
	});
}

export const bugReviewMessage = (from: string, pushed: boolean) =>
	[
		'Before Anton pushes your change, have it reviewed with fresh eyes for what it could break.',
		`Start the reviewer subagent with a brief that says in two or three sentences what the change is for, and that it is \`git diff ${from.slice(0, 12)}\` in the repository${pushed ? ' (what changed since your last push)' : ''}.`,
		'It reports problems with a severity. Check each against the code and what the user asked for before you act: a reviewer can be wrong. ' +
			'Fix each critical, high or medium one that holds, with a test that covers it, and commit; for one that does not, or that rests on a risk the code already accepts elsewhere, say why in a line and leave it. Leave low ones out of this reply and name them in a line. ' +
			'Do not build a new feature, data model or approval flow to answer a finding: name it in your reply as a question for the user. It reviews once a reply, so do not ask it again; end your reply: Anton pushes it then.',
		'If you cannot start the subagent, read that diff yourself the same way: callers and state it touches, ordering and timing, error and failure paths, input limits, and data in the shape the real system produces.',
	].join('\n');

/** Null unless the reply is about to push a change no such review has read; asked once a reply. */
export async function prePushReview(id: string, deps: Deps = defaults): Promise<string | null> {
	await loadGate(id);
	const { pullRequest, bugsAsked, bugsReviewed } = gate(id);
	if (!pullRequest) return null;
	if (!(await deps.reviews())) return null;
	const change = await deps.change(id);
	const patch = change?.patch.trim();
	if (!change || !patch) return null;
	const digest = createHash('sha256').update(patch).digest('hex');
	// The fixes made for the review asked in this reply count as reviewed, so a later reply that changes nothing is not held.
	// A reply whose agent already had the reviewer read its change is not asked again.
	if (bugsAsked || reviewerRan(id)) {
		changeGate(id, (state) => {
			state.bugsReviewed = digest;
		});
		return null;
	}
	if (bugsReviewed === digest) return null;
	const paths = patchFiles(patch).map((file) => file.path);
	if (paths.length && paths.every((file) => PROSE.test(file))) return null;
	changeGate(id, (state) => {
		state.bugsAsked = true;
		state.bugsReviewed = digest;
	});
	return bugReviewMessage(change.from, change.pushed);
}

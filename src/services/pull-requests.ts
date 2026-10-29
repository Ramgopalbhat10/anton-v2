import { getProject } from '../db/projects.ts';
import { getPullRequestRecord, listPullRequestRecords, type PullRequestRecord, recordPullRequest, setPullRequestState } from '../db/pull-requests.ts';
import { getSessionRecord, updateSession } from '../db/sessions.ts';
import { getProviders } from '../providers/index.ts';
import { branchAfterMerge, conflictedFiles, settleMergedBase } from './base-merge.ts';
import { saveCheckpoint } from './checkpoints.ts';
import { reviewAfterPush } from './code-review.ts';
import { commitAndPush } from './git.ts';
import { savePullRequestStatus } from './pr-status.ts';
import { watchPullRequest } from './pr-watch.ts';
import { machineFor } from './workspace.ts';
import { InvalidInputError, NotFoundError } from '../core/errors.ts';
import type { MergeMethod, PullRequestDetail, PullRequestState } from '../core/ports.ts';
import { announce } from '../core/changes.ts';

/** The number at the end of a pull request's URL. */
const numberOf = (url: string) => Number(/\/pull\/(\d+)/.exec(url)?.[1] ?? 0);

/**
 * Commits the task's work, sends its branch to the host and opens (or finds)
 * the pull request. Anton pushes through the host's API with its own
 * credentials, so they never enter the machine the agent works in. Each push
 * is then reviewed, when reviews are on, and its checks watched. Once the
 * task's pull request has merged, the next one starts on a new branch from
 * the base as it is now (`branchAfterMerge`).
 */
export async function openPullRequest(id: string, input: { title: string; body: string }): Promise<string> {
	let session = await getSessionRecord(id);
	if (session && !session.projectId) throw new InvalidInputError('A chat has no repository to open a pull request on.');
	const project = session && (await getProject(session.projectId));
	if (!session || !project) throw new NotFoundError('Session not found');
	if (session.review) throw new InvalidInputError("This task reviews someone else's pull request; Anton does not push to it. Describe fixes in the review instead.");
	const { git } = getProviders();
	const machine = await machineFor(id);
	if (session.prUrl && (session.pullRequest?.state === 'merged' || (await git.pullRequestState(session.prUrl).catch(() => null)) === 'merged')) {
		await setPullRequestState(session.prUrl, 'merged');
		await branchAfterMerge(id, machine);
		session = (await getSessionRecord(id))!;
	}
	const conflicted = await conflictedFiles(machine);
	if (conflicted.length) throw new InvalidInputError(`Resolve the merge conflicts first, then git add the files: ${conflicted.join(', ')}`);
	const pushed = await commitAndPush(machine, git, {
		repo: project.repoFullName,
		branch: session.branch,
		baseSha: session.baseSha,
		message: input.title,
	});
	if (!pushed) throw new InvalidInputError('There are no changes to open a pull request with.');
	await updateSession(id, { pushedSha: pushed });
	await settleMergedBase(id, machine);
	const url = await git.openPullRequest({
		repo: project.repoFullName,
		head: session.branch,
		base: session.baseBranch,
		title: input.title,
		body: input.body,
	});
	await updateSession(id, { prUrl: url, pullRequestJson: JSON.stringify({ url, state: 'open', checks: null, runs: [] }) });
	await recordPullRequest({ url, sessionId: id, repo: project.repoFullName, number: numberOf(url), title: input.title, head: session.branch, base: session.baseBranch, state: 'open' });
	announce({ kind: 'task', id, what: 'pr-metadata' });
	// Its checks start now; the card follows them closely rather than on the next slow round.
	watchPullRequest(id);
	await saveCheckpoint(id, machine);
	reviewAfterPush(id);
	return url;
}

export type PullRequestView = { url: string; state: PullRequestState | null };

/** The task's pull request and its state on the git host, or null before one is opened. */
export async function pullRequestView(id: string): Promise<PullRequestView | null> {
	const session = await getSessionRecord(id);
	if (!session) throw new NotFoundError('Session not found');
	if (!session.prUrl) return null;
	// The link is still worth showing when the host can't be reached.
	const state = await getProviders().git.pullRequestState(session.prUrl).catch(() => null);
	if (state && state !== session.pullRequest?.state) {
		const open = state === 'open' || state === 'draft';
		const checks = open ? session.pullRequest : null;
		await savePullRequestStatus(session, { state, checks: checks?.checks ?? null, runs: checks?.runs ?? [] });
	}
	return { url: session.prUrl, state };
}

/** A pull request in the task's list: `current` is the one the task works on now. */
export type PullRequestItem = PullRequestRecord & { current: boolean };

/** Every pull request the task opened, newest first; its current one carries its latest state. */
export async function pullRequestsOf(id: string): Promise<PullRequestItem[]> {
	const session = await getSessionRecord(id);
	if (!session) throw new NotFoundError('Session not found');
	const records = await listPullRequestRecords(id);
	return records.map((record) => {
		const current = record.url === session.prUrl;
		return { ...record, current, state: (current ? session.pullRequest?.state : null) ?? record.state };
	});
}

async function recordOf(id: string, number: number): Promise<PullRequestRecord> {
	const record = await getPullRequestRecord(id, number);
	if (!record) throw new NotFoundError('This task has no such pull request');
	return record;
}

/** Resolve only PRs belonging to the task, including old tasks without a history record. */
async function detailRecord(id: string, number: number) {
	const record = await getPullRequestRecord(id, number);
	const session = record ? null : await getSessionRecord(id);
	const url = record?.url ?? (session?.prUrl && numberOf(session.prUrl) === number ? session.prUrl : null);
	if (!url) throw new NotFoundError('This task has no such pull request');
	return { record, url };
}

/** Lightweight metadata for chat, without the PR panel's checks and discussion. */
export async function pullRequestMetadata(id: string, number: number) {
	const { url } = await detailRecord(id, number);
	return getProviders().git.pullRequestMetadata(url);
}

/** What the PR panel shows of one of the task's pull requests, read from the host; its state is kept as read. */
export async function pullRequestDetail(id: string, number: number): Promise<PullRequestDetail> {
	const { record, url } = await detailRecord(id, number);
	const detail = await getProviders().git.pullRequestDetail(url);
	if (record && (detail.state !== record.state || detail.mergedAt !== record.mergedAt)) await setPullRequestState(url, detail.state, detail.mergedAt);
	return detail;
}

/** The pull request's whole diff, as the host shows it. */
export async function pullRequestDiff(id: string, number: number): Promise<string> {
	return getProviders().git.pullRequestDiff((await recordOf(id, number)).url);
}

/**
 * Merges one of the task's own pull requests on the host, squashing by default, as long as its head is still
 * the one you saw (`sha`). The task then counts it merged, and its next pull request starts afresh.
 */
export async function mergePullRequest(id: string, number: number, input: { method?: MergeMethod; sha?: string } = {}): Promise<PullRequestDetail> {
	const session = await getSessionRecord(id);
	if (!session) throw new NotFoundError('Session not found');
	if (session.review) throw new InvalidInputError("This task reviews someone else's pull request; merge it on GitHub.");
	const record = await recordOf(id, number);
	const { git } = getProviders();
	await git.mergePullRequest(record.url, { method: input.method ?? 'squash', title: `${record.title} (#${record.number})`, sha: input.sha }).catch((error: unknown) => {
		// The host says why in words (checks required, not mergeable, head moved); that is what the panel shows.
		const reason = error instanceof Error ? /"message":"([^"]+)"/.exec(error.message)?.[1] : undefined;
		throw reason ? new InvalidInputError(`GitHub did not merge it: ${reason}`) : error;
	});
	const detail = await git.pullRequestDetail(record.url).catch(() => null);
	await setPullRequestState(record.url, 'merged', detail?.mergedAt ?? new Date().toISOString());
	if (record.url === session.prUrl) {
		if (!session.pushedSha && detail) await updateSession(id, { pushedSha: detail.headSha });
		await savePullRequestStatus(session, { state: 'merged', checks: null, runs: [] });
	}
	announce({ kind: 'task', id, what: 'state' });
	announce({ kind: 'task', id, what: 'pr-metadata' });
	if (!detail) throw new Error('Merged, but the pull request could not be read back.');
	return detail;
}

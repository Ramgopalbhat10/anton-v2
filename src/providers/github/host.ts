import type {
	CheckResult,
	CommitData,
	CommitSource,
	DiscussionEntry,
	GitHost,
	PullRequestDetail,
	PullRequestComment,
	PullRequestInfo,
	PullRequestInput,
	PullRequestState,
	PullRequestSummary,
	RepoInfo,
	ReviewComment,
	TreeChange,
	TreeEntry,
} from '../../core/ports.ts';

/** Requests that take longer than this fail, so a stuck connection never stalls the headless loop. */
const TIMEOUT_MS = 30_000;
/** A file upload or a repo download may take longer than an ordinary request. */
const UPLOAD_TIMEOUT_MS = 5 * 60_000;
/** Lists longer than this many pages are cut, oldest pages first kept. */
const MAX_PAGES = 10;
/** GET answers kept to ask GitHub whether they changed; the least recently used beyond this are dropped. */
const MAX_SAVED = 500;
/** A larger answer (a big repository's tree) is not kept. */
const MAX_SAVED_CHARS = 1_000_000;

const PULL_URL = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)$/;

type PullRequest = {
	html_url: string;
	number: number;
	title: string;
	body: string | null;
	user: { login: string; type?: string } | null;
	author_association?: string;
	state: 'open' | 'closed';
	draft: boolean;
	merged_at: string | null;
	updated_at: string;
	/** Null while the host is still working out whether it merges cleanly. */
	mergeable?: boolean | null;
	head: { sha: string; ref: string };
	base: { sha: string; ref: string };
	created_at?: string;
	closed_at?: string | null;
	merged_by?: { login: string } | null;
	additions?: number;
	deletions?: number;
	changed_files?: number;
};
type CommitStatus = { context: string; state: 'error' | 'failure' | 'pending' | 'success'; description: string | null; target_url: string | null };
type CheckRun = { name: string; status: string; conclusion: string | null; html_url: string; output?: { title?: string | null; summary?: string | null } };
type Comment = { id: number; user: { login: string; type?: string } | null; author_association?: string; body: string | null; state?: string; created_at?: string; submitted_at?: string; path?: string; line?: number | null; original_line?: number | null };

/** Each reviewer's latest verdict counts: approved when one approves and none still asks for changes. */
function approvedBy(reviews: Comment[]): boolean {
	const latest = new Map<string, string>();
	for (const review of reviews) {
		if (review.user && (review.state === 'APPROVED' || review.state === 'CHANGES_REQUESTED' || review.state === 'DISMISSED')) latest.set(review.user.login, review.state);
	}
	const verdicts = [...latest.values()];
	return verdicts.includes('APPROVED') && !verdicts.includes('CHANGES_REQUESTED');
}

const FAILING = new Set(['failure', 'timed_out', 'startup_failure']);

/** Cancelled, stale and waiting-for-approval runs are not failures of the code. */
function statusOf(run: CheckRun): CheckResult['status'] {
	if (run.status !== 'completed') return 'pending';
	if (FAILING.has(run.conclusion ?? '')) return 'failed';
	return run.conclusion === 'success' ? 'passed' : 'skipped';
}

function checkOf(run: CheckRun): CheckResult {
	const status = statusOf(run);
	const summary = (run.output?.title || run.output?.summary || run.conclusion || '').trim().slice(0, 500);
	return { name: run.name, status, summary, url: run.html_url };
}

/** CI that reports through the older commit status API instead of check runs. */
function statusCheckOf(status: CommitStatus): CheckResult {
	const states: Record<CommitStatus['state'], CheckResult['status']> = { error: 'failed', failure: 'failed', pending: 'pending', success: 'passed' };
	return { name: status.context, status: states[status.state], summary: (status.description ?? '').trim().slice(0, 500), url: status.target_url ?? '' };
}

const TRUSTED = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

/** People who can push to the repo, and apps installed on it; anyone else could steer the agent from a public repo. */
const isTrusted = (comment: Comment) => TRUSTED.has(comment.author_association ?? '') || comment.user?.type === 'Bot';

function summaryOf(pull: PullRequest): PullRequestSummary {
	return {
		url: pull.html_url,
		number: pull.number,
		title: pull.title,
		author: pull.user?.login ?? 'someone',
		trusted: TRUSTED.has(pull.author_association ?? ''),
		draft: pull.draft,
		headBranch: pull.head.ref,
		headSha: pull.head.sha,
		updatedAt: pull.updated_at,
	};
}

function commentOf(kind: string, comment: Comment): PullRequestComment {
	return {
		id: `${kind}-${comment.id}`,
		author: comment.user?.login ?? 'someone',
		body: (comment.body ?? '').trim(),
		path: comment.path ?? null,
		line: comment.line ?? comment.original_line ?? null,
		at: comment.submitted_at ?? comment.created_at ?? '',
	};
}

/** Line comments as a list under the summary, for when they cannot be placed on the diff. */
function foldComments(body: string, comments: ReviewComment[]): string {
	const list = comments.map((comment) => `- \`${comment.path}:${comment.line}\`: ${comment.body.replace(/\n+/g, ' ')}`);
	return [body, ...(list.length ? [list.join('\n')] : [])].join('\n\n');
}

/** Anyone's comment as the discussion shows it; a review without words but with a verdict still counts. */
function discussionOf(kind: DiscussionEntry['kind'], comment: Comment): DiscussionEntry {
	const verdict = kind === 'review' && comment.state && comment.state !== 'COMMENTED' ? comment.state.toLowerCase().replace(/_/g, ' ') : null;
	return { ...commentOf(kind, comment), kind, verdict };
}

function pullOf(url: string): { repo: string; number: string } {
	const match = PULL_URL.exec(url);
	if (!match) throw new Error(`Not a GitHub pull request URL: ${url}`);
	return { repo: match[1], number: match[2] };
}

function stateOf(pull: PullRequest): PullRequestState {
	if (pull.merged_at) return 'merged';
	if (pull.state === 'closed') return 'closed';
	return pull.draft ? 'draft' : 'open';
}

export type GitHubOptions = { token: string; apiUrl: string };

/** GitHub over its REST API, authenticated with one token. */
export function githubHost({ token, apiUrl }: GitHubOptions): GitHost {
	const urlOf = (path: string) => (path.startsWith(apiUrl) ? path : `${apiUrl}${path}`);

	/** `path` is under the API, or a full URL GitHub returned for a next page. */
	async function call(path: string, init: RequestInit & { accept?: string; etag?: string } = {}): Promise<Response> {
		const { accept, etag, ...request } = init;
		const response = await fetch(urlOf(path), {
			signal: AbortSignal.timeout(TIMEOUT_MS),
			...request,
			headers: {
				Accept: accept ?? 'application/vnd.github+json',
				'X-GitHub-Api-Version': '2022-11-28',
				...(token ? { Authorization: `Bearer ${token}` } : {}),
				...(request.body ? { 'Content-Type': 'application/json' } : {}),
				...(etag ? { 'If-None-Match': etag } : {}),
			},
		});
		if (!response.ok && !(etag && response.status === 304)) {
			const body = await response.text();
			throw new GitHubError(response.status, `GitHub ${path}: ${response.status} ${body.slice(0, 300)}`);
		}
		return response;
	}

	/**
	 * GET answers by URL with their ETag. Asked again, GitHub answers 304 when
	 * nothing changed, which costs nothing from the rate limit, so a pull request
	 * can be read every few seconds while its checks run.
	 */
	const saved = new Map<string, { etag: string; text: string; next: string | null }>();

	/** A GET of JSON, answered from `saved` when GitHub says it is unchanged; with the next page's URL, if any. */
	async function cachedGet(path: string): Promise<{ text: string; next: string | null }> {
		const url = urlOf(path);
		const known = saved.get(url);
		const response = await call(url, { etag: known?.etag });
		if (known && response.status === 304) {
			// Most recently used last, so the oldest is the one dropped.
			saved.delete(url);
			saved.set(url, known);
			return known;
		}
		const fresh = { text: await response.text(), next: /<([^>]+)>;\s*rel="next"/.exec(response.headers.get('link') ?? '')?.[1] ?? null };
		const etag = response.headers.get('etag');
		saved.delete(url);
		if (etag && fresh.text.length <= MAX_SAVED_CHARS) {
			saved.set(url, { etag, ...fresh });
			if (saved.size > MAX_SAVED) saved.delete(saved.keys().next().value!);
		}
		return fresh;
	}

	async function json<T>(path: string, init?: RequestInit & { accept?: string }): Promise<T> {
		if (!init) return JSON.parse((await cachedGet(path)).text) as T;
		return (await call(path, init)).json() as Promise<T>;
	}

	/** Every page of a list, following GitHub's `next` links. */
	async function all<T>(path: string): Promise<T[]> {
		const items: T[] = [];
		let next: string | null = path;
		for (let page = 0; next && page < MAX_PAGES; page += 1) {
			const answer = await cachedGet(next);
			items.push(...(JSON.parse(answer.text) as T[]));
			next = answer.next;
		}
		return items;
	}

	const post = <T>(path: string, body: unknown, timeoutMs = TIMEOUT_MS) =>
		json<T>(path, { method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
	const notFound = (error: unknown) => (error instanceof GitHubError && error.status === 404 ? null : Promise.reject(error));
	/** A branch name as a ref path: each segment encoded, slashes kept. */
	const refPath = (branch: string) => `heads/${branch.split('/').map(encodeURIComponent).join('/')}`;

	async function branchHead(repo: string, branch: string): Promise<string | null> {
		const ref = await json<{ object: { sha: string } }>(`/repos/${repo}/git/ref/${refPath(branch)}`).catch(notFound);
		return ref?.object.sha ?? null;
	}

	async function hasCommit(repo: string, sha: string): Promise<boolean> {
		return (await call(`/repos/${repo}/git/commits/${sha}`).catch(notFound)) !== null;
	}

	/** One tree entry; a file's contents are uploaded first, so the tree can point at them. */
	async function entryFor(repo: string, { path, mode, sha }: TreeChange, source: CommitSource) {
		const type = mode === '160000' ? 'commit' : 'blob';
		if (sha !== null && type === 'blob') {
			const content = Buffer.from(await source.blob(sha)).toString('base64');
			await post(`/repos/${repo}/git/blobs`, { content, encoding: 'base64' }, UPLOAD_TIMEOUT_MS);
		}
		return { path, mode, type, sha };
	}

	/** Builds the commit's tree on the host as its first parent's tree plus its changes. */
	async function writeTree(repo: string, commit: CommitData, source: CommitSource): Promise<string> {
		if (commit.changes.length === 0) return commit.tree;
		const entries = [];
		for (const change of commit.changes) entries.push(await entryFor(repo, change, source));
		return (await post<{ sha: string }>(`/repos/${repo}/git/trees`, { base_tree: commit.parentTree ?? undefined, tree: entries })).sha;
	}

	/** Same contents, parents, people, dates and message give the same hash; anything else is refused. */
	async function recreate(repo: string, commit: CommitData, source: CommitSource): Promise<void> {
		const short = commit.sha.slice(0, 7);
		const tree = await writeTree(repo, commit, source);
		if (tree !== commit.tree) throw new Error(`GitHub built a different tree for commit ${short}`);
		const { message, parents, author, committer } = commit;
		const created = await post<{ sha: string }>(`/repos/${repo}/git/commits`, { message, tree, parents, author, committer });
		if (created.sha !== commit.sha) throw new Error(`GitHub recreated commit ${short} as ${created.sha.slice(0, 7)}`);
	}

	async function existingPullRequest({ repo, head }: PullRequestInput): Promise<string | null> {
		const owner = repo.split('/')[0];
		const open = await json<Array<{ html_url: string }>>(`/repos/${repo}/pulls?state=open&head=${owner}:${encodeURIComponent(head)}`);
		return open[0]?.html_url ?? null;
	}

	return {
		name: 'github',
		async listRepos() {
			if (!token) return [];
			const repos = await all<{ full_name: string }>('/user/repos?per_page=100&sort=pushed');
			return repos.map((repo) => repo.full_name);
		},
		async searchRepos(query, limit) {
			const found = await json<{ items: Array<{ full_name: string; description: string | null; stargazers_count: number }> }>(
				`/search/repositories?q=${encodeURIComponent(query)}&per_page=${limit}`,
			);
			return found.items.map((item) => ({ fullName: item.full_name, description: item.description ?? '', stars: item.stargazers_count }));
		},
		async searchFiles(query, filename, limit) {
			// Code search needs an account.
			if (!token) return [];
			const found = await json<{ items: Array<{ path: string; url: string; repository: { full_name: string } }> }>(
				`/search/code?q=${encodeURIComponent(`${query} filename:${filename}`)}&per_page=${limit}`,
			);
			return found.items.map((item) => ({ repo: item.repository.full_name, path: item.path, ref: new URL(item.url).searchParams.get('ref') ?? 'HEAD' }));
		},
		async accountName() {
			if (!token) return null;
			const user = await json<{ login: string; name: string | null }>('/user');
			return user.name?.trim() || user.login;
		},
		async getRepo(fullName): Promise<RepoInfo> {
			const repo = await json<{ full_name: string; default_branch: string; private: boolean }>(`/repos/${fullName}`);
			return { fullName: repo.full_name, defaultBranch: repo.default_branch, private: repo.private };
		},
		async listBranches(fullName) {
			const branches = await json<Array<{ name: string }>>(`/repos/${fullName}/branches?per_page=100`);
			return branches.map((branch) => branch.name);
		},
		async resolveRef(fullName, ref) {
			return (await (await call(`/repos/${fullName}/commits/${encodeURIComponent(ref)}`, { accept: 'application/vnd.github.sha' })).text()).trim();
		},
		async tree(fullName, sha) {
			const tree = await json<{ tree: Array<{ path: string; type: string }> }>(`/repos/${fullName}/git/trees/${sha}?recursive=1`);
			return tree.tree.filter((entry) => entry.type === 'blob').map((entry) => entry.path);
		},
		async archive(fullName, sha) {
			const response = await call(`/repos/${fullName}/tarball/${sha}`, { signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS) });
			if (!response.body) throw new Error(`GitHub sent no archive for ${fullName}@${sha}`);
			return response.body;
		},
		async file(fullName, sha, path) {
			const encoded = path.split('/').map(encodeURIComponent).join('/');
			const response = await call(`/repos/${fullName}/contents/${encoded}?ref=${sha}`, { accept: 'application/vnd.github.raw' });
			return new Uint8Array(await response.arrayBuffer());
		},
		cloneUrl: (fullName) => `https://github.com/${fullName}.git`,
		gitAuthEnv(): Record<string, string> {
			if (!token) return {};
			const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
			return {
				GIT_TERMINAL_PROMPT: '0',
				// Hooks and fsmonitor in the agent's repo must not run while the token is in the environment.
				GIT_CONFIG_COUNT: '3',
				GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
				GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
				GIT_CONFIG_KEY_1: 'core.hooksPath',
				GIT_CONFIG_VALUE_1: '/dev/null',
				GIT_CONFIG_KEY_2: 'core.fsmonitor',
				GIT_CONFIG_VALUE_2: 'false',
			};
		},
		async openPullRequest(input) {
			const existing = await existingPullRequest(input);
			if (existing) return existing;
			const created = await json<{ html_url: string }>(`/repos/${input.repo}/pulls`, {
				method: 'POST',
				body: JSON.stringify({ title: input.title, body: input.body, head: input.head, base: input.base }),
			});
			return created.html_url;
		},
		async pullRequestState(url) {
			const { repo, number } = pullOf(url);
			return stateOf(await json<PullRequest>(`/repos/${repo}/pulls/${number}`));
		},
		branchHead,
		async pushCommits({ repo, branch, head, commits, source }) {
			for (const sha of commits) {
				if (!(await hasCommit(repo, sha))) await recreate(repo, await source.commit(sha), source);
			}
			// Like a forced push: the task's branch is the agent's, so it moves to wherever the agent's work is.
			if ((await branchHead(repo, branch)) === null) await post(`/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: head });
			else await json(`/repos/${repo}/git/refs/${refPath(branch)}`, { method: 'PATCH', body: JSON.stringify({ sha: head, force: true }) });
		},
		async listIssues(fullName, label) {
			const issues = await all<{ number: number; title: string; body: string | null; html_url: string; pull_request?: unknown }>(
				`/repos/${fullName}/issues?state=open&labels=${encodeURIComponent(label)}&sort=created&direction=asc&per_page=100`,
			);
			return issues
				.filter((issue) => !issue.pull_request)
				.map((issue) => ({ number: issue.number, title: issue.title, body: issue.body ?? '', url: issue.html_url }));
		},
		async pullRequestActivity(url) {
			const { repo, number } = pullOf(url);
			const pull = await json<PullRequest>(`/repos/${repo}/pulls/${number}`);
			const state = stateOf(pull);
			// A finished pull request needs nothing more, so its checks and comments are not fetched.
			if (state === 'merged' || state === 'closed') return { state, headSha: pull.head.sha, checks: [], comments: [] };
			const [runs, statuses, notes, lineNotes, reviews] = await Promise.all([
				json<{ check_runs: CheckRun[] }>(`/repos/${repo}/commits/${pull.head.sha}/check-runs?per_page=100`),
				json<{ statuses: CommitStatus[] }>(`/repos/${repo}/commits/${pull.head.sha}/status?per_page=100`),
				all<Comment>(`/repos/${repo}/issues/${number}/comments?per_page=100`),
				all<Comment>(`/repos/${repo}/pulls/${number}/comments?per_page=100`),
				all<Comment>(`/repos/${repo}/pulls/${number}/reviews?per_page=100`),
			]);
			const comments = [
				...notes.filter(isTrusted).map((comment) => commentOf('comment', comment)),
				...lineNotes.filter(isTrusted).map((comment) => commentOf('line', comment)),
				...reviews.filter(isTrusted).map((review) => commentOf('review', review)),
			].filter((comment) => comment.body);
			const checks = [...runs.check_runs.map(checkOf), ...statuses.statuses.map(statusCheckOf)];
			return { state, headSha: pull.head.sha, checks, comments, approved: approvedBy(reviews), conflicts: pull.mergeable === false, baseSha: pull.base.sha };
		},
		async pullRequest(url): Promise<PullRequestInfo> {
			const { repo, number } = pullOf(url);
			const [pull, commits] = await Promise.all([
				json<PullRequest>(`/repos/${repo}/pulls/${number}`),
				all<{ sha: string; commit: { message: string } }>(`/repos/${repo}/pulls/${number}/commits?per_page=100`),
			]);
			return {
				...summaryOf(pull),
				repo,
				body: (pull.body ?? '').trim(),
				state: stateOf(pull),
				baseBranch: pull.base.ref,
				commits: commits.map((commit) => ({ sha: commit.sha, subject: commit.commit.message.split('\n')[0] })),
			};
		},
		async pullRequestDetail(url): Promise<PullRequestDetail> {
			const { repo, number } = pullOf(url);
			const [pull, commits, notes, lineNotes, reviews] = await Promise.all([
				json<PullRequest>(`/repos/${repo}/pulls/${number}`),
				all<{ sha: string; commit: { message: string } }>(`/repos/${repo}/pulls/${number}/commits?per_page=100`),
				all<Comment>(`/repos/${repo}/issues/${number}/comments?per_page=100`),
				all<Comment>(`/repos/${repo}/pulls/${number}/comments?per_page=100`),
				all<Comment>(`/repos/${repo}/pulls/${number}/reviews?per_page=100`),
			]);
			const [runs, statuses] = await Promise.all([
				json<{ check_runs: CheckRun[] }>(`/repos/${repo}/commits/${pull.head.sha}/check-runs?per_page=100`),
				json<{ statuses: CommitStatus[] }>(`/repos/${repo}/commits/${pull.head.sha}/status?per_page=100`),
			]);
			const discussion = [
				...notes.map((comment) => discussionOf('comment', comment)),
				...lineNotes.map((comment) => discussionOf('line', comment)),
				...reviews.map((review) => discussionOf('review', review)),
			]
				.filter((entry) => entry.body || entry.verdict)
				.sort((a, b) => a.at.localeCompare(b.at));
			return {
				...summaryOf(pull),
				repo,
				body: (pull.body ?? '').trim(),
				state: stateOf(pull),
				baseBranch: pull.base.ref,
				commits: commits.map((commit) => ({ sha: commit.sha, subject: commit.commit.message.split('\n')[0] })),
				createdAt: pull.created_at ?? pull.updated_at,
				mergedAt: pull.merged_at,
				mergedBy: pull.merged_by?.login ?? null,
				closedAt: pull.closed_at ?? null,
				additions: pull.additions ?? 0,
				deletions: pull.deletions ?? 0,
				changedFiles: pull.changed_files ?? 0,
				mergeable: pull.mergeable ?? null,
				approved: approvedBy(reviews),
				checks: [...runs.check_runs.map(checkOf), ...statuses.statuses.map(statusCheckOf)],
				discussion,
			};
		},
		async pullRequestDiff(url) {
			const { repo, number } = pullOf(url);
			return (await call(`/repos/${repo}/pulls/${number}`, { accept: 'application/vnd.github.diff' })).text();
		},
		async mergePullRequest(url, { method, title, sha }) {
			const { repo, number } = pullOf(url);
			await json(`/repos/${repo}/pulls/${number}/merge`, {
				method: 'PUT',
				body: JSON.stringify({ merge_method: method, ...(title ? { commit_title: title } : {}), ...(sha ? { sha } : {}) }),
			});
		},
		async listPullRequests(fullName) {
			const pulls = await json<PullRequest[]>(`/repos/${fullName}/pulls?state=open&sort=updated&direction=desc&per_page=100`);
			return pulls.map(summaryOf);
		},
		async mergeBase(fullName, a, b) {
			const compared = await json<{ merge_base_commit: { sha: string } }>(`/repos/${fullName}/compare/${a}...${b}?per_page=1`);
			return compared.merge_base_commit.sha;
		},
		async treeEntries(fullName, commit) {
			const { tree } = await json<{ tree: { sha: string } }>(`/repos/${fullName}/git/commits/${commit}`);
			const listing = await json<{ sha: string; truncated: boolean; tree: TreeEntry[] }>(`/repos/${fullName}/git/trees/${tree.sha}?recursive=1`);
			if (listing.truncated) throw new Error(`${fullName} has too many files at ${commit.slice(0, 7)} for GitHub to list them all`);
			return { sha: listing.sha, entries: listing.tree.map(({ path, mode, type, sha }) => ({ path, mode, type, sha })) };
		},
		async blob(fullName, sha) {
			const response = await call(`/repos/${fullName}/git/blobs/${sha}`, { accept: 'application/vnd.github.raw+json', signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS) });
			return new Uint8Array(await response.arrayBuffer());
		},
		async changedFiles(url) {
			const { repo, number } = pullOf(url);
			const files = await all<{ filename: string; patch?: string }>(`/repos/${repo}/pulls/${number}/files?per_page=100`);
			return files.map((file) => ({ path: file.filename, patch: file.patch ?? null }));
		},
		async postReview(url, { commit, body, comments }) {
			const { repo, number } = pullOf(url);
			const path = `/repos/${repo}/pulls/${number}/reviews`;
			const review = { ...(commit ? { commit_id: commit } : {}), event: 'COMMENT' };
			try {
				await post(path, { ...review, body, comments: comments.map((comment) => ({ ...comment, side: 'RIGHT' })) });
			} catch (error) {
				// GitHub refuses the whole review when one line is outside the diff.
				if (!(error instanceof GitHubError && error.status === 422 && comments.length)) throw error;
				await post(path, { ...review, body: foldComments(body, comments) });
			}
		},
	};
}

export class GitHubError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

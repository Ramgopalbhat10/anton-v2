import type { CheckResult, GitHost, PullRequestComment, PullRequestInput, PullRequestState, RepoInfo } from '../../core/ports.ts';

/** Requests that take longer than this fail, so a stuck connection never stalls the headless loop. */
const TIMEOUT_MS = 30_000;
/** Lists longer than this many pages are cut, oldest pages first kept. */
const MAX_PAGES = 10;

const PULL_URL = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)$/;

type PullRequest = { state: 'open' | 'closed'; draft: boolean; merged_at: string | null; head: { sha: string } };
type CheckRun = { name: string; status: string; conclusion: string | null; html_url: string; output?: { title?: string | null; summary?: string | null } };
type Comment = { id: number; user: { login: string; type?: string } | null; author_association?: string; body: string | null; created_at?: string; submitted_at?: string; path?: string; line?: number | null; original_line?: number | null };

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

const TRUSTED = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

/** People who can push to the repo, and apps installed on it; anyone else could steer the agent from a public repo. */
const isTrusted = (comment: Comment) => TRUSTED.has(comment.author_association ?? '') || comment.user?.type === 'Bot';

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
	/** `path` is under the API, or a full URL GitHub returned for a next page. */
	async function call(path: string, init: RequestInit & { accept?: string } = {}): Promise<Response> {
		const response = await fetch(path.startsWith(apiUrl) ? path : `${apiUrl}${path}`, {
			signal: AbortSignal.timeout(TIMEOUT_MS),
			...init,
			headers: {
				Accept: init.accept ?? 'application/vnd.github+json',
				'X-GitHub-Api-Version': '2022-11-28',
				...(token ? { Authorization: `Bearer ${token}` } : {}),
				...(init.body ? { 'Content-Type': 'application/json' } : {}),
			},
		});
		if (!response.ok) {
			const body = await response.text();
			throw new GitHubError(response.status, `GitHub ${path}: ${response.status} ${body.slice(0, 300)}`);
		}
		return response;
	}
	const json = async <T>(path: string, init?: RequestInit & { accept?: string }) => (await call(path, init)).json() as Promise<T>;

	/** Every page of a list, following GitHub's `next` links. */
	async function all<T>(path: string): Promise<T[]> {
		const items: T[] = [];
		let next: string | null = path;
		for (let page = 0; next && page < MAX_PAGES; page += 1) {
			const response = await call(next);
			items.push(...((await response.json()) as T[]));
			next = /<([^>]+)>;\s*rel="next"/.exec(response.headers.get('link') ?? '')?.[1] ?? null;
		}
		return items;
	}

	async function existingPullRequest({ repo, head }: PullRequestInput): Promise<string | null> {
		const owner = repo.split('/')[0];
		const open = await json<Array<{ html_url: string }>>(`/repos/${repo}/pulls?state=open&head=${owner}:${encodeURIComponent(head)}`);
		return open[0]?.html_url ?? null;
	}

	return {
		name: 'github',
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
			const [runs, notes, lineNotes, reviews] = await Promise.all([
				json<{ check_runs: CheckRun[] }>(`/repos/${repo}/commits/${pull.head.sha}/check-runs?per_page=100`),
				all<Comment>(`/repos/${repo}/issues/${number}/comments?per_page=100`),
				all<Comment>(`/repos/${repo}/pulls/${number}/comments?per_page=100`),
				all<Comment>(`/repos/${repo}/pulls/${number}/reviews?per_page=100`),
			]);
			const comments = [
				...notes.filter(isTrusted).map((comment) => commentOf('comment', comment)),
				...lineNotes.filter(isTrusted).map((comment) => commentOf('line', comment)),
				...reviews.filter(isTrusted).map((review) => commentOf('review', review)),
			].filter((comment) => comment.body);
			return { state, headSha: pull.head.sha, checks: runs.check_runs.map(checkOf), comments };
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

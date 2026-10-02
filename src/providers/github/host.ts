import type { GitHost, PullRequestInput, PullRequestState, RepoInfo } from '../../core/ports.ts';

const PULL_URL = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)$/;

type PullRequest = { state: 'open' | 'closed'; draft: boolean; merged_at: string | null };

function stateOf(pull: PullRequest): PullRequestState {
	if (pull.merged_at) return 'merged';
	if (pull.state === 'closed') return 'closed';
	return pull.draft ? 'draft' : 'open';
}

export type GitHubOptions = { token: string; apiUrl: string };

/** GitHub over its REST API, authenticated with one token. */
export function githubHost({ token, apiUrl }: GitHubOptions): GitHost {
	async function call(path: string, init: RequestInit & { accept?: string } = {}): Promise<Response> {
		const response = await fetch(`${apiUrl}${path}`, {
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
				GIT_CONFIG_COUNT: '1',
				GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
				GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
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
			const match = PULL_URL.exec(url);
			if (!match) throw new Error(`Not a GitHub pull request URL: ${url}`);
			return stateOf(await json<PullRequest>(`/repos/${match[1]}/pulls/${match[2]}`));
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

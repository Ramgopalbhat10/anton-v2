export type GitHubClientConfig = {
	clientId: string;
	clientSecret: string;
	callbackUrl: string;
};

export type GitHubToken = {
	accessToken: string;
	refreshToken: string | null;
	expiresAt: string | null;
};

export type GitHubUser = {
	id: number;
	login: string;
	avatarUrl: string | null;
	name: string | null;
	email: string | null;
};

export type GitHubRepo = {
	fullName: string;
	defaultBranch: string;
	private: boolean;
};

const SCOPES = 'read:user user:email repo';
const API = 'https://api.github.com';

export function githubAuthorizeUrl(state: string, client: GitHubClientConfig): string {
	const url = new URL('https://github.com/login/oauth/authorize');
	url.searchParams.set('client_id', client.clientId);
	url.searchParams.set('redirect_uri', client.callbackUrl);
	url.searchParams.set('scope', SCOPES);
	url.searchParams.set('state', state);
	return url.toString();
}

export async function exchangeCode(
	code: string,
	client: GitHubClientConfig,
	fetchImpl: typeof fetch = fetch,
	now = Date.now(),
): Promise<GitHubToken> {
	return requestToken(
		{
			client_id: client.clientId,
			client_secret: client.clientSecret,
			code,
			redirect_uri: client.callbackUrl,
		},
		fetchImpl,
		now,
	);
}

export async function refreshAccessToken(
	refreshToken: string,
	client: GitHubClientConfig,
	fetchImpl: typeof fetch = fetch,
	now = Date.now(),
): Promise<GitHubToken> {
	return requestToken(
		{
			client_id: client.clientId,
			client_secret: client.clientSecret,
			grant_type: 'refresh_token',
			refresh_token: refreshToken,
		},
		fetchImpl,
		now,
	);
}

async function requestToken(
	body: Record<string, string>,
	fetchImpl: typeof fetch,
	now: number,
): Promise<GitHubToken> {
	const response = await fetchImpl('https://github.com/login/oauth/access_token', {
		method: 'POST',
		headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
	const payload = (await response.json()) as {
		access_token?: string;
		refresh_token?: string;
		expires_in?: number;
		error_description?: string;
		error?: string;
	};
	if (!response.ok || payload.error || !payload.access_token) {
		throw new Error(payload.error_description || payload.error || 'GitHub token exchange failed');
	}
	return {
		accessToken: payload.access_token,
		refreshToken: payload.refresh_token ?? null,
		expiresAt: typeof payload.expires_in === 'number' ? new Date(now + payload.expires_in * 1000).toISOString() : null,
	};
}

export async function fetchUser(token: string, fetchImpl: typeof fetch = fetch): Promise<GitHubUser> {
	const profile = await githubJson<{
		id: number;
		login: string;
		avatar_url: string | null;
		name: string | null;
		email: string | null;
	}>(token, `${API}/user`, fetchImpl);
	let email = profile.email;
	if (!email) {
		const emails = await githubJson<Array<{ email: string; primary: boolean; verified: boolean }>>(
			token,
			`${API}/user/emails`,
			fetchImpl,
		);
		email = emails.find((item) => item.primary && item.verified)?.email ?? emails.find((item) => item.verified)?.email ?? null;
	}
	return {
		id: profile.id,
		login: profile.login,
		avatarUrl: profile.avatar_url,
		name: profile.name,
		email,
	};
}

export async function listRepos(token: string, fetchImpl: typeof fetch = fetch): Promise<GitHubRepo[]> {
	const repos: GitHubRepo[] = [];
	let url: string | null =
		`${API}/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member`;
	for (let page = 0; url && page < 10; page += 1) {
		const response = await githubFetch(token, url, fetchImpl);
		const payload = (await response.json()) as Array<{
			full_name: string;
			default_branch: string;
			private: boolean;
			permissions?: { push?: boolean };
		}>;
		for (const repo of payload) {
			if (repo.permissions?.push) {
				repos.push({ fullName: repo.full_name, defaultBranch: repo.default_branch, private: repo.private });
			}
		}
		url = nextLink(response);
	}
	return repos;
}

export async function fetchRepo(token: string, fullName: string, fetchImpl: typeof fetch = fetch): Promise<GitHubRepo> {
	assertRepoName(fullName);
	const repo = await githubJson<{
		full_name: string;
		default_branch: string;
		private: boolean;
		permissions?: { push?: boolean };
	}>(token, `${API}/repos/${fullName}`, fetchImpl);
	if (!repo.permissions?.push) throw new Error(`No push access to ${fullName}`);
	return { fullName: repo.full_name, defaultBranch: repo.default_branch, private: repo.private };
}

export async function openPullRequest(
	input: { token: string; repoFullName: string; title: string; head: string; base: string; body: string },
	fetchImpl: typeof fetch = fetch,
): Promise<{ url: string; number: number }> {
	assertRepoName(input.repoFullName);
	const response = await githubFetch(input.token, `${API}/repos/${input.repoFullName}/pulls`, fetchImpl, {
		method: 'POST',
		body: JSON.stringify({
			title: input.title,
			head: input.head,
			base: input.base,
			body: input.body,
		}),
	});
	const payload = (await response.json()) as { html_url?: string; number?: number; message?: string };
	if (response.status === 401) throw new GitHubReconnectError();
	if (!response.ok || !payload.html_url || typeof payload.number !== 'number') {
		throw new Error(payload.message || 'GitHub pull request failed');
	}
	return { url: payload.html_url, number: payload.number };
}

export class GitHubReconnectError extends Error {
	constructor() {
		super('GitHub authorization expired. Reconnect GitHub, then open the pull request again.');
		this.name = 'GitHubReconnectError';
	}
}

function assertRepoName(fullName: string): void {
	if (!/^[\w.-]+\/[\w.-]+$/.test(fullName)) throw new Error('Invalid repository name');
}

async function githubJson<T>(token: string, url: string, fetchImpl: typeof fetch): Promise<T> {
	const response = await githubFetch(token, url, fetchImpl);
	if (!response.ok) {
		const payload = (await response.json().catch(() => ({}))) as { message?: string };
		if (response.status === 401) throw new GitHubReconnectError();
		throw new Error(payload.message || `GitHub request failed (${response.status})`);
	}
	return response.json() as Promise<T>;
}

function githubFetch(token: string, url: string, fetchImpl: typeof fetch, init?: RequestInit): Promise<Response> {
	return fetchImpl(url, {
		...init,
		headers: {
			Accept: 'application/vnd.github+json',
			Authorization: `Bearer ${token}`,
			'User-Agent': 'anton-v2',
			'X-GitHub-Api-Version': '2022-11-28',
			...(init?.body ? { 'Content-Type': 'application/json' } : {}),
		},
	});
}

function nextLink(response: Response): string | null {
	const link = response.headers.get('Link');
	if (!link) return null;
	for (const part of link.split(',')) {
		const match = part.match(/<([^>]+)>;\s*rel="next"/);
		if (match?.[1]) return match[1];
	}
	return null;
}

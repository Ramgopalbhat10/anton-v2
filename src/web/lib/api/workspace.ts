import { json, post, request } from './http';
import type { Session } from './sessions';

/** Where a view's data came from: the running machine, the last checkpoint, or the starting commit. */
export type Source = 'live' | 'saved' | 'base';

export type FileChange = { path: string; status: 'A' | 'M' | 'D' };

export type FilesPayload = { source: Source; at: string | null; paths: string[]; changes: FileChange[] };

/** `unpushed`: what GitHub does not have yet; `branch`: everything since the task began. */
export type ChangesScope = 'unpushed' | 'branch';

export type ChangesPayload = {
	source: Source;
	at: string | null;
	branch: string;
	baseBranch: string;
	/** Missing from older servers, which always sent the whole branch. */
	scope?: ChangesScope;
	/** The commit the unpushed diff starts from; null before anything was pushed. */
	pushedSha?: string | null;
	patch: string;
	/** `pushed` once anything was: whether GitHub has the commit. */
	log: Array<{ sha: string; subject: string; at: string; pushed?: boolean }>;
};

export type PullRequestState = 'open' | 'draft' | 'merged' | 'closed';

/** A pull request the task opened; `current` is the one it works on now. */
export type PullRequestItem = {
	url: string;
	repo: string;
	number: number;
	title: string;
	head: string;
	base: string;
	state: PullRequestState | null;
	openedAt: string;
	mergedAt: string | null;
	current: boolean;
};

export type CheckRun = { name: string; status: 'pending' | 'passed' | 'failed' | 'skipped'; summary: string; url: string };

export type DiscussionEntry = {
	id: string;
	kind: 'comment' | 'review' | 'line';
	author: string;
	body: string;
	path: string | null;
	line: number | null;
	at: string;
	verdict: string | null;
};

/** `mergeable` is null while GitHub works it out. */
export type PullRequestDetail = {
	url: string;
	number: number;
	repo: string;
	title: string;
	body: string;
	author: string;
	state: PullRequestState;
	draft: boolean;
	headBranch: string;
	headSha: string;
	baseBranch: string;
	createdAt: string;
	mergedAt: string | null;
	mergedBy: string | null;
	closedAt: string | null;
	additions: number;
	deletions: number;
	changedFiles: number;
	mergeable: boolean | null;
	approved: boolean;
	commits: Array<{ sha: string; subject: string }>;
	checks: CheckRun[];
	discussion: DiscussionEntry[];
};

export type PullRequest = { url: string; state: 'open' | 'draft' | 'merged' | 'closed' | null };

export type Preview = { port: number; url: string | null; listening: boolean };
export type PreviewsPayload = { live: boolean; previews: Preview[] };

export type ReviewGroup = 'failing' | 'checking' | 'ready' | 'merged' | 'closed' | 'unknown';
export type ReviewItem = {
	sessionId: string;
	title: string;
	repo: string;
	url: string;
	group: ReviewGroup;
	draft: boolean;
	/** Someone else's pull request, which the task reviews; its author's login. */
	reviewing: string | null;
	conflicts: boolean;
	checks: { passed: number; failed: number; pending: number };
	comments: number;
	createdAt: string;
};

export type BrowserPage = { url: string; title: string; canGoBack: boolean; canGoForward: boolean };
export type BrowserView = {
	/** False until KERNEL_API_KEY is set. */
	available: boolean;
	browser: {
		liveViewUrl: string;
		viewport: { width: number; height: number };
		openedAt: string;
		page: BrowserPage | null;
		/** The agent is acting in this browser, or did a moment ago. */
		agentBusy: boolean;
		/** Why the agent stopped for you here (a sign-in or a human check), until the page moves on. */
		needsYou: string | null;
	} | null;
};
export type ComputerView = {
	/** The task's sandbox runs. */
	live: boolean;
	running: boolean;
	browser: boolean;
	screen: { width: number; height: number };
	agentBusy: boolean;
	/** You took over: the agent's steps wait until you hand it back. */
	userControl: boolean;
};

export type ComputerConnection = ComputerView & { url: string };

export type PickedElement = {
	tag: string;
	selector: string;
	text: string;
	html: string;
	rect: { x: number; y: number; width: number; height: number };
	styles: Record<string, string>;
	components: Array<{ name: string; source: string | null }>;
	url: string;
	title: string;
	/** PNG, base64. */
	image: string | null;
};

export const workspaceApi = {
	reviews: () => json<{ reviews: ReviewItem[] }>('/api/reviews'),
	reviewAnyPullRequest: (url: string) => post<Session>('/api/reviews', { url }),
	/** `to: 'pushed'` keeps what was pushed and drops only the edits since. */
	revertFile: async (id: string, path: string, to: 'base' | 'pushed' = 'base') => void (await post(`/api/sessions/${id}/revert`, { path, to })),
	previews: (id: string) => json<PreviewsPayload>(`/api/sessions/${id}/previews`),
	browser: (id: string) => json<BrowserView>(`/api/sessions/${id}/browser`),
	openBrowser: (id: string, url?: string) => post<BrowserView>(`/api/sessions/${id}/browser`, { url }),
	closeBrowser: async (id: string) => void (await request(`/api/sessions/${id}/browser`, { method: 'DELETE' })),
	navigateBrowser: (id: string, to: { url: string } | { action: 'back' | 'forward' | 'reload' }) => post<BrowserPage>(`/api/sessions/${id}/browser/navigate`, to),
	inspectBrowser: (id: string, point: { x: number; y: number; pick: boolean }) =>
		post<{ element: PickedElement | null }>(`/api/sessions/${id}/browser/inspect`, point),
	clearBrowserHighlight: async (id: string) => void (await post(`/api/sessions/${id}/browser/highlight/clear`)),
	browserScreenshot: (id: string) => post<{ data: string; width: number; height: number }>(`/api/sessions/${id}/browser/screenshot`),
	watchBrowser: (id: string) => post<BrowserView>(`/api/sessions/${id}/browser/watch`),
	computer: (id: string) => json<ComputerView>(`/api/sessions/${id}/computer`),
	startComputer: (id: string) => post<ComputerConnection>(`/api/sessions/${id}/computer`),
	connectComputer: (id: string) => post<ComputerConnection>(`/api/sessions/${id}/computer/connect`),
	connectSandboxBrowser: (id: string) => post<ComputerConnection>(`/api/sessions/${id}/computer/browser`),
	stopComputer: (id: string) => post<ComputerView>(`/api/sessions/${id}/computer/stop`),
	setComputerControl: (id: string, driver: 'user' | 'agent') => post<ComputerView>(`/api/sessions/${id}/computer/control`, { driver }),
	computerScreenshot: (id: string) => post<{ data: string; width: number; height: number }>(`/api/sessions/${id}/computer/screenshot`),
	pullRequest: (id: string) => json<PullRequest | null>(`/api/sessions/${id}/pull-request`),
	reviewPullRequest: (id: string) => post<{ started: boolean }>(`/api/sessions/${id}/review`),
	changes: (id: string, scope: ChangesScope = 'unpushed') => json<ChangesPayload>(`/api/sessions/${id}/changes${scope === 'branch' ? '?scope=branch' : ''}`),
	pulls: (id: string) => json<{ pulls: PullRequestItem[] }>(`/api/sessions/${id}/pulls`),
	pullMetadata: (id: string, number: number) => json<Pick<PullRequestDetail, 'url' | 'headBranch' | 'baseBranch' | 'additions' | 'deletions'>>(`/api/sessions/${id}/pulls/${number}/metadata`),
	pull: (id: string, number: number) => json<PullRequestDetail>(`/api/sessions/${id}/pulls/${number}`),
	pullDiff: (id: string, number: number) => json<{ patch: string }>(`/api/sessions/${id}/pulls/${number}/diff`),
	/** Squashes by default; `sha` refuses the merge when the head moved since you looked. */
	mergePull: (id: string, number: number, input: { method?: 'squash' | 'merge' | 'rebase'; sha?: string } = {}) =>
		post<PullRequestDetail>(`/api/sessions/${id}/pulls/${number}/merge`, input),
	files: (id: string) => json<FilesPayload>(`/api/sessions/${id}/files`),
	file: async (id: string, path: string) =>
		new Uint8Array(await (await request(`/api/sessions/${id}/file?path=${encodeURIComponent(path)}`)).arrayBuffer()),
};

/**
 * The seams between Anton and the services it runs on. Everything outside
 * `src/providers/` depends only on these interfaces, so a sandbox, storage
 * or git host is swapped by writing one new provider and selecting it in
 * `src/providers/index.ts`.
 */

export type ExecOptions = {
	cwd?: string;
	env?: Record<string, string>;
	stdin?: Uint8Array;
	timeoutMs?: number;
	signal?: AbortSignal;
};

export type ExecResult = {
	stdout: Uint8Array;
	stderr: string;
	exitCode: number;
};

export type Pty = {
	write(data: Uint8Array): void;
	resize(cols: number, rows: number): Promise<void>;
	onData(listener: (chunk: Uint8Array) => void): void;
	onExit(listener: () => void): void;
	close(): void;
};

/** A running computer for one task. Files and git are built on `exec`. */
export type Machine = {
	readonly id: string;
	/** Absolute directory holding `repo/` and `outputs/`. */
	readonly root: string;
	/** Runs a command through `bash -lc`. */
	exec(command: string, options?: ExecOptions): Promise<ExecResult>;
	openPty(options: { cols: number; rows: number; cwd: string; env?: Record<string, string> }): Promise<Pty>;
	/** A URL the user's browser can open for a server listening on `port`, or null when none is exposed. */
	previewUrl(port: number): Promise<string | null>;
};

/** How a machine came to be: decides how much setup the workspace still needs. */
export type MachineOrigin = 'live' | 'resumed' | 'image' | 'base';

/** How big a new machine is, how long it may live, and what it may reach. Providers that cannot apply one ignore it. */
export type SandboxResources = {
	cpu: number;
	memoryMiB: number;
	/** Shut down after this long with nothing running. */
	idleTimeoutMs: number;
	/** Shut down this long after starting, whatever it is doing. */
	lifetimeMs: number;
	/** Regions to start in; empty lets the provider choose. */
	regions: string[];
	/** Domains outbound requests may reach, `*.` wildcards allowed; empty allows all. */
	allowedDomains: string[];
};

export type AcquireRequest = {
	/** Stable task key; providers use it to find a running machine. */
	key: string;
	/** The provider's own state from the last acquire, or null. */
	state: string | null;
	/** A prepared image to start from when there is nothing to resume. */
	image: string | null;
	/** Registry image for a fresh machine; null uses the provider's default. */
	baseImage: string | null;
	/** Ports to expose for previews. Fixed when the machine starts. */
	ports: number[];
	/** Applied to a machine that starts; a running one keeps what it started with. */
	resources: SandboxResources;
};

export type Acquired = {
	machine: Machine;
	state: string;
	origin: MachineOrigin;
};

export type SandboxProvider = {
	readonly name: string;
	acquire(request: AcquireRequest): Promise<Acquired>;
	/** The task's machine if it is running; never starts one. */
	find(key: string): Promise<Machine | null>;
	/** Keys of machines running right now. */
	running(): Promise<Set<string>>;
	stop(state: string): Promise<void>;
	/** Saves the machine's filesystem as an image id that `acquire` accepts. */
	snapshot(machine: Machine): Promise<string>;
};

/** `modifiedAt` is milliseconds since the epoch. */
export type StoredObject = { key: string; size: number; modifiedAt: number };

export type ObjectStore = {
	readonly name: string;
	put(key: string, body: Uint8Array | string, contentType?: string): Promise<void>;
	get(key: string): Promise<Uint8Array | null>;
	has(key: string): Promise<boolean>;
	list(prefix: string): Promise<StoredObject[]>;
	/** Deletes one object; a missing key is not an error. */
	remove(key: string): Promise<void>;
};

export type RepoInfo = { fullName: string; defaultBranch: string; private: boolean };

export type PullRequestInput = {
	repo: string;
	head: string;
	base: string;
	title: string;
	body: string;
};

/** Who made a commit and when; `date` is ISO 8601 with the original offset, so the commit's hash survives. */
export type Signature = { name: string; email: string; date: string };

/** A path a commit changed against its first parent; `sha` is null when it was removed. Mode 160000 is a submodule. */
export type TreeChange = { path: string; mode: string; sha: string | null };

/** A commit exactly as stored, enough to recreate it with the same hash. `parentTree` is its first parent's tree. */
export type CommitData = {
	sha: string;
	tree: string;
	parents: string[];
	parentTree: string | null;
	author: Signature;
	committer: Signature;
	message: string;
	changes: TreeChange[];
};

/** Reads commits and file contents from wherever they were made. */
export type CommitSource = { commit(sha: string): Promise<CommitData>; blob(sha: string): Promise<Uint8Array> };

export type PushInput = { repo: string; branch: string; head: string; commits: string[]; source: CommitSource };

export type PullRequestState = 'open' | 'draft' | 'merged' | 'closed';

export type GitHost = {
	readonly name: string;
	getRepo(fullName: string): Promise<RepoInfo>;
	listBranches(fullName: string): Promise<string[]>;
	resolveRef(fullName: string, ref: string): Promise<string>;
	/** Every file path in the tree at a commit. */
	tree(fullName: string, sha: string): Promise<string[]>;
	/** The repo's files at a commit as a gzipped tar stream, every entry under one top-level folder. */
	archive(fullName: string, sha: string): Promise<ReadableStream<Uint8Array>>;
	file(fullName: string, sha: string, path: string): Promise<Uint8Array>;
	cloneUrl(fullName: string): string;
	/**
	 * Environment that authenticates the git commands Anton runs to set up a
	 * machine, before any agent or terminal has used it. Never given to the agent.
	 */
	gitAuthEnv(): Record<string, string>;
	/** Where `branch` points on the host, or null when it does not exist. */
	branchHead(fullName: string, branch: string): Promise<string | null>;
	/**
	 * Recreates `commits` (oldest first) on the host from their contents,
	 * skipping any it already has, then points `branch` at `head`, replacing
	 * what was there. Pushing this way keeps credentials out of the machine.
	 */
	pushCommits(input: PushInput): Promise<void>;
	openPullRequest(input: PullRequestInput): Promise<string>;
	/** The state of a pull request this host opened, by its URL. */
	pullRequestState(url: string): Promise<PullRequestState>;
	/** Open issues carrying `label`, oldest first. Pull requests are not issues here. */
	listIssues(fullName: string, label: string): Promise<Issue[]>;
	/** A pull request's checks on its head commit and every comment and review on it; only its state once it is merged or closed. */
	pullRequestActivity(url: string): Promise<PullRequestActivity>;
	/** The files a pull request changes, each with its diff when the host shows one (not for binary or very large files). */
	changedFiles(url: string): Promise<ChangedFile[]>;
	/**
	 * Posts a review on a pull request as Anton's account, never approving or
	 * blocking it: a summary, and comments on lines of the change. Comments the
	 * host cannot place on the diff are folded into the summary.
	 */
	postReview(url: string, review: ReviewInput): Promise<void>;
	/** The display name of the account Anton acts as on the host, or null when it has none. */
	accountName(): Promise<string | null>;
	/** `owner/name` of the repos Anton's account can reach, most recently pushed first. */
	listRepos(): Promise<string[]>;
};

export type Issue = { number: number; title: string; body: string; url: string };

/** `failed` only when the check ran and failed; a cancelled, stale or neutral one is `skipped`. */
export type CheckResult = { name: string; status: 'pending' | 'passed' | 'failed' | 'skipped'; summary: string; url: string };

/**
 * A comment, a line comment or a review with a body; `path` and `line` only
 * for line comments. Only from people who can push to the repo and from apps
 * installed on it.
 */
export type PullRequestComment = { id: string; author: string; body: string; path: string | null; line: number | null; at: string };

/** A comment on one line of the new version of a file the pull request changed. */
export type ReviewComment = { path: string; line: number; body: string };

/** `commit` is the head the review read; null means the pull request's latest. */
export type ReviewInput = { commit: string | null; body: string; comments: ReviewComment[] };

export type ChangedFile = { path: string; patch: string | null };

export type PullRequestActivity = { state: PullRequestState; headSha: string; checks: CheckResult[]; comments: PullRequestComment[] };

/** How hard a model reasons before answering, from none to the most it offers. */
export const REASONING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Reasoning = (typeof REASONING_LEVELS)[number];

export type ModelInfo = {
	/** The agent's model specifier, `<gateway>/<model>`. */
	id: string;
	name: string;
	vendor: string;
	description: string;
	/** Unix milliseconds the model was published. */
	createdAt: number;
	contextLength: number;
	maxOutput: number | null;
	/** US dollars per million tokens; `cacheRead` and `cacheWrite` are for prompt tokens read from or written to the provider's cache. */
	price: { input: number; output: number; cacheRead: number; cacheWrite: number };
	vision: boolean;
	/** Levels the model accepts, weakest first; empty when it cannot reason. */
	reasoning: Reasoning[];
	defaultReasoning: Reasoning;
};

/** The models an LLM gateway offers for agent work (tool calling, text out). */
export type ModelCatalog = {
	readonly name: string;
	list(): Promise<ModelInfo[]>;
};

/** A question with a bounded answer: yes or no, or one of a few named options, each with what it means. */
export type Question = { type: 'yes-no'; instructions: string } | { type: 'choice'; instructions: string; options: Record<string, string> };

/** `yes` is the probability that the answer is yes; a choice gives the option picked and each option's probability. */
export type Answer = { yes: number } | { choice: string; probabilities: Record<string, number> };

export type Decision = { answers: Record<string, Answer>; inputTokens: number; cost: number };

/**
 * A fast, cheap model that answers typed questions about some state with
 * probabilities instead of text (a "System One" model such as TypeSafe's Jev),
 * for decisions code makes without a full model call.
 */
export type DecisionModel = {
	/** The model specifier, `<gateway>/<model>`, as usage is logged under. */
	readonly name: string;
	decide(state: Record<string, unknown>, questions: Record<string, Question>, signal?: AbortSignal): Promise<Decision>;
};

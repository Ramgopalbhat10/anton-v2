/** The seams between Anton and the services it runs on: everything outside `src/providers/` depends only on these. */

import type { VariantOf } from './model-variants.ts';

export type ExecOptions = {
	cwd?: string;
	env?: Record<string, string>;
	stdin?: Uint8Array;
	timeoutMs?: number;
	signal?: AbortSignal;
	/** Run without a login shell (`bash -c`): for commands that need only the base tools, such as reading a file. */
	plain?: boolean;
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
	/** Without a shell, as a login shell per read is slow under gVisor. Null leaves it to `exec`; a missing file throws a `CommandError` as `exec`'s does. */
	readFile?(path: string): Promise<Uint8Array | null>;
	/** Likewise: false leaves it to `exec`, and an error is the one `cat >` gives. */
	writeFile?(path: string, content: Uint8Array): Promise<boolean>;
	openPty(options: { cols: number; rows: number; cwd: string; env?: Record<string, string> }): Promise<Pty>;
	previewUrl(port: number): Promise<string | null>;
	/** Carries its own short-lived credential, so only Anton's own UI gets it. Null when the provider has no way in. */
	socketUrl(port: number): Promise<string | null>;
};

export type MachineOrigin = 'live' | 'resumed' | 'image' | 'base';

export type SandboxRuntime = 'container' | 'vm';

/** Providers that cannot apply one ignore it. */
export type SandboxResources = {
	runtime: SandboxRuntime;
	cpu: number;
	memoryMiB: number;
	/** Shut down after this long with nothing running. */
	idleTimeoutMs: number;
	/** Shut down this long after starting, whatever it is doing. */
	lifetimeMs: number;
	regions: string[];
	/** `*.` wildcards allowed; empty allows all. */
	allowedDomains: string[];
};

export type AcquireRequest = {
	key: string;
	state: string | null;
	image: string | null;
	baseImage: string | null;
	/** Fixed when the machine starts. */
	ports: number[];
	/** A running machine keeps what it started with. */
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
	/** Never starts one. */
	find(key: string): Promise<Machine | null>;
	rootOf(key: string): string;
	running(): Promise<Set<string>>;
	stop(state: string): Promise<void>;
	snapshot(machine: Machine): Promise<string>;
};

export type StoredObject = { key: string; size: number; modifiedAt: number };

export type ObjectStore = {
	readonly name: string;
	put(key: string, body: Uint8Array | string, contentType?: string): Promise<void>;
	get(key: string): Promise<Uint8Array | null>;
	has(key: string): Promise<boolean>;
	list(prefix: string): Promise<StoredObject[]>;
	/** A missing key is not an error. */
	remove(key: string): Promise<void>;
	/** A credential-free link that expires, so a sandbox downloads from the store itself. Absent for a store that cannot make one. */
	signedUrl?(key: string, expiresInSeconds: number): Promise<string>;
};

export type RepoInfo = { fullName: string; defaultBranch: string; private: boolean };

export type PullRequestInput = {
	repo: string;
	head: string;
	base: string;
	title: string;
	body: string;
};

/** `date` is ISO 8601 with the original offset, so the commit's hash survives. */
export type Signature = { name: string; email: string; date: string };

/** Against its first parent; `sha` is null when removed. Mode 160000 is a submodule. */
export type TreeChange = { path: string; mode: string; sha: string | null };

/** Enough to recreate the commit with the same hash. `parentTree` is its first parent's tree. */
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

export type CommitSource = { commit(sha: string): Promise<CommitData>; blob(sha: string): Promise<Uint8Array> };

export type PushInput = { repo: string; branch: string; head: string; commits: string[]; source: CommitSource };

export type PullRequestState = 'open' | 'draft' | 'merged' | 'closed';

export type GitHost = {
	readonly name: string;
	getRepo(fullName: string): Promise<RepoInfo>;
	listBranches(fullName: string): Promise<string[]>;
	resolveRef(fullName: string, ref: string): Promise<string>;
	tree(fullName: string, sha: string): Promise<string[]>;
	/** A gzipped tar stream with every entry under one top-level folder. */
	archive(fullName: string, sha: string): Promise<ReadableStream<Uint8Array>>;
	file(fullName: string, sha: string, path: string): Promise<Uint8Array>;
	cloneUrl(fullName: string): string;
	/** Authenticates the git commands Anton runs to set up a machine, before any agent or terminal has used it. Never given to the agent. */
	gitAuthEnv(): Record<string, string>;
	branchHead(fullName: string, branch: string): Promise<string | null>;
	/**
	 * Recreates `commits` on the host from their contents, skipping any it has, then points `branch` at `head`, replacing
	 * what was there. Pushing this way keeps credentials out of the machine.
	 */
	pushCommits(input: PushInput): Promise<void>;
	openPullRequest(input: PullRequestInput): Promise<string>;
	pullRequestState(url: string): Promise<PullRequestState>;
	/** Oldest first. Pull requests are not issues here. */
	listIssues(fullName: string, label: string): Promise<Issue[]>;
	/** Only its state once it is merged or closed. */
	pullRequestActivity(url: string): Promise<PullRequestActivity>;
	changedFiles(url: string): Promise<ChangedFile[]>;
	pullRequest(url: string): Promise<PullRequestInfo>;
	listPullRequests(fullName: string): Promise<PullRequestSummary[]>;
	pullRequestMetadata(url: string): Promise<PullRequestMetadata>;
	pullRequestDetail(url: string): Promise<PullRequestDetail>;
	pullRequestDiff(url: string): Promise<string>;
	/** `sha` refuses the merge if the head moved since. */
	mergePullRequest(url: string, input: MergeInput): Promise<void>;
	mergeBase(fullName: string, a: string, b: string): Promise<string>;
	treeEntries(fullName: string, commit: string): Promise<TreeListing>;
	blob(fullName: string, sha: string): Promise<Uint8Array>;
	/** As Anton's account, never approving or blocking. Comments the host cannot place on the diff are folded into the summary. */
	postReview(url: string, review: ReviewInput): Promise<void>;
	/** Answers a comment (`PullRequestComment.id`) where it was made: in a line comment's thread, which `resolve` then marks resolved, else on the pull request. */
	answerComment?(url: string, comment: string, body: string, resolve: boolean): Promise<void>;
	/** The pull request's line comment threads, oldest first, each with its replies and whether it is resolved. */
	reviewThreads?(url: string): Promise<ReviewThread[]>;
	accountName(): Promise<string | null>;
	listRepos(): Promise<string[]>;
	searchRepos(query: string, limit: number): Promise<RepoHit[]>;
	searchFiles(query: string, filename: string, limit: number): Promise<FileHit[]>;
};

export type RepoHit = { fullName: string; description: string; stars: number };
export type FileHit = { repo: string; path: string; ref: string };

export type Issue = { number: number; title: string; body: string; url: string };

/** `failed` only when the check ran and failed; a cancelled, stale or neutral one is `skipped`. */
export type CheckResult = { name: string; status: 'pending' | 'passed' | 'failed' | 'skipped'; summary: string; url: string };

/** Only from people who can push to the repo and from apps installed on it. */
/** `replyTo`: for a reply in a line comment's thread, the id of the comment that started it. `side`/`outdated` are only set on line comments: the host's REST payload carries `side`, and `line` going null while `original_line` stays means the line has since left the diff. */
export type PullRequestComment = { id: string; author: string; body: string; path: string | null; line: number | null; at: string; replyTo?: string | null; side?: 'old' | 'new' | null; outdated?: boolean };

/** `id` is its first comment's `PullRequestComment.id`; `outdated` when the lines it was on have since changed. */
export type ReviewThread = { id: string; path: string; line: number | null; resolved: boolean; outdated: boolean; comments: Array<{ author: string; body: string; at: string }> };

/** `line` is in the new version of the file. */
export type ReviewComment = { path: string; line: number; body: string };

/** `commit` is the head the review read; null means the pull request's latest. */
export type ReviewInput = { commit: string | null; body: string; comments: ReviewComment[] };

export type ChangedFile = { path: string; patch: string | null };

/** `trusted`: the author can push to the repository. */
export type PullRequestSummary = {
	url: string;
	number: number;
	title: string;
	author: string;
	trusted: boolean;
	draft: boolean;
	headBranch: string;
	headSha: string;
	updatedAt: string;
};

export type PullRequestInfo = PullRequestSummary & {
	repo: string;
	body: string;
	state: PullRequestState;
	baseBranch: string;
	baseSha?: string;
	commits: Array<{ sha: string; subject: string }>;
};

export type MergeMethod = 'squash' | 'merge' | 'rebase';
export type MergeInput = { method: MergeMethod; title?: string; sha?: string };

export type DiscussionEntry = PullRequestComment & { kind: 'comment' | 'review' | 'line'; verdict: string | null };

export type PullRequestMetadata = { url: string; headBranch: string; baseBranch: string; additions: number; deletions: number };

/** `mergeable` is null while the host is still working it out. `discussion` is never given to an agent, only shown. */
export type PullRequestDetail = PullRequestInfo & {
	createdAt: string;
	mergedAt: string | null;
	mergedBy: string | null;
	closedAt: string | null;
	additions: number;
	deletions: number;
	changedFiles: number;
	mergeable: boolean | null;
	approved: boolean;
	checks: CheckResult[];
	discussion: DiscussionEntry[];
};

/** `path` is from the root; `type` commit is a submodule. */
export type TreeEntry = { path: string; mode: string; type: 'blob' | 'tree' | 'commit'; sha: string };
export type TreeListing = { sha: string; entries: TreeEntry[] };

/**
 * `approved`: a reviewer's latest review approves it and none asks for changes. `conflicts`: it cannot merge without
 * someone resolving them, as far as the host has worked out; `baseSha` is the base head the host last compared it with.
 */
export type PullRequestActivity = {
	state: PullRequestState;
	headSha: string;
	/** Branch names can change even when the commits stay the same. */
	headBranch?: string;
	baseBranch?: string;
	checks: CheckResult[];
	comments: PullRequestComment[];
	approved?: boolean;
	conflicts?: boolean;
	baseSha?: string;
};

export const REASONING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Reasoning = (typeof REASONING_LEVELS)[number];

export type ModelInfo = {
	id: string;
	name: string;
	vendor: string;
	description: string;
	createdAt: number;
	contextLength: number;
	maxOutput: number | null;
	/** US dollars per million tokens; `cacheRead` and `cacheWrite` are for prompt tokens read from or written to the provider's cache. */
	price: { input: number; output: number; cacheRead: number; cacheWrite: number };
	vision: boolean;
	/** Weakest first; empty when it cannot reason. */
	reasoning: Reasoning[];
	defaultReasoning: Reasoning;
	subscription?: string;
	variant?: VariantOf;
};

export type ModelEndpoint = {
	slug: string;
	name: string;
	/** US dollars per million tokens. */
	price: { input: number; output: number };
	contextLength: number;
	/** Median seconds to the first token and tokens a second, where the gateway says. */
	latency: number | null;
	throughput: number | null;
	uptime: number | null;
};

/** The models an LLM gateway offers for agent work (tool calling, text out). */
export type ModelCatalog = {
	readonly name: string;
	list(fresh?: boolean): Promise<ModelInfo[]>;
	/** Absent when the gateway routes on its own. */
	endpoints?(model: string): Promise<ModelEndpoint[]>;
};

/** The account behind a pay-per-token gateway (OpenRouter, Vercel AI Gateway): a key pasted in Settings, else the server's. */
export type GatewayAccount = {
	readonly id: string;
	readonly name: string;
	readonly gateway: string;
	readonly keyPage: string;
	readonly envVar: string;
	check(key: string): Promise<{ email: string | null }>;
	windows?(key: string): Promise<PlanWindow[]>;
};

export type SubscriptionCredential = {
	access: string;
	refresh: string;
	expiresAt: number;
	clientId: string;
	scopes: string[];
	/** Who signed in, for display only. */
	email: string | null;
};

/** One sign-in attempt: open `url`, approve, and the browser lands on `redirectUri` with what `complete` needs. */
export type SubscriptionLogin = {
	url: string;
	redirectUri: string;
	complete(callbackUrl: string, signal?: AbortSignal): Promise<SubscriptionCredential>;
};

/** `listPrice`: what the same calls would cost through the vendor's API, when known. */
export type SubscriptionModel = Omit<ModelInfo, 'price' | 'subscription'> & { listPrice: ModelInfo['price'] | null };

/** A plan the user pays for (ChatGPT), signed in to with the vendor's OAuth flow; its calls bill the plan. */
export type SubscriptionProvider = {
	readonly id: string;
	readonly name: string;
	readonly gateway: string;
	/** `hostId` names this install to the vendor across sign-ins; `previous` client is reused so the vendor lists Anton once. */
	startLogin(hostId: string, previous?: Pick<SubscriptionCredential, 'clientId' | 'email'>): SubscriptionLogin;
	/** The refresh token rotates, so the old credential stops working. */
	refresh(credential: SubscriptionCredential, signal?: AbortSignal): Promise<SubscriptionCredential>;
	listModels(accessToken: string): Promise<SubscriptionModel[]>;
};

/** What a vendor's agent program says of its sign-in; the token itself never leaves the program. */
export type AgentRuntimeStatus = {
	signedIn: boolean;
	email: string | null;
	plan: string | null;
	version: string | null;
	problem: string | null;
};

export type RuntimeTool = { name: string; description: string; inputSchema: Record<string, unknown> };

export type RuntimeContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

/** Anton runs the tool; the program only waits for this. */
export type RuntimeToolOutput = { content: RuntimeContent[]; isError: boolean };

export type RuntimeUsage = { input: number; output: number; cacheRead: number; cacheWrite: number };

/**
 * In the shape of Anthropic's Messages stream: each model call opens with `message_start` and closes with
 * `message_stop`; `turn_end` comes once per turn. Tool names are Anton's, without the program's MCP prefix.
 */
export type RuntimeEvent =
	| { type: 'message_start'; id: string; usage: RuntimeUsage }
	| { type: 'block_start'; index: number; block: { type: 'text' } | { type: 'thinking' } | { type: 'tool_use'; id: string; name: string } }
	| { type: 'block_delta'; index: number; text?: string; thinking?: string; signature?: string; json?: string }
	| { type: 'block_stop'; index: number }
	| { type: 'message_delta'; stopReason: string | null; usage: Partial<RuntimeUsage> }
	| { type: 'message_stop' }
	/** `limit` when the plan's usage limit stopped it. */
	| { type: 'error'; message: string; limit: boolean }
	/** The plan's limit ran out and the account now pays for extra usage. */
	| { type: 'extra_usage' }
	| { type: 'turn_end' };

export type RuntimeConversationOptions = {
	model: string;
	/** Added after the program's own. */
	instructions: string;
	tools: RuntimeTool[];
	/** Null for the program's default; `off` turns thinking off. */
	effort: string | null;
	callTool(toolUseId: string, name: string): Promise<RuntimeToolOutput>;
};

export type RuntimeConversation = {
	send(content: RuntimeContent[]): void;
	readonly events: AsyncIterable<RuntimeEvent>;
	close(): void;
	/** Swap the served tool list under a live conversation. Runtimes that cannot do it omit this and the bridge opens a fresh session instead. */
	setTools?(tools: RuntimeTool[]): void;
};

/** Anton relays only the code the vendor's page shows; the program trades it for its token and keeps that. */
export type RuntimeSignIn = {
	url: string;
	complete(code: string): Promise<void>;
	cancel(): void;
};

/** A vendor's own agent program (Claude Code) Anton drives as a model. Anton never sees its token: it hands the program Anton's tools and runs every call. */
export type AgentRuntime = {
	readonly id: string;
	readonly name: string;
	readonly gateway: string;
	readonly signInCommand: string;
	signIn?(): Promise<RuntimeSignIn>;
	signOut?(): Promise<void>;
	/** Without `fresh`, the last answer is reused for a few minutes. */
	status(fresh?: boolean): Promise<AgentRuntimeStatus>;
	listModels(): Promise<SubscriptionModel[]>;
	windows?(): Promise<PlanWindow[] | null>;
	/** Where the vendor agent's jailed process runs when the runtime offers a choice (ACP agents on Modal). */
	isolation?(): Promise<'sidecar' | 'sandbox'>;
	/** The OAuth client Anton's sign-in for this program uses, when Settings may change it (Antigravity). */
	oauthClient?: OAuthClientSlot;
	open(options: RuntimeConversationOptions): RuntimeConversation;
};

/** An OAuth client kept in Settings; null until one is saved, and `set(null)` removes it. */
export type OAuthClientSlot = {
	get(): Promise<OAuthClient | null>;
	set(client: OAuthClient | null): Promise<OAuthClient | null>;
};

export type PlanWindow = { label: string; usedPercent: number; resetsAt: string | null; limited: boolean };

/** A plan used with a key from the vendor's dashboard (OpenCode Go, Cursor), as the vendor documents for other coding agents. */
export type KeyPlan = {
	readonly id: string;
	readonly name: string;
	readonly gateway: string;
	readonly keyPage: string;
	check(key: string): Promise<{ email: string | null }>;
	listModels(key: string): Promise<SubscriptionModel[]>;
	windows?(key: string): Promise<PlanWindow[]>;
	/** For a plan whose models run inside the vendor's own agent (Cursor), as `AgentRuntime.open`. */
	open?(key: string, options: RuntimeConversationOptions): RuntimeConversation;
};

export type Question = { type: 'yes-no'; instructions: string } | { type: 'choice'; instructions: string; options: Record<string, string> };

/** `yes` is the probability that the answer is yes; a choice gives the option picked and each option's probability. */
export type Answer = { yes: number } | { choice: string; probabilities: Record<string, number> };

export type Decision = { answers: Record<string, Answer>; inputTokens: number; cost: number };

/** A fast model that answers typed questions with probabilities instead of text (a "System One" model such as TypeSafe's Jev). */
export type DecisionModel = {
	readonly name: string;
	decide(state: Record<string, unknown>, questions: Record<string, Question>, signal?: AbortSignal): Promise<Decision>;
};

export type OpenRouterEffort = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

/** Reads an image and answers in text, with no tools, such as the computer tool finding what to click. */
export type VisionModel = {
	runs(model: string): boolean;
	look(
		input: { model: string; prompt: string; image: Uint8Array; mimeType: string; reasoning?: OpenRouterEffort },
		signal?: AbortSignal,
	): Promise<{ text: string; inputTokens: number; outputTokens: number; cost: number }>;
};

/** A fast model that writes a few words with no tools, such as a task's title. */
export type TextModel = {
	runs(model: string): boolean;
	/** `timeoutMs` allows a longer piece than the default few seconds. */
	write(
		input: { model: string; prompt: string; maxTokens: number; reasoning?: OpenRouterEffort; timeoutMs?: number },
		signal?: AbortSignal,
	): Promise<{ text: string; inputTokens: number; outputTokens: number; cost: number }>;
};

export type ImageModelInfo = {
	id: string;
	name: string;
	vendor: string;
	description: string;
	/** 0 makes images from words alone. */
	references: number;
	aspectRatios: string[];
	transparent: boolean;
};

export type ImageReference = { bytes: Uint8Array; mimeType: string };

/** generate_image draws here whatever model the task runs on, so a model that cannot draw still makes one. */
export type ImageModel = {
	runs(model: string): boolean;
	list(): Promise<ImageModelInfo[]>;
	generate(
		input: { model: string; prompt: string; references: ImageReference[]; aspectRatio?: string; transparent?: boolean },
		signal?: AbortSignal,
	): Promise<{ image: Uint8Array; mimeType: string; inputTokens: number; outputTokens: number; cost: number }>;
};

/** A browser running on a hosted service: Chrome DevTools Protocol for code, a live view for people. */
export type HostedBrowser = {
	id: string;
	cdpUrl: string;
	/** A credential, so only Anton's own UI gets it. */
	liveViewUrl: string | null;
};

/** Each lives until it is removed or has been idle for `idleSeconds`. */
export type BrowserHost = {
	readonly name: string;
	create(options: { idleSeconds: number; viewport: { width: number; height: number }; startUrl?: string }): Promise<HostedBrowser>;
	get(id: string): Promise<HostedBrowser | null>;
	remove(id: string): Promise<void>;
};

/** As `PushSubscription.toJSON()` gives them. */
export type PushTarget = { endpoint: string; keys: { p256dh: string; auth: string } };

/** VAPID, base64url: the raw public point and the private scalar. */
export type PushKeys = { publicKey: string; privateKey: string };

export type PushMessage = {
	/** Encrypted on the way, so the push service never reads it. */
	payload: string;
	ttlSeconds: number;
	/** `high` wakes a sleeping phone at once. */
	urgency: 'high' | 'normal';
	/** A message waiting with the same topic is replaced by this one. */
	topic?: string;
};

/** Web Push, so a phone or a closed browser hears of a task without an Anton tab open. */
export type PushSender = {
	generateKeys(): PushKeys;
	/** `gone` when the push service says the subscription no longer exists, so it can be forgotten. */
	send(target: PushTarget, message: PushMessage, auth: { keys: PushKeys; subject: string }): Promise<{ ok: boolean; gone: boolean; status: number; detail: string }>;
};

/** Your own OAuth client at a vendor, made in its console: a self-hosted Anton has no verified app of its own. */
export type OAuthClient = { clientId: string; clientSecret: string };

/** An account the agent's tools reach (Google), signed in to on your own OAuth client. */
export type AccountSignIn = {
	readonly id: string;
	readonly name: string;
	/** `redirectUri` is Anton's own callback; `complete` takes that address with its query. */
	startLogin(client: OAuthClient, scopes: string[], redirectUri: string, hint?: string | null): SubscriptionLogin;
	/** A refresh token the vendor does not rotate is kept. */
	refresh(client: OAuthClient, credential: SubscriptionCredential, signal?: AbortSignal): Promise<SubscriptionCredential>;
	revoke(credential: SubscriptionCredential): Promise<void>;
};

export type MailThreadSummary = { id: string; subject: string; from: string; date: string; snippet: string; messages: number; unread: boolean; labels: string[] };

export type MailAttachment = { name: string; mimeType: string; size: number };

export type MailMessage = {
	id: string;
	from: string;
	to: string;
	cc: string;
	date: string;
	subject: string;
	body: string;
	attachments: MailAttachment[];
};

export type MailThread = { id: string; subject: string; messages: MailMessage[] };

/** With `threadId` it replies to that conversation's latest message. */
export type MailDraftInput = { to: string[]; cc: string[]; bcc: string[]; subject: string; body: string; threadId: string | null };

export type MailDraft = MailDraftInput & { id: string; messageId: string };

/** A mailbox (Gmail) the agent reads and writes drafts in, with its account sign-in's access token. */
export type Mailbox = {
	readonly id: string;
	readonly name: string;
	readonly account: string;
	readonly scopes: { read: string[]; draft: string[] };
	/** In the mailbox's own search syntax, newest first. */
	search(token: string, query: string, max: number, signal?: AbortSignal): Promise<MailThreadSummary[]>;
	thread(token: string, id: string, signal?: AbortSignal): Promise<MailThread>;
	saveDraft(token: string, draft: MailDraftInput, draftId: string | null, signal?: AbortSignal): Promise<MailDraft>;
	draft(token: string, id: string, signal?: AbortSignal): Promise<MailDraft>;
	sendDraft(token: string, id: string, signal?: AbortSignal): Promise<{ id: string; threadId: string }>;
};

export type AppsToolkit = {
	slug: string;
	name: string;
	description: string;
	logo: string;
	appUrl: string | null;
	categories: string[];
	toolsCount: number;
	noAuth: boolean;
};

export type AppsTool = {
	slug: string;
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	tags: string[];
};

/** Its id and status, never its tokens. */
export type AppsAccount = {
	id: string;
	toolkit: string;
	label: string | null;
	status: string;
	statusReason: string | null;
	createdAt: string;
};

export type AppsAuthField = { name: string; label: string; description: string; required: boolean; secret: boolean; default: string | null };
/** One way a toolkit signs in: `configFields` go into the auth config (an OAuth app's client, say), `connectFields` are asked when an account connects. */
export type AppsAuthMethod = { scheme: string; name: string; configFields: AppsAuthField[]; connectFields: AppsAuthField[]; hintUrl: string | null };
export type AppsToolkitAuth = { managedSchemes: string[]; methods: AppsAuthMethod[]; guideUrl: string | null };
export type AppsAuthConfig = { id: string; name: string; scheme: string | null; managed: boolean; enabled: boolean; createdAt: string };

export type AppsConnectLink = { redirectUrl: string; accountId: string; expiresAt: string };

export type AppsExecution = { data: unknown; error: string | null; successful: boolean; logId: string | null };

/** An apps platform (Composio): the providers' tokens stay inside the platform; Anton keeps only account ids and status. */
export type AppsConnector = {
	keySource(): 'settings' | 'environment' | null;
	checkKey(key: string): Promise<void>;
	toolkits(options?: { search?: string; slug?: string; limit?: number }): Promise<AppsToolkit[]>;
	tools(toolkit: string): Promise<AppsTool[]>;
	toolkitAuth(toolkit: string): Promise<AppsToolkitAuth>;
	authConfigs(toolkit: string): Promise<AppsAuthConfig[]>;
	/** The credentials go to the platform and are not kept by Anton. */
	createAuthConfig(toolkit: string, input: { managed: true; name: string } | { managed: false; name: string; scheme: string; credentials: Record<string, string> }): Promise<string>;
	connectLink(input: { authConfigId: string; userId: string; callbackUrl?: string }): Promise<AppsConnectLink>;
	connectedAccount(id: string): Promise<AppsAccount | null>;
	connectedAccounts(input: { userId: string; toolkits?: string[] }): Promise<AppsAccount[]>;
	deleteConnectedAccount(id: string): Promise<void>;
	revokeConnectedAccount(id: string): Promise<void>;
	runTool(toolSlug: string, input: { userId: string; connectedAccountId?: string | null; args: Record<string, unknown> }, signal?: AbortSignal): Promise<AppsExecution>;
};

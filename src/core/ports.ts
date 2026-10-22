/**
 * The seams between Anton and the services it runs on. Everything outside
 * `src/providers/` depends only on these interfaces, so a sandbox, storage
 * or git host is swapped by writing one new provider and selecting it in
 * `src/providers/index.ts`.
 */

import type { VariantOf } from './model-variants.ts';

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
	/**
	 * A WebSocket address the user's browser can open for a server listening
	 * on `port` inside the machine, carrying its own short-lived credential, so
	 * only Anton's own UI gets it. Null when the provider has no way in.
	 */
	socketUrl(port: number): Promise<string | null>;
};

/** How a machine came to be: decides how much setup the workspace still needs. */
export type MachineOrigin = 'live' | 'resumed' | 'image' | 'base';

/** What a machine runs on: a container, or a full VM with its own kernel, for Docker, FUSE and the like. */
export type SandboxRuntime = 'container' | 'vm';

/** How big a new machine is, how long it may live, and what it may reach. Providers that cannot apply one ignore it. */
export type SandboxResources = {
	runtime: SandboxRuntime;
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
	/** Who opened a pull request, what it says and where its head and base are, by its URL. */
	pullRequest(url: string): Promise<PullRequestInfo>;
	/** A repository's open pull requests, most recently updated first. */
	listPullRequests(fullName: string): Promise<PullRequestSummary[]>;
	/** The newest commit both `a` and `b` contain. */
	mergeBase(fullName: string, a: string, b: string): Promise<string>;
	/** Every entry of a commit's tree, subtrees included, so a machine can rebuild it without fetching. */
	treeEntries(fullName: string, commit: string): Promise<TreeListing>;
	/** One file's contents by its blob hash. */
	blob(fullName: string, sha: string): Promise<Uint8Array>;
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
	/** Public repositories matching a search, best match first. */
	searchRepos(query: string, limit: number): Promise<RepoHit[]>;
	/** Files named `filename` whose contents match a search, best match first, each with the commit it was found at. */
	searchFiles(query: string, filename: string, limit: number): Promise<FileHit[]>;
};

export type RepoHit = { fullName: string; description: string; stars: number };
export type FileHit = { repo: string; path: string; ref: string };

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

/** `trusted`: the author can push to the repository (an owner, member or collaborator). */
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

/** `commits` are the pull request's own, oldest first, each as its hash and first line. */
export type PullRequestInfo = PullRequestSummary & {
	repo: string;
	body: string;
	state: PullRequestState;
	baseBranch: string;
	commits: Array<{ sha: string; subject: string }>;
};

/** A tree entry as git lists it; `path` is from the root, `type` blob, tree or commit (a submodule). */
export type TreeEntry = { path: string; mode: string; type: 'blob' | 'tree' | 'commit'; sha: string };
export type TreeListing = { sha: string; entries: TreeEntry[] };

/**
 * `approved`: a reviewer's latest review approves it and none asks for changes. `conflicts`: it cannot
 * merge into its base without someone resolving them, as far as the host has worked out; `baseSha` is
 * the base branch's head the host last compared it with.
 */
export type PullRequestActivity = {
	state: PullRequestState;
	headSha: string;
	checks: CheckResult[];
	comments: PullRequestComment[];
	approved?: boolean;
	conflicts?: boolean;
	baseSha?: string;
};

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
	/** The plan its calls bill, such as "ChatGPT", when it runs on a subscription you signed in to rather than per token. */
	subscription?: string;
	/** Set on a plan model's larger context or fast mode (`<model>[1m]`, `<model>[fast]`): the model it is a variant of. */
	variant?: VariantOf;
};

/** One provider a gateway can send a model's calls to, as a task's route names it. */
export type ModelEndpoint = {
	/** What a route names it by, such as `anthropic` or `deepinfra/fp8`. */
	slug: string;
	name: string;
	/** US dollars per million tokens through this provider. */
	price: { input: number; output: number };
	contextLength: number;
	/** Median seconds to the first token and tokens a second, recently, where the gateway says. */
	latency: number | null;
	throughput: number | null;
	/** Percent of recent calls it answered, where the gateway says. */
	uptime: number | null;
};

/** The models an LLM gateway offers for agent work (tool calling, text out). */
export type ModelCatalog = {
	readonly name: string;
	/** `fresh` lists them again rather than serving the cached list. */
	list(fresh?: boolean): Promise<ModelInfo[]>;
	/** The providers that serve one of its models (`<gateway>/<model>`), for a route; absent when the gateway routes on its own. */
	endpoints?(model: string): Promise<ModelEndpoint[]>;
};

/**
 * The account behind a gateway Anton pays per token through (OpenRouter,
 * Vercel AI Gateway), used with a key pasted in Settings › Subscriptions, or
 * the server's own when none is pasted. Its models are its catalog's.
 */
export type GatewayAccount = {
	/** `openrouter`: how settings and routes name it. */
	readonly id: string;
	readonly name: string;
	/** The `<gateway>` in its models' `<gateway>/<model>`. */
	readonly gateway: string;
	/** Where you make a key. */
	readonly keyPage: string;
	/** The variable a key set on the server comes from, used while none is pasted. */
	readonly envVar: string;
	/** Asks the vendor whether the key works; throws why when it does not. */
	check(key: string): Promise<{ email: string | null }>;
	/** The key's spending limits and the account's credits, as the vendor reports them. */
	windows?(key: string): Promise<PlanWindow[]>;
};

/**
 * A signed-in subscription: a short-lived access token, the rotating refresh
 * token that renews it, and the OAuth client that sign-in registered.
 */
export type SubscriptionCredential = {
	access: string;
	refresh: string;
	/** Unix milliseconds the access token stops working. */
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
	/** Takes the full address the browser was sent back to. */
	complete(callbackUrl: string, signal?: AbortSignal): Promise<SubscriptionCredential>;
};

/** A model the subscription offers this account, with what the same calls would cost through the vendor's API, when known. */
export type SubscriptionModel = Omit<ModelInfo, 'price' | 'subscription'> & { listPrice: ModelInfo['price'] | null };

/**
 * A model subscription the user already pays for (a ChatGPT plan), signed in to
 * with the vendor's own OAuth flow, whose calls bill the plan instead of per token.
 */
export type SubscriptionProvider = {
	/** `chatgpt`: how settings and routes name it. */
	readonly id: string;
	/** The plan, as the model picker shows it: "ChatGPT". */
	readonly name: string;
	/** The Flue provider id its models resolve under, the `<gateway>` in `<gateway>/<model>`. */
	readonly gateway: string;
	/**
	 * `hostId` names this Anton install to the vendor and stays the same across
	 * sign-ins; `previous` is the last sign-in's client, reused so the vendor
	 * lists Anton once.
	 */
	startLogin(hostId: string, previous?: Pick<SubscriptionCredential, 'clientId' | 'email'>): SubscriptionLogin;
	/** Renews the access token; the refresh token rotates, so the old credential stops working. */
	refresh(credential: SubscriptionCredential, signal?: AbortSignal): Promise<SubscriptionCredential>;
	/** The models this account may use now. */
	listModels(accessToken: string): Promise<SubscriptionModel[]>;
};

/** What a vendor's agent program says about its own sign-in; the token itself never leaves the program. */
export type AgentRuntimeStatus = {
	signedIn: boolean;
	email: string | null;
	/** The plan as the program names it, such as "max". */
	plan: string | null;
	version: string | null;
	/** Why the program cannot run tasks on a plan now, such as a sign-in with an API key instead. */
	problem: string | null;
};

/** One of Anton's tools as the program is offered it, over MCP. */
export type RuntimeTool = { name: string; description: string; inputSchema: Record<string, unknown> };

export type RuntimeContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

/** What a tool call answers; Anton runs the tool, the program only waits for this. */
export type RuntimeToolOutput = { content: RuntimeContent[]; isError: boolean };

export type RuntimeUsage = { input: number; output: number; cacheRead: number; cacheWrite: number };

/**
 * What the program streams for one turn, in the shape of Anthropic's Messages
 * stream: each model call opens with `message_start` and closes with
 * `message_stop`; `turn_end` comes once the program has finished the turn.
 * Tool names are Anton's own, without the program's MCP prefix.
 */
export type RuntimeEvent =
	| { type: 'message_start'; id: string; usage: RuntimeUsage }
	| { type: 'block_start'; index: number; block: { type: 'text' } | { type: 'thinking' } | { type: 'tool_use'; id: string; name: string } }
	| { type: 'block_delta'; index: number; text?: string; thinking?: string; signature?: string; json?: string }
	| { type: 'block_stop'; index: number }
	| { type: 'message_delta'; stopReason: string | null; usage: Partial<RuntimeUsage> }
	| { type: 'message_stop' }
	/** A model call the program gave up on; `limit` when the plan's usage limit stopped it. */
	| { type: 'error'; message: string; limit: boolean }
	/** The plan's own limit ran out and the account now pays for extra usage. */
	| { type: 'extra_usage' }
	| { type: 'turn_end' };

export type RuntimeConversationOptions = {
	/** The vendor's model id, without the gateway. */
	model: string;
	/** Anton's instructions, added after the program's own. */
	instructions: string;
	tools: RuntimeTool[];
	/** The program's effort level, or null for its default; `off` turns thinking off. */
	effort: string | null;
	/** Runs one tool call; the program waits until it answers. */
	callTool(toolUseId: string, name: string): Promise<RuntimeToolOutput>;
};

/** One conversation with the program: messages in, events out, until it is closed. */
export type RuntimeConversation = {
	send(content: RuntimeContent[]): void;
	readonly events: AsyncIterable<RuntimeEvent>;
	/** Stops the current turn and ends the conversation. */
	close(): void;
};

/**
 * A vendor's own agent program (Claude Code) that Anton drives as a model,
 * signed in through the program's own flow. Anton never sees its token: it
 * hands the program Anton's tools and runs every call the program makes.
 */
export type AgentRuntime = {
	/** `claude-code`: how settings and routes name it. */
	readonly id: string;
	/** The plan, as the model picker shows it: "Claude". */
	readonly name: string;
	/** The Flue provider id its models resolve under. */
	readonly gateway: string;
	/** The command to run once on the server to sign in, in the program's own flow. */
	readonly signInCommand: string;
	/** Read again with `fresh`; otherwise the last answer is reused for a few minutes. */
	status(fresh?: boolean): Promise<AgentRuntimeStatus>;
	listModels(): Promise<SubscriptionModel[]>;
	/** What the program says is used of the plan's own limits, read with its status; null when it will not say. */
	windows?(): Promise<PlanWindow[] | null>;
	open(options: RuntimeConversationOptions): RuntimeConversation;
};

/** One of a plan's own limits as the vendor reports it, such as OpenCode Go's five-hour window. */
export type PlanWindow = { label: string; usedPercent: number; resetsAt: string | null; limited: boolean };

/**
 * A plan used with a key made on the vendor's own dashboard (OpenCode Go,
 * Cursor), the way the vendor documents for coding agents other than its own.
 * Anton keeps the key and hands it to each call.
 */
export type KeyPlan = {
	/** `opencode-go`: how settings and routes name it. */
	readonly id: string;
	/** The plan, as the model picker shows it: "OpenCode Go". */
	readonly name: string;
	/** The Flue provider id its models resolve under. */
	readonly gateway: string;
	/** Where you make a key. */
	readonly keyPage: string;
	/** Asks the vendor whether the key works on the plan, and whose it is; throws why when it does not. */
	check(key: string): Promise<{ email: string | null }>;
	listModels(key: string): Promise<SubscriptionModel[]>;
	/** What is left of the plan's own limits, for a vendor that tells apps. */
	windows?(key: string): Promise<PlanWindow[]>;
	/** For a plan whose models run inside the vendor's own agent (Cursor): one conversation, as `AgentRuntime.open`. */
	open?(key: string, options: RuntimeConversationOptions): RuntimeConversation;
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

/**
 * A model that reads an image and answers in text, with no tools: for code
 * that must see something, such as the computer tool finding what to click on
 * the screen and saying what the screen shows.
 */
export type VisionModel = {
	/** Whether it runs this `<gateway>/<model>` specifier. */
	runs(model: string): boolean;
	look(input: { model: string; prompt: string; image: Uint8Array; mimeType: string }, signal?: AbortSignal): Promise<{ text: string; inputTokens: number; outputTokens: number; cost: number }>;
};

/**
 * A fast model that answers a short prompt in a few words, with no tools: for
 * code that needs a little text written, such as a task's short title.
 */
export type TextModel = {
	/** Whether it runs this `<gateway>/<model>` specifier. */
	runs(model: string): boolean;
	write(input: { model: string; prompt: string; maxTokens: number }, signal?: AbortSignal): Promise<{ text: string; inputTokens: number; outputTokens: number; cost: number }>;
};

/** An image model as the image port lists it: how many images it starts from, and the shapes it draws. */
export type ImageModelInfo = {
	/** `<gateway>/<model>`, as tasks name models. */
	id: string;
	name: string;
	vendor: string;
	description: string;
	/** The most images it takes to start from or edit; 0 makes images from words alone. */
	references: number;
	/** Aspect ratios it draws, such as "16:9"; empty when it does not say. */
	aspectRatios: string[];
	/** Whether it can leave the background transparent. */
	transparent: boolean;
};

export type ImageReference = { bytes: Uint8Array; mimeType: string };

/**
 * A model that makes an image from a prompt, and from images to start from,
 * for the agent's generate_image tool: whatever model the task runs on, the
 * image comes from here, so a model that cannot draw (or a plan whose route
 * offers no image tool) still makes one.
 */
export type ImageModel = {
	/** Whether it runs this `<gateway>/<model>` specifier. */
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
	/** WebSocket address of the browser's Chrome DevTools Protocol endpoint. */
	cdpUrl: string;
	/** A page that shows the browser and takes the viewer's input; a credential, so only Anton's own UI gets it. */
	liveViewUrl: string | null;
};

/**
 * Real browsers someone can see and use from inside Anton (Kernel, say).
 * Each lives until it is removed or has been idle for `idleSeconds`.
 */
export type BrowserHost = {
	readonly name: string;
	create(options: { idleSeconds: number; viewport: { width: number; height: number }; startUrl?: string }): Promise<HostedBrowser>;
	/** Null once the browser is gone, removed or timed out. */
	get(id: string): Promise<HostedBrowser | null>;
	remove(id: string): Promise<void>;
};

/** Where a browser takes push messages, and its keys for encrypting them, as `PushSubscription.toJSON()` gives them. */
export type PushTarget = { endpoint: string; keys: { p256dh: string; auth: string } };

/** The application server's key pair that push services know Anton by (VAPID), base64url: the raw public point and the private scalar. */
export type PushKeys = { publicKey: string; privateKey: string };

export type PushMessage = {
	/** Delivered to the device's service worker as is; encrypted on the way, so the push service never reads it. */
	payload: string;
	/** How long the push service keeps it for a device that is offline. */
	ttlSeconds: number;
	/** `high` wakes a sleeping phone at once. */
	urgency: 'high' | 'normal';
	/** A message waiting with the same topic is replaced by this one. */
	topic?: string;
};

/**
 * Delivers messages to browsers' push services (Web Push), so a phone or a
 * closed browser hears of a task without an Anton tab open.
 */
export type PushSender = {
	generateKeys(): PushKeys;
	/** `gone` when the push service says the subscription no longer exists, so it can be forgotten. */
	send(target: PushTarget, message: PushMessage, auth: { keys: PushKeys; subject: string }): Promise<{ ok: boolean; gone: boolean; status: number; detail: string }>;
};

/** Your own OAuth client at a vendor, made in its console: a self-hosted Anton has no verified app of its own. */
export type OAuthClient = { clientId: string; clientSecret: string };

/**
 * An account the agent's tools reach (Google), signed in to with the vendor's
 * OAuth flow on your own client. The credential is the same shape a plan's is.
 */
export type AccountSignIn = {
	/** `google`: how settings and routes name it. */
	readonly id: string;
	readonly name: string;
	/** A sign-in for `scopes` that returns to `redirectUri`, Anton's own callback; `complete` takes that address with its query. */
	startLogin(client: OAuthClient, scopes: string[], redirectUri: string, hint?: string | null): SubscriptionLogin;
	/** Renews the access token; a refresh token the vendor does not rotate is kept. */
	refresh(client: OAuthClient, credential: SubscriptionCredential, signal?: AbortSignal): Promise<SubscriptionCredential>;
	/** Tells the vendor to forget the sign-in, so Anton no longer appears among the account's connected apps. */
	revoke(credential: SubscriptionCredential): Promise<void>;
};

/** A conversation in a mailbox as a search lists it: its first message's subject, the latest sender and date. */
export type MailThreadSummary = { id: string; subject: string; from: string; date: string; snippet: string; messages: number; unread: boolean; labels: string[] };

export type MailAttachment = { name: string; mimeType: string; size: number };

export type MailMessage = {
	id: string;
	from: string;
	to: string;
	cc: string;
	date: string;
	subject: string;
	/** The text of the message, from its plain part or else its HTML. */
	body: string;
	attachments: MailAttachment[];
};

export type MailThread = { id: string; subject: string; messages: MailMessage[] };

/** A message to write as a draft; with `threadId` it replies in that conversation, to its latest message. */
export type MailDraftInput = { to: string[]; cc: string[]; bcc: string[]; subject: string; body: string; threadId: string | null };

export type MailDraft = MailDraftInput & { id: string; messageId: string };

/** A mailbox the agent reads and writes drafts in (Gmail), with an access token from its account's sign-in. */
export type Mailbox = {
	/** `gmail` */
	readonly id: string;
	readonly name: string;
	/** The sign-in it uses: an `AccountSignIn`'s id. */
	readonly account: string;
	/** Scopes to read, and to write drafts and send them. */
	readonly scopes: { read: string[]; draft: string[] };
	/** Conversations matching the mailbox's own search syntax, newest first. */
	search(token: string, query: string, max: number, signal?: AbortSignal): Promise<MailThreadSummary[]>;
	thread(token: string, id: string, signal?: AbortSignal): Promise<MailThread>;
	/** Writes a draft, or rewrites the draft `draftId`. */
	saveDraft(token: string, draft: MailDraftInput, draftId: string | null, signal?: AbortSignal): Promise<MailDraft>;
	draft(token: string, id: string, signal?: AbortSignal): Promise<MailDraft>;
	/** Sends a draft as it stands. */
	sendDraft(token: string, id: string, signal?: AbortSignal): Promise<{ id: string; threadId: string }>;
};

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
	openPty(size: { cols: number; rows: number; cwd: string }): Promise<Pty>;
};

/** How a machine came to be: decides how much setup the workspace still needs. */
export type MachineOrigin = 'live' | 'resumed' | 'image' | 'base';

export type AcquireRequest = {
	/** Stable task key; providers use it to find a running machine. */
	key: string;
	/** The provider's own state from the last acquire, or null. */
	state: string | null;
	/** A prepared image to start from when there is nothing to resume. */
	image: string | null;
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

export type StoredObject = { key: string; size: number };

export type ObjectStore = {
	readonly name: string;
	put(key: string, body: Uint8Array | string, contentType?: string): Promise<void>;
	get(key: string): Promise<Uint8Array | null>;
	has(key: string): Promise<boolean>;
	list(prefix: string): Promise<StoredObject[]>;
};

export type RepoInfo = { fullName: string; defaultBranch: string; private: boolean };

export type PullRequestInput = {
	repo: string;
	head: string;
	base: string;
	title: string;
	body: string;
};

export type GitHost = {
	readonly name: string;
	getRepo(fullName: string): Promise<RepoInfo>;
	listBranches(fullName: string): Promise<string[]>;
	resolveRef(fullName: string, ref: string): Promise<string>;
	/** Every file path in the tree at a commit. */
	tree(fullName: string, sha: string): Promise<string[]>;
	file(fullName: string, sha: string, path: string): Promise<Uint8Array>;
	cloneUrl(fullName: string): string;
	/** Environment that authenticates git commands Anton runs itself. Never given to the agent. */
	gitAuthEnv(): Record<string, string>;
	openPullRequest(input: PullRequestInput): Promise<string>;
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
	/** US dollars per million tokens. */
	price: { input: number; output: number };
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

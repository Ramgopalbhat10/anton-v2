import type { PullRequestState, Reasoning } from './ports.ts';
import type { ModelRoute } from './model-route.ts';
import type { ThreadState } from './thread-state.ts';

export type Project = {
	id: string;
	repoFullName: string;
	defaultBranch: string;
	warmImage: string | null;
	warmedAt: string | null;
	/** One note per line. */
	memory: string;
} & ProjectSettings;

/** `auth` is sent as a Bearer token; `codeMode: false` keeps its tools in the agent's tool list rather than only in run_script. */
export type McpServer = { name: string; url: string; auth: string | null; tools: string[]; codeMode?: boolean };

export const HELPER_AGENTS = ['explorer', 'tester', 'browser', 'computer', 'reviewer'] as const;
export type HelperAgent = (typeof HELPER_AGENTS)[number];
export type AgentModel = { model: string; reasoning: Reasoning | null };

export type InstalledMcpServer = McpServer & { enabled: boolean; addedAt: string };

/** Changing the base image retires the warm image. */
export type ProjectSettings = {
	env: Record<string, string>;
	/** Runs after dependencies install, before the agent starts. */
	setupScript: string;
	/** Run after the agent changes files; the agent hears of it only when it fails. It should not change tracked files. */
	checkCommand: string;
	previewPorts: number[];
	baseImage: string | null;
	fullVm: boolean;
	followUps: boolean;
	reviewOthers: boolean;
};

export type SessionStatus = 'starting' | 'running' | 'stopped' | 'error';

export type Session = {
	id: string;
	/** Null for a chat. */
	projectId: string | null;
	repo: string;
	title: string;
	model: string;
	reasoning: Reasoning | null;
	route: ModelRoute | null;
	branch: string;
	baseBranch: string;
	baseSha: string;
	/** Changes measures unpushed work from it; null before the first push. */
	pushedSha: string | null;
	status: SessionStatus;
	working: boolean;
	/** Until then it reads the repo without a sandbox, clone or branch. */
	workspace: boolean;
	/** Null only from older servers. */
	threadState: ThreadState | null;
	planMode: boolean;
	prUrl: string | null;
	errorMessage: string | null;
	checkpointAt: string | null;
	createdAt: string;
	pinnedAt: string | null;
	pullRequest: PullRequestStatus | null;
	/** Cost in US dollars. */
	usage: Usage;
	/** Null on tasks from before it was kept. */
	lastInput: string | null;
	lastInputAt: string | null;
	asking: string | null;
	plan: string | null;
	spaceId: string | null;
	resolvedAt: string | null;
	/** While the thread waits for a free slot; null once it has started. */
	brief: string | null;
	lastReply: string | null;
	review: ReviewOf | null;
	automationId: string | null;
	/** `host` is a folder on the server Anton runs on. */
	runOn: RunOn;
};

export type RunOn = 'sandbox' | 'host';

/** `trusted`: its author can push to the repo. `reviewedHead`: the head its last review read; `automatic`: started by the repo's review setting. */
export type ReviewOf = { number: number; author: string; trusted: boolean; reviewedHead: string | null; automatic: boolean };

export type PullRequestStatus = {
	state: PullRequestState;
	checks: 'passed' | 'failed' | 'pending' | null;
	/** Missing on statuses read before this was kept. */
	approved?: boolean;
	conflicts?: boolean;
	runs: Array<{ name: string; status: 'pending' | 'passed' | 'failed'; url: string }>;
};

/** `inputTokens` counts cached tokens too; `cachedTokens` is the part read from the provider's cache. */
export type Usage = { inputTokens: number; outputTokens: number; cost: number; cachedTokens?: number };

export type SessionRecord = Omit<Session, 'status' | 'working' | 'workspace' | 'threadState'> & {
	reportedState: string | null;
	failed: boolean;
	machineState: string | null;
	followState: string | null;
	/** Created before setup wrote a marker, so a machine without one may still be set up. */
	legacySetup: boolean;
};

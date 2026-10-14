import type { PullRequestState, Reasoning } from './ports.ts';
import type { ThreadState } from './thread-state.ts';

export type Project = {
	id: string;
	repoFullName: string;
	defaultBranch: string;
	/** Image with the repo cloned and dependencies installed, if one was built. */
	warmImage: string | null;
	warmedAt: string | null;
	/** Notes about the repo every task's agent reads: one per line, added by the agent or written by the user. */
	memory: string;
} & ProjectSettings;

/** A remote MCP server whose tools the agent gets; `auth` is sent as a Bearer token. */
/** A remote MCP server; `codeMode: false` keeps its tools in the agent's tool list rather than only in run_script programs. */
export type McpServer = { name: string; url: string; auth: string | null; tools: string[]; codeMode?: boolean };

/** How a repo's tasks are set up. Changing the base image retires the warm image. */
export type ProjectSettings = {
	/** Variables every command in the repo's tasks sees: the agent's, the terminal's and setup's. */
	env: Record<string, string>;
	/** Runs in the repo after dependencies install, before the agent starts. */
	setupScript: string;
	/** Ports a dev server can listen on to get a preview URL. */
	previewPorts: number[];
	/** Container image to start from instead of the default, such as `python:3.12`. */
	baseImage: string | null;
	/** Sandboxes run as full VMs with their own kernel, for Docker, FUSE and the like, where the provider has them. */
	fullVm: boolean;
	/** The agent fixes failed checks, merge conflicts and review comments on its pull requests by itself. */
	followUps: boolean;
	/** Anton reviews the pull requests people open on the repo, and again after their pushes. */
	reviewOthers: boolean;
	mcpServers: McpServer[];
};

/** What the machine is doing right now, from the sandbox provider. */
export type SessionStatus = 'starting' | 'running' | 'stopped' | 'error';

export type Session = {
	id: string;
	/** The repository the task works on; null for a chat, which has no repository. */
	projectId: string | null;
	/** `owner/name` of the project's repository; empty for a chat. */
	repo: string;
	title: string;
	model: string;
	/** Chosen reasoning level; null runs the model's default. */
	reasoning: Reasoning | null;
	/** The branch the task works on, created from `baseSha`. */
	branch: string;
	baseBranch: string;
	baseSha: string;
	status: SessionStatus;
	/** The agent is working on a message right now. */
	working: boolean;
	/** The task has had a machine; until then it reads the repo without a sandbox, clone or branch. */
	workspace: boolean;
	/** Where a project's thread stands (src/core/thread-state.ts); null for a task outside a project. */
	threadState: ThreadState | null;
	/** The agent investigates and proposes a plan, changing nothing until the plan is approved. */
	planMode: boolean;
	prUrl: string | null;
	errorMessage: string | null;
	checkpointAt: string | null;
	createdAt: string;
	/** When the task was pinned to the top of the sidebar; null when it is not. */
	pinnedAt: string | null;
	/** Its pull request as last read from the git host; null before one is opened or read. */
	pullRequest: PullRequestStatus | null;
	/** Model tokens and cost (US dollars) across every finished response. */
	usage: Usage;
	/** The latest message the task was given, by you or by Anton (a follow-up, an automation); null before Anton kept it. */
	lastInput: string | null;
	lastInputAt: string | null;
	/** What the agent's last reply asks the user, until they send a message; null when it waits on nothing. */
	asking: string | null;
	/** The plan the agent's last reply proposed in plan mode, waiting for your approval; null when none waits. */
	plan: string | null;
	/** The project the task is a thread of; null for a task of its own. */
	spaceId: string | null;
	/** When the thread was marked done, by you or Anton; null while it is open. */
	resolvedAt: string | null;
	/** The coordinator's brief while the thread waits for a free slot; null once it has started. */
	brief: string | null;
	/** The start of the thread's latest reply, for its card and the coordinator. */
	lastReply: string | null;
	/** Someone else's pull request (`prUrl`) this task reviews; null for a task that does its own work. */
	review: ReviewOf | null;
};

/**
 * A pull request a task reviews. `trusted`: its author can push to the repo. `reviewedHead`: the head
 * its last review read; `automatic`: Anton started it for the repo's Review every pull request setting.
 */
export type ReviewOf = { number: number; author: string; trusted: boolean; reviewedHead: string | null; automatic: boolean };

/**
 * A pull request's state and its checks on the head commit: in a word (null when it has none or is
 * finished), and each one that ran, for the sidebar's CI card.
 */
export type PullRequestStatus = {
	state: PullRequestState;
	checks: 'passed' | 'failed' | 'pending' | null;
	/** A reviewer approved it and none asks for changes; missing on statuses read before this was kept. */
	approved?: boolean;
	/** It cannot merge into its base until its conflicts are resolved. */
	conflicts?: boolean;
	runs: Array<{ name: string; status: 'pending' | 'passed' | 'failed'; url: string }>;
};

/** `inputTokens` counts every input token, cached ones too; `cachedTokens` is the part read from the provider's cache, which is priced lower. */
export type Usage = { inputTokens: number; outputTokens: number; cost: number; cachedTokens?: number };

/** A stored session row, before the live status is joined in. */
export type SessionRecord = Omit<Session, 'status' | 'working' | 'workspace' | 'threadState'> & {
	/** The thread state the coordinator was last told about. */
	reportedState: string | null;
	failed: boolean;
	machineState: string | null;
	/** What follow-ups on the task's pull request have already handled, as JSON. */
	followState: string | null;
	/** Created before setup wrote a marker, so a machine without one may still be set up. */
	legacySetup: boolean;
};

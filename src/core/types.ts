import type { PullRequestState, Reasoning } from './ports.ts';

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
export type McpServer = { name: string; url: string; auth: string | null; tools: string[] };

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
	/** The agent fixes failed checks and answers review comments on its pull requests by itself. */
	followUps: boolean;
	mcpServers: McpServer[];
};

/** What the machine is doing right now, from the sandbox provider. */
export type SessionStatus = 'starting' | 'running' | 'stopped' | 'error';

export type Session = {
	id: string;
	projectId: string;
	/** `owner/name` of the project's repository. */
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
};

/**
 * A pull request's state and its checks on the head commit: in a word (null when it has none or is
 * finished), and each one that ran, for the sidebar's CI card.
 */
export type PullRequestStatus = {
	state: PullRequestState;
	checks: 'passed' | 'failed' | 'pending' | null;
	runs: Array<{ name: string; status: 'pending' | 'passed' | 'failed'; url: string }>;
};

/** `inputTokens` counts every input token, cached ones too; `cachedTokens` is the part read from the provider's cache, which is priced lower. */
export type Usage = { inputTokens: number; outputTokens: number; cost: number; cachedTokens?: number };

/** A stored session row, before the live status is joined in. */
export type SessionRecord = Omit<Session, 'status' | 'working' | 'workspace'> & {
	failed: boolean;
	machineState: string | null;
	/** What follow-ups on the task's pull request have already handled, as JSON. */
	followState: string | null;
	/** Created before setup wrote a marker, so a machine without one may still be set up. */
	legacySetup: boolean;
};

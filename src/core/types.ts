import type { Reasoning } from './ports.ts';

export type Project = {
	id: string;
	repoFullName: string;
	defaultBranch: string;
	/** Image with the repo cloned and dependencies installed, if one was built. */
	warmImage: string | null;
	warmedAt: string | null;
} & ProjectSettings;

/** How a repo's tasks are set up. Changing any of it retires the warm image. */
export type ProjectSettings = {
	/** Variables every command in the repo's tasks sees: the agent's, the terminal's and setup's. */
	env: Record<string, string>;
	/** Runs in the repo after dependencies install, before the agent starts. */
	setupScript: string;
	/** Ports a dev server can listen on to get a preview URL. */
	previewPorts: number[];
	/** Container image to start from instead of the default, such as `python:3.12`. */
	baseImage: string | null;
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
	prUrl: string | null;
	errorMessage: string | null;
	checkpointAt: string | null;
	createdAt: string;
};

/** A stored session row, before the live status is joined in. */
export type SessionRecord = Omit<Session, 'status' | 'working'> & {
	failed: boolean;
	machineState: string | null;
};

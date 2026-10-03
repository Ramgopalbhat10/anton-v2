import type { Reasoning } from './ports.ts';

export type Project = {
	id: string;
	repoFullName: string;
	defaultBranch: string;
	/** Image with the repo cloned and dependencies installed, if one was built. */
	warmImage: string | null;
	warmedAt: string | null;
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
	/** Created before setup wrote a marker, so a machine without one may still be set up. */
	legacySetup: boolean;
};

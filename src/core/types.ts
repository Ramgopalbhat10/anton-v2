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
	title: string;
	model: string;
	/** The branch the task works on, created from `baseSha`. */
	branch: string;
	baseBranch: string;
	baseSha: string;
	status: SessionStatus;
	prUrl: string | null;
	errorMessage: string | null;
	checkpointAt: string | null;
	createdAt: string;
};

/** A stored session row, before the live status is joined in. */
export type SessionRecord = Omit<Session, 'status'> & {
	failed: boolean;
	machineState: string | null;
};

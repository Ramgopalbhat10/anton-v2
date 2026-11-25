export type AgentNow = {
	/** writing: the model is still writing a tool call's input; finishing: the model is done and the reply wraps up; stopping: Stop was pressed and the reply has not settled yet. */
	what: 'thinking' | 'writing' | 'running' | 'replying' | 'compacting' | 'finishing' | 'stopping';
	tool: string | null;
	detail: string | null;
	/** While writing: the input received so far, in characters. */
	chars: number;
	since: string;
	/** Set while the Reviewer reads the task's pull request, which keeps the thread working after its reply has ended. */
	by?: 'reviewer';
};

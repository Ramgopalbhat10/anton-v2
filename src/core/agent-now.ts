/**
 * What a task's agent is doing this moment, for the line at the foot of its
 * thread (src/services/agent-now.ts keeps it from the runtime's live events).
 */
export type AgentNow = {
	/**
	 * thinking: a model call with nothing out yet; writing: the model is still
	 * writing a tool call's input, such as a whole file; running: a tool runs;
	 * replying: the reply's text streams; compacting: the conversation is being
	 * summarised; finishing: the model is done and the reply is wrapping up.
	 */
	what: 'thinking' | 'writing' | 'running' | 'replying' | 'compacting' | 'finishing';
	/** The tool being written or run. */
	tool: string | null;
	/** A few words on what it is for: the file being written, the command, the subagent. */
	detail: string | null;
	/** While writing: how much of the tool call's input has come so far, in characters. */
	chars: number;
	/** When this began. */
	since: string;
};

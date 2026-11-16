export type AgentNow = {
	/** writing: the model is still writing a tool call's input; finishing: the model is done and the reply wraps up. */
	what: 'thinking' | 'writing' | 'running' | 'replying' | 'compacting' | 'finishing';
	tool: string | null;
	detail: string | null;
	/** While writing: the input received so far, in characters. */
	chars: number;
	since: string;
};

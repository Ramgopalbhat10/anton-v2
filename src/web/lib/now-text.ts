import type { AgentNow } from '@/lib/api';

/** Images an image model made: drawn in the reply where they were made, so they are not repeated among its files. */
export const IMAGE_TOOL = 'generate_image';

/** The last part of a path, for a line that names a file. */
const baseName = (path: string) => path.split('/').filter(Boolean).pop() ?? path;

/** Size of what the model has written so far, as a file would be measured. */
function written(chars: number): string {
	return chars < 1024 ? `${chars} B` : `${(chars / 1024).toFixed(chars < 10 * 1024 ? 1 : 0)} KB`;
}

/** Where the reply stands, for the line when Anton has not heard what the agent does: not begun, being written, or written and wrapping up. */
export type ReplyPhase = 'starting' | 'replying' | 'finishing';

/** What the agent is doing this moment, in a few words. */
export function nowText(now: AgentNow | null, phase: ReplyPhase): string {
	if (!now) return phase === 'replying' ? 'Working' : phase === 'finishing' ? 'Wrapping up' : 'Preparing the response';
	const file = now.detail ? baseName(now.detail) : null;
	const agent = now.detail ? `the ${now.detail} agent` : 'a subagent';
	switch (now.what) {
		case 'thinking':
			return 'Thinking';
		case 'replying':
			return 'Writing the reply';
		case 'compacting':
			return 'Compacting the conversation';
		case 'finishing':
			return 'Wrapping up';
		case 'writing': {
			const size = now.chars >= 200 ? ` · ${written(now.chars)}` : '';
			if (now.tool === 'write' && file) return `Writing ${file}${size}`;
			if (now.tool === 'edit' && file) return `Editing ${file}${size}`;
			if (now.tool === 'bash') return 'Writing a command';
			if (now.tool === 'run_script') return `Writing a script${size}`;
			if (now.tool === 'task') return `Briefing ${agent}`;
			if (now.tool === 'update_todos') return 'Updating the todo list';
			if (now.tool === 'render_html') return `Drawing a page${size}`;
			if (now.tool === 'show') return 'Drawing a card';
			if (now.tool === IMAGE_TOOL) return 'Describing an image';
			return `Preparing ${now.tool ?? 'a step'}`;
		}
		case 'running':
			if (now.tool === 'task') return `Waiting on ${agent}`;
			if ((now.tool === 'write' || now.tool === 'edit') && file) return `Saving ${file}`;
			if (now.tool === 'read' && file) return `Reading ${file}`;
			if (now.tool === 'bash') return 'Running a command';
			if (now.tool === 'start_workspace') return 'Starting the sandbox';
			if (now.tool === IMAGE_TOOL) return 'Making an image';
			return `Running ${now.tool ?? 'a step'}`;
	}
}


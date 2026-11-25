import type { AgentNow } from '@/lib/api/sessions';

/** Images an image model made: drawn in the reply where they were made, so they are not repeated among its files. */
export const IMAGE_TOOL = 'generate_image';

const baseName = (path: string) => path.split('/').filter(Boolean).pop() ?? path;

function written(chars: number): string {
	return chars < 1024 ? `${chars} B` : `${(chars / 1024).toFixed(chars < 10 * 1024 ? 1 : 0)} KB`;
}

/** Where the reply stands, for the line when Anton has not heard what the agent does: not begun, being written, or written and wrapping up. */
export type ReplyPhase = 'starting' | 'replying' | 'finishing';

const REVIEWING = 'Reviewing the pull request';

/** The Reviewer's step under its own heading: it runs after the reply has ended, so its steps are never the coding agent's. */
function reviewText(now: AgentNow): string {
	if (now.what === 'finishing' || now.what === 'replying') return REVIEWING;
	if (now.tool === 'post_review') return `${REVIEWING} · ${now.what === 'writing' ? 'Writing the review' : 'Posting the review'}`;
	return `${REVIEWING} · ${stepText(now)}`;
}

export function nowText(now: AgentNow | null, phase: ReplyPhase): string {
	if (now?.by === 'reviewer') return reviewText(now);
	if (!now) return phase === 'replying' ? 'Working' : phase === 'finishing' ? 'Wrapping up' : 'Preparing the response';
	return stepText(now);
}

function stepText(now: AgentNow): string {
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
		case 'stopping':
			return 'Stopping';
		case 'writing': {
			const size = now.chars >= 200 ? ` · ${written(now.chars)}` : '';
			if (now.tool === 'write' && file) return `Writing ${file}${size}`;
			if ((now.tool === 'edit' || now.tool === 'apply_patch') && file) return `Editing ${file}${size}`;
			if (now.tool === 'apply_patch') return `Writing a patch${size}`;
			if (now.tool === 'bash' || now.tool === 'run_in_background') return 'Writing a command';
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
			if ((now.tool === 'write' || now.tool === 'edit' || now.tool === 'apply_patch') && file) return `Saving ${file}`;
			if (now.tool === 'apply_patch') return 'Applying a patch';
			if ((now.tool === 'read' || now.tool === 'read_file') && file) return `Reading ${file}`;
			if (now.tool === 'grep' || now.tool === 'search_code') return 'Searching the code';
			if (now.tool === 'glob' || now.tool === 'list_files') return 'Listing files';
			if (now.tool === 'bash') return 'Running a command';
			if (now.tool === 'run_in_background') return 'Starting a background job';
			if (now.tool === 'check_job') return 'Checking a background job';
			if (now.tool === 'start_workspace') return 'Starting the sandbox';
			if (now.tool === IMAGE_TOOL) return 'Making an image';
			return `Running ${now.tool ?? 'a step'}`;
	}
}

/** What the page shows the moment Stop is pressed, until the server says the same or that the reply has settled. */
export function stoppingNow(): AgentNow {
	return { what: 'stopping', tool: null, detail: null, chars: 0, since: new Date().toISOString() };
}

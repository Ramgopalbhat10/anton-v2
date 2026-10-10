import type { LucideIcon } from 'lucide-react';
import { Bot, Braces, Camera, FilePlus, FileText, FolderSearch, GitPullRequest, Globe, Pencil, Search, SquareTerminal, Wrench } from 'lucide-react';
import type { ReactNode } from 'react';

/*
 * Each tool call as a short sentence with an icon, the same in the thread and
 * in a subagent's transcript in the Agents panel.
 */

/** A tool call as both places know it: what was called, with what, and how it went. */
export type ToolCall = { toolName: string; input: unknown; state?: string; output?: unknown };

export function field(input: unknown, key: string): string {
	if (input && typeof input === 'object' && key in input) {
		const value = (input as Record<string, unknown>)[key];
		return typeof value === 'string' ? value : value == null ? '' : String(value);
	}
	return '';
}

/** The tool returns `{ url }`; the runtime may wrap it as `{ output: { url } }`. */
function pullRequestUrl(output: unknown): string {
	const record = output && typeof output === 'object' ? (output as Record<string, unknown>) : {};
	return field(record, 'url') || field(record.output, 'url');
}

/** One browser step as a sentence: what was done, and to what. */
function browserStep(input: unknown) {
	const target = <Em>{field(input, 'target')}</Em>;
	switch (field(input, 'action')) {
		case 'open':
			return (
				<>
					Opened <Em>{field(input, 'url')}</Em>
				</>
			);
		case 'click':
			return <>Clicked {target}</>;
		case 'type':
			return (
				<>
					Typed <Em>{field(input, 'text')}</Em> into {target}
				</>
			);
		case 'select':
			return (
				<>
					Chose <Em>{field(input, 'text')}</Em> in {target}
				</>
			);
		case 'press':
			return (
				<>
					Pressed <Em>{field(input, 'key')}</Em>
				</>
			);
		case 'hover':
			return <>Hovered over {target}</>;
		case 'scroll':
			return <>Scrolled the page</>;
		case 'back':
			return <>Went back</>;
		case 'wait':
			return <>Waited{field(input, 'target') ? <> for {target}</> : null}</>;
		default:
			return <>Looked at the page</>;
	}
}

function lineCount(text: string) {
	return text ? text.split('\n').length : 0;
}

export function Em({ children }: { children: ReactNode }) {
	return <span className="text-(--text-secondary)">{children}</span>;
}

export function describeTool(part: ToolCall): { icon: LucideIcon; body: ReactNode } {
	const input = part.input;
	switch (part.toolName) {
		case 'read': {
			const offset = Number(field(input, 'offset')) || 0;
			const limit = Number(field(input, 'limit')) || 0;
			const range = limit ? `:${offset || 1}-${(offset || 1) + limit - 1}` : '';
			return {
				icon: FileText,
				body: (
					<>
						Read <Em>{field(input, 'path') + range}</Em>
					</>
				),
			};
		}
		case 'grep':
			return {
				icon: Search,
				body: (
					<>
						Searched <Em>{field(input, 'pattern')}</Em>
					</>
				),
			};
		case 'glob':
			return {
				icon: FolderSearch,
				body: (
					<>
						Listed <Em>{field(input, 'pattern')}</Em>
					</>
				),
			};
		case 'edit': {
			const added = lineCount(field(input, 'newText'));
			const removed = lineCount(field(input, 'oldText'));
			return {
				icon: Pencil,
				body: (
					<>
						Edited <Em>{field(input, 'path')}</Em> <span className="text-(--success-text)">+{added}</span>{' '}
						<span className="text-(--danger-text)">-{removed}</span>
					</>
				),
			};
		}
		case 'write':
			return {
				icon: FilePlus,
				body: (
					<>
						Wrote <Em>{field(input, 'path')}</Em> <span className="text-(--success-text)">+{lineCount(field(input, 'content'))}</span>
					</>
				),
			};
		case 'bash':
			return {
				icon: SquareTerminal,
				body: (
					<>
						Ran <Em>{field(input, 'command').split('\n')[0]}</Em>
					</>
				),
			};
		case 'run_script':
			return { icon: Braces, body: <>Ran a script</> };
		case 'task':
			return {
				icon: Bot,
				body: (
					<>
						Delegated to <Em>{field(input, 'agent') || 'a subagent'}</Em>
						{field(input, 'description') ? ` — ${field(input, 'description')}` : ''}
					</>
				),
			};
		case 'open_pull_request': {
			const url = pullRequestUrl(part.state === 'output-available' ? part.output : undefined);
			return {
				icon: GitPullRequest,
				body: url ? (
					<>
						Opened{' '}
						<a href={url} target="_blank" rel="noreferrer" className="text-(--accent-text) underline underline-offset-2">
							{url.replace(/^https:\/\/github\.com\//, '')}
						</a>
					</>
				) : (
					<>Opening a pull request</>
				),
			};
		}
		case 'screenshot':
			return {
				icon: Camera,
				body: (
					<>
						Took a screenshot of <Em>{field(input, 'url')}</Em>
					</>
				),
			};
		case 'browser':
			return { icon: Globe, body: browserStep(input) };
		default:
			return {
				icon: Wrench,
				body: (
					<>
						Called <Em>{part.toolName}</Em>
					</>
				),
			};
	}
}

/** What kind of work a tool call was, as a colour: commands cyan, edits violet, the browser amber, failures red. */
export function toolTone(toolName: string, failed: boolean): string {
	if (failed) return 'var(--danger-base)';
	switch (toolName) {
		case 'bash':
		case 'run_script':
			return 'var(--data-1)';
		case 'edit':
		case 'write':
			return 'var(--data-2)';
		case 'screenshot':
		case 'browser':
			return 'var(--data-3)';
		case 'open_pull_request':
			return 'var(--data-4)';
		case 'task':
			return 'var(--data-5)';
		default:
			return 'var(--neutral-500)';
	}
}

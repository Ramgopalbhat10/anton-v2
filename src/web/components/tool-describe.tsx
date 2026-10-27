import type { LucideIcon } from 'lucide-react';
import { AppWindow, Bot, Braces, Camera, FilePlus, FileText, FolderSearch, GitPullRequest, Globe, ImagePlus, LayoutPanelTop, MessageCircleQuestion, Monitor, Pencil, Plug, Search, SquareTerminal, Wrench, Zap } from 'lucide-react';
import type { ReactNode } from 'react';
import { GMAIL, MCP } from '@/components/brand-marks';

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

/** A step on the sandbox's desktop, named by what it acted on. */
function computerStep(input: unknown) {
	const target = field(input, 'target') ? <Em>{field(input, 'target')}</Em> : <>a point on the screen</>;
	switch (field(input, 'action')) {
		case 'click':
			return <>Clicked {target}</>;
		case 'double_click':
			return <>Double-clicked {target}</>;
		case 'right_click':
			return <>Right-clicked {target}</>;
		case 'move':
			return <>Pointed at {target}</>;
		case 'drag':
			return (
				<>
					Dragged {target}
					{field(input, 'to') ? (
						<>
							{' '}
							to <Em>{field(input, 'to')}</Em>
						</>
					) : null}
				</>
			);
		case 'type':
			return (
				<>
					Typed <Em>{field(input, 'text')}</Em>
				</>
			);
		case 'key':
			return (
				<>
					Pressed <Em>{field(input, 'keys')}</Em>
				</>
			);
		case 'scroll':
			return <>Scrolled {field(input, 'direction') || 'down'}</>;
		case 'wait':
			return <>Waited for the screen</>;
		case 'open':
			return (
				<>
					Opened <Em>{field(input, 'url')}</Em> on the computer
				</>
			);
		case 'launch':
			return (
				<>
					Started <Em>{field(input, 'command')}</Em> on the computer
				</>
			);
		default:
			return <>Looked at the screen</>;
	}
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
		case 'do':
			return (
				<>
					Drove the page to <Em>{field(input, 'goal')}</Em>
				</>
			);
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
		case 'read':
		case 'read_file': {
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
		case 'search_code':
			return {
				icon: Search,
				body: (
					<>
						Searched <Em>{field(input, 'pattern')}</Em>
					</>
				),
			};
		case 'glob':
		case 'list_files':
			return {
				icon: FolderSearch,
				body: (
					<>
						Listed <Em>{field(input, 'pattern') || field(input, 'glob') || field(input, 'path') || 'the repository'}</Em>
					</>
				),
			};
		case 'edit': {
			// One call can make several edits (`more`), in other files too.
			const more = input && typeof input === 'object' && Array.isArray((input as { more?: unknown }).more) ? (input as { more: unknown[] }).more : [];
			const edits = [input, ...more];
			const added = edits.reduce<number>((sum, next) => sum + lineCount(field(next, 'newText')), 0);
			const removed = edits.reduce<number>((sum, next) => sum + lineCount(field(next, 'oldText')), 0);
			const others = new Set(more.map((next) => field(next, 'path')).filter((path) => path && path !== field(input, 'path'))).size;
			return {
				icon: Pencil,
				body: (
					<>
						Edited <Em>{field(input, 'path')}</Em>
						{others ? ` and ${others} more file${others === 1 ? '' : 's'}` : ''} <span className="text-(--success-text)">+{added}</span>{' '}
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
			// A step the decision model drove reads as one quick move, not a single click.
			return { icon: field(input, 'action') === 'do' ? Zap : Globe, body: browserStep(input) };
		case 'computer':
			return { icon: Monitor, body: computerStep(input) };
		case 'ask':
			return {
				icon: MessageCircleQuestion,
				body: (
					<>
						Asked <Em>{field(input, 'question')}</Em>
					</>
				),
			};
		case 'show':
			return {
				icon: LayoutPanelTop,
				body: field(input, 'title') ? (
					<>
						Showed <Em>{field(input, 'title')}</Em>
					</>
				) : (
					<>Showed a card</>
				),
			};
		case 'generate_image':
			return {
				icon: ImagePlus,
				body: (
					<>
						{field(input, 'from') ? 'Changed an image' : 'Made an image'}: <Em>{field(input, 'prompt')}</Em>
					</>
				),
			};
		case 'render_html':
			return {
				icon: AppWindow,
				body: (
					<>
						Drew the page <Em>{field(input, 'title')}</Em>
					</>
				),
			};
		case 'connector_tools':
			return {
				icon: Plug,
				body: field(input, 'query') ? (
					<>
						Looked up connector tools for <Em>{field(input, 'query')}</Em>
					</>
				) : (
					<>Looked up connector tools</>
				),
			};
		case 'gmail_search':
			return {
				icon: GMAIL.icon,
				body: field(input, 'query') ? (
					<>
						Searched Gmail for <Em>{field(input, 'query')}</Em>
					</>
				) : (
					<>Listed the newest mail</>
				),
			};
		case 'gmail_read_thread':
			return { icon: GMAIL.icon, body: <>Read an email conversation</> };
		case 'gmail_draft':
			return {
				icon: GMAIL.icon,
				body: (
					<>
						{field(input, 'draft_id') ? 'Rewrote' : 'Drafted'} <Em>{field(input, 'subject') || 'a reply'}</Em>
					</>
				),
			};
		case 'gmail_send':
			return { icon: GMAIL.icon, body: <>Asked to send an email</> };
		default:
			if (part.toolName.startsWith('mcp__')) {
				// A server's tool given to the agent directly; the thread draws it with the server's own mark.
				return {
					icon: MCP.icon,
					body: (
						<>
							Called <Em>{part.toolName.replace(/^mcp__/, '').replace('__', ' · ')}</Em>
						</>
					),
				};
			}
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
		case 'computer':
			return 'var(--data-3)';
		case 'open_pull_request':
			return 'var(--data-4)';
		case 'task':
			return 'var(--data-5)';
		default:
			return 'var(--neutral-500)';
	}
}

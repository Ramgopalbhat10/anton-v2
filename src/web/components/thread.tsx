import type { FlueConversationMessage, FlueConversationPart, UseFlueAgentResult } from '@flue/react';
import { useQuery } from '@tanstack/react-query';
import type { LucideIcon } from 'lucide-react';
import {
	Bot,
	Camera,
	ChevronDown,
	ChevronRight,
	CircleAlert,
	FilePlus,
	FileText,
	FolderSearch,
	GitPullRequest,
	Pencil,
	Search,
	SquareTerminal,
	Wrench,
	Zap,
} from 'lucide-react';
import { createContext, Fragment, type ReactNode, useContext, useEffect, useRef, useState } from 'react';
import { Composer } from '@/components/composer';
import { Markdown } from '@/components/markdown';
import { EmptyState, Icon, Spinner } from '@/components/signal';
import { api, outputUrl } from '@/lib/api';
import { elapsed } from '@/lib/format';
import { takePendingPrompt } from '@/lib/pending-prompt';

type ToolPart = Extract<FlueConversationPart, { type: 'dynamic-tool' }>;
type ReasoningPart = Extract<FlueConversationPart, { type: 'reasoning' }>;
type Step = ToolPart | ReasoningPart;
type Block = { kind: 'text'; text: string } | { kind: 'steps'; steps: Step[] };

function field(input: unknown, key: string): string {
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

/** The task whose thread is showing, for links into its Library. */
const SessionId = createContext('');

/** The screenshot tool returns a path relative to the repo; the Library lists it relative to outputs. */
function screenshotPath(part: ToolPart): string {
	if (part.state !== 'output-available') return '';
	const record = part.output && typeof part.output === 'object' ? (part.output as Record<string, unknown>) : {};
	return (field(record, 'path') || field(record.output, 'path')).replace(/^\.\.\/outputs\//, '');
}

function lineCount(text: string) {
	return text ? text.split('\n').length : 0;
}

/** Plain text from a tool result, whichever shape the tool returned. */
function outputText(output: unknown): string {
	if (typeof output === 'string') return output;
	if (!output || typeof output !== 'object') return '';
	const record = output as Record<string, unknown>;
	if (typeof record.output === 'string') return record.output;
	if (Array.isArray(record.content)) {
		return record.content
			.map((item) => (item && typeof item === 'object' && 'text' in item ? String((item as { text: unknown }).text) : ''))
			.join('\n');
	}
	return '';
}

function Em({ children }: { children: ReactNode }) {
	return <span className="text-(--text-secondary)">{children}</span>;
}

function describeTool(part: ToolPart): { icon: LucideIcon; body: ReactNode } {
	const input = part.input;
	switch (part.toolName) {
		case 'read': {
			const offset = Number(field(input, 'offset')) || 0;
			const limit = Number(field(input, 'limit')) || 0;
			const range = limit ? `:${offset || 1}-${(offset || 1) + limit - 1}` : '';
			return { icon: FileText, body: <>Read <Em>{field(input, 'path') + range}</Em></> };
		}
		case 'grep':
			return { icon: Search, body: <>Searched <Em>{field(input, 'pattern')}</Em></> };
		case 'glob':
			return { icon: FolderSearch, body: <>Listed <Em>{field(input, 'pattern')}</Em></> };
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
			return { icon: SquareTerminal, body: <>Ran <Em>{field(input, 'command').split('\n')[0]}</Em></> };
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
			return { icon: Camera, body: <>Took a screenshot of <Em>{field(input, 'url')}</Em></> };
		default:
			return { icon: Wrench, body: <>Called <Em>{part.toolName}</Em></> };
	}
}

function toBlocks(parts: FlueConversationPart[]): Block[] {
	const blocks: Block[] = [];
	for (const part of parts) {
		if (part.type === 'text') {
			if (part.text.trim()) blocks.push({ kind: 'text', text: part.text });
		} else if (part.type === 'reasoning' || part.type === 'dynamic-tool') {
			const last = blocks[blocks.length - 1];
			if (last?.kind === 'steps') last.steps.push(part);
			else blocks.push({ kind: 'steps', steps: [part] });
		}
	}
	return blocks;
}

function ThoughtRow({ part }: { part: ReasoningPart }) {
	const [open, setOpen] = useState(false);
	const words = part.text.trim().split(/\s+/).filter(Boolean).length;
	return (
		<>
			<button
				type="button"
				onClick={() => setOpen((current) => !current)}
				className="flex h-6 min-w-0 items-center gap-2 px-1 text-left"
			>
				<Icon icon={open ? ChevronDown : ChevronRight} size={12} className="text-(--icon-tertiary)" />
				<span className="text-[12px] whitespace-nowrap text-(--text-tertiary)">
					{part.state === 'streaming' ? 'Thinking…' : `Thought${words ? ` · ${words} words` : ''}`}
				</span>
			</button>
			{open && part.text.trim() ? (
				<div className="mx-1 mt-0.5 mb-1.5 ml-6 text-[12px] leading-[18px] whitespace-pre-wrap text-pretty text-(--text-tertiary)">
					{part.text.trim()}
				</div>
			) : null}
		</>
	);
}

function ToolRow({ part }: { part: ToolPart }) {
	const { icon, body } = describeTool(part);
	const failed = part.state === 'output-error';
	const output = part.toolName === 'bash' && part.state === 'output-available' ? outputText(part.output).trimEnd() : '';
	const command = field(part.input, 'command');
	const sessionId = useContext(SessionId);
	const image = part.toolName === 'screenshot' ? screenshotPath(part) : '';
	return (
		<>
			<div className="flex h-6 min-w-0 items-center gap-2 px-1 text-[12px] text-(--text-tertiary)">
				{part.state === 'input-available' ? (
					<Spinner size={12} />
				) : (
					<Icon icon={failed ? CircleAlert : icon} size={12} className={failed ? 'text-(--danger-text)' : 'text-(--icon-tertiary)'} />
				)}
				<span className="truncate">{body}</span>
			</div>
			{failed ? <div className="mx-1 mb-1 ml-6 text-[12px] leading-[18px] text-(--danger-text)">{part.errorText}</div> : null}
			{image ? (
				<a href={outputUrl(sessionId, image)} target="_blank" rel="noreferrer" className="mx-1 mb-1 ml-6 block w-fit">
					<img src={outputUrl(sessionId, image)} alt={image} className="block max-h-48 max-w-full rounded-md border border-(--border-subtle)" />
				</a>
			) : null}
			{output ? (
				<div className="px-1 pt-1 pb-0.5">
					<div className="max-h-56 overflow-auto rounded-md bg-(--bg-inset) px-3 py-2.5 font-mono text-[12px] leading-[18px] whitespace-pre text-(--text-secondary)">
						{`$ ${command}\n${output.split('\n').slice(-40).join('\n')}`}
					</div>
				</div>
			) : null}
		</>
	);
}

function StepsCard({ steps, live }: { steps: Step[]; live: boolean }) {
	const [open, setOpen] = useState(true);
	const tools = steps.filter((step): step is ToolPart => step.type === 'dynamic-tool');
	const duration = tools.reduce((sum, step) => sum + (step.durationMs ?? 0), 0);
	const label = live ? 'Working' : duration > 0 ? `Worked for ${elapsed(duration)}` : 'Worked';
	return (
		<div className="overflow-hidden rounded-lg bg-(--bg-surface)">
			<button
				type="button"
				onClick={() => setOpen((current) => !current)}
				className="flex h-[34px] w-full items-center gap-1.5 pr-3 pl-2 text-left hover:bg-(--bg-hover)"
			>
				<Icon icon={open ? ChevronDown : ChevronRight} className="text-(--icon-tertiary)" />
				<div className="min-w-0 flex-auto truncate text-[12px] text-(--text-secondary)">{label}</div>
				<div className="shrink-0 text-[11px] tracking-[0.04em] whitespace-nowrap text-(--text-disabled)">
					{steps.length} {steps.length === 1 ? 'STEP' : 'STEPS'}
				</div>
			</button>
			{open ? (
				<div className="flex flex-col gap-px px-2 pt-0.5 pb-2">
					{steps.map((step, index) =>
						step.type === 'reasoning' ? (
							<ThoughtRow key={index} part={step} />
						) : (
							<ToolRow key={step.toolCallId} part={step} />
						),
					)}
				</div>
			) : null}
		</div>
	);
}

function UserMessage({ message, meta }: { message: FlueConversationMessage; meta: string[] }) {
	const text = message.parts.map((part) => (part.type === 'text' ? part.text : '')).join('');
	return (
		<div className="flex flex-col items-end gap-1.5">
			<div className="max-w-[520px] rounded-[12px_12px_4px_12px] bg-(--bg-overlay) px-3.5 py-2.5 text-[13px] leading-[19px] whitespace-pre-wrap text-pretty">
				{text}
			</div>
			<div className="flex items-center gap-1.5 text-[11px] tracking-[0.04em] text-(--text-disabled) uppercase">
				{meta.map((item, index) => (
					<Fragment key={item + index}>
						{index > 0 ? <span>·</span> : null}
						<span>{item}</span>
					</Fragment>
				))}
			</div>
		</div>
	);
}

function AssistantMessage({ message, live }: { message: FlueConversationMessage; live: boolean }) {
	const blocks = toBlocks(message.parts);
	if (blocks.length === 0 && !live) return null;
	return (
		<div className="flex flex-col gap-3">
			<div className="flex items-center gap-2">
				<Icon icon={Zap} size={12} className="text-(--accent-text)" />
				<div className="text-[12px] font-medium text-(--text-secondary)">Anton</div>
			</div>
			{blocks.map((block, index) =>
				block.kind === 'text' ? (
					<Markdown key={index} text={block.text} />
				) : (
					<StepsCard key={index} steps={block.steps} live={live && index === blocks.length - 1} />
				),
			)}
		</div>
	);
}

function Notice({ children }: { children: ReactNode }) {
	return (
		<div className="flex items-start gap-2 rounded-lg border border-(--danger-border) bg-(--danger-bg) px-3 py-2 text-[12px] leading-[18px] text-(--danger-text)">
			<Icon icon={CircleAlert} size={12} className="mt-[3px]" />
			<div className="min-w-0 flex-1 break-words">{children}</div>
		</div>
	);
}

function SettlementNotice({ message }: { message: FlueConversationMessage }) {
	const text = message.parts.map((part) => (part.type === 'text' ? part.text : '')).join('').trim();
	const verb = message.settlement?.outcome === 'aborted' ? 'was stopped' : 'failed';
	return <Notice>{text || `The agent turn ${verb}. Send the message again to retry.`}</Notice>;
}

export function Thread({ sessionId, agent }: { sessionId: string; agent: UseFlueAgentResult }) {
	const health = useQuery({ queryKey: ['health'], queryFn: api.health });
	const session = useQuery({ queryKey: ['session', sessionId], queryFn: () => api.session(sessionId) });
	const scroller = useRef<HTMLDivElement>(null);
	const busy = agent.status === 'submitted' || agent.status === 'streaming';
	const messages = agent.messages.filter(
		(message) => message.settlement || (message.display === 'visible' && message.role !== 'system'),
	);
	const meta = session.data ? [session.data.repo, session.data.branch] : [];
	const lastAssistant = [...messages].reverse().find((message) => message.role === 'assistant');

	useEffect(() => {
		if (!agent.historyReady) return;
		const prompt = takePendingPrompt(sessionId);
		if (prompt) void agent.sendMessage(prompt);
	}, [agent.historyReady, agent.sendMessage, sessionId]);

	useEffect(() => {
		const el = scroller.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [agent.messages]);

	return (
		<SessionId.Provider value={sessionId}>
			<div className="flex min-h-0 min-w-0 flex-1 flex-col">
				<div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-4 pt-2 pb-1">
					<div className="mx-auto flex max-w-[700px] flex-col gap-5">
						{health.data && !health.data.openRouter ? (
							<div className="rounded-lg border border-(--warning-border) bg-(--warning-bg) px-3 py-2 text-[12px] leading-[18px] text-(--warning-text)">
								Set OPENROUTER_API_KEY to run the coding agent. Changes, Files, Library and Terminal still work.
							</div>
						) : null}
						{messages.length === 0 && !busy ? (
							<EmptyState
								icon={Zap}
								title="Workspace is ready"
								body="Describe the outcome you want. Anton works in the sandbox on the right and shows every step here."
								className="mt-[12vh]"
							/>
						) : null}
						{messages.map((message) =>
							message.settlement ? (
								<SettlementNotice key={message.id} message={message} />
							) : message.role === 'user' ? (
								<UserMessage key={message.id} message={message} meta={meta} />
							) : (
								<AssistantMessage key={message.id} message={message} live={busy && message === lastAssistant} />
							),
						)}
						{busy && messages[messages.length - 1]?.role !== 'assistant' ? (
							<div className="flex items-center gap-2 text-[12px] text-(--text-secondary)">
								<Spinner size={12} />
								<span>Starting the agent</span>
							</div>
						) : null}
						{agent.status === 'error' && !messages.some((message) => message.settlement) ? (
							<Notice>
								The agent turn failed{agent.error?.message ? `: ${agent.error.message}` : ''}. Check OPENROUTER_API_KEY or send the message again.
							</Notice>
						) : null}
					</div>
				</div>
				<Composer busy={busy} onSend={(text) => agent.sendMessage(text)} onStop={() => api.stopAgent(sessionId)} sessionId={sessionId} />
			</div>
		</SessionId.Provider>
	);
}

import type { FlueConversationMessage, FlueConversationPart, UseFlueAgentResult } from '@flue/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, ChevronDown, ChevronRight, CircleAlert, CircleStop, CornerDownRight, ListChecks } from 'lucide-react';
import { createContext, Fragment, memo, type ReactNode, useCallback, useContext, useDeferredValue, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Disclosure } from '@/components/disclosure';
import { describeTool, field, toolTone } from '@/components/tool-describe';
import { toolServerMark, useBrands, useMcpServers } from '@/components/brand-marks';
import { AgentsCard, delegationOf, lookOf, useStopRun, useSubagentRuns } from '@/components/subagents';
import { Composer } from '@/components/composer';
import { FileLinks, Markdown, OutputLinks } from '@/components/markdown';
import { OutputCards } from '@/components/output-viewer';
import { AskCard, ChangesCard, PullRequestCard, type ReplyPlace, ReplyActions } from '@/components/reply-cards';
import { ShowCard } from '@/components/show-card';
import { approvalOf, MailSendCard, MAIL_SEND_TOOLS } from '@/components/mail-card';
import { HtmlFrame } from '@/components/html-frame';
import { Logo, SandboxArt } from '@/components/illustrations';
import { Btn, EmptyState, Icon, IconBtn, Spinner } from '@/components/signal';
import { type AgentNow, api, branchLabel, isChat, type Join, outputUrl, type ScriptCall, type Session, type Usage, type UsagePart } from '@/lib/api';
import { deliveredImages, type ImageAttachment } from '@/lib/attachments';
import { SentAttachments } from '@/components/attachments';
import { splitAttachments } from '../../core/attachments';
import { dollars, elapsed, tokens } from '@/lib/format';
import { addToComposer } from '@/lib/composer-inbox';
import { takePendingPrompt } from '@/lib/pending-prompt';
import { cn } from '@/lib/utils';
import { focusFile, ShowPanel } from '@/lib/workspace';
import { openViewer, type ViewerItem } from '@/lib/viewer';
import { messageText, placeJoined, type ThreadRow } from '@/lib/joined';
import { IMAGE_TOOL, nowText, type ReplyPhase } from '@/lib/now-text';
import { outputLinkPath, outputLinksIn } from '../../core/outputs';

type ToolPart = Extract<FlueConversationPart, { type: 'dynamic-tool' }>;
type ReasoningPart = Extract<FlueConversationPart, { type: 'reasoning' }>;
type Step = ToolPart | ReasoningPart;
type Block =
	| { kind: 'text'; text: string }
	| { kind: 'steps'; steps: Step[] }
	| { kind: 'plan'; part: ToolPart }
	| { kind: 'agents'; calls: ToolPart[] }
	| { kind: 'ask'; part: ToolPart }
	| { kind: 'show'; part: ToolPart }
	| { kind: 'page'; part: ToolPart }
	| { kind: 'image'; part: ToolPart }
	| { kind: 'mail'; part: ToolPart };

const PLAN_TOOL = 'propose_plan';
/** The todo list shows as the pill above the composer, not as steps in the thread. */
const TODO_TOOL = 'update_todos';
const APPROVED = 'Your plan is approved. Go ahead and build it.';
/** Tools whose calls draw in the reply itself rather than as a step; one that failed stays a step, with its error. */
const DRAWN: Record<string, 'ask' | 'show' | 'page' | 'image'> = { ask: 'ask', show: 'show', render_html: 'page', [IMAGE_TOOL]: 'image' };

/** The Library path of an image generate_image made, and the model that drew it, from the tool's result. */
function madeImageOf(part: ToolPart): { path: string; model: string } | null {
	if (part.state !== 'output-available') return null;
	const record = part.output && typeof part.output === 'object' ? (part.output as Record<string, unknown>) : {};
	const output = record.output && typeof record.output === 'object' ? (record.output as Record<string, unknown>) : record;
	const path = field(output, 'path');
	return path ? { path, model: field(output, 'model') } : null;
}

/** What a page from render_html says it is, from the tool's result. */
function pageOf(part: ToolPart): { path: string; title: string; height: number } | null {
	if (part.state !== 'output-available') return null;
	const record = part.output && typeof part.output === 'object' ? (part.output as Record<string, unknown>) : {};
	const output = record.output && typeof record.output === 'object' ? (record.output as Record<string, unknown>) : record;
	const path = field(output, 'path');
	return path ? { path, title: field(output, 'title') || 'Page', height: Number(field(output, 'height')) || 360 } : null;
}

/** Whether a reply ends waiting on approval of a plan it proposed. */
function proposesPlan(message: FlueConversationMessage | undefined): boolean {
	return Boolean(
		message?.role === 'assistant' &&
			message.parts.some((part) => part.type === 'dynamic-tool' && part.toolName === PLAN_TOOL && part.state === 'output-available' && field(part.input, 'plan')),
	);
}

/** Files a reply wrote or edited, in the order it first touched them. */
function changedPaths(parts: FlueConversationPart[]): string[] {
	const paths: string[] = [];
	for (const part of parts) {
		if (part.type !== 'dynamic-tool' || part.state !== 'output-available' || (part.toolName !== 'edit' && part.toolName !== 'write')) continue;
		const path = field(part.input, 'path').replace(/^\.\//, '');
		if (path && !paths.includes(path)) paths.push(path);
	}
	return paths;
}

/** The pull request a reply opened, with its title. */
function openedPullRequest(parts: FlueConversationPart[]): { url: string; title: string } | null {
	for (const part of [...parts].reverse()) {
		if (part.type !== 'dynamic-tool' || part.toolName !== 'open_pull_request' || part.state !== 'output-available') continue;
		const record = part.output && typeof part.output === 'object' ? (part.output as Record<string, unknown>) : {};
		const url = field(record, 'url') || field(record.output, 'url');
		if (url) return { url, title: field(part.input, 'title') };
	}
	return null;
}

/** The task whose thread is showing, for links into its Library. */
const SessionId = createContext('');

/** The screenshot and browser tools return a path relative to the repo; the Library lists it relative to outputs. */
function screenshotPath(part: ToolPart): string {
	if (part.state !== 'output-available') return '';
	const record = part.output && typeof part.output === 'object' ? (part.output as Record<string, unknown>) : {};
	const key = part.toolName === 'browser' ? 'screenshot' : 'path';
	return (field(record, key) || field(record.output, key)).replace(/^\.\.\/outputs\//, '');
}

/**
 * The files a reply made for you, in the order it first names them: those
 * its words link to in the outputs folder, its screenshots, and files it
 * wrote there. Files you attached (uploads/) are yours, not its. A file
 * it saved along the way but did not link is shown only while the Library
 * still has it (`kept`, once known): a check screenshot it later deleted is
 * not one it made for you.
 */
function replyOutputs(parts: FlueConversationPart[], kept: Set<string> | null): string[] {
	const named: { path: string; linked: boolean }[] = [];
	const drawn = new Set(parts.flatMap((part) => (part.type === 'dynamic-tool' && part.toolName === IMAGE_TOOL ? [madeImageOf(part)?.path ?? ''] : [])));
	for (const part of parts) {
		if (part.type === 'text') for (const path of outputLinksIn(part.text)) named.push({ path, linked: true });
		if (part.type !== 'dynamic-tool' || part.state !== 'output-available') continue;
		if (part.toolName === 'screenshot' || part.toolName === 'browser') named.push({ path: screenshotPath(part), linked: false });
		if (part.toolName === 'write') named.push({ path: outputLinkPath(field(part.input, 'path')) ?? '', linked: false });
	}
	const linked = new Set(named.filter((entry) => entry.linked).map((entry) => entry.path));
	const paths: string[] = [];
	for (const { path } of named) {
		if (!path || path.startsWith('uploads/') || drawn.has(path) || paths.includes(path)) continue;
		if (linked.has(path) || !kept || kept.has(path)) paths.push(path);
	}
	return paths;
}

/** Plain text from a tool result, whichever shape the tool returned. */
function outputText(output: unknown): string {
	if (typeof output === 'string') return output;
	if (!output || typeof output !== 'object') return '';
	const record = output as Record<string, unknown>;
	if (typeof record.output === 'string') return record.output;
	if (Array.isArray(record.content)) {
		return record.content.map((item) => (item && typeof item === 'object' && 'text' in item ? String((item as { text: unknown }).text) : '')).join('\n');
	}
	return '';
}

function toBlocks(parts: FlueConversationPart[]): Block[] {
	const blocks: Block[] = [];
	for (const part of parts) {
		if (part.type === 'dynamic-tool' && part.toolName === TODO_TOOL) continue;
		if (part.type === 'text') {
			if (part.text.trim()) blocks.push({ kind: 'text', text: part.text });
		} else if (part.type === 'dynamic-tool' && part.toolName === PLAN_TOOL) {
			blocks.push({ kind: 'plan', part });
		} else if (part.type === 'dynamic-tool' && MAIL_SEND_TOOLS.has(part.toolName) && part.state !== 'output-error') {
			blocks.push({ kind: 'mail', part });
		} else if (part.type === 'dynamic-tool' && DRAWN[part.toolName] && part.state !== 'output-error') {
			blocks.push({ kind: DRAWN[part.toolName], part });
		} else if (part.type === 'dynamic-tool' && part.toolName === 'task') {
			// Work handed to subagents gets its own card, the calls of one batch together.
			const last = blocks[blocks.length - 1];
			if (last?.kind === 'agents') last.calls.push(part);
			else blocks.push({ kind: 'agents', calls: [part] });
		} else if (part.type === 'reasoning' || part.type === 'dynamic-tool') {
			const last = blocks[blocks.length - 1];
			if (last?.kind === 'steps') last.steps.push(part);
			else blocks.push({ kind: 'steps', steps: [part] });
		}
	}
	return blocks;
}

/** True when two lists hold the same items in the same order, so a list rebuilt each render can still skip one. */
function sameItems<T>(a: readonly T[], b: readonly T[]): boolean {
	return a.length === b.length && a.every((item, index) => item === b[index]);
}

/*
 * Every streamed chunk gives the reply being written a new object, and only
 * that one: the parts and messages before it keep theirs. The pieces below
 * are memoized on those objects, so a chunk re-renders the reply it lands in
 * and not the whole conversation.
 */

const ThoughtRow = memo(function ThoughtRow({ part }: { part: ReasoningPart }) {
	const [open, setOpen] = useState(false);
	const words = part.text.trim().split(/\s+/).filter(Boolean).length;
	return (
		<>
			<button type="button" onClick={() => setOpen((current) => !current)} className="flex h-6 min-w-0 items-center gap-2 px-1 text-left">
				<span className={NODE}>
					<Icon icon={open ? ChevronDown : ChevronRight} size={12} className="text-(--icon-tertiary)" />
				</span>
				<span className="text-[12px] whitespace-nowrap text-(--text-tertiary)">
					{part.state === 'streaming' ? 'Thinking…' : `Thought${words ? ` · ${words} words` : ''}`}
				</span>
			</button>
			{open && part.text.trim() ? (
				<div className="mx-1 mt-0.5 mb-1.5 ml-6 text-[12px] leading-[18px] whitespace-pre-wrap text-pretty text-(--text-tertiary)">{part.text.trim()}</div>
			) : null}
		</>
	);
});

/** The calls a run_script program made, read from Anton (the runtime only has the program and its result); live while it runs. */
function useScriptCalls(sessionId: string, toolCallId: string, enabled: boolean): ScriptCall[] {
	const { data } = useQuery({ queryKey: ['scripts', sessionId], queryFn: () => api.scripts(sessionId), enabled: enabled && Boolean(sessionId) });
	return data?.scripts[toolCallId] ?? [];
}

/** Each call of a program on its own line: the tool (an MCP server's with the server's mark), its input, and how long it took or that it failed. */
function ScriptCalls({ calls }: { calls: ScriptCall[] }) {
	const mcp = calls.some((call) => call.tool.startsWith('mcp__'));
	const servers = useMcpServers(mcp);
	const brands = useBrands(mcp);
	return (
		<ul className="flex min-w-0 flex-col gap-0.5 pt-1 pr-1 pl-6">
			{calls.map((call, index) => (
				<li key={index} className="flex min-w-0 items-center gap-1.5 font-mono text-[11.5px] leading-[18px] text-(--text-tertiary)">
					{call.state === 'running' ? (
						<Spinner size={10} />
					) : (
						<Icon
							icon={call.state === 'failed' ? CircleAlert : (toolServerMark(call.tool, servers, brands)?.icon ?? CornerDownRight)}
							size={10}
							className={call.state === 'failed' ? 'shrink-0 text-(--danger-text)' : 'shrink-0 text-(--icon-disabled)'}
						/>
					)}
					<span className={cn('shrink-0', call.state === 'failed' ? 'text-(--danger-text)' : 'text-(--text-secondary)')}>{call.tool.replace(/^mcp__/, '').replace('__', ' · ')}</span>
					<span className="min-w-0 flex-1 truncate" title={call.input}>
						{call.input}
					</span>
					{call.durationMs !== null ? (
						<span className="in-num shrink-0 text-[10.5px] text-(--text-disabled)">{call.durationMs < 1000 ? `${call.durationMs}ms` : elapsed(call.durationMs)}</span>
					) : null}
				</li>
			))}
		</ul>
	);
}

const ToolRow = memo(function ToolRow({ part }: { part: ToolPart }) {
	const described = describeTool(part);
	const { body } = described;
	// A server's tool given to the agent directly shows the server's mark.
	const mcp = part.toolName.startsWith('mcp__');
	const servers = useMcpServers(mcp);
	const brands = useBrands(mcp);
	const icon = (mcp ? toolServerMark(part.toolName, servers, brands)?.icon : null) ?? described.icon;
	const failed = part.state === 'output-error';
	const script = part.toolName === 'run_script';
	const expandable = script || part.toolName === 'bash';
	const running = part.state === 'input-available';
	const [open, setOpen] = useState(running);
	const detailsId = useId();
	useEffect(() => setOpen(running), [running]);
	const output = (part.toolName === 'bash' || script) && part.state === 'output-available' ? outputText(part.output).trimEnd() : '';
	const command = script ? field(part.input, 'code').trim() : `$ ${field(part.input, 'command')}`;
	const sessionId = useContext(SessionId);
	const calls = useScriptCalls(sessionId, part.toolCallId, script);
	const image = part.toolName === 'screenshot' || part.toolName === 'browser' ? screenshotPath(part) : '';
	const heading = (
		<>
			<span className={cn(NODE, 'relative')}>
				<span
					className={
						expandable
							? 'inline-flex transition-opacity duration-(--duration-micro) group-hover/trace:opacity-0 group-focus-visible/trace:opacity-0'
							: 'inline-flex'
					}
				>
					{running ? (
						<Spinner size={12} />
					) : (
						<Icon icon={failed ? CircleAlert : icon} size={12} className={failed ? 'text-(--danger-text)' : 'text-(--icon-tertiary)'} />
					)}
				</span>
				{expandable ? (
					<Icon
						icon={ChevronRight}
						size={12}
						className="absolute inset-0 text-(--icon-tertiary) opacity-0 transition-[opacity,transform] duration-(--duration-overlay) ease-(--ease-out) group-hover/trace:opacity-100 group-focus-visible/trace:opacity-100"
						style={{ transform: open ? 'rotate(90deg)' : 'rotate(0)' }}
					/>
				) : null}
			</span>
			<span className="min-w-0 flex-1 truncate">{body}</span>
			{script && calls.length ? (
				<span className="in-num shrink-0 text-[11px] text-(--text-disabled)">
					{calls.length} {calls.length === 1 ? 'call' : 'calls'}
				</span>
			) : null}
		</>
	);
	const details = (
		<>
			{script && calls.length ? <ScriptCalls calls={calls} /> : null}
			{failed ? <div className="mx-1 mb-1 ml-6 text-[12px] leading-[18px] text-(--danger-text)">{part.errorText}</div> : null}
			{image ? (
				<button
					type="button"
					title={`Open ${image}`}
					onClick={() => openViewer({ sessionId, path: image }, [], sessionId)}
					className="mx-1 mb-1 ml-6 block w-fit cursor-zoom-in rounded-[10px] outline-none focus-visible:shadow-(--focus-ring)"
				>
					<img src={outputUrl(sessionId, image)} alt={image} className="block max-h-48 max-w-full rounded-[10px] border border-(--card-border)" />
				</button>
			) : null}
			{output || (expandable && command) ? (
				<div className="pt-1 pr-1 pb-0.5 pl-6">
					<div className="in-well max-h-56 overflow-auto px-3 py-2.5 font-mono text-[12px] leading-[18px] whitespace-pre text-(--text-secondary)">
						{`${command}${output ? `${script ? '\n\n// Result' : ''}\n${output.split('\n').slice(-40).join('\n')}` : ''}`}
					</div>
				</div>
			) : null}
		</>
	);
	return (
		<>
			{expandable ? (
				<button
					type="button"
					aria-expanded={open}
					aria-controls={detailsId}
					onClick={() => setOpen((current) => !current)}
					className="group/trace flex h-6 min-w-0 items-center gap-2 rounded-md px-1 text-left text-[12px] text-(--text-tertiary) hover:bg-(--bg-hover) outline-none focus-visible:shadow-(--focus-ring)"
				>
					{heading}
				</button>
			) : (
				<div className="flex h-6 min-w-0 items-center gap-2 px-1 text-[12px] text-(--text-tertiary)">{heading}</div>
			)}
			{expandable ? (
				<Disclosure open={open} id={detailsId}>
					{details}
				</Disclosure>
			) : (
				details
			)}
		</>
	);
});

/** What kind of work a step was, for the strip on a steps card. */
function stepTone(step: Step): string {
	return step.type === 'reasoning' ? 'var(--neutral-600)' : toolTone(step.toolName, step.state === 'output-error');
}

/** Steps shown in a card's strip; a long turn shows its latest. */
const STRIP = 36;

/**
 * One mark per step, coloured by what it did (commands cyan, edits violet,
 * the browser amber, failures red), so a turn's shape reads before it opens.
 */
function StepStrip({ steps, live }: { steps: Step[]; live: boolean }) {
	const shown = steps.slice(-STRIP);
	return (
		<span aria-hidden className="hidden h-3.5 shrink-0 items-end gap-[2px] sm:flex">
			{shown.map((step, index) => {
				const running = live && index === shown.length - 1;
				return (
					<span
						key={index}
						className={cn('w-[3px] rounded-[1px]', running && 'in-pulse')}
						style={{ height: step.type === 'reasoning' ? 7 : 14, background: running ? 'var(--accent-base)' : stepTone(step), opacity: running ? 1 : 0.85 }}
					/>
				);
			})}
		</span>
	);
}

/** A step's mark on the card's rail: it sits over the line so the line runs between steps. */
const NODE = 'z-[1] inline-flex size-3 shrink-0 items-center justify-center rounded-full bg-(--card-bg) ring-[3px] ring-(--card-bg)';

function StepsCardView({ steps, live, duration }: { steps: Step[]; live: boolean; duration?: number }) {
	const [open, setOpen] = useState(live);
	const detailsId = useId();
	useEffect(() => setOpen(live), [live]);
	const label = live ? 'Working' : duration !== undefined && Number.isFinite(duration) && duration >= 1000 ? `Worked for ${elapsed(duration)}` : 'Worked';
	return (
		<div className="overflow-hidden rounded-[12px] border border-(--card-border) bg-(--card-bg) shadow-(--card-highlight)">
			<button
				type="button"
				aria-expanded={open}
				aria-controls={detailsId}
				onClick={() => setOpen((current) => !current)}
				className="flex h-9 w-full items-center gap-2 pr-3 pl-2.5 text-left outline-none hover:bg-(--bg-hover) focus-visible:shadow-(--focus-ring-inset)"
			>
				<Icon
					icon={ChevronRight}
					className="text-(--icon-tertiary) transition-transform duration-(--duration-overlay) ease-(--ease-out)"
					style={{ transform: open ? 'rotate(90deg)' : 'rotate(0)' }}
				/>
				<div className={cn('min-w-0 flex-auto truncate text-[12px]', live ? 'text-(--text-primary)' : 'text-(--text-secondary)')}>{label}</div>
				<StepStrip steps={steps} live={live} />
				<div className="in-caption shrink-0 whitespace-nowrap">
					{steps.length} {steps.length === 1 ? 'STEP' : 'STEPS'}
				</div>
			</button>
			<Disclosure open={open} id={detailsId}>
				<div className="relative flex flex-col gap-px border-t border-(--card-border) px-2 pt-1.5 pb-2">
					<span aria-hidden className="absolute top-4 bottom-4 left-[17.5px] w-px bg-(--border-default)" />
					{steps.map((step, index) => (step.type === 'reasoning' ? <ThoughtRow key={index} part={step} /> : <ToolRow key={step.toolCallId} part={step} />))}
				</div>
			</Disclosure>
		</div>
	);
}

/** Its steps list is rebuilt each render; the card re-renders only when a step in it changed. */
const StepsCard = memo(StepsCardView, (prev, next) => prev.live === next.live && prev.duration === next.duration && sameItems(prev.steps, next.steps));

/** A proposed plan, shown in full, and whether you approved it. */
const PlanCard = memo(function PlanCard({ part, answer }: { part: ToolPart; answer: string | null }) {
	const plan = field(part.input, 'plan');
	return (
		<div className="in-card overflow-hidden">
			<div className="flex h-10 items-center gap-2.5 border-b border-(--card-border) px-3.5">
				<span className="inline-flex size-[22px] items-center justify-center rounded-[7px] border border-dashed border-(--accent-border) text-(--accent-text)">
					<Icon icon={ListChecks} size={12} />
				</span>
				<span className="text-[13px] font-medium">Plan</span>
				<span className="in-caption ml-auto">{!plan ? 'Writing' : answer === APPROVED ? 'Approved' : 'Proposed'}</span>
			</div>
			<div className="px-4 pt-3 pb-3.5">{plan ? <Markdown text={plan} /> : <Spinner size={12} />}</div>
		</div>
	);
});

/**
 * While plan mode is on and the agent's last reply proposed a plan, approving
 * turns plan mode off first, so the agent has its full tools for the message
 * that follows. A reply with no plan (a question, plan mode just turned on)
 * has nothing to approve.
 */
function ApproveBar({ sessionId, send }: { sessionId: string; send: (text: string) => Promise<void> }) {
	const queryClient = useQueryClient();
	const [approving, setApproving] = useState(false);
	const approve = async () => {
		setApproving(true);
		try {
			const updated = await api.editSession(sessionId, { planMode: false });
			queryClient.setQueryData<Session>(['session', sessionId], updated);
			await send(APPROVED);
		} finally {
			setApproving(false);
		}
	};
	return (
		<div className="mx-auto mt-2 flex w-[calc(100%-32px)] max-w-[700px] items-center gap-2.5 rounded-full border border-(--card-border) bg-(--card-bg) py-1 pr-1 pl-3.5 shadow-(--card-highlight)">
			<span className="in-pulse size-1.5 shrink-0 rounded-full bg-(--accent-base)" />
			<span className="min-w-0 flex-1 text-[12px] text-(--text-secondary)">
				The plan is ready. Approve it to let Anton build it, or reply to change it.
			</span>
			<Btn size="sm" variant="primary" disabled={approving} onClick={() => void approve()}>
				{approving ? 'Approving…' : 'Approve and build'}
			</Btn>
		</div>
	);
}

type FilePart = Extract<FlueConversationPart, { type: 'file' }>;

/** Your message gets a new object each chunk (the client gives it back its local id), so it compares by its parts. */
const UserMessage = memo(UserMessageView, (prev, next) => prev.message.parts === next.message.parts && prev.note === next.note && sameItems(prev.meta, next.meta));

/**
 * A message sent while the agent works joins the reply in hand: the agent reads it between two
 * steps and answers within that reply. The runtime lists it after the whole reply, so it says so,
 * rather than reading as a message nobody answered.
 */
const JOINING = 'Anton reads this between its steps';
const JOINED = 'Read while Anton worked on the reply above';
/** Once Anton has noted where it read the message, the message shows there, inside the reply. */
const JOINED_HERE = 'Sent while Anton worked, read here';

function UserMessageView({ message, meta, note }: { message: FlueConversationMessage; meta: string[]; note?: string }) {
	// Attached files show as chips; the text they carry is the agent's to read.
	const { text, files } = splitAttachments(message.parts.map((part) => (part.type === 'text' ? part.text : '')).join(''));
	const images = message.parts.filter((part): part is FilePart => part.type === 'file' && part.mediaType.startsWith('image/') && Boolean(part.url));
	return (
		<div className="group/user flex flex-col items-end gap-1.5">
			{images.length > 0 ? (
				<div className="flex max-w-[520px] flex-wrap justify-end gap-1.5">
					{images.map((image, index) => (
						<a key={image.id ?? index} href={image.url} target="_blank" rel="noreferrer">
							<img src={image.url} alt={image.filename ?? 'Attached image'} className="block max-h-40 max-w-60 rounded-lg border border-(--border-subtle)" />
						</a>
					))}
				</div>
			) : null}
			<SentAttachments files={files} />
			{/* A long hash, path or URL breaks where it must, rather than widening the thread. */}
			{text ? (
				<div className="max-w-[min(520px,100%)] rounded-[14px_14px_4px_14px] border border-(--card-border) bg-(--bg-overlay) px-3.5 py-2.5 text-[13px] leading-[19px] whitespace-pre-wrap text-pretty [overflow-wrap:anywhere] shadow-(--card-highlight)">
					{text}
				</div>
			) : null}
			{note ? (
				<div className="flex items-center gap-1.5 text-[11.5px] text-(--text-tertiary)">
					<Icon icon={CornerDownRight} size={11} className="-scale-y-100" />
					{note}
				</div>
			) : null}
			{/* The same for every message, so it waits for the pointer. */}
			<div className="in-caption flex items-center gap-1.5 tracking-[0.06em] opacity-0 transition-opacity duration-(--duration-micro) group-hover/user:opacity-100">
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

/** The usage the agent attached when the response finished, if any: its subagents' calls included, split by who made them, and whether a plan paid. */
type ReplyUsageView = Usage & { parts: { main: UsagePart; subagents: UsagePart } | null; billing: 'plan' | 'api' | null };

function usageOf(message: FlueConversationMessage): ReplyUsageView | null {
	const usage = message.metadata?.usage as Usage | undefined;
	if (!usage || typeof usage.inputTokens !== 'number') return null;
	const parts = message.metadata?.usageParts as ReplyUsageView['parts'] | undefined;
	const billing = message.metadata?.billing;
	return { ...usage, parts: parts?.main ? parts : null, billing: billing === 'plan' || billing === 'api' ? billing : null };
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** The reply's tokens, every model call it made counted, and what it cost; the tooltip breaks it down. */
function ReplyUsageLine({ usage }: { usage: ReplyUsageView }) {
	const total = usage.inputTokens + usage.outputTokens;
	const lines = [`${total.toLocaleString()} tokens used by this reply: ${usage.inputTokens.toLocaleString()} in, ${usage.outputTokens.toLocaleString()} out.`];
	if (usage.cachedTokens) lines.push(`${usage.cachedTokens.toLocaleString()} of the input came from the provider's cache, which costs less.`);
	if (usage.parts) {
		const { main, subagents } = usage.parts;
		lines.push(`The agent: ${tokens(main.inputTokens + main.outputTokens)} over ${plural(main.calls, 'call')}.`);
		if (subagents.calls) lines.push(`Its subagents: ${tokens(subagents.inputTokens + subagents.outputTokens)} over ${plural(subagents.calls, 'call')}.`);
	}
	lines.push(usage.billing === 'plan' ? 'Run on your plan: no charge per token.' : `Charged: ${dollars(usage.cost)}.`);
	return (
		<div className="in-num text-[11px] text-(--text-disabled)" title={lines.join('\n')}>
			{tokens(total)} tokens · {usage.billing === 'plan' ? 'plan' : dollars(usage.cost)}
		</div>
	);
}

function CopyResponse({ text }: { text: string }) {
	const [state, setState] = useState<'ready' | 'copied' | 'failed'>('ready');
	useEffect(() => {
		if (state === 'ready') return;
		const timer = setTimeout(() => setState('ready'), 2000);
		return () => clearTimeout(timer);
	}, [state]);
	return (
		<IconBtn
			size="xs"
			icon={state === 'copied' ? Check : Copy}
			label={state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed. Try again' : 'Copy response'}
			disabled={!text}
			onClick={() => {
				void navigator.clipboard
					.writeText(text)
					.then(() => setState('copied'))
					.catch(() => setState('failed'));
			}}
		/>
	);
}

const AssistantMessage = memo(function AssistantMessage({
	message,
	live,
	last,
	answer,
	segment,
}: {
	message: FlueConversationMessage;
	live: boolean;
	last: boolean;
	/** The user's message that followed this reply, for its cards to show what was picked. */
	answer: string | null;
	/** The stretch shown, when a message sent while it worked cut the reply: the header goes on its first, the cards and usage on its last. */
	segment?: ThreadRow['segment'];
}) {
	const blocks = useMemo(() => toBlocks(segment?.parts ?? message.parts), [segment?.parts, message.parts]);
	const head = !segment || segment.first;
	const foot = !segment || segment.last;
	const place = useMemo<ReplyPlace>(() => ({ latest: last, answer }), [last, answer]);
	const changed = useMemo(() => (live ? [] : changedPaths(message.parts)), [live, message.parts]);
	const pull = useMemo(() => (live ? null : openedPullRequest(message.parts)), [live, message.parts]);
	const sessionId = useContext(SessionId);
	// The files it made show as cards once it is whole, so a half-written link never loads.
	const library = useQuery({ queryKey: ['outputs', sessionId], queryFn: () => api.outputs(sessionId), staleTime: 30_000, enabled: !live });
	const kept = useMemo(() => (library.data ? new Set(library.data.outputs.map((output) => output.path)) : null), [library.data]);
	const made = useMemo<ViewerItem[]>(() => (live ? [] : replyOutputs(message.parts, kept).map((path) => ({ sessionId, path }))), [live, message.parts, sessionId, kept]);
	const outputLinks = useMemo<OutputLinks>(
		() => ({
			resolve: (href) => {
				const path = outputLinkPath(href);
				return path ? { sessionId, path } : null;
			},
			open: (item) => openViewer(item, made, sessionId),
		}),
		[made, sessionId],
	);
	const usage = usageOf(message);
	// This is the whole response's wall time, including model thinking, not tool execution time.
	const duration = typeof message.metadata?.durationMs === 'number' ? message.metadata.durationMs : undefined;
	const firstTrace = blocks.findIndex((block) => block.kind === 'steps');
	const whole = useMemo(() => (segment ? toBlocks(message.parts) : blocks), [segment, message.parts, blocks]);
	const copyText = whole.flatMap((block) => (block.kind === 'text' ? [block.text] : block.kind === 'plan' ? [field(block.part.input, 'plan')] : copiedText(block))).join('\n\n');
	if (blocks.length === 0 && !(live && foot)) return null;
	return (
		<OutputLinks.Provider value={outputLinks}>
		<div className="group/reply flex flex-col gap-3">
			{head ? (
				<div className="flex items-center gap-2">
					<Logo size={18} />
					<div className="text-[12px] font-medium text-(--text-secondary)">Anton</div>
					{live ? <span className="in-caption text-(--accent-text)">Live</span> : null}
				</div>
			) : null}
			{blocks.map((block, index) =>
				block.kind === 'text' ? (
					<Markdown key={index} text={block.text} />
				) : block.kind === 'plan' ? (
					<PlanCard key={block.part.toolCallId} part={block.part} answer={answer} />
				) : block.kind === 'agents' ? (
					<AgentsBlock key={block.calls[0].toolCallId} sessionId={sessionId} calls={block.calls} />
				) : block.kind === 'ask' ? (
					<AskCard key={block.part.toolCallId} input={block.part.input} place={place} />
				) : block.kind === 'show' ? (
					block.part.state === 'output-available' ? (
						<ShowCard key={block.part.toolCallId} sessionId={sessionId} input={block.part.input} place={place} />
					) : (
						<Drawing key={block.part.toolCallId} what="Drawing a card" />
					)
				) : block.kind === 'mail' ? (
					approvalOf(block.part.output) ? (
						<MailSendCard key={block.part.toolCallId} sessionId={sessionId} approvalId={approvalOf(block.part.output)!} place={place} />
					) : (
						<Drawing key={block.part.toolCallId} what="Preparing the email" />
					)
				) : block.kind === 'page' ? (
					<PageBlock key={block.part.toolCallId} sessionId={sessionId} part={block.part} />
				) : block.kind === 'image' ? (
					<ImageBlock key={block.part.toolCallId} sessionId={sessionId} part={block.part} />
				) : (
					<StepsCard key={index} steps={block.steps} live={live && foot && index === blocks.length - 1} duration={head && index === firstTrace ? duration : undefined} />
				),
			)}
			{foot ? <OutputCards items={made} composer={sessionId} /> : null}
			{foot && pull ? <PullRequestCard sessionId={sessionId} url={pull.url} title={pull.title} /> : null}
			{foot && changed.length && !pull ? <ChangesCard sessionId={sessionId} paths={changed} /> : null}
			{foot && !live ? (
				// Copy and usage stay on the latest reply; earlier ones show them on hover.
				<div className={cn('flex items-center gap-1.5', !last && 'opacity-0 transition-opacity duration-(--duration-micro) group-focus-within/reply:opacity-100 group-hover/reply:opacity-100')}>
					<CopyResponse text={copyText} />
					{usage ? <ReplyUsageLine usage={usage} /> : null}
				</div>
			) : null}
		</div>
		</OutputLinks.Provider>
	);
});

/** The text a drawn block adds to Copy response: the question and its options, or what a card says. */
function copiedText(block: Block): string[] {
	if (block.kind === 'ask') {
		const options = (block.part.input as { options?: Array<{ label?: string }> } | undefined)?.options ?? [];
		return [[field(block.part.input, 'question'), ...options.map((option) => `- ${option.label ?? ''}`)].join('\n')];
	}
	if (block.kind === 'show' && block.part.state === 'output-available') {
		// The tool's result says what the card shows, between its first line and its closing advice.
		const text = typeof block.part.output === 'string' ? block.part.output : field(block.part.output, 'output');
		const parts = text.split('\n\n');
		return parts.length > 2 ? [parts.slice(1, -1).filter((part) => !part.startsWith('When the user presses')).join('\n\n')] : [];
	}
	return [];
}

/** A card or page still being drawn. */
function Drawing({ what }: { what: string }) {
	return (
		<div className="flex h-9 items-center gap-2 rounded-[12px] border border-dashed border-(--card-border) px-3 text-[12px] text-(--text-tertiary)">
			<Spinner size={12} />
			{what}
		</div>
	);
}

const PageBlock = memo(function PageBlock({ sessionId, part }: { sessionId: string; part: ToolPart }) {
	const page = pageOf(part);
	if (!page) return <Drawing what="Drawing a page" />;
	return <HtmlFrame sessionId={sessionId} path={page.path} title={page.title} height={page.height} />;
});

/** A width:height the tool was asked for, as CSS; square when it named none. */
function aspectOf(input: unknown): string {
	const [width, height] = field(input, 'aspect_ratio').split(':').map(Number);
	return width > 0 && height > 0 ? `${width} / ${height}` : '1 / 1';
}

/** A light checkerboard under an image asked for with a transparent background, so a dark mark on it still shows. */
const CHECKERBOARD = { background: 'repeating-conic-gradient(var(--neutral-200) 0% 25%, var(--neutral-50) 0% 50%) 50% / 16px 16px' };

/** An image the agent made: a frame of its shape while the model draws, then the image, which opens full size. */
const ImageBlock = memo(function ImageBlock({ sessionId, part }: { sessionId: string; part: ToolPart }) {
	const made = madeImageOf(part);
	const prompt = field(part.input, 'prompt');
	if (!made) {
		return (
			<div
				role="status"
				className="in-sweep flex h-60 max-w-full items-center justify-center gap-2 self-start rounded-[12px] border border-dashed border-(--card-border) bg-(--bg-inset) px-3 text-[12px] text-(--text-tertiary)"
				style={{ aspectRatio: aspectOf(part.input) }}
			>
				<Spinner size={12} />
				Making an image
			</div>
		);
	}
	return (
		<figure className="flex max-w-full flex-col gap-1.5 self-start">
			<button
				type="button"
				title={`Open ${made.path}`}
				onClick={() => openViewer({ sessionId, path: made.path }, [], sessionId)}
				className="block w-fit max-w-full cursor-zoom-in rounded-[12px] outline-none focus-visible:shadow-(--focus-ring)"
			>
				<img
					src={outputUrl(sessionId, made.path)}
					alt={prompt}
					className="block max-h-[420px] max-w-full rounded-[12px] border border-(--card-border) bg-(--bg-inset)"
					style={part.input && (part.input as { transparent?: unknown }).transparent === true ? CHECKERBOARD : undefined}
				/>
			</button>
			<figcaption className="max-w-[560px] truncate text-[11.5px] text-(--text-tertiary)" title={prompt}>
				{made.model ? <span className="text-(--text-secondary)">{made.model}</span> : null}
				{made.model && prompt ? ' · ' : ''}
				{prompt}
			</figcaption>
		</figure>
	);
});

/** A batch of subagent calls; its list is rebuilt each render, so it re-renders only when one of its calls changed. */
const AgentsBlock = memo(
	function AgentsBlock({ sessionId, calls }: { sessionId: string; calls: ToolPart[] }) {
		const delegations = useMemo(() => calls.map(delegationOf), [calls]);
		return <AgentsCard sessionId={sessionId} calls={delegations} />;
	},
	(prev, next) => prev.sessionId === next.sessionId && sameItems(prev.calls, next.calls),
);

function Notice({ children }: { children: ReactNode }) {
	return (
		<div className="flex items-start gap-2 rounded-[12px] border border-(--danger-border) bg-(--danger-bg) px-3 py-2 text-[12px] leading-[18px] text-(--danger-text)">
			<Icon icon={CircleAlert} size={12} className="mt-[3px]" />
			<div className="min-w-0 flex-1 break-words">{children}</div>
		</div>
	);
}

const SettlementNotice = memo(function SettlementNotice({ message }: { message: FlueConversationMessage }) {
	// Stopping is something you did, not a failure: one quiet line, however many messages it stopped.
	if (message.settlement?.outcome === 'aborted') {
		return (
			<div className="flex items-center gap-1.5 text-[12px] text-(--text-tertiary)">
				<Icon icon={CircleStop} size={12} />
				Stopped
			</div>
		);
	}
	const text = message.parts
		.map((part) => (part.type === 'text' ? part.text : ''))
		.join('')
		.trim();
	return <Notice>{text || 'The agent turn failed. Send the message again to retry.'}</Notice>;
});

/** Milliseconds since a moment, ticking each second while shown. */
function useSince(since: string | null): number {
	const [clock, setClock] = useState(() => Date.now());
	useEffect(() => {
		if (!since) return;
		setClock(Date.now());
		const timer = setInterval(() => setClock(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [since]);
	return since ? Math.max(0, clock - new Date(since).getTime()) : 0;
}

/**
 * The line at the foot of a working thread: what the agent is doing this
 * moment and for how long. The thread shows a step only once it is whole, so
 * without it a file being written or a long think reads as nothing happening.
 */
function NowLine({ sessionId, phase }: { sessionId: string; phase: ReplyPhase }) {
	const now = useQuery({ queryKey: ['now', sessionId], queryFn: () => api.now(sessionId) }).data?.now ?? null;
	const took = useSince(now?.since ?? null);
	return (
		<div className="flex min-w-0 items-center gap-2 text-[12px] text-(--text-secondary)">
			<Spinner size={12} />
			<span className="min-w-0 truncate">{nowText(now, phase)}</span>
			{now && took >= 1000 ? (
				<span className="in-num shrink-0 text-(--text-disabled)" aria-hidden>
					{elapsed(took)}
				</span>
			) : null}
		</div>
	);
}

/**
 * The foot of a working thread. A message sent while the agent works waits for
 * its next step; while a subagent runs, that step comes only when the subagent
 * finishes, so this says so and lets you stop it to have the message read now.
 * Otherwise it says what the agent is doing.
 */
function Waiting({ sessionId, queued, phase }: { sessionId: string; queued: boolean; phase: ReplyPhase }) {
	const running = (useSubagentRuns(sessionId).data?.runs ?? []).filter((run) => run.status === 'running');
	const stop = useStopRun(sessionId);
	if (!queued || !running.length) return <NowLine sessionId={sessionId} phase={phase} />;
	const names = [...new Set(running.map((run) => lookOf(run.agent).label.toLowerCase()))];
	const who = running.length === 1 ? `the ${names[0]} agent` : `${running.length} agents`;
	return (
		<div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[12px] border border-(--card-border) bg-(--card-bg) px-3 py-2 text-[12px] leading-[18px] text-(--text-secondary)">
			<Spinner size={12} />
			<span className="min-w-0 flex-1">
				Anton reads your message when {who} {running.length === 1 ? 'finishes' : 'finish'}. Stop {running.length === 1 ? 'it' : 'them'} to have it read now.
			</span>
			<Btn
				size="sm"
				disabled={stop.isPending}
				onClick={() => {
					for (const run of running) stop.mutate(run.id);
				}}
			>
				{running.length === 1 ? `Stop ${names[0]} agent` : 'Stop agents'}
			</Btn>
		</div>
	);
}

const textOf = (message: FlueConversationMessage) => messageText(message).trim();
const NO_JOINS: Join[] = [];
const rowKey = (row: ThreadRow) => row.segment?.key ?? row.message.id;

/** File references in replies link to the task's files, and open in the Files panel at their line. */
function useThreadFileLinks(sessionId: string): FileLinks {
	const showPanel = useContext(ShowPanel);
	const files = useQuery({ queryKey: ['files', sessionId], queryFn: () => api.files(sessionId), staleTime: 30_000 });
	const paths = useMemo(() => new Set(files.data?.paths ?? []), [files.data?.paths]);
	return useMemo(
		() => ({
			has: (path: string) => paths.has(path),
			open: (path: string, line?: number) => {
				focusFile(sessionId, path, line);
				showPanel('Files');
			},
		}),
		[paths, sessionId, showPanel],
	);
}

export function Thread({ sessionId, agent }: { sessionId: string; agent: UseFlueAgentResult }) {
	const health = useQuery({ queryKey: ['health'], queryFn: api.health });
	const session = useQuery({ queryKey: ['session', sessionId], queryFn: () => api.session(sessionId) });
	const scroller = useRef<HTMLDivElement>(null);
	const busy = agent.status === 'submitted' || agent.status === 'streaming';
	// Chunks can land faster than a long conversation renders; deferred, React drops the ones it falls behind on rather than blocking typing and clicks.
	const conversation = useDeferredValue(agent.messages);
	const messages = useMemo(
		() =>
			conversation
				.filter((message) => message.settlement || (message.display === 'visible' && message.role !== 'system'))
				// One Stop settles the reply and every message queued behind it; it reads as one stop.
				.filter((message, index, list) => !(message.settlement?.outcome === 'aborted' && list[index - 1]?.settlement?.outcome === 'aborted')),
		[conversation],
	);
	// A chat's messages carry no repository or branch under them.
	const repo = session.data && !isChat(session.data) ? session.data.repo : undefined;
	const branch = session.data ? branchLabel(session.data) : undefined;
	const meta = useMemo(() => (repo && branch ? [repo, branch] : []), [repo, branch]);
	const lastAssistant = messages.findLast((message) => message.role === 'assistant');
	// A finished reply carries its usage; the latest one without it is the one being written.
	const liveReply = busy && lastAssistant && !lastAssistant.metadata?.usage ? lastAssistant : undefined;
	const settlements = agent.settlements;
	const joins = useQuery({ queryKey: ['joins', sessionId], queryFn: () => api.joins(sessionId) }).data?.joins ?? NO_JOINS;
	const answeredBy = useMemo(() => new Map(settlements.map((settlement) => [settlement.submissionId, settlement.answeredBySubmissionId])), [settlements]);
	// Messages sent while Anton worked, moved into the reply where it read them.
	const rows = useMemo(() => placeJoined(messages, joins, answeredBy, liveReply), [messages, joins, answeredBy, liveReply]);
	const notes = useMemo(() => {
		const live = liveReply ? messages.indexOf(liveReply) : -1;
		const map = new Map<string, string>();
		for (const row of rows) {
			const message = row.message;
			if (message.role !== 'user') continue;
			if (row.joined) {
				map.set(message.id, JOINED_HERE);
				continue;
			}
			const index = messages.indexOf(message);
			const by = message.submissionId ? answeredBy.get(message.submissionId) : undefined;
			if (by && by !== message.submissionId) map.set(message.id, JOINED);
			else if (live !== -1 && index > live && !(message.submissionId && answeredBy.has(message.submissionId))) map.set(message.id, JOINING);
		}
		return map;
	}, [rows, messages, answeredBy, liveReply]);
	// The message after each reply, for the cards in it: an option tapped, a form sent or anything typed. A reply cut by a message read mid-way keeps its cards for its last part.
	const answers = useMemo(() => {
		const map = new Map<string, string>();
		rows.forEach((row, index) => {
			const next = rows[index + 1];
			if (row.message.role === 'assistant' && (!row.segment || row.segment.last) && next?.message.role === 'user' && !next.joined) map.set(rowKey(row), messageText(next.message));
		});
		return map;
	}, [rows]);
	const send = agent.sendMessage;
	const actions = useMemo<ReplyActions>(() => ({ send: (text: string) => void send(text), busy }), [send, busy]);
	const fileLinks = useThreadFileLinks(sessionId);
	const planned = Boolean(session.data?.planMode) && !busy && proposesPlan(messages[messages.length - 1]);

	useEffect(() => {
		if (!agent.historyReady) return;
		const pending = takePendingPrompt(sessionId);
		if (pending) void (pending.images.length ? agent.sendMessage(pending.prompt, { images: deliveredImages(pending.images) }) : agent.sendMessage(pending.prompt));
	}, [agent.historyReady, agent.sendMessage, sessionId]);

	// Kept at the bottom as the reply grows: once a frame at most, as reading the height lays the page out.
	useEffect(() => {
		const frame = requestAnimationFrame(() => {
			const el = scroller.current;
			if (el) el.scrollTop = el.scrollHeight;
		});
		return () => cancelAnimationFrame(frame);
	}, [conversation]);

	const onSend = useCallback(
		(text: string, images: ImageAttachment[]) => agent.sendMessage(text, { images: deliveredImages(images) }),
		[agent.sendMessage],
	);
	// Stop also drops messages still waiting for the agent's next step, unread; they go back to the composer.
	const waiting = useRef<{ texts: string[]; until: number } | null>(null);
	const latest = useRef(messages);
	latest.current = messages;
	const onStop = useCallback(() => {
		const shown = latest.current;
		const last = shown.findLastIndex((message) => message.role === 'assistant');
		const texts = shown.slice(last + 1).flatMap((message) => (message.role === 'user' ? [textOf(message)] : [])).filter(Boolean);
		waiting.current = texts.length ? { texts, until: Number.POSITIVE_INFINITY } : null;
		return api.stopAgent(sessionId);
	}, [sessionId]);
	useEffect(() => {
		const pending = waiting.current;
		if (!pending || busy) return;
		// Read ones stay in the thread; give the thread a few seconds to drop the unread ones.
		if (pending.until === Number.POSITIVE_INFINITY) pending.until = Date.now() + 10_000;
		const shown = new Set(messages.flatMap((message) => (message.role === 'user' ? [textOf(message)] : [])));
		const lost = pending.texts.filter((text) => !shown.has(text));
		pending.texts = pending.texts.filter((text) => shown.has(text));
		// Files they carried stay in the Library; only the typed words go back.
		for (const text of lost) {
			const typed = splitAttachments(text).text;
			if (typed) addToComposer(sessionId, { kind: 'text', text: typed });
		}
		if (!pending.texts.length || Date.now() > pending.until) waiting.current = null;
	}, [busy, messages, sessionId]);

	return (
		<SessionId.Provider value={sessionId}>
			<ReplyActions.Provider value={actions}>
			<FileLinks.Provider value={fileLinks}>
			<div className="flex min-h-0 min-w-0 flex-1 flex-col">
				<div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-4 pt-2 pb-1">
					<div className="mx-auto flex max-w-[700px] flex-col gap-5">
						{health.data && !health.data.openRouter ? (
							<div className="rounded-lg border border-(--warning-border) bg-(--warning-bg) px-3 py-2 text-[12px] leading-[18px] text-(--warning-text)">
								Add an OpenRouter key under Settings › Subscriptions to run OpenRouter models. Models on a plan, Changes, Files, Library and Terminal still work.
							</div>
						) : null}
						{messages.length === 0 && !busy ? (
							<EmptyState
								art={<SandboxArt className="w-full max-w-[300px]" label="ready" />}
								title={session.data && isChat(session.data) ? 'Ready to chat' : 'Workspace is ready'}
								body={
									session.data && isChat(session.data)
										? 'Ask anything, or describe a job on the web. Anton answers here, and starts a scratch sandbox only when it has to run something.'
										: 'Describe the outcome you want. Anton works in the sandbox on the right and shows every step here.'
								}
								className="mt-[10vh]"
							/>
						) : null}
						{rows.map((row) =>
							row.message.settlement ? (
								<SettlementNotice key={row.message.id} message={row.message} />
							) : row.message.role === 'user' ? (
								<UserMessage key={row.message.id} message={row.message} meta={meta} note={notes.get(row.message.id)} />
							) : (
								<AssistantMessage
									key={rowKey(row)}
									message={row.message}
									segment={row.segment}
									live={row.message === liveReply && (!row.segment || row.segment.last)}
									last={row.message === lastAssistant && (!row.segment || row.segment.last)}
									answer={answers.get(rowKey(row)) ?? null}
								/>
							),
						)}
						{busy ? <Waiting sessionId={sessionId} queued={rows[rows.length - 1]?.message.role === 'user' && !rows[rows.length - 1]?.joined} phase={liveReply ? 'replying' : rows[rows.length - 1]?.message.role === 'assistant' ? 'finishing' : 'starting'} /> : null}
						{agent.status === 'error' && !messages.some((message) => message.settlement) ? (
							<Notice>
								{agent.error?.message
									? `The agent turn failed: ${agent.error.message}`
									: 'The agent turn failed. Check the OpenRouter key in Settings › Subscriptions or send the message again.'}
							</Notice>
						) : null}
					</div>
				</div>
				{planned ? <ApproveBar sessionId={sessionId} send={(text) => agent.sendMessage(text)} /> : null}
				<Composer busy={busy} onSend={onSend} onStop={onStop} sessionId={sessionId} />
			</div>
			</FileLinks.Provider>
			</ReplyActions.Provider>
		</SessionId.Provider>
	);
}

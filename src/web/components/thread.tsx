import type { FlueConversationMessage, FlueConversationPart, UseFlueAgentResult } from '@flue/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, ChevronDown, ChevronRight, CircleAlert, ListChecks } from 'lucide-react';
import { createContext, Fragment, type ReactNode, useContext, useEffect, useId, useRef, useState } from 'react';
import { Disclosure } from '@/components/disclosure';
import { describeTool, field, toolTone } from '@/components/tool-describe';
import { AgentsCard, delegationOf } from '@/components/subagents';
import { Composer } from '@/components/composer';
import { Markdown } from '@/components/markdown';
import { Logo, SandboxArt } from '@/components/illustrations';
import { Btn, EmptyState, Icon, IconBtn, Spinner } from '@/components/signal';
import { api, branchLabel, outputUrl, type Session, type Usage, type UsagePart } from '@/lib/api';
import { dollars, elapsed, tokens } from '@/lib/format';
import { takePendingPrompt } from '@/lib/pending-prompt';
import { cn } from '@/lib/utils';

type ToolPart = Extract<FlueConversationPart, { type: 'dynamic-tool' }>;
type ReasoningPart = Extract<FlueConversationPart, { type: 'reasoning' }>;
type Step = ToolPart | ReasoningPart;
type Block = { kind: 'text'; text: string } | { kind: 'steps'; steps: Step[] } | { kind: 'plan'; part: ToolPart } | { kind: 'agents'; calls: ToolPart[] };

const PLAN_TOOL = 'propose_plan';
const APPROVED = 'Your plan is approved. Go ahead and build it.';

/** The task whose thread is showing, for links into its Library. */
const SessionId = createContext('');

/** The screenshot and browser tools return a path relative to the repo; the Library lists it relative to outputs. */
function screenshotPath(part: ToolPart): string {
	if (part.state !== 'output-available') return '';
	const record = part.output && typeof part.output === 'object' ? (part.output as Record<string, unknown>) : {};
	const key = part.toolName === 'browser' ? 'screenshot' : 'path';
	return (field(record, key) || field(record.output, key)).replace(/^\.\.\/outputs\//, '');
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
		if (part.type === 'text') {
			if (part.text.trim()) blocks.push({ kind: 'text', text: part.text });
		} else if (part.type === 'dynamic-tool' && part.toolName === PLAN_TOOL) {
			blocks.push({ kind: 'plan', part });
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

function ThoughtRow({ part }: { part: ReasoningPart }) {
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
}

function ToolRow({ part }: { part: ToolPart }) {
	const { icon, body } = describeTool(part);
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
		</>
	);
	const details = (
		<>
			{failed ? <div className="mx-1 mb-1 ml-6 text-[12px] leading-[18px] text-(--danger-text)">{part.errorText}</div> : null}
			{image ? (
				<a href={outputUrl(sessionId, image)} target="_blank" rel="noreferrer" className="mx-1 mb-1 ml-6 block w-fit">
					<img src={outputUrl(sessionId, image)} alt={image} className="block max-h-48 max-w-full rounded-[10px] border border-(--card-border)" />
				</a>
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
}

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

function StepsCard({ steps, live, duration }: { steps: Step[]; live: boolean; duration?: number }) {
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

/** A proposed plan, shown in full. */
function PlanCard({ part }: { part: ToolPart }) {
	const plan = field(part.input, 'plan');
	return (
		<div className="in-card overflow-hidden">
			<div className="flex h-10 items-center gap-2.5 border-b border-(--card-border) px-3.5">
				<span className="inline-flex size-[22px] items-center justify-center rounded-[7px] border border-dashed border-(--accent-border) text-(--accent-text)">
					<Icon icon={ListChecks} size={12} />
				</span>
				<span className="text-[13px] font-medium">Plan</span>
				<span className="in-caption ml-auto">{plan ? 'Proposed' : 'Writing'}</span>
			</div>
			<div className="px-4 pt-3 pb-3.5">{plan ? <Markdown text={plan} /> : <Spinner size={12} />}</div>
		</div>
	);
}

/**
 * While plan mode is on and the agent has answered, approving turns plan
 * mode off first, so the agent has its full tools for the message that follows.
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
				Plan mode is on. Approve the plan to let Anton build it, or reply to change it.
			</span>
			<Btn size="sm" variant="primary" disabled={approving} onClick={() => void approve()}>
				{approving ? 'Approving…' : 'Approve and build'}
			</Btn>
		</div>
	);
}

type FilePart = Extract<FlueConversationPart, { type: 'file' }>;

function UserMessage({ message, meta }: { message: FlueConversationMessage; meta: string[] }) {
	const text = message.parts.map((part) => (part.type === 'text' ? part.text : '')).join('');
	const images = message.parts.filter((part): part is FilePart => part.type === 'file' && part.mediaType.startsWith('image/') && Boolean(part.url));
	return (
		<div className="flex flex-col items-end gap-1.5">
			{images.length > 0 ? (
				<div className="flex max-w-[520px] flex-wrap justify-end gap-1.5">
					{images.map((image, index) => (
						<a key={image.id ?? index} href={image.url} target="_blank" rel="noreferrer">
							<img src={image.url} alt={image.filename ?? 'Attached image'} className="block max-h-40 max-w-60 rounded-lg border border-(--border-subtle)" />
						</a>
					))}
				</div>
			) : null}
			<div className="max-w-[520px] rounded-[14px_14px_4px_14px] border border-(--card-border) bg-(--bg-overlay) px-3.5 py-2.5 text-[13px] leading-[19px] whitespace-pre-wrap text-pretty shadow-(--card-highlight)">
				{text}
			</div>
			<div className="in-caption flex items-center gap-1.5 tracking-[0.06em]">
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

function AssistantMessage({ message, live }: { message: FlueConversationMessage; live: boolean }) {
	const blocks = toBlocks(message.parts);
	const sessionId = useContext(SessionId);
	const usage = usageOf(message);
	// This is the whole response's wall time, including model thinking, not tool execution time.
	const duration = typeof message.metadata?.durationMs === 'number' ? message.metadata.durationMs : undefined;
	const firstTrace = blocks.findIndex((block) => block.kind === 'steps');
	const copyText = blocks
		.flatMap((block) => (block.kind === 'text' ? [block.text] : block.kind === 'plan' ? [field(block.part.input, 'plan')] : []))
		.join('\n\n');
	if (blocks.length === 0 && !live) return null;
	return (
		<div className="flex flex-col gap-3">
			<div className="flex items-center gap-2">
				<Logo size={18} />
				<div className="text-[12px] font-medium text-(--text-secondary)">Anton</div>
				{live ? <span className="in-caption text-(--accent-text)">Live</span> : null}
			</div>
			{blocks.map((block, index) =>
				block.kind === 'text' ? (
					<Markdown key={index} text={block.text} />
				) : block.kind === 'plan' ? (
					<PlanCard key={block.part.toolCallId} part={block.part} />
				) : block.kind === 'agents' ? (
					<AgentsCard key={block.calls[0].toolCallId} sessionId={sessionId} calls={block.calls.map(delegationOf)} />
				) : (
					<StepsCard key={index} steps={block.steps} live={live && index === blocks.length - 1} duration={index === firstTrace ? duration : undefined} />
				),
			)}
			{!live ? (
				<div className="flex items-center gap-1.5">
					<CopyResponse text={copyText} />
					{usage ? <ReplyUsageLine usage={usage} /> : null}
				</div>
			) : null}
		</div>
	);
}

function Notice({ children }: { children: ReactNode }) {
	return (
		<div className="flex items-start gap-2 rounded-[12px] border border-(--danger-border) bg-(--danger-bg) px-3 py-2 text-[12px] leading-[18px] text-(--danger-text)">
			<Icon icon={CircleAlert} size={12} className="mt-[3px]" />
			<div className="min-w-0 flex-1 break-words">{children}</div>
		</div>
	);
}

function SettlementNotice({ message }: { message: FlueConversationMessage }) {
	const text = message.parts
		.map((part) => (part.type === 'text' ? part.text : ''))
		.join('')
		.trim();
	const verb = message.settlement?.outcome === 'aborted' ? 'was stopped' : 'failed';
	return <Notice>{text || `The agent turn ${verb}. Send the message again to retry.`}</Notice>;
}

export function Thread({ sessionId, agent }: { sessionId: string; agent: UseFlueAgentResult }) {
	const health = useQuery({ queryKey: ['health'], queryFn: api.health });
	const session = useQuery({ queryKey: ['session', sessionId], queryFn: () => api.session(sessionId) });
	const scroller = useRef<HTMLDivElement>(null);
	const busy = agent.status === 'submitted' || agent.status === 'streaming';
	const messages = agent.messages.filter((message) => message.settlement || (message.display === 'visible' && message.role !== 'system'));
	const meta = session.data ? [session.data.repo, branchLabel(session.data)] : [];
	const lastAssistant = [...messages].reverse().find((message) => message.role === 'assistant');
	const planned = Boolean(session.data?.planMode) && !busy && messages[messages.length - 1]?.role === 'assistant';

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
								art={<SandboxArt className="w-full max-w-[300px]" label="ready" />}
								title="Workspace is ready"
								body="Describe the outcome you want. Anton works in the sandbox on the right and shows every step here."
								className="mt-[10vh]"
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
								{agent.error?.message
									? `The agent turn failed: ${agent.error.message}`
									: 'The agent turn failed. Check OPENROUTER_API_KEY or send the message again.'}
							</Notice>
						) : null}
					</div>
				</div>
				{planned ? <ApproveBar sessionId={sessionId} send={(text) => agent.sendMessage(text)} /> : null}
				<Composer
					busy={busy}
					onSend={(text, images) =>
						agent.sendMessage(text, {
							images: images.map(({ data, mimeType, filename }) => ({ type: 'image' as const, data, mimeType, filename })),
						})
					}
					onStop={() => api.stopAgent(sessionId)}
					sessionId={sessionId}
				/>
			</div>
		</SessionId.Provider>
	);
}

import { type FlueConversationMessage, type FlueConversationPart, type UseFlueAgentResult } from '@flue/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Bookmark, Check, ChevronRight, CircleAlert, FolderGit2, ListPlus, Plus, Send, Square, Waypoints } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { ComposerInput } from '@/components/composer-input';
import { PlanToggle } from '@/components/composer';
import { Caption } from '@/components/instrument';
import { Markdown } from '@/components/markdown';
import { ModelPicker, useModels } from '@/components/model-picker';
import { ProjectArt } from '@/components/illustrations';
import { Btn, Icon, IconBtn, Kbd, Menu, MenuContent, MenuItem, MenuTrigger, PickerChip, Spinner } from '@/components/signal';
import { ThreadCard, ThreadStateIcon, useOpenThread } from '@/components/thread-card';
import { field } from '@/components/tool-describe';
import { api, type ModelChoice, SAFETY_NET_MS, type Session, type Space } from '@/lib/api';
import { expandCommand } from '@/lib/completion';
import { askToNotify } from '@/lib/notifications';
import { parseReports, type Report, STATE_LOOK } from '@/lib/spaces';
import { cn } from '@/lib/utils';

type ToolPart = Extract<FlueConversationPart, { type: 'dynamic-tool' }>;

/** Plain text from a tool result, whichever shape the runtime wrapped it in. */
function outputText(output: unknown): string {
	if (typeof output === 'string') return output;
	if (!output || typeof output !== 'object') return '';
	const record = output as Record<string, unknown>;
	if (typeof record.output === 'string') return record.output;
	if (Array.isArray(record.content)) return record.content.map((item) => (item && typeof item === 'object' && 'text' in item ? String((item as { text: unknown }).text) : '')).join('\n');
	return '';
}

const textOf = (message: FlueConversationMessage) => message.parts.map((part) => (part.type === 'text' ? part.text : '')).join('');

/** The thread a tool result names, as `[id:…]`. */
const threadIdIn = (part: ToolPart) => (part.state === 'output-available' ? (/\[id:([\w-]+)\]/.exec(outputText(part.output))?.[1] ?? null) : null);

/** A thread named by the start of its id, as reports and the coordinator name them. */
const byPrefix = (threads: Session[], id: string) => threads.find((thread) => thread.id === id || (id.length >= 6 && thread.id.startsWith(id)));

function Bubble({ text }: { text: string }) {
	return (
		<div className="flex justify-end">
			<div className="max-w-[560px] rounded-[14px_14px_4px_14px] border border-(--card-border) bg-(--bg-overlay) px-3.5 py-2.5 text-[13px] leading-[19px] whitespace-pre-wrap text-pretty shadow-(--card-highlight)">
				{text}
			</div>
		</div>
	);
}

/** Thread reports are news, not something you said: one quiet line that opens to a line per thread. */
/** What a report says happened, in a few words. */
const REPORTED: Record<Report['state'], string> = {
	waiting: 'is waiting on you',
	working: 'is working',
	queued: 'is queued',
	review: 'is ready for review',
	landing: 'was approved',
	idle: 'replied',
	resolved: 'is done',
};

function ReportRow({ reports, threads }: { reports: Report[]; threads: Session[] }) {
	const [open, setOpen] = useState(false);
	const openThread = useOpenThread();
	const needs = reports.filter((report) => report.state === 'waiting').length;
	return (
		<div className="flex flex-col gap-1">
			<button
				type="button"
				aria-expanded={open}
				onClick={() => setOpen((current) => !current)}
				className="group/report flex h-7 items-center gap-2 self-start rounded-lg pr-2 pl-1.5 text-[12px] text-(--text-tertiary) outline-none hover:bg-(--bg-hover) hover:text-(--text-secondary) focus-visible:shadow-(--focus-ring)"
			>
				<Icon icon={ChevronRight} size={12} className="text-(--icon-tertiary) transition-transform duration-(--duration-micro)" style={{ transform: open ? 'rotate(90deg)' : undefined }} />
				<span className="flex items-center gap-0.5">
					{reports.slice(0, 5).map((report, index) => (
						<span key={index} className="size-1.5 rounded-full" style={{ background: `var(--${STATE_LOOK[report.state].tone === 'neutral' ? 'neutral-500' : `${STATE_LOOK[report.state].tone}-base`})` }} />
					))}
				</span>
				<span>
					{reports.length === 1 ? `${reports[0].title} ${REPORTED[reports[0].state]}` : `${reports.length} threads reported`}
					{needs && reports.length > 1 ? <span className="text-(--warning-text)"> · {needs} need you</span> : null}
				</span>
			</button>
			{open ? (
				<div className="ml-3 flex flex-col gap-1 border-l border-(--border-subtle) py-1 pl-3">
					{reports.map((report, index) => {
						const thread = byPrefix(threads, report.id);
						return (
							<button
								key={index}
								type="button"
								disabled={!thread}
								onClick={() => thread && openThread(thread)}
								className="flex min-w-0 items-start gap-2 rounded-md px-1.5 py-1 text-left outline-none hover:bg-(--bg-hover) focus-visible:shadow-(--focus-ring)"
							>
								<span className="mt-[3px] inline-flex">{thread ? <ThreadStateIcon thread={thread} size={12} /> : null}</span>
								<span className="flex min-w-0 flex-col">
									<span className="truncate text-[12.5px] text-(--text-primary)">{report.title}</span>
									{report.text ? <span className="line-clamp-2 text-[12px] leading-[17px] text-(--text-tertiary)">{report.text}</span> : null}
								</span>
							</button>
						);
					})}
				</div>
			) : null}
		</div>
	);
}

/** A line for what the coordinator did quietly: sent a thread a note, saved to memory, added a repository. */
function ActionRow({ icon, children, failed }: { icon: typeof Send; children: ReactNode; failed?: boolean }) {
	return (
		<div className={cn('flex min-w-0 items-center gap-2 px-1 text-[12px]', failed ? 'text-(--danger-text)' : 'text-(--text-tertiary)')}>
			<Icon icon={failed ? CircleAlert : icon} size={12} className={failed ? undefined : 'text-(--icon-tertiary)'} />
			<span className="min-w-0 truncate">{children}</span>
		</div>
	);
}

type Suggestion = { title: string; brief: string; repo?: string };

/** Threads the coordinator proposes: a numbered list, Start on each, Start all below. */
function SuggestedThreads({ space, suggestions }: { space: Space; suggestions: Suggestion[] }) {
	const queryClient = useQueryClient();
	const [started, setStarted] = useState<Record<number, string>>({});
	const openThread = useOpenThread();
	const { data } = useQuery({ queryKey: ['sessions'], queryFn: api.sessions });
	const start = useMutation({
		mutationFn: async (indexes: number[]) => {
			for (const index of indexes) {
				const suggestion = suggestions[index];
				const thread = await api.startThread(space.id, { title: suggestion.title, brief: suggestion.brief, repo: suggestion.repo });
				setStarted((current) => ({ ...current, [index]: thread.id }));
			}
		},
		onSettled: () => void queryClient.invalidateQueries({ queryKey: ['sessions'] }),
	});
	const left = suggestions.map((_, index) => index).filter((index) => !started[index]);
	return (
		<section className="in-card overflow-hidden" aria-label="Suggested threads">
			<header className="flex items-center gap-2 px-3.5 pt-3 pb-2">
				<Icon icon={ListPlus} size={13} className="text-(--accent-text)" />
				<span className="flex-1 text-[13px] font-medium">Suggested threads</span>
				<Caption>{suggestions.length} proposed</Caption>
			</header>
			<ol className="m-0 flex list-none flex-col p-0">
				{suggestions.map((suggestion, index) => {
					const threadId = started[index];
					const thread = threadId ? data?.sessions.find((session) => session.id === threadId) : undefined;
					return (
						<li key={index} className="flex items-start gap-3 border-t border-(--border-subtle) px-3.5 py-2.5">
							<span className="in-num mt-px w-4 shrink-0 text-[11px] text-(--text-disabled)">{String(index + 1).padStart(2, '0')}</span>
							<div className="flex min-w-0 flex-1 flex-col gap-0.5">
								<span className="truncate text-[13px] text-(--text-primary)">{suggestion.title}</span>
								<span className="line-clamp-2 text-[12px] leading-[17px] text-(--text-tertiary)">{suggestion.brief}</span>
								{suggestion.repo ? <Caption>{suggestion.repo.split('/').pop()}</Caption> : null}
							</div>
							{thread ? (
								<Btn size="xs" variant="ghost" icon={Check} onClick={() => openThread(thread)}>
									Started
								</Btn>
							) : (
								<Btn size="xs" variant="secondary" disabled={start.isPending} onClick={() => start.mutate([index])}>
									Start
								</Btn>
							)}
						</li>
					);
				})}
			</ol>
			{left.length > 1 ? (
				<footer className="flex items-center justify-between gap-2 border-t border-(--border-subtle) px-3.5 py-2">
					<Caption>{start.isError ? <span className="text-(--danger-text)">{start.error.message}</span> : `Up to ${space.maxParallel} work at once; the rest queue`}</Caption>
					<Btn size="sm" variant="primary" disabled={start.isPending} onClick={() => start.mutate(left)}>
						Start all {left.length}
					</Btn>
				</footer>
			) : null}
		</section>
	);
}

/** One of the coordinator's tool calls, as what it did: a thread card, suggestions, or a quiet line. */
function ToolBlock({ part, space, threads }: { part: ToolPart; space: Space; threads: Session[] }) {
	const failed = part.state === 'output-error';
	const target = byPrefix(threads, field(part.input, 'thread').replace(/^\[|\]$|^id:/g, ''));
	switch (part.toolName) {
		case 'start_thread': {
			const thread = threads.find((item) => item.id === threadIdIn(part));
			if (thread) return <ThreadCard thread={thread} />;
			if (failed) return <ActionRow icon={Plus} failed>Could not start “{field(part.input, 'title')}”</ActionRow>;
			return (
				<div className="in-card flex flex-col gap-1.5 px-3.5 py-3">
					<Caption>Starting thread</Caption>
					<div className="flex items-center gap-2 text-[13.5px] font-medium">
						<Spinner size={12} />
						<span className="truncate">{field(part.input, 'title') || 'New thread'}</span>
					</div>
				</div>
			);
		}
		case 'suggest_threads': {
			const list = (part.input as { threads?: Suggestion[] } | undefined)?.threads ?? [];
			return list.length ? <SuggestedThreads space={space} suggestions={list} /> : null;
		}
		case 'message_thread':
			return (
				<ActionRow icon={Send} failed={failed}>
					Sent to <span className="text-(--text-secondary)">{target?.title ?? 'a thread'}</span>: {field(part.input, 'message')}
				</ActionRow>
			);
		case 'remember':
			return (
				<ActionRow icon={Bookmark} failed={failed}>
					Saved to memory: {field(part.input, 'note')}
				</ActionRow>
			);
		case 'resolve_thread':
			return <ActionRow icon={Check} failed={failed}>Resolved {target?.title ?? 'a thread'}</ActionRow>;
		case 'stop_thread':
			return <ActionRow icon={Square} failed={failed}>Stopped {target?.title ?? 'a thread'}</ActionRow>;
		case 'add_repo':
			return <ActionRow icon={FolderGit2} failed={failed}>Added {field(part.input, 'repo')}</ActionRow>;
		default:
			return null;
	}
}

function CoordinatorMessage({ message, live, space, threads }: { message: FlueConversationMessage; live: boolean; space: Space; threads: Session[] }) {
	const parts = message.parts.filter((part) => (part.type === 'text' && part.text.trim()) || part.type === 'dynamic-tool');
	if (parts.length === 0 && !live) return null;
	return (
		<div className="flex flex-col gap-2.5">
			{parts.map((part, index) =>
				part.type === 'text' ? (
					<div key={index} className="text-[13.5px] leading-[21px]">
						<Markdown text={part.text} />
					</div>
				) : part.type === 'dynamic-tool' ? (
					<ToolBlock key={part.toolCallId} part={part} space={space} threads={threads} />
				) : null,
			)}
			{live && parts.length === 0 ? (
				<div className="flex items-center gap-2 text-[12px] text-(--text-tertiary)">
					<Spinner size={12} />
					<span>Thinking</span>
				</div>
			) : null}
		</div>
	);
}

const STARTERS = ['What is running right now?', 'Split this into threads: ', 'Which pull requests are ready for review?'];

/** The empty project: what the coordinator does, and a few ways to begin. */
function Welcome({ space, onPick }: { space: Space; onPick: (text: string) => void }) {
	return (
		<div className="mt-[6vh] flex flex-col items-center gap-6 text-center">
			<div className="in-well in-grid flex w-full justify-center px-6 pt-8 pb-6">
				<ProjectArt className="w-full max-w-[340px]" />
			</div>
			<div className="flex max-w-[52ch] flex-col items-center gap-1.5">
				<h1 className="m-0 text-[20px] leading-[26px] font-semibold tracking-[-0.02em]">{space.name}</h1>
				<p className="m-0 text-[13px] leading-[19px] text-pretty text-(--text-tertiary)">
					{space.goal || 'Describe the work. The coordinator splits it into threads that run in parallel, each on its own branch and sandbox, and reports back here.'}
				</p>
			</div>
			<div className="flex flex-wrap justify-center gap-1.5">
				{STARTERS.map((starter) => (
					<button
						key={starter}
						type="button"
						onClick={() => onPick(starter)}
						className="h-7 rounded-full border border-(--border-subtle) bg-(--well-bg) px-3 text-[12px] text-(--text-secondary) outline-none hover:border-(--border-default) hover:text-(--text-primary) focus-visible:shadow-(--focus-ring)"
					>
						{starter.trim()}
					</button>
				))}
			</div>
		</div>
	);
}

/** Starts a thread yourself, without the coordinator: a repository, a brief, and its model. */
export function NewThreadForm({ space, onDone }: { space: Space; onDone: () => void }) {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const models = useModels();
	const [brief, setBrief] = useState('');
	const [repoId, setRepoId] = useState(space.repos[0]?.id ?? '');
	const [choice, setChoice] = useState<Partial<ModelChoice>>({});
	const [planMode, setPlanMode] = useState(false);
	const repo = space.repos.find((item) => item.id === repoId) ?? space.repos[0];
	const model = choice.model ?? space.threadModel ?? models.data?.default ?? '';
	const start = useMutation({
		mutationFn: () =>
			api.startThread(space.id, {
				brief,
				projectId: repo?.id,
				model: choice.model ?? undefined,
				reasoning: choice.reasoning ?? undefined,
				planMode,
			}),
		onSuccess: (thread) => {
			void queryClient.invalidateQueries({ queryKey: ['sessions'] });
			onDone();
			void navigate({ to: '/projects/$spaceId/threads/$threadId', params: { spaceId: space.id, threadId: thread.id } });
		},
	});
	return (
		<form
			className="in-card relative mx-auto flex w-full max-w-[700px] flex-col focus-within:border-(--border-strong)"
			onSubmit={(event) => {
				event.preventDefault();
				if (brief.trim() && repo) start.mutate();
			}}
		>
			<div className="flex items-center gap-2 px-3.5 pt-3">
				<Caption className="flex-1">New thread in {space.name}</Caption>
				<button type="button" onClick={onDone} className="text-[12px] text-(--text-tertiary) hover:text-(--text-primary)">
					Cancel
				</button>
			</div>
			<ComposerInput
				autoFocus
				value={brief}
				onChange={setBrief}
				projectId={repo?.id}
				submitOn="mod-enter"
				placeholder="What should this thread do? It works on its own branch and reports back to the coordinator."
				className="min-h-[72px] px-3.5 pt-2 text-[13.5px] leading-[20px]"
			/>
			<div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-(--border-subtle) px-3 py-2">
				<Menu>
					<MenuTrigger asChild>
						<PickerChip icon={FolderGit2} label={repo ? repo.repoFullName.split('/').pop()! : 'Repository'} height={26} />
					</MenuTrigger>
					<MenuContent align="start" className="min-w-[220px]">
						{space.repos.map((item) => (
							<MenuItem key={item.id} checked={item.id === repo?.id} onSelect={() => setRepoId(item.id)}>
								{item.repoFullName}
							</MenuItem>
						))}
					</MenuContent>
				</Menu>
				<ModelPicker value={{ model, reasoning: choice.reasoning ?? null }} onChange={(change) => setChoice((current) => ({ ...current, ...change }))} side="bottom" />
				<PlanToggle on={planMode} onChange={setPlanMode} />
				<div className="min-w-0 flex-1" />
				{start.isError ? <span className="text-[12px] text-(--danger-text)">{start.error.message}</span> : null}
				<Btn type="submit" size="sm" variant="primary" icon={Waypoints} disabled={!brief.trim() || !repo || start.isPending}>
					{start.isPending ? 'Starting…' : 'Start thread'}
				</Btn>
			</div>
		</form>
	);
}

/** The coordinator's message box: what you type goes to the coordinator, which answers or starts threads. */
function CoordinatorComposer({ space, agent, draft, onDraft, onNewThread }: { space: Space; agent: UseFlueAgentResult; draft: string; onDraft: (text: string) => void; onNewThread: () => void }) {
	const queryClient = useQueryClient();
	const models = useModels();
	const busy = agent.status === 'submitted' || agent.status === 'streaming';
	const budget = useQuery({ queryKey: ['budget'], queryFn: () => api.budget(), refetchInterval: SAFETY_NET_MS });
	const blocked = budget.data?.blocked ?? null;
	const [notice, setNotice] = useState<string | null>(null);
	const choice = { model: space.coordinatorModel ?? models.data?.default ?? '', reasoning: space.coordinatorReasoning ?? 'low' };
	const edit = useMutation({
		mutationFn: (change: Partial<ModelChoice>) =>
			api.editSpace(space.id, {
				...(change.model !== undefined ? { coordinatorModel: change.model, coordinatorReasoning: null } : {}),
				...(change.reasoning !== undefined ? { coordinatorReasoning: change.reasoning } : {}),
			}),
		onSuccess: (updated) => queryClient.setQueryData(['space', space.id], updated),
	});
	const paused = space.state !== 'active';
	return (
		<form
			className="shrink-0 px-4 pt-1 pb-4"
			onSubmit={async (event) => {
				event.preventDefault();
				const text = draft.trim();
				if (!text || blocked) return;
				askToNotify();
				onDraft('');
				setNotice(null);
				try {
					const saved = await queryClient.fetchQuery({ queryKey: ['commands'], queryFn: api.commands, staleTime: 60_000 });
					await agent.sendMessage(expandCommand(text, saved.commands, true));
				} catch (error) {
					onDraft(text);
					setNotice(`Not sent: ${error instanceof Error ? error.message : String(error)}`);
				}
			}}
		>
			<div className="in-card relative mx-auto flex max-w-[700px] flex-col gap-2 px-3 pt-3 pb-2 focus-within:border-(--border-strong)">
				<ComposerInput
					value={draft}
					onChange={onDraft}
					placeholder={busy ? 'Add to what the coordinator is doing' : `Tell the coordinator what ${space.name} needs`}
				/>
				{blocked || notice || paused ? (
					<div className={cn('text-[12px]', blocked || notice ? 'text-(--danger-text)' : 'text-(--warning-text)')}>
						{blocked ?? notice ?? `The project is ${space.state}: new threads wait as queued until it is active again.`}
					</div>
				) : null}
				<div className="flex flex-nowrap items-center gap-1.5">
					<IconBtn icon={Plus} size="sm" label="Start a thread yourself" onClick={onNewThread} />
					<ModelPicker value={choice} onChange={(change) => edit.mutate(change)} />
					<span className="hidden text-[11px] text-(--text-disabled) sm:inline">coordinator</span>
					<div className="flex min-w-0 flex-[1_1_8px] items-center justify-end gap-1.5 overflow-hidden text-[11px] whitespace-nowrap text-(--text-disabled) max-sm:invisible">
						<span className="truncate">{busy ? 'Send to the coordinator' : 'Send'}</span>
						<Kbd keys="enter" size="sm" />
					</div>
					{busy ? <IconBtn icon={Square} size="sm" variant="secondary" label="Stop the coordinator" onClick={() => void api.stopCoordinator(space.id)} /> : null}
					<IconBtn type="submit" icon={Send} size="sm" variant="primary" label="Send message" disabled={!draft.trim() || Boolean(blocked)} />
				</div>
			</div>
		</form>
	);
}

/**
 * The coordinator's conversation: what you asked, what it answered, the
 * threads it started as live cards under your message, and the threads'
 * reports as quiet rows.
 */
export function ProjectFeed({
	space,
	agent,
	threads,
	starting,
	onStartingChange: setStarting,
}: {
	space: Space;
	agent: UseFlueAgentResult;
	threads: Session[];
	starting: boolean;
	onStartingChange: (starting: boolean) => void;
}) {
	const scroller = useRef<HTMLDivElement>(null);
	const [draft, setDraft] = useState('');
	const busy = agent.status === 'submitted' || agent.status === 'streaming';
	const messages = agent.messages.filter((message) => message.settlement || (message.display === 'visible' && message.role !== 'system'));
	const lastAssistant = [...messages].reverse().find((message) => message.role === 'assistant');

	useEffect(() => {
		const el = scroller.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [agent.messages, starting]);

	return (
		<div className="flex min-h-0 min-w-0 flex-1 flex-col">
			<div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-4 pt-2 pb-2">
				<div className="mx-auto flex max-w-[700px] flex-col gap-5">
					{messages.length === 0 && !busy && agent.historyReady ? <Welcome space={space} onPick={setDraft} /> : null}
					{messages.map((message) => {
						if (message.settlement) {
							return (
								<ActionRow key={message.id} icon={CircleAlert} failed>
									{textOf(message).trim() || `The coordinator ${message.settlement.outcome === 'aborted' ? 'was stopped' : 'failed'}. Send the message again to retry.`}
								</ActionRow>
							);
						}
						if (message.role === 'user') {
							const text = textOf(message);
							const reports = parseReports(text);
							return reports ? <ReportRow key={message.id} reports={reports} threads={threads} /> : <Bubble key={message.id} text={text} />;
						}
						return <CoordinatorMessage key={message.id} message={message} live={busy && message === lastAssistant} space={space} threads={threads} />;
					})}
					{busy && messages[messages.length - 1]?.role !== 'assistant' ? (
						<div className="flex items-center gap-2 text-[12px] text-(--text-secondary)">
							<Spinner size={12} />
							<span>The coordinator is reading</span>
						</div>
					) : null}
					{agent.status === 'error' && !messages.some((message) => message.settlement) ? (
						<ActionRow icon={CircleAlert} failed>
							{agent.error?.message ? `The coordinator failed: ${agent.error.message}` : 'The coordinator failed. Send the message again.'}
						</ActionRow>
					) : null}
					{starting ? <NewThreadForm space={space} onDone={() => setStarting(false)} /> : null}
				</div>
			</div>
			<CoordinatorComposer space={space} agent={agent} draft={draft} onDraft={setDraft} onNewThread={() => setStarting(true)} />
		</div>
	);
}

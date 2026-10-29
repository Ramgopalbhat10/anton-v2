import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { ArrowUpRight, Clock, Github, GitPullRequest, type LucideIcon, MessageCircleReply, MessageSquare, Play, RotateCcw, Square, Wrench } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Popover } from 'radix-ui';
import { Markdown, InlineLinks } from '@/components/markdown';
import { HoverPeek } from '@/components/hover-peek';
import { FileFace, OutputThumb } from '@/components/output-viewer';
import { Chip } from '@/components/instrument';
import { PrChecks, PrMetadata, PrStatus, prSummary } from '@/components/pr-status';
export { prNumber, prSummary } from '@/components/pr-status';
import { Btn, Icon } from '@/components/signal';
import { useNow } from '@/components/subagents';
import { Glyph, glyphKind, ThreadGlyph } from '@/components/thread-glyph';
import { api, isChat, outputUrl, repoShort, type Session, type ThreadState } from '@/lib/api';
import { categoryInfo, categoryOf, extensionOf, nameOf } from '@/lib/artifacts';
import { age, elapsed } from '@/lib/format';
import { failed, STATE_LOOK, stateOf, threadActiveAt, threadLine } from '@/lib/spaces';
import { useThreadOutputs } from '@/lib/thread-outputs';
import { nowText } from '@/lib/now-text';
import { cn } from '@/lib/utils';
import { openViewer, type ViewerItem } from '@/lib/viewer';
import { isImagePath } from '../../core/outputs';

/** The state as a drawn glyph, for list rows: a turning ring while it works, a calling dot while it waits on you. */
export function ThreadStateIcon({ thread, size = 13 }: { thread: Session; size?: number }) {
	return <ThreadGlyph thread={thread} size={size} />;
}

type Step = { label: string; icon: LucideIcon; primary?: boolean } & ({ send: string } | { open: true; panel?: 'Changes' | 'PR' } | { stop: true } | { href: string });

/** The next steps a thread offers in its state; each sends that instruction to the thread, as if you typed it. */
export function nextSteps(thread: Session): Step[] {
	const state: ThreadState = stateOf(thread);
	const pr = thread.prUrl ? thread.pullRequest : null;
	if (state === 'working') return [{ label: 'Stop', icon: Square, stop: true }];
	if (state === 'queued') return [];
	if (thread.status === 'error') return [{ label: 'Try again', icon: RotateCcw, send: 'Something failed. Look at what went wrong and try again.', primary: true }];
	if (pr?.conflicts && !thread.review) return [{ label: 'Fix conflicts', icon: Wrench, send: 'The pull request has merge conflicts. Merge the latest base branch with merge_base_branch, resolve them, check the result and update the pull request.', primary: true }];
	if (pr?.checks === 'failed') return [{ label: 'Fix CI', icon: Wrench, send: 'Checks are failing on the pull request. Find out why, fix it and push.', primary: true }];
	if (state === 'waiting') return [{ label: 'Answer', icon: MessageCircleReply, open: true, primary: true }];
	if (state === 'review') return [{ label: 'Review', icon: GitPullRequest, open: true, panel: thread.prUrl ? 'PR' : 'Changes', primary: true }, ...(thread.prUrl ? [{ label: 'PR', icon: ArrowUpRight, href: thread.prUrl }] : [])];
	if (state === 'landing' && thread.prUrl) return [{ label: 'Open PR', icon: ArrowUpRight, href: thread.prUrl, primary: true }];
	if (state === 'idle' && thread.workspace && !thread.prUrl) return [{ label: 'Create PR', icon: GitPullRequest, send: 'Open a pull request with the changes on this branch. Write a clear title and a short description.' }];
	return [];
}

/** Opens a project's thread in the main view, with one of its panels when asked. */
export function useOpenThread() {
	const navigate = useNavigate();
	return (thread: Session, panel?: 'Changes' | 'PR') => {
		if (!thread.spaceId) return void navigate({ to: '/agents/$sessionId', params: { sessionId: thread.id }, search: { app: 'code', panel } });
		void navigate({ to: '/projects/$spaceId/threads/$threadId', params: { spaceId: thread.spaceId, threadId: thread.id }, search: { panel } });
	};
}

/** The card's buttons: each next step, plus opening the thread. */
export function NextSteps({ thread, size = 'sm' }: { thread: Session; size?: 'sm' | 'xs' }) {
	const queryClient = useQueryClient();
	const open = useOpenThread();
	const send = useMutation({
		mutationFn: async (step: Step) => {
			if ('send' in step && thread.spaceId) await api.nudgeThread(thread.spaceId, thread.id, step.send);
			if ('stop' in step) await api.stopAgent(thread.id);
		},
		onSettled: () => void queryClient.invalidateQueries({ queryKey: ['sessions'] }),
	});
	const steps = nextSteps(thread);
	return (
		<div className="flex min-w-0 flex-wrap items-center gap-1.5" onClick={(event) => event.stopPropagation()}>
			{steps.map((step) =>
				'href' in step ? (
					<a key={step.label} href={step.href} target="_blank" rel="noreferrer" className={cn('sg-btn', `sg-btn--${size}`, step.primary ? 'sg-btn--secondary' : 'sg-btn--ghost')}>
						<Icon icon={step.icon} size={size === 'xs' ? 12 : 14} />
						<span>{step.label}</span>
					</a>
				) : (
					<Btn
						key={step.label}
						size={size}
						variant={step.primary ? 'secondary' : 'ghost'}
						icon={step.icon}
						disabled={send.isPending}
						onClick={() => ('open' in step ? open(thread, step.panel) : send.mutate(step))}
					>
						{step.label}
					</Btn>
				),
			)}
			{send.isError ? <span role="alert" className="basis-full text-[12px] text-(--danger-text)">Action failed. Try again.</span> : null}
			{size === 'sm' ? (
				<Btn size="sm" variant="ghost" icon={Play} onClick={() => open(thread)} aria-label={`Open ${thread.title}`}>
					Open
				</Btn>
			) : null}
		</div>
	);
}

/**
 * What a row says beyond its glyph and title, as chips: its pull request,
 * and its state only where the glyph alone would not do (it needs you, it
 * failed, it waits for a slot). Everything else is in the peek.
 */
export function ThreadChips({ thread }: { thread: Session }) {
	const state = stateOf(thread);
	const checksFailing = thread.pullRequest?.checks === 'failed';
	return (
		<>
			<PrStatus thread={thread} />
			{thread.status === 'error' ? (
				<Chip tone="danger">Failed</Chip>
			) : state === 'waiting' && !checksFailing ? (
				<Chip tone="warning">Needs you</Chip>
			) : state === 'queued' ? (
				<Chip>Queued</Chip>
			) : null}
		</>
	);
}

/** A chip that does something: the look of a Chip, with a hover and a click of its own. */
const CHIP_BUTTON =
	'inline-flex h-5 max-w-[168px] shrink-0 items-center gap-1 rounded-[6px] border border-(--border-subtle) bg-(--alpha-white-4) px-1.5 text-[11px] leading-none whitespace-nowrap text-(--text-secondary) outline-none transition-colors duration-(--duration-micro) hover:border-(--border-strong) hover:bg-(--alpha-white-7) hover:text-(--text-primary) focus-visible:shadow-(--focus-ring)';

/** A file's look on a chip: a speck of the picture, or its kind's icon. */
function FileMark({ item }: { item: ViewerItem }) {
	const [broken, setBroken] = useState(false);
	if (isImagePath(item.path) && !broken) {
		return (
			<img
				src={outputUrl(item.sessionId, item.path)}
				alt=""
				loading="lazy"
				onError={() => setBroken(true)}
				className="size-3.5 shrink-0 rounded-[3px] object-cover object-top shadow-[0_0_0_1px_var(--border-subtle)]"
			/>
		);
	}
	const info = categoryInfo(categoryOf(item.path));
	return <Icon icon={info.icon} size={11} className={cn('shrink-0', info.tone)} />;
}

/** The file larger, with its name: what a file chip shows on hover. */
function FilePeek({ item }: { item: ViewerItem }) {
	return (
		<>
			<div className="relative h-[148px] overflow-hidden rounded-[8px] border border-(--border-subtle) bg-(--bg-inset)">
				{isImagePath(item.path) ? <OutputThumb item={item} fit="contain" /> : <FileFace path={item.path} size={24} />}
			</div>
			<div className="flex min-w-0 items-center gap-2">
				<FileMark item={item} />
				<span className="min-w-0 flex-1 truncate text-[12.5px] text-(--text-primary)" title={item.path}>
					{nameOf(item.path)}
				</span>
				<Chip mono className="shrink-0">
					{extensionOf(item.path)}
				</Chip>
			</div>
		</>
	);
}

/** All remaining files are available by click, keyboard or touch, not only on hover. */
function FileList({ items, open }: { items: ViewerItem[]; open: (item: ViewerItem) => void }) {
	const row = 'flex min-h-8 min-w-0 items-center gap-2 rounded-[7px] px-1.5 text-left outline-none hover:bg-(--bg-hover) focus-visible:shadow-(--focus-ring)';
	return (
		<div className="flex max-h-[min(320px,50vh)] flex-col overflow-y-auto overscroll-contain">
			{items.map((item) => (
				<button key={item.path} type="button" onClick={() => open(item)} className={row}>
					<span className="inline-flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-[5px] border border-(--border-subtle) bg-(--bg-inset)">
						{isImagePath(item.path) ? <OutputThumb item={item} /> : <FileMark item={item} />}
					</span>
					<span className="min-w-0 flex-1 truncate text-[12.5px] text-(--text-secondary)" title={item.path}>{nameOf(item.path)}</span>
				</button>
			))}
		</div>
	);
}

function MoreFiles({ items, open, className }: { items: ViewerItem[]; open: (item: ViewerItem) => void; className: string }) {
	const [show, setShow] = useState(false);
	return (
		<Popover.Root open={show} onOpenChange={setShow}>
			<Popover.Trigger asChild>
				<button type="button" aria-label={`${items.length} more files`} onClick={(event) => event.stopPropagation()} className={className}>+{items.length}</button>
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Content side="top" align="start" sideOffset={6} collisionPadding={12} onClick={(event) => event.stopPropagation()} className="in-pop z-50 w-[min(268px,calc(100vw-24px))] p-1.5 outline-none">
					<FileList items={items} open={(item) => { setShow(false); open(item); }} />
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	);
}

/**
 * What a thread made, as chips after its pull request: its newest file, a
 * peek of it on hover, and +N for the rest, listed in a popover. A click opens
 * a file in the viewer beside the conversation. `onPeek` says when one of them shows a peek, so the row's own stays shut.
 */
export function ThreadOutputChips({ thread, onPeek }: { thread: Session; onPeek?: (peeking: boolean) => void }) {
	const outputs = useThreadOutputs(thread.id);
	if (outputs.length === 0) return null;
	const items: ViewerItem[] = outputs.map((output) => ({ sessionId: thread.id, path: output.path }));
	const open = (item: ViewerItem) => openViewer(item, items, thread.spaceId ?? null);
	const [first, ...rest] = items;
	return (
		<span className="flex min-w-0 items-center gap-1" onPointerEnter={() => onPeek?.(true)} onPointerLeave={() => onPeek?.(false)}>
			<HoverPeek content={<FilePeek item={first} />} width={268} openDelay={200}>
				<button
					type="button"
					aria-label={`Open ${nameOf(first.path)}`}
					onClick={(event) => {
						event.stopPropagation();
						open(first);
					}}
					className={cn(CHIP_BUTTON, 'min-w-0 shrink')}
				>
					<FileMark item={first} />
					<span className="min-w-0 truncate">{nameOf(first.path)}</span>
				</button>
			</HoverPeek>
			{rest.length ? <MoreFiles items={rest} open={open} className={cn(CHIP_BUTTON, 'in-num px-1.5 text-[10.5px] text-(--text-tertiary)')} /> : null}
		</span>
	);
}

/** How long it has worked, or how long since it last did anything. */
function phaseOf(thread: Session, now: number): string {
	const state = stateOf(thread);
	if (state === 'working') return elapsed(now - new Date(thread.lastInputAt ?? thread.createdAt).getTime());
	if (state === 'queued') return 'starts when a slot frees';
	const ago = age(threadActiveAt(thread), now);
	return ago === 'now' ? 'just now' : `${ago} ago`;
}

/**
 * What a thread made, in its peek's footer: a tile for each of its newest
 * files, as many as there is `room` for, then +N; each opens in the viewer.
 */
function PeekFiles({ thread, room }: { thread: Session; room: number }) {
	const outputs = useThreadOutputs(thread.id);
	const items: ViewerItem[] = outputs.map((output) => ({ sessionId: thread.id, path: output.path }));
	const open = (item: ViewerItem) => openViewer(item, items, thread.spaceId ?? null);
	const shown = items.length > room ? items.slice(0, room - 1) : items;
	const more = items.length - shown.length;
	const tile =
		'inline-flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-[6px] border border-(--border-subtle) bg-(--bg-inset) outline-none transition-colors duration-(--duration-micro) hover:border-(--border-strong) focus-visible:shadow-(--focus-ring)';
	return (
		<span role="list" aria-label="Files" className="flex min-w-0 flex-1 items-center gap-1">
			{shown.map((item) => (
				<span role="listitem" key={item.path} className="inline-flex">
					<button type="button" title={nameOf(item.path)} aria-label={`Open ${nameOf(item.path)}`} onClick={() => open(item)} className={tile}>
						{isImagePath(item.path) ? <OutputThumb item={item} /> : <FileMark item={item} />}
					</button>
				</span>
			))}
			{more > 0 ? (
				<span role="listitem" className="inline-flex"><MoreFiles items={items.slice(shown.length)} open={open} className={cn(tile, 'in-num border-dashed text-[10.5px] text-(--text-tertiary) hover:text-(--text-primary)')} /></span>
			) : null}
		</span>
	);
}

/**
 * Everything a row leaves out, on hover: its state, where it works and for
 * how long, what it last said or asks, its pull request, and its next steps.
 */
export function ThreadPeek({ thread }: { thread: Session }) {
	const open = useOpenThread();
	const state = stateOf(thread);
	const now = useNow(state === 'working');
	const live = useThreadNow(thread);
	const line = live?.text ?? threadLine(thread, true);
	const waiting = state === 'waiting';
	const broken = waiting && failed(thread);
	const pr = prSummary(thread);
	return (
		<>
			<div className="flex items-start gap-2">
				<span className="mt-[2px] inline-flex shrink-0">
					<Glyph kind={glyphKind(thread)} size={14} title={broken ? (thread.status === 'error' ? 'Failed' : 'Checks failing') : STATE_LOOK[state].label} />
				</span>
				<div className="flex min-w-0 flex-1 flex-col gap-1">
					<span className="line-clamp-2 text-[13px] leading-[18px] font-medium text-(--text-primary)">{thread.title}</span>
					<span className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
						<span className="inline-flex min-w-0 items-center gap-1 text-[11.5px] text-(--text-tertiary)">
							<Icon icon={isChat(thread) ? MessageSquare : Github} size={11} className="text-(--icon-tertiary)" />
							<span className="truncate">{repoShort(thread)}</span>
						</span>
						<span className="inline-flex shrink-0 items-center gap-1 text-[11.5px] text-(--text-tertiary)">
							<Icon icon={Clock} size={11} className="text-(--icon-tertiary)" />
							{phaseOf(thread, now)}
						</span>
					</span>
				</div>
			</div>
			{line ? (
				waiting ? (
					<div
						className={cn(
							'line-clamp-4 rounded-r-[6px] border-l-2 py-1 pr-2 pl-2.5 text-[12.5px] leading-[18px] text-pretty [&_.sg-markdown]:text-[12.5px] [&_.sg-markdown]:leading-[18px] [&_.sg-markdown]:text-inherit',
							broken ? 'border-(--danger-base) bg-(--danger-bg) text-(--danger-text)' : 'border-(--warning-base) bg-(--warning-bg) text-(--warning-text)',
						)}
					>
						<InlineLinks.Provider value={null}><Markdown text={line} /></InlineLinks.Provider>
					</div>
				) : (
					<div className={cn('m-0 flex min-w-0 items-baseline gap-1.5 text-[12.5px] leading-[18px] text-pretty text-(--text-tertiary)', live && 'agent-live-line')}>
						{live?.total ? (
							<span className="in-num shrink-0 text-[11px] text-(--text-disabled)">
								{live.done}/{live.total}
							</span>
						) : null}
						<div className="line-clamp-3 min-w-0 [&_.sg-markdown]:text-[12.5px] [&_.sg-markdown]:leading-[18px] [&_.sg-markdown]:text-(--text-tertiary)"><InlineLinks.Provider value={null}><Markdown text={line} /></InlineLinks.Provider></div>
					</div>
				)
			) : null}
			{pr ? <div className="flex min-w-0 flex-wrap items-center gap-2"><PrStatus thread={thread} link showConflicts={false} showFailing={false} /><PrMetadata sessionId={thread.id} url={thread.prUrl!} /><PrChecks pull={thread.pullRequest} /></div> : null}
			<div className="flex min-w-0 flex-wrap items-center gap-1.5 border-t border-(--border-subtle) pt-2.5">
				<PeekFiles thread={thread} room={nextSteps(thread).length ? 2 : 5} />
				<NextSteps thread={thread} size="xs" />
				<Btn size="xs" variant="primary" onClick={() => open(thread)}>
					Open thread
				</Btn>
			</div>
		</>
	);
}

/** States that open a card out with its line and buttons: each asks something of you. */
const CALLING = new Set<ThreadState>(['waiting', 'review', 'landing']);

export type ThreadNow = { text: string; done: number; total: number };

/**
 * What a working thread is on, live: the step of its todo list in hand and how
 * far down the list it is, else what its agent does this moment, else its
 * brief. Both follow the agent as it goes (`live-updates.ts`): a new list
 * refetches its query, and the moment arrives whole. Null when it is not working.
 */
export function useThreadNow(thread: Session): ThreadNow | null {
	const working = stateOf(thread) === 'working';
	const todos = useQuery({ queryKey: ['todos', thread.id], queryFn: () => api.todos(thread.id), staleTime: Infinity, enabled: working });
	const now = useQuery({ queryKey: ['now', thread.id], queryFn: () => api.now(thread.id), enabled: working }).data?.now ?? null;
	if (!working) return null;
	const list = todos.data?.list?.todos ?? [];
	const step = list.find((todo) => todo.status === 'in_progress') ?? list.find((todo) => todo.status === 'pending');
	if (step) return { text: step.content, done: list.filter((todo) => todo.status === 'completed').length, total: list.length };
	return { text: now ? nowText(now, 'replying') : threadLine(thread) || nowText(null, 'replying'), done: 0, total: 0 };
}

/**
 * A thread's line: what it works on while it works, shimmering, with how many
 * of its steps are done; else what it last said. A new line rises into place,
 * so a step ticking over reads as progress.
 */
function LiveLine({ text, live, className }: { text: string; live: ThreadNow | null; className?: string }) {
	return (
		<div className={cn('flex min-w-0 items-center gap-1.5 text-[12px] leading-[17px] text-(--text-tertiary)', className)}>
			{live?.total ? (
				<span className="in-num shrink-0 text-[10.5px] text-(--text-disabled)" title={`${live.done} of ${live.total} steps done`}>
					{live.done}/{live.total}
				</span>
			) : null}
			<div key={text} className={cn('min-w-0 duration-300 animate-in fade-in-0 slide-in-from-bottom-1', live && 'agent-live-line')}>
				<div className="truncate [&_.sg-markdown]:truncate [&_.sg-markdown]:text-[12px] [&_.sg-markdown]:leading-[17px] [&_.sg-markdown]:text-inherit" onClick={(event) => { if ((event.target as HTMLElement).closest('a')) event.stopPropagation(); }}><InlineLinks.Provider value={null}><Markdown text={text} /></InlineLinks.Provider></div>
			</div>
		</div>
	);
}

/** A thread's card in the feed: its own border, as wide as what it says. */
export const THREAD_CARD = 'flex w-fit max-w-full min-w-0 flex-col rounded-[10px] border border-(--card-border) bg-(--card-bg) px-3 py-1.5';

/**
 * A thread in a reply, as a card that follows it live: its glyph, title and
 * the step it is on while it works (else what it last said), then its pull
 * request and files as chips. A thread that asks something of you (it waits
 * on you, or its pull request is ready) opens out with that line and its next
 * steps as buttons. Resting on it shows the rest; clicking opens it.
 * `ThreadRows` stacks them.
 */
export function ThreadRow({ thread }: { thread: Session }) {
	const open = useOpenThread();
	const state = stateOf(thread);
	const live = useThreadNow(thread);
	const broken = state === 'waiting' && failed(thread);
	const calling = CALLING.has(state);
	const line = live?.text ?? (state === 'queued' ? 'Starts when a slot frees' : threadLine(thread, true));
	const steps = nextSteps(thread);
	// Answer already opens the thread; anything else leaves it a button away.
	const opens = steps.some((step) => 'open' in step && !step.panel);
	const [peeking, setPeeking] = useState(false);
	return (
		<HoverPeek content={<ThreadPeek thread={thread} />} quiet={peeking}>
			<article
				aria-label={thread.title}
				data-state={state}
				onClick={() => open(thread)}
				className={cn(
					THREAD_CARD,
					'group/thread cursor-pointer gap-1 transition-colors duration-(--duration-micro) hover:border-(--border-strong) hover:bg-(--bg-hover)',
					calling && 'gap-1.5 border-(--border-default) py-2.5 sm:min-w-[360px]',
				)}
			>
				<div className="flex min-h-6 min-w-0 flex-wrap items-center gap-x-2.5 gap-y-0.5 sm:flex-nowrap">
					<ThreadGlyph thread={thread} size={14} />
					<button type="button" onClick={(event) => { event.stopPropagation(); open(thread); }} className="min-w-0 flex-1 truncate rounded text-left text-[13px] text-(--text-primary) focus-visible:outline focus-visible:outline-2 focus-visible:outline-(--accent-text) sm:flex-initial">{thread.title}</button>
					{/* On a phone the line and the chips take a row each under the title, so none squeezes the others. */}
					{!calling && line ? <LiveLine text={line} live={live} className="order-last basis-full pl-[24px] sm:order-none sm:shrink-[4] sm:basis-auto sm:pl-0" /> : null}
					<span className="order-last flex min-w-0 basis-full items-center gap-1 pl-[24px] empty:hidden sm:order-none sm:basis-auto sm:pl-0">
						<ThreadChips thread={thread} />
						<ThreadOutputChips thread={thread} onPeek={setPeeking} />
					</span>
				</div>
				{calling && line ? (
					<div className={cn('line-clamp-2 pl-[24px] text-[12px] leading-[17px] text-pretty [&_.sg-markdown]:text-[12px] [&_.sg-markdown]:leading-[17px] [&_.sg-markdown]:text-inherit', broken ? 'text-(--danger-text)' : state === 'waiting' ? 'text-(--warning-text)' : 'text-(--text-secondary)')} onClick={(event) => { if ((event.target as HTMLElement).closest('a')) event.stopPropagation(); }}><InlineLinks.Provider value={null}><Markdown text={line} /></InlineLinks.Provider></div>
				) : null}
				{calling ? (
					<div className="flex flex-wrap items-center gap-1.5 pl-[24px]">
						<NextSteps thread={thread} size="xs" />
						{opens ? null : (
							<Btn
								size="xs"
								variant="ghost"
								onClick={(event) => {
									event.stopPropagation();
									open(thread);
								}}
							>
								View thread
							</Btn>
						)}
					</div>
				) : null}
			</article>
		</HoverPeek>
	);
}

/** Threads in a reply: a card each, stacked. */
export function ThreadRows({ children, label }: { children: ReactNode; label?: string }) {
	return (
		<section aria-label={label} className="flex min-w-0 flex-col items-start gap-1.5">
			{children}
		</section>
	);
}

/**
 * A thread named in the middle of a sentence: its glyph and title as a chip,
 * the same peek on hover, and a click opens it.
 */
export function ThreadChip({ thread, children }: { thread: Session; children?: ReactNode }) {
	const open = useOpenThread();
	return (
		<HoverPeek content={<ThreadPeek thread={thread} />}>
			<button
				type="button"
				onClick={() => open(thread)}
				className="mx-px inline-flex max-w-full items-center gap-1 rounded-[6px] bg-(--alpha-white-6) px-1.5 align-baseline text-[0.95em] leading-[1.5] text-(--accent-text) outline-none hover:bg-(--alpha-white-9) focus-visible:shadow-(--focus-ring)"
			>
				<span className="inline-flex shrink-0 self-center">
					<ThreadGlyph thread={thread} size={11} />
				</span>
				<span className="truncate">{children ?? thread.title}</span>
			</button>
		</HoverPeek>
	);
}

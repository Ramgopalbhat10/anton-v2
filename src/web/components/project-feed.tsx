import { type FlueConversationMessage, type FlueConversationPart, type UseFlueAgentResult } from '@flue/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Bookmark, Check, ChevronRight, CircleAlert, FolderGit2, ListPlus, Plus, Send, Square, Waypoints } from 'lucide-react';
import { memo, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ComposerPlus } from '@/components/composer-plus';
import { AttachButton, AttachmentTray, SentAttachments, useAttachments } from '@/components/attachments';
import { ComposerInput } from '@/components/composer-input';
import { PlanToggle } from '@/components/composer';
import { Mascot, useMascotMood } from '@/components/mascot';
import { SentText } from '@/components/sent-text';
import { Caption } from '@/components/instrument';
import { InlineLinks, Markdown, OutputLinks } from '@/components/markdown';
import { OutputCards } from '@/components/output-viewer';
import { ModelPicker, useModels } from '@/components/model-picker';
import { Btn, Icon, IconBtn, Kbd, Menu, MenuContent, MenuItem, MenuTrigger, PickerChip, Spinner } from '@/components/signal';
import { ProjectRoute } from '@/components/project-viz';
import { THREAD_CARD, ThreadChip, ThreadRow, ThreadRows, useOpenThread } from '@/components/thread-card';
import { Glyph, ThreadGlyph } from '@/components/thread-glyph';
import { field } from '@/components/tool-describe';
import { api, type ModelChoice, SAFETY_NET_MS, type Session, type Space } from '@/lib/api';
import { expandCommand } from '@/lib/completion';
import { askToNotify } from '@/lib/notifications';
import { takeFromInbox, useInbox } from '@/lib/composer-inbox';
import { useThreadFileResolver } from '@/lib/thread-outputs';
import { openViewer, sameItem, type ViewerItem } from '@/lib/viewer';
import { linkTargets } from '../../core/outputs';
import { parseReports, type Report, threadsLoaded } from '@/lib/spaces';
import { cn } from '@/lib/utils';
import { useFollowLatest } from '@/lib/use-follow-latest';
import { JumpToLatest } from '@/components/jump-to-latest';
import { deliveredImages, imageFile } from '@/lib/attachments';
import { splitAttachments, withAttachments } from '../../core/attachments';

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

type FilePart = Extract<FlueConversationPart, { type: 'file' }>;

/** What you sent: its images, its files as chips (the text they carry is the coordinator's to read), and what you typed. */
function Bubble({ message }: { message: FlueConversationMessage }) {
	const { text, files } = splitAttachments(textOf(message));
	const images = message.parts.filter((part): part is FilePart => part.type === 'file' && part.mediaType.startsWith('image/') && Boolean(part.url));
	return (
		<div className="flex flex-col items-end gap-1.5">
			{images.length > 0 ? (
				<div className="flex max-w-[520px] flex-wrap justify-end gap-1.5">
					{images.map((image, index) => (
						<a key={image.url ?? index} href={image.url} target="_blank" rel="noreferrer">
							<img src={image.url} alt={image.filename ?? 'Attached image'} className="block max-h-40 max-w-60 rounded-lg border border-(--border-subtle)" />
						</a>
					))}
				</div>
			) : null}
			{/* Images sent with the message are saved to the Library too; their pictures above already show them. */}
			<SentAttachments files={images.length ? files.filter((file) => !/ image$/.test(file.kind)) : files} />
			{text ? <SentText text={text} className="max-w-[min(560px,100%)]" /> : null}
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

const said = (report: Report) => REPORTED[report.state];

function ReportRow({ reports: all, threads }: { reports: Report[]; threads: Session[] }) {
	const [open, setOpen] = useState(false);
	const openThread = useOpenThread();
	// A deleted thread's reports leave the feed with it.
	const reports = threadsLoaded(threads) ? all.filter((report) => byPrefix(threads, report.id)) : all;
	if (!reports.length) return null;
	const needs = reports.filter((report) => report.state === 'waiting').length;
	return (
		<div className="flex flex-col gap-1">
			<button
				type="button"
				aria-expanded={open}
				onClick={() => setOpen((current) => !current)}
				className="group/report flex h-7 max-w-full min-w-0 items-center gap-2 self-start rounded-full border border-(--border-subtle) bg-(--well-bg) pr-3 pl-1.5 text-left text-[12px] text-(--text-tertiary) outline-none hover:bg-(--bg-hover) hover:text-(--text-secondary) focus-visible:shadow-(--focus-ring)"
			>
				<Icon icon={ChevronRight} size={12} className="text-(--icon-tertiary) transition-transform duration-(--duration-micro)" style={{ transform: open ? 'rotate(90deg)' : undefined }} />
				<span className="flex shrink-0 items-center -space-x-1">
					{reports.slice(0, 5).map((report, index) => {
						const thread = byPrefix(threads, report.id);
						return (
							<span key={index} className="inline-flex rounded-full bg-(--bg-canvas) p-px">
								{thread ? <ThreadGlyph thread={thread} size={12} /> : <Glyph kind={report.state} size={12} />}
							</span>
						);
					})}
				</span>
				{reports.length === 1 ? (
					// A long title gives way, never what happened to it.
					<span className="flex min-w-0 gap-1">
						<span className="min-w-0 truncate">{reports[0].title}</span>
						<span className="shrink-0">{said(reports[0])}</span>
					</span>
				) : (
					<span className="min-w-0 truncate">
						{reports.length} threads reported
						{needs ? <span className="text-(--warning-text)"> · {needs} need you</span> : null}
					</span>
				)}
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
								<span className="mt-[3px] inline-flex">{thread ? <ThreadGlyph thread={thread} size={12} /> : <Glyph kind={report.state} size={12} />}</span>
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

/**
 * Threads you or a routine started, not the coordinator: a quiet line saying
 * who, over the same live card the coordinator's threads get, so the feed
 * shows them as they begin and follows them from there. A deleted thread
 * leaves the card.
 */
function StartedRows({ reports, threads }: { reports: Report[]; threads: Session[] }) {
	const rows = reports.flatMap((report) => {
		const thread = byPrefix(threads, report.id);
		return thread ? [<ThreadRow key={report.id} thread={thread} />] : [];
	});
	if (!rows.length) return null;
	const who = reports.every((report) => report.started === 'routine') ? 'A routine' : 'You';
	const what = rows.length === 1 ? 'a thread' : `${rows.length} threads`;
	return (
		<div className="flex flex-col gap-1.5">
			<ActionRow icon={Waypoints}>
				{who} started {what}
			</ActionRow>
			<ThreadRows label={`${who} started ${what}`}>{rows}</ThreadRows>
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

/** A thread the coordinator is starting, until the server has it: its title, or why it could not start. */
function Starting({ part }: { part: ToolPart }) {
	const failed = part.state === 'output-error';
	return (
		<div className={cn(THREAD_CARD, 'min-h-9 flex-row items-center gap-2.5')}>
			{failed ? <Icon icon={CircleAlert} size={14} className="text-(--danger-text)" /> : <Spinner size={13} />}
			<span className={cn('min-w-0 truncate text-[13px]', failed ? 'text-(--danger-text)' : 'text-(--text-secondary)')}>
				{failed ? `Could not start “${field(part.input, 'title')}”` : field(part.input, 'title') || 'New thread'}
			</span>
		</div>
	);
}

/**
 * The threads a reply started, a live card each, in the order they were
 * started: several at once read as one batch. A thread deleted since
 * leaves the card, as it leaves the sidebar; one the reply being written just
 * started may not be in the list yet, so it shows as starting until it is.
 */
function Dispatch({ parts, threads, live }: { parts: ToolPart[]; threads: Session[]; live: boolean }) {
	const rows = parts.flatMap((part) => {
		const id = threadIdIn(part);
		const thread = id ? threads.find((item) => item.id === id) : undefined;
		if (thread) return [<ThreadRow key={part.toolCallId} thread={thread} />];
		const gone = id !== null && !live && threadsLoaded(threads);
		return gone ? [] : [<Starting key={part.toolCallId} part={part} />];
	});
	if (!rows.length) return null;
	return <ThreadRows label={rows.length === 1 ? 'Started a thread' : `Started ${rows.length} threads`}>{rows}</ThreadRows>;
}

/** One of the coordinator's tool calls, as what it did: a thread card, suggestions, or a quiet line. */
function ToolBlock({ part, space, threads, live }: { part: ToolPart; space: Space; threads: Session[]; live: boolean }) {
	const failed = part.state === 'output-error';
	const target = byPrefix(threads, field(part.input, 'thread').replace(/^\[|\]$|^id:/g, ''));
	switch (part.toolName) {
		case 'start_thread':
			return <Dispatch parts={[part]} threads={threads} live={live} />;
		case 'suggest_threads': {
			const list = (part.input as { threads?: Suggestion[] } | undefined)?.threads ?? [];
			return list.length ? <SuggestedThreads space={space} suggestions={list} /> : null;
		}
		case 'message_thread':
			return (
				<ActionRow icon={Send} failed={failed}>
					{/* A thread deleted since is gone from the list; the coordinator then starts a new one. */}
					{failed ? 'Not sent' : 'Sent'} to <span className="text-(--text-secondary)">{target?.title ?? (failed ? 'a deleted thread' : 'a thread')}</span>: {field(part.input, 'message')}
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

type Block = { kind: 'text'; text: string; key: string } | { kind: 'tool'; part: ToolPart } | { kind: 'dispatch'; parts: ToolPart[] };

/** The message's parts as blocks: threads started in a row become one dispatch. */
function blocks(parts: FlueConversationPart[]): Block[] {
	const out: Block[] = [];
	parts.forEach((part, index) => {
		if (part.type === 'text') return void out.push({ kind: 'text', text: part.text, key: String(index) });
		if (part.type !== 'dynamic-tool') return;
		const last = out[out.length - 1];
		if (part.toolName === 'start_thread' && last?.kind === 'dispatch') last.parts.push(part);
		else if (part.toolName === 'start_thread') out.push({ kind: 'dispatch', parts: [part] });
		else out.push({ kind: 'tool', part });
	});
	return out;
}

/** Memoized: the coordinator's stream re-renders the feed with every chunk, and only the reply being written changes. */
/** A thread named in a reply as `[title](#thread-<id>)` draws as its chip; one the project no longer has, as its words. */
function threadChips(threads: Session[]): InlineLinks {
	return (href, children) => {
		const id = /^#thread-([\w-]+)$/.exec(href)?.[1];
		if (!id) return null;
		const thread = byPrefix(threads, id);
		return thread ? <ThreadChip thread={thread}>{children}</ThreadChip> : <span>{children}</span>;
	};
}

/** The thread files a reply's words link to, each once, in the order it names them. */
function linkedFiles(parts: FlueConversationPart[], resolve: (href: string) => ViewerItem | null): ViewerItem[] {
	const items: ViewerItem[] = [];
	for (const part of parts) {
		if (part.type !== 'text') continue;
		for (const target of linkTargets(part.text)) {
			const item = resolve(target);
			if (item && !items.some((other) => sameItem(other, item))) items.push(item);
		}
	}
	return items;
}

const CoordinatorMessage = memo(function CoordinatorMessage({
	message,
	live,
	space,
	threads,
	resolveFile,
}: {
	message: FlueConversationMessage;
	live: boolean;
	space: Space;
	threads: Session[];
	/** The thread file a link names, as the coordinator passes on what a thread made. */
	resolveFile: (href: string) => ViewerItem | null;
}) {
	const parts = message.parts.filter((part) => (part.type === 'text' && part.text.trim()) || part.type === 'dynamic-tool');
	const chips = useMemo(() => threadChips(threads), [threads]);
	const files = useMemo(() => (live ? [] : linkedFiles(message.parts, resolveFile)), [live, message.parts, resolveFile]);
	// A drawing on one of them goes to the coordinator, which passes it on.
	const outputLinks = useMemo<OutputLinks>(() => ({ resolve: resolveFile, open: (item) => openViewer(item, files, space.id) }), [resolveFile, files, space.id]);
	if (parts.length === 0 && !live) return null;
	return (
		<OutputLinks.Provider value={outputLinks}>
		<div className="flex flex-col gap-2.5">
			{blocks(parts).map((block) =>
				block.kind === 'text' ? (
					<div key={block.key} className="text-[13.5px] leading-[21px]">
						<InlineLinks.Provider value={chips}>
							<Markdown text={block.text} />
						</InlineLinks.Provider>
					</div>
				) : block.kind === 'dispatch' ? (
					<Dispatch key={block.parts[0].toolCallId} parts={block.parts} threads={threads} live={live} />
				) : (
					<ToolBlock key={block.part.toolCallId} part={block.part} space={space} threads={threads} live={live} />
				),
			)}
			<OutputCards items={files} composer={space.id} />
			{live && parts.length === 0 ? (
				<div className="flex items-center gap-2 text-[12px] text-(--text-tertiary)">
					<Spinner size={12} />
					<span>Thinking</span>
				</div>
			) : null}
		</div>
		</OutputLinks.Provider>
	);
});

/** Something you said, or the threads' reports; compared by its parts, as the client gives your messages a new object each chunk. */
const UserEntry = memo(
	function UserEntry({ message, threads }: { message: FlueConversationMessage; threads: Session[] }) {
		const text = textOf(message);
		const reports = useMemo(() => parseReports(text), [text]);
		if (!reports) return <Bubble message={message} />;
		const started = reports.filter((report) => report.started);
		const changed = reports.filter((report) => !report.started);
		return (
			<>
				{started.length ? <StartedRows reports={started} threads={threads} /> : null}
				{changed.length ? <ReportRow reports={changed} threads={threads} /> : null}
			</>
		);
	},
	(prev, next) => prev.message.parts === next.message.parts && prev.threads === next.threads,
);

const STARTERS = ['What is running right now?', 'Split this into threads: ', 'Which pull requests are ready for review?'];

/** The empty project: what the coordinator does, and a few ways to begin. */
function Welcome({ space, onPick }: { space: Space; onPick: (text: string) => void }) {
	return (
		<div className="mt-[6vh] flex flex-col items-center gap-6 text-center">
			<div className="w-full">
				<ProjectRoute space={space} />
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

/** Starts a thread yourself, without the coordinator: a repository (or none, for a chat), a brief, and its model. */
export function NewThreadForm({ space, onDone }: { space: Space; onDone: () => void }) {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const models = useModels();
	const [brief, setBrief] = useState('');
	// null is no repository: the thread works as a chat, as every thread does in a project without repositories.
	const [repoId, setRepoId] = useState<string | null>(space.repos[0]?.id ?? null);
	const [choice, setChoice] = useState<Partial<ModelChoice>>({});
	const [planMode, setPlanMode] = useState(false);
	// A brief carries no pictures, so images go to the project Library as files, like any other.
	const attachments = useAttachments({ imagesAsFiles: true });
	const repo = repoId === null ? undefined : (space.repos.find((item) => item.id === repoId) ?? space.repos[0]);
	const model = choice.model ?? space.threadModel ?? models.data?.default ?? '';
	const start = useMutation({
		mutationFn: async () =>
			api.startThread(space.id, {
				// Files go to the project's Library, where the thread reads them, and the brief carries what they say.
				brief: withAttachments(brief, await Promise.all(attachments.files.map((file) => api.attachToProject(space.id, file.file))), 'project'),
				projectId: repo?.id ?? null,
				model: choice.model ?? undefined,
				reasoning: choice.reasoning ?? undefined,
				planMode: repo ? planMode : false,
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
				if (brief.trim() || attachments.count) start.mutate();
			}}
			{...attachments.dropZone}
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
				onPaste={attachments.onPaste}
				placeholder={
					repo
						? 'What should this thread do? It works on its own branch and reports back to the coordinator.'
						: 'What should this thread do? It works without a repository, in a scratch sandbox when it needs one, and reports back to the coordinator.'
				}
				className="min-h-[72px] px-3.5 pt-2 text-[13.5px] leading-[20px]"
			/>
			<AttachmentTray attachments={attachments} className="px-3.5 pt-2" />
			{attachments.notice ? <div className="px-3.5 pt-2 text-[12px] text-(--warning-text)">{attachments.notice}</div> : null}
			<div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-(--border-subtle) px-3 py-2">
				<ComposerPlus attachments={attachments} label="Attach files to the brief" side="bottom" />
				<Menu>
					<MenuTrigger asChild>
						<PickerChip icon={FolderGit2} label={repo ? repo.repoFullName.split('/').pop()! : 'No repository'} height={26} />
					</MenuTrigger>
					<MenuContent align="start" className="min-w-[220px]">
						<MenuItem checked={!repo} onSelect={() => setRepoId(null)}>
							No repository
						</MenuItem>
						{space.repos.map((item) => (
							<MenuItem key={item.id} checked={item.id === repo?.id} onSelect={() => setRepoId(item.id)}>
								{item.repoFullName}
							</MenuItem>
						))}
					</MenuContent>
				</Menu>
				<ModelPicker value={{ model, reasoning: choice.reasoning ?? null }} onChange={(change) => setChoice((current) => ({ ...current, ...change }))} side="bottom" />
				{/* Plan mode plans changes to code; a thread with no repository has none to plan. */}
				{repo ? <PlanToggle on={planMode} onChange={setPlanMode} /> : null}
				<div className="min-w-0 flex-1" />
				{start.isError ? <span className="text-[12px] text-(--danger-text)">{start.error.message}</span> : null}
				<Btn type="submit" size="sm" variant="primary" icon={Waypoints} disabled={(!brief.trim() && !attachments.count) || start.isPending}>
					{start.isPending ? (attachments.count ? 'Attaching…' : 'Starting…') : 'Start thread'}
				</Btn>
			</div>
		</form>
	);
}

/** The coordinator's message box: what you type goes to the coordinator, which answers or starts threads. */
const CoordinatorComposer = memo(function CoordinatorComposer({
	space,
	busy,
	send,
	draft,
	onDraft,
	onNewThread,
}: {
	space: Space;
	busy: boolean;
	send: UseFlueAgentResult['sendMessage'];
	draft: string;
	onDraft: (text: string) => void;
	onNewThread: () => void;
}) {
	const queryClient = useQueryClient();
	const models = useModels();
	const budget = useQuery({ queryKey: ['budget'], queryFn: () => api.budget(), refetchInterval: SAFETY_NET_MS });
	const blocked = budget.data?.blocked ?? null;
	const [notice, setNotice] = useState<string | null>(null);
	const attachments = useAttachments();
	const { addImages } = attachments;
	// A drawing on a thread's image, from the viewer, joins the draft.
	const inbox = useInbox(space.id);
	useEffect(() => {
		if (!inbox.length) return;
		const drawn = takeFromInbox(space.id).flatMap((item) => (item.kind === 'image' ? [item.image] : []));
		if (drawn.length) addImages(drawn);
	}, [inbox, space.id, addImages]);
	/** What is being attached while a message with files is on its way. */
	const [sending, setSending] = useState<string | null>(null);
	const choice = { model: space.coordinatorModel ?? models.data?.default ?? '', reasoning: space.coordinatorReasoning ?? 'low' };
	const model = models.data?.models.find((item) => item.id === choice.model);
	const blind = attachments.images.length > 0 && model !== undefined && !model.vision;
	const ready = (draft.trim() || attachments.count > 0) && !blocked && !blind && !sending;
	const edit = useMutation({
		mutationFn: (change: Partial<ModelChoice>) =>
			api.editSpace(space.id, {
				...(change.model !== undefined ? { coordinatorModel: change.model, coordinatorReasoning: null } : {}),
				...(change.reasoning !== undefined ? { coordinatorReasoning: change.reasoning } : {}),
			}),
		onSuccess: (updated) => queryClient.setQueryData(['space', space.id], updated),
	});
	const paused = space.state !== 'active';
	const mood = useMascotMood({ busy, waiting: false, stir: draft });
	return (
		<form
			className="shrink-0 px-4 pt-1 pb-4"
			onSubmit={async (event) => {
				event.preventDefault();
				const text = draft.trim();
				if (!ready) return;
				const taken = attachments.take();
				askToNotify();
				onDraft('');
				setNotice(null);
				const count = taken.images.length + taken.files.length;
				setSending(count === 0 ? null : count === 1 ? (taken.files[0]?.name ?? taken.images[0]!.filename) : `${count} files`);
				try {
					// Files go to the project's Library, where the coordinator and every thread read them; the message carries what they say.
					// Images too: the coordinator sees them with the message, and hands them on to the threads it starts by name.
					const attached = await Promise.all([...taken.images.map(imageFile), ...taken.files.map((file) => file.file)].map((file) => api.attachToProject(space.id, file)));
					const saved = await queryClient.fetchQuery({ queryKey: ['commands'], queryFn: api.commands, staleTime: 60_000 });
					const message = withAttachments(expandCommand(text, saved.commands, true), attached, 'project');
					await (taken.images.length ? send(message, { images: deliveredImages(taken.images) }) : send(message));
				} catch (error) {
					onDraft(text);
					attachments.restore(taken);
					setNotice(`Not sent: ${error instanceof Error ? error.message : String(error)}`);
				} finally {
					setSending(null);
				}
			}}
		>
			<div className="in-card relative mx-auto flex max-w-[700px] flex-col gap-2 px-3 pt-3 pb-2 focus-within:border-(--border-strong)" {...attachments.dropZone}>
				<Mascot mood={mood} className="absolute right-5 bottom-[calc(100%-1px)]" />
				<AttachmentTray attachments={attachments} />
				<ComposerInput
					value={draft}
					onChange={onDraft}
					onPaste={attachments.onPaste}
					placeholder={busy ? 'Add to what the coordinator is doing' : `Tell the coordinator what ${space.name} needs`}
				/>
				{blocked || notice ? (
					<div className="text-[12px] text-(--danger-text)">{blocked ?? notice}</div>
				) : blind ? (
					<div className="text-[12px] text-(--warning-text)">{`${model?.name ?? 'This model'} cannot see images. Pick a model marked Vision to send them.`}</div>
				) : sending ? (
					<div className="text-[12px] text-(--text-tertiary)">{`Attaching ${sending}…`}</div>
				) : attachments.notice || paused ? (
					<div className="text-[12px] text-(--warning-text)">{attachments.notice ?? `The project is ${space.state}: new threads wait as queued until it is active again.`}</div>
				) : null}
				<div className="flex flex-nowrap items-center gap-1.5">
					<IconBtn icon={Plus} size="sm" label="Start a thread yourself" onClick={onNewThread} />
					<AttachButton attachments={attachments} />
					<ModelPicker value={choice} onChange={(change) => edit.mutate(change)} />
					{/* Enter sends, as everywhere; the hint speaks up only while the coordinator is busy. */}
					<div className="flex min-w-0 flex-[1_1_8px] items-center justify-end gap-1.5 overflow-hidden text-[11px] whitespace-nowrap text-(--text-disabled) max-sm:invisible">
						{busy ? (
							<>
								<span className="truncate">Send to the coordinator</span>
								<Kbd keys="enter" size="sm" />
							</>
						) : null}
					</div>
					{busy ? <IconBtn icon={Square} size="sm" variant="secondary" label="Stop the coordinator" onClick={() => void api.stopCoordinator(space.id)} /> : null}
					<IconBtn type="submit" icon={Send} size="sm" variant="primary" label="Send message" disabled={!ready} />
				</div>
			</div>
		</form>
	);
});

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
	const messages = useMemo(() => agent.messages.filter((message) => message.settlement || (message.display === 'visible' && message.role !== 'system')), [agent.messages]);
	const lastAssistant = messages.findLast((message) => message.role === 'assistant');
	const newThread = useCallback(() => setStarting(true), [setStarting]);
	const resolveFile = useThreadFileResolver(threads);

	// Kept at the newest content while you are at it; scrolling up to read holds the view still.
	const { following, follow } = useFollowLatest(scroller, { reset: space.id });
	const sendMessage = agent.sendMessage;
	const send = useCallback<UseFlueAgentResult['sendMessage']>(
		(...args) => {
			follow();
			return sendMessage(...args);
		},
		[sendMessage, follow],
	);
	// A new thread's form opens at the bottom, in view.
	useEffect(() => {
		if (starting) follow();
	}, [starting, follow]);

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
						if (message.role === 'user') return <UserEntry key={message.id} message={message} threads={threads} />;
						return <CoordinatorMessage key={message.id} message={message} live={busy && message === lastAssistant} space={space} threads={threads} resolveFile={resolveFile} />;
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
				<JumpToLatest show={!following} live={busy} onJump={follow} />
			</div>
			<CoordinatorComposer space={space} busy={busy} send={send} draft={draft} onDraft={setDraft} onNewThread={newThread} />
		</div>
	);
}

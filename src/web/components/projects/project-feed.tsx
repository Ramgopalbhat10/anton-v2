import { unrouted } from '../../../core/model-route';
import { type FlueConversationMessage, type FlueConversationPart, type UseFlueAgentResult } from '@flue/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { ArrowUp, Bookmark, Check, ChevronRight, CircleAlert, FolderGit2, ListPlus, Plus, Send, Square, Waypoints } from '@/lib/icons';
import { memo, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ComposerPlus } from '@/components/composer/composer-plus';
import { AttachButton, AttachmentTray, SentAttachments, useAttachments } from '@/components/composer/attachments';
import { besidePictures, SentImages, sentPictures } from '@/components/thread/sent-images';
import { ComposerInput } from '@/components/composer/composer-input';
import { PlanToggle } from '@/components/composer/composer';
import { Mascot, useMascotMood } from '@/components/marks/mascot';
import { type PendingChange, PendingMessage, placeholders, SentText, useSends } from '@/components/thread/sent-text';
import { Caption } from '@/components/kit/instrument';
import { InlineLinks, Markdown, OutputLinks } from '@/components/content/markdown';
import { OutputCards } from '@/components/content/output-viewer';
import { ModelPicker } from '@/components/composer/model-picker';
import { useModels } from '@/lib/models';
import { Btn, Icon, IconBtn, Kbd, Menu, MenuContent, MenuItem, MenuTrigger, PickerChip, Spinner } from '@/components/kit/signal';
import { ProjectRoute } from '@/components/projects/project-viz';
import { THREAD_CARD, ThreadChip, ThreadRow, ThreadRows, useOpenThread } from '@/components/projects/thread-card';
import { Glyph, ThreadGlyph } from '@/components/marks/thread-glyph';
import { field } from '@/components/thread/tool-describe';
import { api, SAFETY_NET_MS } from '@/lib/api';
import type { ModelChoice } from '@/lib/api/plans';
import type { Session } from '@/lib/api/sessions';
import type { Space } from '@/lib/api/spaces';
import { expandCommand } from '@/lib/completion';
import { askToNotify } from '@/lib/notifications';
import { takeFromInbox, useInbox } from '@/lib/composer-inbox';
import { useThreadFileResolver } from '@/lib/thread-outputs';
import { openViewer, sameItem, type ViewerItem } from '@/lib/viewer';
import { linkTargets } from '../../../core/outputs';
import { parseReports, type Report, threadsLoaded } from '@/lib/spaces';
import { draftSession, madeAlready, newTaskId, startInBackground, titleFrom } from '@/lib/starting';
import { cn } from '@/lib/utils';
import { useFollowLatest } from '@/lib/use-follow-latest';
import { JumpToLatest } from '@/components/kit/jump-to-latest';
import { deliveredImages, imageFile } from '@/lib/attachments';
import { splitAttachments, withAttachments } from '../../../core/attachments';
import { uniqueUploadNames } from '../../../core/upload-name';

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

const threadIdIn = (part: ToolPart) => (part.state === 'output-available' ? (/\[id:([\w-]+)\]/.exec(outputText(part.output))?.[1] ?? null) : null);

/** A thread named by the start of its id, as reports and the coordinator name them. */
const byPrefix = (threads: Session[], id: string) => threads.find((thread) => thread.id === id || (id.length >= 6 && thread.id.startsWith(id)));

/** Files show as chips; the text they carry is the coordinator's to read. */
function Bubble({ message, composer }: { message: FlueConversationMessage; composer: string }) {
	const { text, files } = splitAttachments(textOf(message));
	const pictures = sentPictures(message);
	return (
		<div className="flex flex-col items-end gap-1.5">
			<SentImages pictures={pictures} composer={composer} />
			<SentAttachments files={besidePictures(files, pictures)} />
			{text ? <SentText text={text} className="max-w-[min(560px,100%)]" /> : null}
		</div>
	);
}

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
				className="group/report flex h-7 max-w-full min-w-0 items-center gap-2 self-start rounded-control bg-(--bg-raised) pr-2.5 pl-1.5 shadow-[inset_0_0_0_1px_var(--line)] text-left text-small text-(--text-3) outline-none hover:bg-(--bg-hover) hover:text-(--text-2) focus-visible:shadow-(--focus)"
			>
				<Icon icon={ChevronRight} size={12} className="text-(--text-3) transition-transform duration-(--t-fast)" style={{ transform: open ? 'rotate(90deg)' : undefined }} />
				<span className="flex shrink-0 items-center -space-x-1">
					{reports.slice(0, 5).map((report, index) => {
						const thread = byPrefix(threads, report.id);
						return (
							<span key={index} className="inline-flex rounded-full bg-(--bg-panel) p-px">
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
						{needs ? <span className="text-(--warn)"> · {needs} need you</span> : null}
					</span>
				)}
			</button>
			{open ? (
				<div className="ml-3 flex flex-col gap-1 border-l border-(--line) py-1 pl-3">
					{reports.map((report, index) => {
						const thread = byPrefix(threads, report.id);
						return (
							<button
								key={index}
								type="button"
								disabled={!thread}
								onClick={() => thread && openThread(thread)}
								className="flex min-w-0 items-start gap-2 rounded-control px-1.5 py-1 text-left outline-none hover:bg-(--bg-hover) focus-visible:shadow-(--focus)"
							>
								<span className="mt-[3px] inline-flex">{thread ? <ThreadGlyph thread={thread} size={12} /> : <Glyph kind={report.state} size={12} />}</span>
								<span className="flex min-w-0 flex-col">
									<span className="truncate text-body text-(--text)">{report.title}</span>
									{report.text ? <span className="line-clamp-2 text-small leading-[17px] text-(--text-3)">{report.text}</span> : null}
								</span>
							</button>
						);
					})}
				</div>
			) : null}
		</div>
	);
}

/** Threads you or a routine started: a line saying who, over the same live card the coordinator's threads get. A deleted thread leaves the card. */
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

function ActionRow({ icon, children, failed }: { icon: typeof Send; children: ReactNode; failed?: boolean }) {
	return (
		<div className={cn('flex min-w-0 items-center gap-2 px-1 text-small', failed ? 'text-(--bad)' : 'text-(--text-3)')}>
			<Icon icon={failed ? CircleAlert : icon} size={12} className={failed ? undefined : 'text-(--text-3)'} />
			<span className="min-w-0 break-words">{children}</span>
		</div>
	);
}

/** One quiet pill that opens to what the coordinator wrote, so a long message stays out of the conversation's way. */
function NoteRow({ icon, failed, text, thread, children }: { icon: typeof Send; failed?: boolean; text: string; thread?: Session; children: ReactNode }) {
	const [open, setOpen] = useState(false);
	const openThread = useOpenThread();
	return (
		<div className="flex min-w-0 flex-col gap-1">
			<button
				type="button"
				aria-expanded={open}
				disabled={!text}
				onClick={() => setOpen((current) => !current)}
				className={cn(
					'flex h-7 max-w-full min-w-0 items-center gap-2 self-start rounded-control bg-(--bg-raised) pr-2.5 pl-1.5 text-left text-small shadow-[inset_0_0_0_1px_var(--line)] outline-none hover:bg-(--bg-hover) focus-visible:shadow-(--focus)',
					failed ? 'text-(--bad)' : 'text-(--text-3) hover:text-(--text-2)',
				)}
			>
				<Icon icon={ChevronRight} size={12} className="shrink-0 text-(--text-3) transition-transform duration-(--t-fast)" style={{ transform: open ? 'rotate(90deg)' : undefined }} />
				<Icon icon={failed ? CircleAlert : icon} size={12} className={cn('shrink-0', !failed && 'text-(--text-3)')} />
				<span className="min-w-0 truncate">{children}</span>
			</button>
			{open ? (
				<div className="ml-3 flex flex-col items-start gap-1.5 border-l border-(--line) py-1 pl-3">
					<p className="m-0 max-h-60 max-w-full overflow-y-auto text-small leading-[18px] break-words whitespace-pre-wrap text-(--text-2)">{text}</p>
					{thread ? (
						<button type="button" onClick={() => openThread(thread)} className="rounded-inner text-small text-(--text-3) outline-none hover:text-(--text) focus-visible:shadow-(--focus)">
							Open the thread
						</button>
					) : null}
				</div>
			) : null}
		</div>
	);
}

type Suggestion = { title: string; brief: string; repo?: string };

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
				<Icon icon={ListPlus} size={13} className="text-(--text-3)" />
				<span className="flex-1 text-body font-medium">Suggested threads</span>
				<Caption>{suggestions.length} proposed</Caption>
			</header>
			<ol className="m-0 flex list-none flex-col p-0">
				{suggestions.map((suggestion, index) => {
					const threadId = started[index];
					const thread = threadId ? data?.sessions.find((session) => session.id === threadId) : undefined;
					return (
						<li key={index} className="flex items-start gap-3 border-t border-(--line) px-3.5 py-2.5">
							<span className="in-num mt-px w-4 shrink-0 text-micro text-(--text-4)">{String(index + 1).padStart(2, '0')}</span>
							<div className="flex min-w-0 flex-1 flex-col gap-0.5">
								<span className="truncate text-body text-(--text)">{suggestion.title}</span>
								<span className="line-clamp-2 text-small leading-[17px] text-(--text-3)">{suggestion.brief}</span>
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
				<footer className="flex items-center justify-between gap-2 border-t border-(--line) px-3.5 py-2">
					<Caption>{start.isError ? <span className="text-(--bad)">{start.error.message}</span> : `Up to ${space.maxParallel} work at once; the rest queue`}</Caption>
					<Btn size="sm" variant="primary" disabled={start.isPending} onClick={() => start.mutate(left)}>
						Start all {left.length}
					</Btn>
				</footer>
			) : null}
		</section>
	);
}

function Starting({ part }: { part: ToolPart }) {
	const failed = part.state === 'output-error';
	// The title streams in with the coordinator's call; until it does, a bar stands in for it.
	const title = field(part.input, 'title');
	return (
		<div aria-busy={!failed} className={cn(THREAD_CARD, 'min-h-9 justify-center')}>
			<div className="flex min-h-6 min-w-0 items-center gap-2.5">
				{failed ? <Icon icon={CircleAlert} size={14} className="text-(--bad)" /> : <Spinner size={13} />}
				{failed ? (
					<span className="min-w-0 truncate text-body text-(--bad)">Could not start “{title || 'a thread'}”</span>
				) : title ? (
					<span className="min-w-0 truncate text-body text-(--text)">{title}</span>
				) : (
					<span aria-hidden className="in-pulse h-2.5 w-[140px] rounded-full bg-(--bg-active)" />
				)}
				{failed ? null : <span className="in-shimmer shrink-0 text-small">Starting</span>}
			</div>
		</div>
	);
}

/** Several threads started at once read as one batch. One the reply being written just started may not be listed yet, so it shows as starting until it is. */
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
				// A thread deleted since is gone from the list; the coordinator then starts a new one.
				<NoteRow icon={Send} failed={failed} thread={target} text={field(part.input, 'message')}>
					{failed ? 'Not sent' : 'Sent'} to <span className="text-(--text-2)">{target?.title ?? (failed ? 'a deleted thread' : 'a thread')}</span>
				</NoteRow>
			);
		case 'remember':
			return (
				<NoteRow icon={Bookmark} failed={failed} text={field(part.input, 'note')}>
					Saved to memory
				</NoteRow>
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
					<div key={block.key} className="text-body-lg leading-[21px]">
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
				<div className="flex items-center gap-2 text-small text-(--text-3)">
					<Spinner size={12} />
					<span>Thinking</span>
				</div>
			) : null}
		</div>
		</OutputLinks.Provider>
	);
});

/** Compared by its parts, as the client gives your messages a new object each chunk. */
const UserEntry = memo(
	function UserEntry({ message, threads, composer }: { message: FlueConversationMessage; threads: Session[]; composer: string }) {
		const text = textOf(message);
		const reports = useMemo(() => parseReports(text), [text]);
		if (!reports) return <Bubble message={message} composer={composer} />;
		const started = reports.filter((report) => report.started);
		const changed = reports.filter((report) => !report.started);
		return (
			<>
				{started.length ? <StartedRows reports={started} threads={threads} /> : null}
				{changed.length ? <ReportRow reports={changed} threads={threads} /> : null}
			</>
		);
	},
	(prev, next) => prev.message.parts === next.message.parts && prev.threads === next.threads && prev.composer === next.composer,
);

const STARTERS = ['What is running right now?', 'Split this into threads: ', 'Which pull requests are ready for review?'];

function Welcome({ space, onPick }: { space: Space; onPick: (text: string) => void }) {
	return (
		<div className="mt-[6vh] flex flex-col items-center gap-6 text-center">
			<div className="w-full">
				<ProjectRoute space={space} />
			</div>
			<div className="flex max-w-[52ch] flex-col items-center gap-1.5">
				<h1 className="m-0 text-h2 leading-[26px] font-semibold tracking-[-0.015em]">{space.name}</h1>
				<p className="m-0 text-body leading-[19px] text-pretty text-(--text-3)">
					{space.goal || 'Describe the work. The coordinator splits it into threads that run in parallel, each on its own branch and sandbox, and reports back here.'}
				</p>
			</div>
			<div className="flex flex-wrap justify-center gap-1.5">
				{STARTERS.map((starter) => (
					<button
						key={starter}
						type="button"
						onClick={() => onPick(starter)}
						className="h-6 rounded-control px-2 text-small text-(--text-2) shadow-[inset_0_0_0_1px_var(--line-strong)] outline-none transition-colors duration-(--t-fast) hover:bg-(--bg-hover) hover:text-(--text) focus-visible:shadow-(--focus)"
					>
						{starter.trim()}
					</button>
				))}
			</div>
		</div>
	);
}

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
	// The thread opens at once, as a skeleton while the server makes it and gives it its slot.
	function start() {
		const id = newTaskId();
		const files = attachments.files;
		const input = { id, projectId: repo?.id ?? null, model: choice.model ?? undefined, reasoning: choice.reasoning ?? undefined, planMode: repo ? planMode : false };
		const draft = draftSession({ id, title: titleFrom(brief.trim() || files[0]?.name || 'New thread'), prompt: brief, projectId: repo?.id, repo: repo?.repoFullName, model, reasoning: choice.reasoning, planMode, spaceId: space.id });
		startInBackground(queryClient, draft, brief, async () =>
			api
				.startThread(space.id, {
					...input,
					// Files go to the project's Library, where the thread reads them, and the brief carries what they say.
					brief: withAttachments(brief, await Promise.all(files.map((file) => api.attachToProject(space.id, file.file))), 'project'),
				})
				.catch((error: unknown) => madeAlready(id, error, api.session)),
		);
		onDone();
		void navigate({ to: '/projects/$spaceId/threads/$threadId', params: { spaceId: space.id, threadId: id } });
	}
	return (
		<form
			className="composer relative mx-auto flex w-full max-w-[720px] flex-col"
			onSubmit={(event) => {
				event.preventDefault();
				if (brief.trim() || attachments.count) start();
			}}
			{...attachments.dropZone}
		>
			<div className="flex items-center gap-2 px-3.5 pt-3">
				<Caption className="flex-1">New thread in {space.name}</Caption>
				<button type="button" onClick={onDone} className="text-small text-(--text-3) hover:text-(--text)">
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
				className="min-h-[72px] px-3.5 pt-2 text-body-lg leading-[20px]"
			/>
			<AttachmentTray attachments={attachments} className="px-3.5 pt-2" />
			{attachments.notice ? <div className="px-3.5 pt-2 text-small text-(--warn)">{attachments.notice}</div> : null}
			<div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-(--line) px-3 py-2">
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
				<Btn type="submit" size="sm" variant="primary" icon={Waypoints} disabled={!brief.trim() && !attachments.count}>
					Start thread
				</Btn>
			</div>
		</form>
	);
}

const CoordinatorComposer = memo(function CoordinatorComposer({
	space,
	busy,
	send,
	draft,
	onDraft,
	onNewThread,
	onPending,
}: {
	space: Space;
	busy: boolean;
	send: UseFlueAgentResult['sendMessage'];
	draft: string;
	onDraft: (text: string) => void;
	onNewThread: () => void;
	onPending: (change: PendingChange) => void;
}) {
	const queryClient = useQueryClient();
	const models = useModels();
	const budget = useQuery({ queryKey: ['budget'], queryFn: () => api.budget(), refetchInterval: SAFETY_NET_MS });
	const blocked = budget.data?.blocked ?? null;
	const [notice, setNotice] = useState<string | null>(null);
	const draftRef = useRef(draft);
	draftRef.current = draft;
	const attachments = useAttachments();
	const { addImages } = attachments;
	const inbox = useInbox(space.id);
	useEffect(() => {
		if (!inbox.length) return;
		const drawn = takeFromInbox(space.id).flatMap((item) => (item.kind === 'image' ? [item.image] : []));
		if (drawn.length) addImages(drawn);
	}, [inbox, space.id, addImages]);
	const [sending, setSending] = useState<string | null>(null);
	const choice = { model: space.coordinatorModel ?? models.data?.default ?? '', reasoning: space.coordinatorReasoning ?? 'low' };
	const model = models.data?.models.find((item) => item.id === unrouted(choice.model));
	const blind = attachments.images.length > 0 && model !== undefined && !model.vision;
	const ready = (draft.trim() || attachments.count > 0) && !blocked && !blind && !sending && !attachments.limitError;
	const edit = useMutation({
		mutationFn: (change: Partial<ModelChoice>) =>
			api.editSpace(space.id, {
				...(change.model !== undefined ? { coordinatorModel: change.model } : {}),
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
				draftRef.current = '';
				onDraft('');
				setNotice(null);
				const count = taken.images.length + taken.files.length;
				const attaching = count === 0 ? null : count === 1 ? (taken.files[0]?.name ?? taken.images[0]!.filename) : `${count} files`;
				setSending(attaching);
				// The message shows in the feed at once; it goes once its files are in the project's Library.
				if (attaching) onPending({ text, attaching, ...placeholders(taken) });
				try {
					// Files go to the project's Library, where the coordinator and every thread read them; the message carries what they say.
					// Images too: the coordinator sees them with the message, and hands them on to the threads it starts by name.
					const uploads = [...taken.images.map(imageFile), ...taken.files.map((file) => file.file)];
					const names = uniqueUploadNames(uploads.map((file) => file.name));
					const named = uploads.map((file, index) => file.name === names[index] ? file : new File([file], names[index]!, { type: file.type, lastModified: file.lastModified }));
					const attached = await Promise.all(named.map((file) => api.attachToProject(space.id, file)));
					const images = taken.images.map((image, index) => ({ ...image, filename: names[index]! }));
					// Saved commands are read only for a message that starts with one, so any other goes out without a round trip.
					const saved = text.trim().startsWith('/') ? await queryClient.fetchQuery({ queryKey: ['commands'], queryFn: api.commands, staleTime: 60_000 }) : { commands: [] };
					const message = withAttachments(expandCommand(text, saved.commands, true), attached, 'project');
					if (attaching) onPending('sent');
					await (images.length ? send(message, { images: deliveredImages(images) }) : send(message));
				} catch (error) {
					onDraft([text, draftRef.current].filter(Boolean).join('\n\n'));
					attachments.restore(taken);
					setNotice(`Not sent: ${error instanceof Error ? error.message : String(error)}`);
				} finally {
					onPending(null);
					setSending(null);
				}
			}}
		>
			<div className="composer relative mx-auto flex max-w-[720px] flex-col gap-2 px-3 pt-3 pb-2" {...attachments.dropZone}>
				<Mascot mood={mood} className="absolute right-5 bottom-[calc(100%-1px)]" />
				<AttachmentTray attachments={attachments} />
				<ComposerInput
					value={draft}
					onChange={(text) => { draftRef.current = text; onDraft(text); }}
					onPaste={attachments.onPaste}
					placeholder={busy ? 'Add to what the coordinator is doing' : `Tell the coordinator what ${space.name} needs`}
				/>
				{blocked || notice || attachments.limitError ? (
					<div className="text-small text-(--bad)">{[blocked ?? notice, attachments.limitError].filter(Boolean).join(' ')}</div>
				) : blind ? (
					<div className="text-small text-(--warn)">{`${model?.name ?? 'This model'} cannot see images. Pick a model marked Vision to send them.`}</div>
				) : attachments.limitError || attachments.notice || paused ? (
					<div className="text-small text-(--warn)">{attachments.limitError ?? attachments.notice ?? `The project is ${space.state}: new threads wait as queued until it is active again.`}</div>
				) : null}
				<div className="flex flex-nowrap items-center gap-1.5">
					<IconBtn icon={Plus} size="sm" label="Start a thread yourself" onClick={onNewThread} />
					<AttachButton attachments={attachments} />
					<ModelPicker value={choice} onChange={(change) => edit.mutate(change)} />
					<div className="flex min-w-0 flex-[1_1_8px] items-center justify-end gap-1.5 overflow-hidden text-micro whitespace-nowrap text-(--text-4) max-sm:invisible">
						{busy ? (
							<>
								<span className="truncate">Send to the coordinator</span>
								<Kbd keys="enter" size="sm" />
							</>
						) : null}
					</div>
					{busy ? <IconBtn icon={Square} variant="secondary" label="Stop the coordinator" onClick={() => void api.stopCoordinator(space.id)} /> : null}
					<IconBtn type="submit" icon={ArrowUp} variant="inverse" label="Send message" disabled={!ready} />
				</div>
			</div>
		</form>
	);
});

export function ProjectFeed({
	space,
	agent,
	threads,
	onStartingChange: setStarting,
}: {
	space: Space;
	agent: UseFlueAgentResult;
	threads: Session[];
	onStartingChange: (starting: boolean) => void;
}) {
	const scroller = useRef<HTMLDivElement>(null);
	const [draft, setDraft] = useState('');
	const busy = agent.status === 'submitted' || agent.status === 'streaming';
	const messages = useMemo(() => agent.messages.filter((message) => message.settlement || (message.display === 'visible' && message.role !== 'system')), [agent.messages]);
	const lastAssistant = messages.findLast((message) => message.role === 'assistant');
	const newThread = useCallback(() => setStarting(true), [setStarting]);
	const resolveFile = useThreadFileResolver(threads);
	const { pending, onPending, rises } = useSends();

	const { following, follow } = useFollowLatest(scroller, { reset: space.id });
	const sendMessage = agent.sendMessage;
	const send = useCallback<UseFlueAgentResult['sendMessage']>(
		(...args) => {
			follow();
			return sendMessage(...args);
		},
		[sendMessage, follow],
	);
	const showPending = useCallback(
		(change: PendingChange) => {
			if (change && change !== 'sent') follow();
			onPending(change);
		},
		[onPending, follow],
	);
	return (
		<div className="flex min-h-0 min-w-0 flex-1 flex-col">
			<div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-4 pt-2 pb-2">
				<div className="mx-auto flex max-w-[720px] flex-col gap-5">
					{messages.length === 0 && !busy && agent.historyReady ? <Welcome space={space} onPick={setDraft} /> : null}
					{messages.map((message) => {
						if (message.settlement) {
							return (
								<ActionRow key={message.id} icon={CircleAlert} failed>
									{textOf(message).trim() || `The coordinator ${message.settlement.outcome === 'aborted' ? 'was stopped' : 'failed'}. Send the message again to retry.`}
								</ActionRow>
							);
						}
						if (message.role === 'user')
							return rises(message.id, false) ? (
								<div key={message.id} className="in-sent flex flex-col gap-5">
									<UserEntry message={message} threads={threads} composer={space.id} />
								</div>
							) : (
								<UserEntry key={message.id} message={message} threads={threads} composer={space.id} />
							);
						return <CoordinatorMessage key={message.id} message={message} live={busy && message === lastAssistant} space={space} threads={threads} resolveFile={resolveFile} />;
					})}
					{pending ? <PendingMessage pending={pending} /> : null}
					{busy && messages[messages.length - 1]?.role !== 'assistant' ? (
						<div className="flex items-center gap-2 text-small text-(--text-2)">
							<Spinner size={12} />
							<span>The coordinator is reading</span>
						</div>
					) : null}
					{agent.status === 'error' && !messages.some((message) => message.settlement) ? (
						<ActionRow icon={CircleAlert} failed>
							{agent.error?.message ? `The coordinator failed: ${agent.error.message}` : 'The coordinator failed. Send the message again.'}
						</ActionRow>
					) : null}
				</div>
				<JumpToLatest show={!following} live={busy} onJump={follow} />
			</div>
			<CoordinatorComposer space={space} busy={busy} send={send} draft={draft} onDraft={setDraft} onNewThread={newThread} onPending={showPending} />
		</div>
	);
}

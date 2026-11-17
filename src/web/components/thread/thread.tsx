import type { FlueConversationMessage, UseFlueAgentResult } from '@flue/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Clock } from '@/lib/icons';
import { memo, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { field } from '@/components/thread/tool-describe';
import { Composer } from '@/components/composer/composer';
import { ErrorBoundary } from '@/components/kit/error-boundary';
import { FileLinks, Markdown, OutputLinks } from '@/components/content/markdown';
import { type PendingChange, PendingMessage, SentText, useSends } from '@/components/thread/sent-text';
import { OutputCards } from '@/components/content/output-viewer';
import { AskCard, ChangesCard, PullRequestCard, type ReplyPlace, ReplyActions } from '@/components/thread/reply-cards';
import { ShowCard } from '@/components/thread/show-card';
import { approvalOf, MailSendCard } from '@/components/thread/mail-card';
import { toolApprovalOf, ToolApprovalCard } from '@/components/thread/tool-approval-card';
import { SandboxArt } from '@/components/marks/illustrations';
import { WorkingLogo } from '@/components/marks/working-logo';
import { useReplyActivity } from '@/lib/reply-activity';
import { Badge, EmptyState, Icon } from '@/components/kit/signal';
import { TraceButton, TraceModal } from '@/components/thread/trace-modal';
import { branchLabel, isChat, type Join, type WaitingMessage } from '@/lib/api/sessions';
import { api } from '@/lib/api';
import { deliveredImages, type ImageAttachment } from '@/lib/attachments';
import { splitAttachments } from '../../../core/attachments';
import { addToComposer } from '@/lib/composer-inbox';
import { peekPendingPrompt, takePendingPrompt } from '@/lib/pending-prompt';
import { openingPrompt } from '@/lib/starting';
import { HistorySkeleton, ReplySkeleton } from '@/components/thread/starting-task';
import { cn } from '@/lib/utils';
import { FOLLOW_SLACK, useFollowLatest } from '@/lib/use-follow-latest';
import { JumpToLatest } from '@/components/kit/jump-to-latest';
import { ChatNavigation } from '@/components/thread/chat-navigation';
import { focusFile, ShowPanel } from '@/lib/workspace';
import { openViewer, type ViewerItem } from '@/lib/viewer';
import { messageText, placeJoined, type ThreadRow } from '@/lib/joined';
import { outputLinkPath } from '../../../core/outputs';
import { taskQueries } from '@/lib/task-queries';
import { type Block, changedPaths, openedPullRequest, proposesPlan, replyOutputs, toBlocks } from '@/components/thread/blocks';
import { SessionId } from '@/components/thread/session-context';
import { StepsCard } from '@/components/thread/steps';
import { ApproveBar, PlanCard } from '@/components/thread/plan-card';
import { CompactionMark, compactionsOf, UserMessage } from '@/components/thread/user-message';
import { CopyResponse, ReplyUsageLine, usageOf } from '@/components/thread/reply-usage';
import { AgentsBlock, Drawing, ImageBlock, Notice, PageBlock, SettlementNotice } from '@/components/thread/reply-blocks';
import { Waiting } from '@/components/thread/waiting';

/** The runtime lists a message sent while the agent works after the whole reply, so it says so rather than read as a message nobody answered. */
const JOINING = 'Anton reads this between its steps';
const JOINED = 'Read while Anton worked on the reply above';
const JOINED_HERE = 'Sent while Anton worked, read here';

type AssistantMessageProps = {
	message: FlueConversationMessage;
	live: boolean;
	working: boolean;
	last: boolean;
	answer: string | null;
	/** The stretch shown, when a message sent while it worked cut the reply: the header goes on its first, the cards and usage on its last. */
	segment?: ThreadRow['segment'];
	showWorkspaceChanges: boolean;
	/** A conversation born on this page: each reply fades in as it arrives, history does not replay it. */
	enter?: boolean;
};

/** One that fails to draw says so in its place, and the rest of the conversation stays. */
const AssistantMessage = memo(function AssistantMessage(props: AssistantMessageProps) {
	return (
		<ErrorBoundary label="This reply">
			<Reply {...props} />
		</ErrorBoundary>
	);
});

function Reply({ message, live, working, last, answer, segment, showWorkspaceChanges, enter }: AssistantMessageProps) {
	const blocks = useMemo(() => toBlocks(segment?.parts ?? message.parts), [segment?.parts, message.parts]);
	const head = !segment || segment.first;
	const foot = !segment || segment.last;
	const place = useMemo<ReplyPlace>(() => ({ latest: last, answer }), [last, answer]);
	const changed = useMemo(() => (live ? [] : changedPaths(message.parts)), [live, message.parts]);
	const pull = useMemo(() => (live ? null : openedPullRequest(message.parts)), [live, message.parts]);
	const sessionId = useContext(SessionId);
	// The files it made show as cards once it is whole, so a half-written link never loads.
	const library = useQuery({ ...taskQueries.outputs(sessionId), staleTime: 30_000, enabled: !live });
	const kept = useMemo(() => (library.data ? new Set(library.data.outputs.map((output) => output.path)) : null), [library.data]);
	const deleted = useMemo(() => new Set(library.data?.deleted ?? []), [library.data]);
	const made = useMemo<ViewerItem[]>(
		() => (live ? [] : replyOutputs(message.parts, kept, deleted).map((path) => ({ sessionId, path }))),
		[live, message.parts, sessionId, kept, deleted],
	);
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
	const traceId = typeof message.metadata?.traceId === 'string' ? message.metadata.traceId : null;
	const [tracing, setTracing] = useState(false);
	const openTrace = useCallback(() => setTracing(true), []);
	const compactions = foot ? compactionsOf(message) : [];
	// This is the whole response's wall time, including model thinking, not tool execution time.
	const duration = typeof message.metadata?.durationMs === 'number' ? message.metadata.durationMs : undefined;
	const firstTrace = blocks.findIndex((block) => block.kind === 'steps');
	const whole = useMemo(() => (segment ? toBlocks(message.parts) : blocks), [segment, message.parts, blocks]);
	const copyText = whole.flatMap((block) => (block.kind === 'text' ? [block.text] : block.kind === 'plan' ? [field(block.part.input, 'plan')] : copiedText(block))).join('\n\n');
	if (blocks.length === 0 && !(live && foot) && !(working && head)) return null;
	return (
		<OutputLinks.Provider value={outputLinks}>
		<div className={cn('group/reply flex flex-col gap-3', enter && 'in-enter', !live && !last && 'thread-row-settled')}>
			{head ? (
				<div className="flex items-center gap-2">
					<WorkingLogo active={working} />
					<div className="text-small font-medium text-(--text-3)">Anton</div>
					{live ? <Badge tone="accent">Live</Badge> : null}
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
				) : block.kind === 'toolapproval' ? (
					toolApprovalOf(block.part.output) ? (
						<ToolApprovalCard key={block.part.toolCallId} sessionId={sessionId} approvalId={toolApprovalOf(block.part.output)!} place={place} />
					) : (
						<Drawing key={block.part.toolCallId} what="Preparing the call" />
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
			{foot && showWorkspaceChanges ? <ChangesCard sessionId={sessionId} /> : foot && changed.length ? <ChangesCard sessionId={sessionId} paths={changed} /> : null}
			{foot && !live ? (
				// Copy and usage stay on the latest reply; earlier ones show them on hover.
				<div className={cn('flex items-center gap-1.5', !last && 'opacity-0 transition-opacity duration-(--t-fast) group-focus-within/reply:opacity-100 group-hover/reply:opacity-100')}>
					<CopyResponse text={copyText} />
					{traceId ? <TraceButton onOpen={openTrace} /> : null}
					{usage ? <ReplyUsageLine usage={usage} onTrace={traceId ? openTrace : undefined} /> : null}
				</div>
			) : null}
			{tracing && traceId ? <TraceModal sessionId={sessionId} traceId={traceId} onClose={() => setTracing(false)} /> : null}
			{compactions.map((compaction) => (
				<CompactionMark key={compaction.at} compaction={compaction} />
			))}
		</div>
		</OutputLinks.Provider>
	);
}

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

const textOf = (message: FlueConversationMessage) => messageText(message).trim();

function openingMessage(text: string): FlueConversationMessage {
	return { id: 'opening', role: 'user', display: 'visible', parts: [{ type: 'text', text, state: 'done' }] } as FlueConversationMessage;
}
const NO_JOINS: Join[] = [];
const NO_WAITING: WaitingMessage[] = [];
/** Ids for messages known only as waiting, apart from any the runtime gives. */
const WAITING_PREFIX = 'waiting:';
const waitingMessage = (message: WaitingMessage): FlueConversationMessage => ({
	id: `${WAITING_PREFIX}${message.id}`,
	role: 'user',
	purpose: 'user',
	display: 'visible',
	submissionId: message.id,
	parts: [{ type: 'text', text: message.text, state: 'done' }],
});
const rowKey = (row: ThreadRow) => row.segment?.key ?? row.message.id;
/** How long the thread trusts a file list nothing has marked stale. */
const FILE_LINKS_FRESH_MS = 30_000;

/** Every tool call marks the file list stale; the thread reads only what is cached, fetching on open and when a reply starts or ends, and takes the Files panel's fresher list while it is open. */
function useThreadFileLinks(sessionId: string, busy: boolean): FileLinks {
	const showPanel = useContext(ShowPanel);
	const queryClient = useQueryClient();
	const files = useQuery({ ...taskQueries.files(sessionId), enabled: false });
	useEffect(() => {
		void queryClient.prefetchQuery({ ...taskQueries.files(sessionId), staleTime: FILE_LINKS_FRESH_MS });
	}, [queryClient, sessionId, busy]);
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

export function Thread({ sessionId, agent, composer, fresh }: { sessionId: string; agent: UseFlueAgentResult; composer?: ReactNode; fresh?: boolean }) {
	const health = useQuery({ queryKey: ['health'], queryFn: api.health });
	const session = useQuery(taskQueries.session(sessionId));
	const scroller = useRef<HTMLDivElement>(null);
	const busy = agent.status === 'submitted' || agent.status === 'streaming';
	const { conversation, working, reply: workingReply } = useReplyActivity(agent);
	// The runtime lists a message sent while Anton works only once Anton reads it; until then only the page that
	// sent it shows it, so a thread opened again gets the ones still waiting from the server.
	const unreadByServer = useQuery(taskQueries.waiting(sessionId)).data?.messages ?? NO_WAITING;
	const messages = useMemo(() => {
		const shown = conversation
			.filter((message) => message.settlement || (message.display === 'visible' && message.role !== 'system'))
			// One Stop settles the reply and every message queued behind it; it reads as one stop.
			.filter((message, index, list) => !(message.settlement?.outcome === 'aborted' && list[index - 1]?.settlement?.outcome === 'aborted'));
		// This page's own sends show until the runtime lists them, by their words before they have an id.
		const listed = new Set(shown.flatMap((message) => (message.role !== 'user' ? [] : message.submissionId ? [message.submissionId] : [textOf(message)])));
		const unread = unreadByServer.filter((message) => !listed.has(message.id) && !listed.has(message.text.trim()));
		return unread.length ? [...shown, ...unread.map(waitingMessage)] : shown;
	}, [conversation, unreadByServer]);
	const repo = session.data && !isChat(session.data) ? session.data.repo : undefined;
	const branch = session.data ? branchLabel(session.data) : undefined;
	const meta = useMemo(() => (repo && branch ? [repo, branch] : []), [repo, branch]);
	const lastAssistant = messages.findLast((message) => message.role === 'assistant');
	// A finished reply carries its usage; the latest one without it is the one being written.
	const liveReply = busy && lastAssistant && !lastAssistant.metadata?.usage ? lastAssistant : undefined;
	// What the reply being written ends on: a steps card's header says what the agent is doing, and streaming text shows itself.
	const tail = useMemo(() => (liveReply ? (toBlocks(liveReply.parts).at(-1)?.kind ?? null) : null), [liveReply?.parts]);
	const settlements = agent.settlements;
	const joins = useQuery(taskQueries.joins(sessionId)).data?.joins ?? NO_JOINS;
	const answeredBy = useMemo(() => new Map(settlements.map((settlement) => [settlement.submissionId, settlement.answeredBySubmissionId])), [settlements]);
	const rows = useMemo(() => placeJoined(messages, joins, answeredBy, workingReply), [messages, joins, answeredBy, workingReply]);
	const notes = useMemo(() => {
		const live = liveReply ? messages.indexOf(liveReply) : -1;
		const map = new Map<string, string>();
		for (const row of rows) {
			const message = row.message;
			if (message.role !== 'user') continue;
			if (message.id.startsWith(WAITING_PREFIX)) {
				map.set(message.id, JOINING);
				continue;
			}
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
	const { following, follow, release } = useFollowLatest(scroller, { reset: sessionId });
	const navigateToInput = useCallback((id: string) => {
		const el = scroller.current;
		const target = el && Array.from(el.querySelectorAll<HTMLElement>('[data-chat-input]')).find((node) => node.dataset.chatInput === id);
		if (!el || !target) return;
		const top = el.scrollTop + target.getBoundingClientRect().top - el.getBoundingClientRect().top - 12;
		const bottom = Math.max(0, el.scrollHeight - el.clientHeight);
		// A short conversation or a target near the end cannot move away from the
		// bottom. Keep following even when no scroll event will be fired.
		if (Math.max(0, Math.min(top, bottom)) >= bottom - FOLLOW_SLACK) {
			follow();
			return;
		}
		release();
		const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
		el.scrollTo({ top, behavior: reduced ? 'auto' : 'smooth' });
		// Rows that were never on screen count at an estimate until drawn (`.thread-row-settled`); once the
		// scroll ends among them, land on the message itself.
		const land = () => {
			const off = target.getBoundingClientRect().top - el.getBoundingClientRect().top - 12;
			if (Math.abs(off) > 2) el.scrollTo({ top: el.scrollTop + off });
		};
		el.addEventListener('scrollend', land, { once: true });
		setTimeout(() => el.removeEventListener('scrollend', land), 3000);
	}, [follow, release]);
	const send = agent.sendMessage;
	const actions = useMemo<ReplyActions>(
		() => ({
			send: (text: string) => {
				follow();
				void send(text);
			},
			busy,
		}),
		[send, busy, follow],
	);
	const fileLinks = useThreadFileLinks(sessionId, busy);
	const planned = Boolean(session.data?.planMode) && !busy && proposesPlan(messages[messages.length - 1]);

	const { pending, onPending, rises } = useSends();
	// Read as the page draws, so a task or thread you just started shows what you asked from its first frame,
	// as the page it opened from did, until the conversation lists it.
	const firstPrompt = messages.length === 0 ? (peekPendingPrompt(sessionId) ?? openingPrompt(sessionId)) : undefined;
	// A task this page just made has no history to wait for: its first message goes at once, as its history loads.
	const sentEarly = useRef<Promise<void> | null>(null);
	useEffect(() => {
		if (!agent.historyReady && openingPrompt(sessionId) === undefined) return;
		const pending = takePendingPrompt(sessionId);
		if (!pending) return;
		const sent = pending.images.length ? agent.sendMessage(pending.prompt, { images: deliveredImages(pending.images) }) : agent.sendMessage(pending.prompt);
		if (!agent.historyReady) sentEarly.current = sent;
		void sent.catch(() => undefined);
	}, [agent.historyReady, agent.sendMessage, sessionId]);
	// Its history may have been read before the message made the conversation, which then reads as absent and
	// is not followed; once both are in, it is read again.
	const refresh = agent.refresh;
	useEffect(() => {
		const sent = sentEarly.current;
		if (!agent.historyReady || !sent) return;
		sentEarly.current = null;
		void sent.then(refresh, () => undefined);
	}, [agent.historyReady, refresh]);

	const onSend = useCallback(
		(text: string, images: ImageAttachment[]) => {
			follow();
			return agent.sendMessage(text, { images: deliveredImages(images) });
		},
		[agent.sendMessage, follow],
	);
	const showPending = useCallback(
		(change: PendingChange) => {
			if (change && change !== 'sent') follow();
			onPending(change);
		},
		[onPending, follow],
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
				<div className="relative min-h-0 flex-1">
				<ChatNavigation rows={rows} onNavigate={navigateToInput} />
				<div ref={scroller} className="h-full overflow-y-auto pt-2 pr-6 pb-1 pl-4">
					<div className="thread-rows mx-auto flex max-w-[720px] flex-col gap-5">
						{health.data && !health.data.openRouter ? (
							<div className="rounded-card border border-(--warn-line) bg-(--warn-soft) px-3 py-2 text-small leading-[18px] text-(--warn)">
								Add an OpenRouter key under Settings › Subscriptions to run OpenRouter models. Models on a plan, Changes, Files, Library and Terminal still work.
							</div>
						) : null}
						{firstPrompt ? (
							<div className="flex flex-col gap-5">
								<UserMessage message={openingMessage(firstPrompt)} meta={meta} />
								{busy ? null : session.data?.threadState === 'queued' ? (
									<div className="flex items-center gap-2 text-small text-(--text-3)">
										<Icon icon={Clock} size={12} className="text-(--text-3)" />
										Queued: it starts when a slot frees.
									</div>
								) : (
									<ReplySkeleton />
								)}
							</div>
						) : messages.length === 0 && !busy && !agent.historyReady ? (
							<HistorySkeleton />
						) : messages.length === 0 && !busy && session.data?.brief ? (
							<div className="flex flex-col gap-2.5">
								<div className="flex flex-col items-end">
									<SentText text={splitAttachments(session.data.brief).text || session.data.brief} className="max-w-[min(520px,100%)]" />
								</div>
								<div className="flex items-center gap-2 text-small text-(--text-3)">
									<Icon icon={Clock} size={12} className="text-(--text-3)" />
									{session.data.threadState === 'queued' ? 'Queued: it starts when a slot frees.' : 'Starting'}
								</div>
							</div>
						) : messages.length === 0 && !busy ? (
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
								<SettlementNotice key={row.message.id} message={row.message} retry={!busy && row === rows[rows.length - 1] ? actions.send : undefined} />
							) : row.message.role === 'user' ? (
								<div key={row.message.id} data-chat-input={row.message.id} className={cn(rises(row.message.id, row === rows[0] && !fresh) && 'in-sent', row !== rows[rows.length - 1] && 'thread-row-settled')}>
									<UserMessage message={row.message} meta={meta} note={notes.get(row.message.id)} />
								</div>
							) : (
								<AssistantMessage
									key={rowKey(row)}
									message={row.message}
									enter={fresh}
									segment={row.segment}
									live={row.message === liveReply && (!row.segment || row.segment.last)}
									working={row.message === workingReply}
									last={row.message === lastAssistant && (!row.segment || row.segment.last)}
									showWorkspaceChanges={Boolean(repo && row.message === lastAssistant && (!row.segment || row.segment.last))}
									answer={answers.get(rowKey(row)) ?? null}
								/>
							),
						)}
						{pending ? <PendingMessage pending={pending} /> : null}
						{working && !workingReply ? (
							<div className="flex items-center gap-2">
								<WorkingLogo active />
								<div className="text-small font-medium text-(--text-3)">Anton</div>
							</div>
						) : null}
						{busy ? <Waiting sessionId={sessionId} tail={tail} queued={rows[rows.length - 1]?.message.role === 'user' && !rows[rows.length - 1]?.joined} phase={liveReply ? 'replying' : rows[rows.length - 1]?.message.role === 'assistant' ? 'finishing' : 'starting'} /> : null}
						{agent.status === 'error' && !messages.some((message) => message.settlement) ? (
							<Notice>
								{agent.error?.message
									? `The agent turn failed: ${agent.error.message}`
									: 'The agent turn failed. Check the OpenRouter key in Settings › Subscriptions or send the message again.'}
							</Notice>
						) : null}
					</div>
					<JumpToLatest show={!following} live={busy} onJump={follow} />
				</div>
				</div>
				{planned ? (
					<ApproveBar
						sessionId={sessionId}
						send={(text) => {
							follow();
							return agent.sendMessage(text);
						}}
					/>
				) : null}
				<ErrorBoundary label="The message box" className="mx-4 mb-3">
					{composer === undefined ? <Composer busy={busy} onSend={onSend} onStop={onStop} onPending={showPending} sessionId={sessionId} /> : composer}
				</ErrorBoundary>
			</div>
			</FileLinks.Provider>
			</ReplyActions.Provider>
		</SessionId.Provider>
	);
}

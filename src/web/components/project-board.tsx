import { FolderGit2, MessageSquare, Plus } from 'lucide-react';
import { PrStatus } from '@/components/pr-status';
import { Btn, Icon, IconBtn } from '@/components/signal';
import { useOpenThread } from '@/components/thread-card';
import { Glyph, type GlyphKind, glyphKind, KIND_LABEL } from '@/components/thread-glyph';
import { repoShort, type Session } from '@/lib/api';
import { threadActiveAt, threadLine } from '@/lib/spaces';

/* A project's threads as a board by state: what needs you first, what is
   done last. Each card shows only what decides the next move — its state,
   where it works, its pull request, and the line it last said or asks. */

const COLUMNS: Array<{ id: string; label: string; glyph: GlyphKind; kinds: GlyphKind[] }> = [
	{ id: 'needs', label: 'Needs you', glyph: 'waiting', kinds: ['waiting', 'failed'] },
	{ id: 'working', label: 'Working', glyph: 'working', kinds: ['working', 'queued'] },
	{ id: 'review', label: 'Ready for review', glyph: 'review', kinds: ['review', 'landing'] },
	// Idle threads finished their turn without resolving; both rest in the last column.
	{ id: 'done', label: 'Done', glyph: 'resolved', kinds: ['idle', 'resolved'] },
];

const KIND_ORDER = COLUMNS.flatMap((column) => column.kinds);

/** A column's threads: by state first, then the most recently moved. */
function columnThreads(threads: Session[], kinds: GlyphKind[]): Session[] {
	const rank = (thread: Session) => KIND_ORDER.indexOf(glyphKind(thread));
	return threads.filter((thread) => kinds.includes(glyphKind(thread))).sort((a, b) => rank(a) - rank(b) || threadActiveAt(b).localeCompare(threadActiveAt(a)));
}

/** One thread on the board: the whole card opens the thread. */
function BoardCard({ thread }: { thread: Session }) {
	const open = useOpenThread();
	const kind = glyphKind(thread);
	const line = threadLine(thread);
	return (
		<button
			type="button"
			onClick={() => open(thread)}
			aria-label={`${thread.title}: ${KIND_LABEL[kind]}`}
			className="flex min-w-0 flex-col gap-2 rounded-card bg-(--bg-surface) p-2.5 text-left shadow-[inset_0_0_0_1px_var(--line),var(--sh-1)] outline-none transition-shadow duration-(--t-fast) hover:shadow-[inset_0_0_0_1px_var(--line-strong),var(--sh-1)] focus-visible:shadow-(--focus)"
		>
			<span className="flex min-w-0 items-start gap-2">
				<Glyph kind={kind} size={13} className="mt-[3px]" />
				<span className="line-clamp-2 min-w-0 flex-1 text-body leading-[18px] font-medium text-(--text)">{thread.title}</span>
			</span>
			<span className="flex min-w-0 items-center gap-1.5 text-small text-(--text-3)">
				<Icon icon={thread.projectId ? FolderGit2 : MessageSquare} size={11} className="shrink-0" />
				<span className="min-w-0 truncate">{repoShort(thread)}</span>
				{thread.prUrl ? (
					<span className="min-w-0 truncate">
						<PrStatus thread={thread} />
					</span>
				) : null}
			</span>
			{line ? <span className="line-clamp-2 border-t border-(--line) pt-1.5 text-small leading-[16px] text-(--text-3)">{line}</span> : null}
		</button>
	);
}

/** The project's threads by state, with a way to start another from any column. */
export function ProjectBoard({ threads, onNewThread }: { threads: Session[]; onNewThread: () => void }) {
	if (threads.length === 0) {
		return (
			<div className="flex h-full min-h-[320px] flex-col items-center justify-center gap-3 p-6 text-center">
				<p className="m-0 max-w-[380px] text-body text-(--text-3)">No threads yet. Ask the coordinator to split the goal into threads, or start one yourself.</p>
				<Btn size="sm" variant="primary" icon={Plus} onClick={onNewThread}>
					New thread
				</Btn>
			</div>
		);
	}
	return (
		<div className="h-full overflow-auto p-4">
			<div className="grid h-full grid-flow-col auto-cols-[minmax(240px,1fr)] gap-3">
				{COLUMNS.map((column) => {
					const items = columnThreads(threads, column.kinds);
					return (
						<section key={column.id} aria-label={column.label} className="flex min-h-0 min-w-0 flex-col gap-1.5">
							<header className="flex h-7 shrink-0 items-center gap-1.5 px-1">
								<Glyph kind={column.glyph} size={12} />
								<span className="text-small font-medium text-(--text-2)">{column.label}</span>
								<span className="in-num text-small text-(--text-3)">{items.length}</span>
								<span className="flex-1" />
								<IconBtn icon={Plus} size="xs" label={`New thread for ${column.label}`} onClick={onNewThread} />
							</header>
							<div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto pb-2">
								{items.map((thread) => (
									<BoardCard key={thread.id} thread={thread} />
								))}
							</div>
						</section>
					);
				})}
			</div>
		</div>
	);
}

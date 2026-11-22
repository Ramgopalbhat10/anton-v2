import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Calendar, FolderGit2, ListTodo, MessageSquare, Plus, Tag, Workflow, X } from '@/lib/icons';
import { type DragEvent, type FormEvent, useMemo, useState } from 'react';
import { Chip, Status } from '@/components/kit/instrument';
import { Btn, Icon, IconBtn } from '@/components/kit/signal';
import { PrStatus } from '@/components/marks/pr-status';
import { Glyph, type GlyphKind, glyphKind, KIND_LABEL } from '@/components/marks/thread-glyph';
import { PriorityBadge, repoLabelFor, TodoAssignMenu, TodoEditorDialog } from '@/components/projects/project-todos';
import { useOpenThread } from '@/components/projects/thread-card';
import { api } from '@/lib/api';
import { repoShort, type Session } from '@/lib/api/sessions';
import type { Space, SpaceTodo } from '@/lib/api/spaces';
import { threadActiveAt, threadLine } from '@/lib/spaces';
import { cn } from '@/lib/utils';
import { PRIORITY_RANK, TODO_NO_REPO } from '../../../core/space-todos';

const THREAD_COLUMNS: Array<{ id: 'needs' | 'working' | 'review' | 'done'; label: string; glyph: GlyphKind; kinds: GlyphKind[] }> = [
	{ id: 'needs', label: 'Needs you', glyph: 'waiting', kinds: ['waiting', 'failed'] },
	{ id: 'working', label: 'Working', glyph: 'working', kinds: ['working', 'queued'] },
	{ id: 'review', label: 'Ready for review', glyph: 'review', kinds: ['review', 'landing'] },
	// Idle threads finished their turn without resolving; both rest in the last column.
	{ id: 'done', label: 'Done', glyph: 'resolved', kinds: ['idle', 'resolved'] },
];

const KIND_ORDER = THREAD_COLUMNS.flatMap((column) => column.kinds);

function columnThreads(threads: Session[], kinds: GlyphKind[]): Session[] {
	const rank = (thread: Session) => KIND_ORDER.indexOf(glyphKind(thread));
	return threads.filter((thread) => kinds.includes(glyphKind(thread))).sort((a, b) => rank(a) - rank(b) || threadActiveAt(b).localeCompare(threadActiveAt(a)));
}

const TODO_DRAG_MIME = 'application/x-anton-todo';

function TodoBoardCard({
	space,
	todo,
	threads,
	onEdit,
	onOpenCoordinator,
	onDragStart,
	onDragEnd,
}: {
	space: Space;
	todo: SpaceTodo;
	threads: Session[];
	onEdit: () => void;
	onOpenCoordinator?: () => void;
	onDragStart?: (event: DragEvent<HTMLElement>) => void;
	onDragEnd?: () => void;
}) {
	const repo = repoLabelFor(space, todo.projectId);
	return (
		<article
			aria-label={todo.title}
			draggable={space.state !== 'archived'}
			onDragStart={onDragStart}
			onDragEnd={onDragEnd}
			className="flex min-w-0 flex-col gap-2 rounded-card bg-(--bg-surface) p-2.5 text-left shadow-[inset_0_0_0_1px_var(--line),var(--sh-1)] transition-shadow duration-(--t-fast) hover:shadow-[inset_0_0_0_1px_var(--line-strong),var(--sh-1)]"
		>
			<button
				type="button"
				onClick={onEdit}
				className="flex min-w-0 flex-col gap-1.5 text-left outline-none focus-visible:shadow-(--focus)"
			>
				<span className="line-clamp-2 min-w-0 text-body leading-[18px] font-medium text-(--text)">{todo.title}</span>
				{todo.description ? (
					<span className="line-clamp-2 text-small leading-[16px] text-(--text-3)">{todo.description}</span>
				) : null}
			</button>

			{todo.priority || repo || todo.tags.length > 0 || todo.dueAt ? (
				<div className="flex min-w-0 flex-wrap items-center gap-1">
					<PriorityBadge priority={todo.priority} compact />
					{repo ? <Chip icon={todo.projectId === TODO_NO_REPO ? MessageSquare : FolderGit2}>{repo}</Chip> : null}
					{todo.tags.slice(0, 2).map((tag) => (
						<Chip key={tag} icon={Tag}>
							{tag}
						</Chip>
					))}
					{todo.tags.length > 2 ? <Chip mono>+{todo.tags.length - 2}</Chip> : null}
					{todo.dueAt ? <Chip icon={Calendar}>{todo.dueAt.slice(5, 10)}</Chip> : null}
				</div>
			) : null}

			<div className="flex items-center justify-between gap-2 border-t border-(--line) pt-1.5">
				<button type="button" onClick={onEdit} className="text-micro text-(--text-3) hover:text-(--text)">
					Details
				</button>
				<TodoAssignMenu space={space} todo={todo} threads={threads} size="xs" variant="secondary" onOpenCoordinator={onOpenCoordinator} />
			</div>
		</article>
	);
}

/** Temporary card while the coordinator is turning an assigned to-do into thread(s); disappears once linked threads exist. */
function CoordinatingCard({
	space,
	todo,
	threads,
	busy,
	onOpenCoordinator,
}: {
	space: Space;
	todo: SpaceTodo;
	threads: Session[];
	busy: boolean;
	onOpenCoordinator?: () => void;
}) {
	return (
		<article
			aria-label={`${todo.title}: ${busy ? 'Coordinating' : 'Waiting in coordinator'}`}
			className="flex min-w-0 flex-col gap-2 rounded-card bg-(--bg-surface) p-2.5 text-left shadow-[inset_0_0_0_1px_var(--line),var(--sh-1)] transition-shadow duration-(--t-fast) hover:shadow-[inset_0_0_0_1px_var(--line-strong),var(--sh-1)]"
		>
			<button
				type="button"
				onClick={() => onOpenCoordinator?.()}
				aria-label={`${todo.title}: ${busy ? 'Coordinating' : 'Waiting in coordinator'}`}
				className="flex min-w-0 flex-col gap-2 text-left outline-none focus-visible:shadow-(--focus)"
			>
				<span className="flex min-w-0 items-start gap-2">
					<Icon icon={Workflow} size={13} className="mt-[3px] shrink-0 text-(--accent-text)" />
					<span className="line-clamp-2 min-w-0 flex-1 text-body leading-[18px] font-medium text-(--text)">{todo.title}</span>
				</span>
				<span className="flex items-center gap-1.5">
					<Status tone={busy ? 'accent' : 'attention'} pulse={busy}>
						{busy ? 'Coordinating' : 'Check coordinator'}
					</Status>
					<PriorityBadge priority={todo.priority} compact />
				</span>
			</button>
			{!busy ? (
				<div className="flex items-center justify-end border-t border-(--line) pt-1.5">
					<TodoAssignMenu space={space} todo={todo} threads={threads} size="xs" variant="secondary" retry label="Retry" onOpenCoordinator={onOpenCoordinator} />
				</div>
			) : null}
		</article>
	);
}

function BoardCard({ thread, linkedTodos }: { thread: Session; linkedTodos: SpaceTodo[] }) {
	const open = useOpenThread();
	const kind = glyphKind(thread);
	const line = threadLine(thread);
	const topPriority = useMemo(() => {
		const sorted = linkedTodos
			.map((todo) => todo.priority)
			.filter((item): item is NonNullable<typeof item> => item !== null)
			.sort((a, b) => PRIORITY_RANK[a] - PRIORITY_RANK[b]);
		return sorted[0] ?? null;
	}, [linkedTodos]);
	const tags = useMemo(() => [...new Set(linkedTodos.flatMap((todo) => todo.tags))].slice(0, 2), [linkedTodos]);

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
			<span className="flex h-[18px] min-w-0 items-center gap-1.5 text-small text-(--text-3)">
				<Icon icon={thread.projectId ? FolderGit2 : MessageSquare} size={11} className="shrink-0" />
				<span className="min-w-0 truncate">{repoShort(thread)}</span>
				{thread.prUrl ? (
					<span className="flex min-w-0 overflow-hidden">
						<PrStatus thread={thread} />
					</span>
				) : null}
			</span>
			{topPriority || tags.length > 0 ? (
				<span className="flex min-w-0 flex-wrap items-center gap-1">
					<PriorityBadge priority={topPriority} compact />
					{tags.map((tag) => (
						<Chip key={tag} icon={Tag}>
							{tag}
						</Chip>
					))}
				</span>
			) : null}
			{line ? <span className="line-clamp-2 border-t border-(--line) pt-1.5 text-small leading-[16px] text-(--text-3)">{line}</span> : null}
		</button>
	);
}

function ColumnQuickAdd({ space, onDone }: { space: Space; onDone: () => void }) {
	const queryClient = useQueryClient();
	const [title, setTitle] = useState('');
	const create = useMutation({
		mutationFn: () => api.createSpaceTodo(space.id, { title: title.trim() }),
		onSuccess: () => {
			setTitle('');
			void queryClient.invalidateQueries({ queryKey: ['space-todos', space.id] });
			void queryClient.invalidateQueries({ queryKey: ['space', space.id] });
		},
	});
	const submit = (event: FormEvent) => {
		event.preventDefault();
		if (!title.trim() || create.isPending) return;
		create.mutate();
	};
	return (
		<form onSubmit={submit} className="flex flex-col gap-1.5 rounded-card bg-(--bg-surface) p-2 shadow-[inset_0_0_0_1px_var(--line-strong)]">
			<input
				autoFocus
				value={title}
				onChange={(event) => setTitle(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === 'Escape') onDone();
				}}
				placeholder="To-do title…"
				aria-label="Quick add to-do"
				maxLength={200}
				className="sg-field h-7 px-2 text-small text-(--text)"
			/>
			<div className="flex items-center justify-end gap-1">
				<Btn size="xs" variant="ghost" onClick={onDone}>
					Done
				</Btn>
				<Btn type="submit" size="xs" variant="primary" disabled={!title.trim() || create.isPending}>
					Add
				</Btn>
			</div>
		</form>
	);
}

export function ProjectBoard({
	space,
	threads,
	todos,
	coordinatorBusy = false,
	onNewThread,
	onOpenCoordinator,
}: {
	space: Space;
	threads: Session[];
	todos: SpaceTodo[];
	coordinatorBusy?: boolean;
	onNewThread: () => void;
	onOpenCoordinator?: () => void;
}) {
	const queryClient = useQueryClient();
	const [addingInColumn, setAddingInColumn] = useState(false);
	const [editing, setEditing] = useState<{ mode: 'edit'; todo: SpaceTodo } | { mode: 'new'; title: string } | null>(null);
	const [draggingTodoId, setDraggingTodoId] = useState<string | null>(null);
	const [dropWorking, setDropWorking] = useState(false);

	const startDroppedTodo = useMutation({
		mutationFn: (todoId: string) => api.assignSpaceTodo(space.id, todoId, { target: 'new-thread' }),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ['space-todos', space.id] });
			void queryClient.invalidateQueries({ queryKey: ['sessions'] });
			void queryClient.invalidateQueries({ queryKey: ['space', space.id] });
		},
	});

	const openTodos = useMemo(
		() =>
			todos
				.filter((todo) => todo.status === 'open')
				.sort((a, b) => a.position - b.position || b.createdAt.localeCompare(a.createdAt)),
		[todos],
	);

	// Assigned to coordinator but not yet converted into thread(s).
	const triagingTodos = useMemo(
		() => todos.filter((todo) => todo.status === 'triaging' && todo.threadIds.length === 0),
		[todos],
	);

	const todosByThread = useMemo(() => {
		const map = new Map<string, SpaceTodo[]>();
		for (const todo of todos) {
			for (const threadId of todo.threadIds) {
				map.set(threadId, [...(map.get(threadId) ?? []), todo]);
			}
		}
		return map;
	}, [todos]);

	if (threads.length === 0 && openTodos.length === 0 && triagingTodos.length === 0 && !addingInColumn) {
		return (
			<div className="flex h-full min-h-[320px] flex-col items-center justify-center gap-3 p-6 text-center">
				<p className="m-0 max-w-[400px] text-body text-(--text-3)">
					No to-dos or threads yet. Add a to-do to the backlog, ask the coordinator to plan the goal, or start a thread yourself.
				</p>
				<div className="flex flex-wrap items-center justify-center gap-2">
					<Btn size="sm" variant="primary" icon={ListTodo} onClick={() => setEditing({ mode: 'new', title: '' })}>
						Add to-do
					</Btn>
					<Btn size="sm" variant="secondary" icon={Plus} onClick={onNewThread}>
						New thread
					</Btn>
				</div>
				{editing ? (
					<TodoEditorDialog
						space={space}
						threads={threads}
						todo={null}
						initialTitle={editing.mode === 'new' ? editing.title : ''}
						onClose={() => setEditing(null)}
						onOpenCoordinator={onOpenCoordinator}
					/>
				) : null}
			</div>
		);
	}

	return (
		<div className="flex h-full flex-col overflow-auto p-4">
			{startDroppedTodo.isError ? (
				<div
					role="alert"
					className="mb-3 flex shrink-0 items-center justify-between gap-2 rounded-control border border-(--bad) bg-(--bad-soft) px-3 py-2 text-small text-(--bad)"
				>
					<span>{startDroppedTodo.error instanceof Error ? startDroppedTodo.error.message : 'Could not assign to-do.'}</span>
					<IconBtn icon={X} size="xs" label="Dismiss error" onClick={() => startDroppedTodo.reset()} />
				</div>
			) : null}
			<div className="grid min-h-0 flex-1 grid-flow-col auto-cols-[minmax(196px,1fr)] gap-3">
				<section aria-label="To do" className="flex min-h-0 min-w-0 flex-col gap-1.5">
					<header className="flex h-7 shrink-0 items-center gap-1.5 px-1">
						<Icon icon={ListTodo} size={13} className="text-(--text-3)" />
						<span className="truncate text-body font-medium text-(--text)">To do</span>
						<span className="in-num text-small text-(--text-3)">{openTodos.length}</span>
						<span className="flex-1" />
						<IconBtn icon={Plus} size="xs" label="Add to-do" onClick={() => setAddingInColumn((current) => !current)} />
					</header>
					<div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto pb-2">
						{addingInColumn ? <ColumnQuickAdd space={space} onDone={() => setAddingInColumn(false)} /> : null}
						{openTodos.map((todo) => (
							<TodoBoardCard
								key={todo.id}
								space={space}
								todo={todo}
								threads={threads}
								onEdit={() => setEditing({ mode: 'edit', todo })}
								onOpenCoordinator={onOpenCoordinator}
								onDragStart={(event) => {
									startDroppedTodo.reset();
									event.dataTransfer.setData(TODO_DRAG_MIME, todo.id);
									event.dataTransfer.effectAllowed = 'move';
									setDraggingTodoId(todo.id);
								}}
								onDragEnd={() => {
									setDraggingTodoId(null);
									setDropWorking(false);
								}}
							/>
						))}
					</div>
				</section>

				{THREAD_COLUMNS.map((column) => {
					const items = columnThreads(threads, column.kinds);
					const triagingHere =
						(column.id === 'working' && coordinatorBusy) || (column.id === 'needs' && !coordinatorBusy) ? triagingTodos : [];
					const total = items.length + triagingHere.length;
					const canDropHere = column.id === 'working' && space.state !== 'archived';
					return (
						<section
							key={column.id}
							aria-label={column.label}
							onDragOver={
								canDropHere
									? (event) => {
											if (!draggingTodoId && !event.dataTransfer.types.includes(TODO_DRAG_MIME)) return;
											event.preventDefault();
											event.dataTransfer.dropEffect = 'move';
											if (!dropWorking) setDropWorking(true);
										}
									: undefined
							}
							onDragLeave={
								canDropHere
									? (event) => {
											if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropWorking(false);
										}
									: undefined
							}
							onDrop={
								canDropHere
									? (event) => {
											event.preventDefault();
											const droppedId = event.dataTransfer.getData(TODO_DRAG_MIME) || draggingTodoId;
											setDropWorking(false);
											setDraggingTodoId(null);
											if (droppedId) startDroppedTodo.mutate(droppedId);
										}
									: undefined
							}
							className={cn(
								'flex min-h-0 min-w-0 flex-col gap-1.5 rounded-card transition-colors duration-(--t-fast)',
								canDropHere && dropWorking && 'bg-(--accent-soft) p-1.5 shadow-[inset_0_0_0_1px_var(--accent-line)]',
							)}
						>
							<header className="flex h-7 shrink-0 items-center gap-1.5 px-1">
								<Glyph kind={column.glyph} size={12} />
								<span className="truncate text-body font-medium text-(--text)">{column.label}</span>
								<span className="in-num text-small text-(--text-3)">{total}</span>
								<span className="flex-1" />
								<IconBtn icon={Plus} size="xs" label={`New thread for ${column.label}`} onClick={onNewThread} />
							</header>
							<div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto pb-2">
								{triagingHere.map((todo) => (
									<CoordinatingCard key={todo.id} space={space} todo={todo} threads={threads} busy={coordinatorBusy} onOpenCoordinator={onOpenCoordinator} />
								))}
								{items.map((thread) => (
									<BoardCard key={thread.id} thread={thread} linkedTodos={todosByThread.get(thread.id) ?? []} />
								))}
							</div>
						</section>
					);
				})}
			</div>

			{editing ? (
				<TodoEditorDialog
					space={space}
					threads={threads}
					todo={editing.mode === 'edit' ? editing.todo : null}
					initialTitle={editing.mode === 'new' ? editing.title : ''}
					onClose={() => setEditing(null)}
					onOpenCoordinator={onOpenCoordinator}
				/>
			) : null}
		</div>
	);
}

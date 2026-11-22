import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Dialog } from 'radix-ui';
import { CircleCheck, FolderGit2, ListTodo, MessageSquare, MoreHorizontal, Paperclip, Pencil, Play, Plus, RotateCcw, Trash2, Waypoints, X } from '@/lib/icons';
import { type FormEvent, useState } from 'react';
import { PrStatus } from '@/components/marks/pr-status';
import { AttachButton, AttachmentTray, FileChip, fileSize, ImageThumb, useAttachments } from '@/components/composer/attachments';
import { Btn, Icon, IconBtn, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '@/components/kit/signal';
import { useOpenThread } from '@/components/projects/thread-card';
import { Glyph, type GlyphKind, glyphKind, KIND_LABEL } from '@/components/marks/thread-glyph';
import { AREA } from '@/components/settings/repo-settings';
import { FIELD } from '@/components/settings/parts';
import { api } from '@/lib/api';
import { repoShort, type Session } from '@/lib/api/sessions';
import { type Space, type SpaceTodo, spaceFileUrl, type TodoAttachment } from '@/lib/api/spaces';
import { imageFile } from '@/lib/attachments';
import { uniqueUploadNames } from '../../../core/upload-name';
import { MAX_TODO_ATTACHMENTS } from '../../../core/space-todos';
import { threadActiveAt, threadLine } from '@/lib/spaces';

/** Thread states: threads move into these on their own, so only To do creates work. */
const COLUMNS: Array<{ id: string; label: string; glyph: GlyphKind; kinds: GlyphKind[] }> = [
	{ id: 'needs', label: 'Needs you', glyph: 'waiting', kinds: ['waiting', 'failed'] },
	{ id: 'working', label: 'Working', glyph: 'working', kinds: ['working', 'queued'] },
	{ id: 'review', label: 'Ready for review', glyph: 'review', kinds: ['review', 'landing'] },
	// Idle threads finished their turn without resolving; both rest in the last column.
	{ id: 'done', label: 'Done', glyph: 'resolved', kinds: ['idle', 'resolved'] },
];

const KIND_ORDER = COLUMNS.flatMap((column) => column.kinds);

function columnThreads(threads: Session[], kinds: GlyphKind[]): Session[] {
	const rank = (thread: Session) => KIND_ORDER.indexOf(glyphKind(thread));
	return threads.filter((thread) => kinds.includes(glyphKind(thread))).sort((a, b) => rank(a) - rank(b) || threadActiveAt(b).localeCompare(threadActiveAt(a)));
}

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
			<span className="flex h-[18px] min-w-0 items-center gap-1.5 text-small text-(--text-3)">
				<Icon icon={thread.projectId ? FolderGit2 : MessageSquare} size={11} className="shrink-0" />
				<span className="min-w-0 truncate">{repoShort(thread)}</span>
				{thread.prUrl ? (
					<span className="flex min-w-0 overflow-hidden">
						<PrStatus thread={thread} />
					</span>
				) : null}
			</span>
			{line ? <span className="line-clamp-2 border-t border-(--line) pt-1.5 text-small leading-[16px] text-(--text-3)">{line}</span> : null}
		</button>
	);
}

/** Open ones, and those handed to the coordinator that it has not started a thread for; the rest show as their threads. */
const waiting = (todo: SpaceTodo) => todo.status === 'open' || (todo.status === 'in_progress' && todo.threads === 0);

const CARD = 'rounded-card bg-(--bg-surface) shadow-[inset_0_0_0_1px_var(--line),var(--sh-1)]';

/** Screenshots and files go to the project's Library on save, as a message's do, and travel with the brief the to-do starts. */
/** Pictures the browser can draw show as their thumbnail, read back from the Library. */
const isPicture = (file: TodoAttachment) => /\.(png|jpe?g|gif|webp)$/i.test(file.path);

async function uploaded(spaceId: string, attachments: ReturnType<typeof useAttachments>, taken: string[]): Promise<TodoAttachment[]> {
	const uploads = [...attachments.images.map(imageFile), ...attachments.files.map((file) => file.file)];
	const names = uniqueUploadNames([...taken, ...uploads.map((file) => file.name)]).slice(taken.length);
	const named = uploads.map((file, index) => (file.name === names[index] ? file : new File([file], names[index]!, { type: file.type, lastModified: file.lastModified })));
	const attached = await Promise.all(named.map((file) => api.attachToProject(spaceId, file)));
	return attached.map(({ name, path, kind, size }) => ({ name, path, kind, size }));
}

function TodoDialog({ spaceId, todo, onClose }: { spaceId: string; todo: SpaceTodo | null; onClose: () => void }) {
	const [title, setTitle] = useState(todo?.title ?? '');
	const [description, setDescription] = useState(todo?.description ?? '');
	const [kept, setKept] = useState<TodoAttachment[]>(todo?.attachments ?? []);
	const attachments = useAttachments({ overflowImagesAsFiles: true });
	const over = kept.length + attachments.count - MAX_TODO_ATTACHMENTS;
	const limit = over > 0 ? `Remove ${over} file${over === 1 ? '' : 's'} (up to ${MAX_TODO_ATTACHMENTS} per to-do).` : attachments.limitError;
	const save = useMutation({
		mutationFn: async () => {
			const files = [...kept, ...(await uploaded(spaceId, attachments, kept.map((file) => file.name)))];
			return todo ? api.editSpaceTodo(spaceId, todo.id, { title, description, attachments: files }) : api.createSpaceTodo(spaceId, { title, description, attachments: files });
		},
		onSuccess: onClose,
	});
	const ready = Boolean(title.trim()) && !limit && attachments.reading === 0 && !save.isPending;
	const submit = (event: FormEvent) => {
		event.preventDefault();
		if (ready) save.mutate();
	};
	return (
		<Dialog.Root open onOpenChange={(open) => !open && onClose()}>
			<Dialog.Portal>
				<Dialog.Overlay className="fixed inset-0 z-40 bg-(--bg-scrim)" />
				<Dialog.Content aria-describedby={undefined} className="in-pop in-pop--modal fixed top-[10vh] left-1/2 z-50 flex w-[calc(100%-2rem)] max-w-[520px] -translate-x-1/2 flex-col overflow-hidden">
					<form onSubmit={submit} className="flex flex-col" {...attachments.dropZone}>
						<header className="flex items-center gap-2 border-b border-(--line) px-4 py-3">
							<Icon icon={ListTodo} size={14} className="text-(--text-3)" />
							<Dialog.Title className="flex-1 text-body-lg font-medium">{todo ? 'Edit to-do' : 'New to-do'}</Dialog.Title>
							<IconBtn icon={X} size="sm" label="Close" onClick={onClose} />
						</header>
						<div className="flex flex-col gap-3 px-4 py-3.5">
							<input autoFocus aria-label="Title" value={title} maxLength={200} onChange={(event) => setTitle(event.target.value)} placeholder="What needs doing" className={`${FIELD} h-9`} />
							<textarea
								aria-label="Description"
								value={description}
								onChange={(event) => setDescription(event.target.value)}
								onPaste={attachments.onPaste}
								rows={5}
								placeholder="Details and what done looks like (optional). Paste or drop screenshots here."
								className={`${AREA} text-body leading-[19px]`}
							/>
							{kept.length || attachments.count || attachments.reading ? (
								// Saved files and new ones in one row; the tray's own row dissolves into it.
								<div className="flex flex-wrap items-center gap-1.5">
									{kept.map((file) => {
										const remove = () => setKept((files) => files.filter((other) => other.path !== file.path));
										return isPicture(file) ? (
											<ImageThumb key={file.path} src={spaceFileUrl(spaceId, file.path)} name={file.name} onRemove={remove} />
										) : (
											<FileChip key={file.path} name={file.name} note={`${file.kind} · ${fileSize(file.size)}`} onRemove={remove} />
										);
									})}
									<AttachmentTray attachments={attachments} className="contents" />
								</div>
							) : null}
							{limit ? <span className="text-small text-(--bad)">{limit}</span> : attachments.notice ? <span className="text-small text-(--warn)">{attachments.notice}</span> : null}
						</div>
						<footer className="flex items-center gap-2 border-t border-(--line) px-4 py-2.5">
							<AttachButton attachments={attachments} label="Attach screenshots or files" />
							{save.isError ? <span className="min-w-0 flex-1 text-small text-(--bad)">{save.error.message}</span> : <span className="flex-1" />}
							<Btn size="sm" variant="ghost" onClick={onClose}>
								Cancel
							</Btn>
							<Btn type="submit" size="sm" variant="primary" disabled={!ready}>
								{todo ? 'Save' : 'Add to-do'}
							</Btn>
						</footer>
					</form>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}

function TodoCard({ spaceId, todo, onEdit, onOpenCoordinator }: { spaceId: string; todo: SpaceTodo; onEdit: () => void; onOpenCoordinator: () => void }) {
	const queryClient = useQueryClient();
	const openThread = useOpenThread();
	const refresh = () => queryClient.invalidateQueries({ queryKey: ['space-todos', spaceId] });
	const start = useMutation({
		mutationFn: (target: 'thread' | 'coordinator') => api.startSpaceTodo(spaceId, todo.id, target),
		onSuccess: (result, target) => {
			void refresh();
			if (result.thread) openThread(result.thread);
			else if (target === 'coordinator') onOpenCoordinator();
		},
	});
	const edit = useMutation({ mutationFn: (status: 'open' | 'done') => api.editSpaceTodo(spaceId, todo.id, { status }), onSuccess: refresh });
	const remove = useMutation({ mutationFn: () => api.deleteSpaceTodo(spaceId, todo.id), onSuccess: refresh });
	const failed = start.error ?? edit.error ?? remove.error;
	const withCoordinator = todo.status === 'in_progress';
	return (
		<article aria-label={todo.title} className={`flex min-w-0 flex-col gap-1.5 p-2.5 ${CARD}`}>
			<div className="flex min-w-0 items-start gap-1">
				<button type="button" onClick={onEdit} className="flex min-w-0 flex-1 flex-col gap-1 text-left outline-none focus-visible:shadow-(--focus)">
					<span className="line-clamp-2 text-body leading-[18px] font-medium text-(--text)">{todo.title}</span>
					{todo.description ? <span className="line-clamp-2 text-small leading-[16px] text-(--text-3)">{todo.description}</span> : null}
					{todo.attachments.length ? (
						<span className="flex min-w-0 items-center gap-1 text-small text-(--text-3)" title={todo.attachments.map((file) => file.name).join('\n')}>
							<Icon icon={Paperclip} size={11} className="shrink-0" />
							<span className="min-w-0 truncate">{todo.attachments.length === 1 ? todo.attachments[0]!.name : `${todo.attachments.length} files`}</span>
						</span>
					) : null}
				</button>
				<Menu>
					<MenuTrigger asChild>
						<IconBtn icon={MoreHorizontal} size="xs" label={`Actions for ${todo.title}`} disabled={start.isPending} />
					</MenuTrigger>
					<MenuContent align="end">
						{withCoordinator ? (
							<MenuItem icon={RotateCcw} onSelect={() => edit.mutate('open')}>
								Move back to To do
							</MenuItem>
						) : (
							<>
								<MenuItem icon={Play} onSelect={() => start.mutate('thread')}>
									Start a thread
								</MenuItem>
								<MenuItem icon={Waypoints} onSelect={() => start.mutate('coordinator')}>
									Hand to the coordinator
								</MenuItem>
							</>
						)}
						<MenuItem icon={Pencil} onSelect={onEdit}>
							Edit
						</MenuItem>
						<MenuItem icon={CircleCheck} onSelect={() => edit.mutate('done')}>
							Mark done
						</MenuItem>
						<MenuSeparator />
						<MenuItem icon={Trash2} onSelect={() => remove.mutate()}>
							Delete
						</MenuItem>
					</MenuContent>
				</Menu>
			</div>
			{withCoordinator || start.isPending ? (
				<button type="button" onClick={onOpenCoordinator} className="flex items-center gap-1.5 text-small text-(--accent-text) outline-none hover:underline">
					<Icon icon={Waypoints} size={11} />
					{start.isPending ? 'Starting…' : 'With the coordinator'}
				</button>
			) : null}
			{failed ? <span className="text-small text-(--bad)">{failed.message}</span> : null}
		</article>
	);
}

function TodoColumn({ spaceId, todos, onOpenCoordinator }: { spaceId: string; todos: SpaceTodo[]; onOpenCoordinator: () => void }) {
	const [editing, setEditing] = useState<SpaceTodo | 'new' | null>(null);
	const shown = todos.filter(waiting);
	const done = todos.filter((todo) => todo.status === 'done').length;
	return (
		<section aria-label="To do" className="flex min-h-0 min-w-0 flex-col gap-1.5">
			<header className="flex h-7 shrink-0 items-center gap-1.5 px-1">
				<Icon icon={ListTodo} size={12} className="text-(--text-3)" />
				<span className="truncate text-body font-medium text-(--text)">To do</span>
				<span className="in-num text-small text-(--text-3)">{shown.length}</span>
				<span className="flex-1" />
				<IconBtn icon={Plus} size="xs" label="New to-do" onClick={() => setEditing('new')} />
			</header>
			<div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto pb-2">
				{shown.map((todo) => (
					<TodoCard key={todo.id} spaceId={spaceId} todo={todo} onEdit={() => setEditing(todo)} onOpenCoordinator={onOpenCoordinator} />
				))}
				{shown.length === 0 ? (
					<button type="button" onClick={() => setEditing('new')} className="rounded-card px-2.5 py-2 text-left text-small text-(--text-3) shadow-[inset_0_0_0_1px_var(--line)] outline-none hover:text-(--text) focus-visible:shadow-(--focus)">
						Add work to start later
					</button>
				) : null}
				{done ? <span className="px-1 text-small text-(--text-3)">{done} done</span> : null}
			</div>
			{editing ? <TodoDialog spaceId={spaceId} todo={editing === 'new' ? null : editing} onClose={() => setEditing(null)} /> : null}
		</section>
	);
}

export function ProjectBoard({
	space,
	threads,
	todos,
	onNewThread,
	onOpenCoordinator,
}: {
	space: Space;
	threads: Session[];
	todos: SpaceTodo[];
	onNewThread: () => void;
	onOpenCoordinator: () => void;
}) {
	const [adding, setAdding] = useState(false);
	if (threads.length === 0 && todos.length === 0) {
		return (
			<div className="flex h-full min-h-[320px] flex-col items-center justify-center gap-3 p-6 text-center">
				<p className="m-0 max-w-[380px] text-body text-(--text-3)">No threads yet. Ask the coordinator to split the goal into threads, start one yourself, or note work to start later.</p>
				<div className="flex gap-2">
					<Btn size="sm" variant="primary" icon={Plus} onClick={onNewThread}>
						New thread
					</Btn>
					<Btn size="sm" variant="secondary" icon={ListTodo} onClick={() => setAdding(true)}>
						New to-do
					</Btn>
				</div>
				{adding ? <TodoDialog spaceId={space.id} todo={null} onClose={() => setAdding(false)} /> : null}
			</div>
		);
	}
	return (
		<div className="h-full overflow-auto p-4">
			<div className="grid h-full grid-flow-col auto-cols-[minmax(184px,1fr)] gap-3">
				<TodoColumn spaceId={space.id} todos={todos} onOpenCoordinator={onOpenCoordinator} />
				{COLUMNS.map((column) => {
					const items = columnThreads(threads, column.kinds);
					return (
						<section key={column.id} aria-label={column.label} className="flex min-h-0 min-w-0 flex-col gap-1.5">
							<header className="flex h-7 shrink-0 items-center gap-1.5 px-1">
								<Glyph kind={column.glyph} size={12} />
								<span className="truncate text-body font-medium text-(--text)">{column.label}</span>
								<span className="in-num text-small text-(--text-3)">{items.length}</span>
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

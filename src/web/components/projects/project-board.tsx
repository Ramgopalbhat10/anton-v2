import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Dialog } from 'radix-ui';
import { CircleCheck, Cloud, FolderGit2, ListTodo, MessageSquare, MoreHorizontal, Paperclip, Pencil, Play, Plus, RotateCcw, Server, Trash2, Waypoints, X } from '@/lib/icons';
import { type FormEvent, useRef, useState } from 'react';
import { PrStatus } from '@/components/marks/pr-status';
import { AttachButton, AttachmentTray, FileChip, fileSize, ImageThumb, useAttachments } from '@/components/composer/attachments';
import { RUN_ON_NOTE, RUN_ON_PROVIDERS } from '@/components/composer/composer-plus';
import { ModelPicker } from '@/components/composer/model-picker';
import { Btn, FloatingLayerContainer, Icon, IconBtn, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, PickerChip } from '@/components/kit/signal';
import { useOpenThread } from '@/components/projects/thread-card';
import { Glyph, type GlyphKind, glyphKind, KIND_LABEL } from '@/components/marks/thread-glyph';
import { AREA } from '@/components/settings/repo-settings';
import { FIELD } from '@/components/settings/parts';
import { api } from '@/lib/api';
import { repoShort, type RunOn, type Session } from '@/lib/api/sessions';
import { type Space, type SpaceTodo, spaceFileUrl, type TodoAttachment } from '@/lib/api/spaces';
import { imageFile } from '@/lib/attachments';
import { MAX_TODO_ATTACHMENTS } from '../../../core/space-todos';
import { threadActiveAt, threadLine } from '@/lib/spaces';
import { cacheStartedTodo, canStartTodo, todoIsUnsaved, todoThreadStartKey, type TodoDraft, type TodoSaves } from './todo-saves';

/** Thread states: threads move into these on their own, so only To do creates work. */
const COLUMNS: Array<{ id: string; label: string; glyph: GlyphKind; kinds: GlyphKind[] }> = [
	{ id: 'needs', label: 'Needs you', glyph: 'waiting', kinds: ['waiting', 'failed'] },
	{ id: 'working', label: 'Working', glyph: 'working', kinds: ['working', 'queued'] },
	// Idle threads finished their reply without resolving, so they wait for you to look as much as an open pull request does.
	{ id: 'review', label: 'Ready for review', glyph: 'review', kinds: ['review', 'landing', 'idle'] },
	{ id: 'done', label: 'Done', glyph: 'resolved', kinds: ['resolved'] },
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

/** Saving closes the dialog at once: the board shows the to-do and saves it, files and all, in the background. */
type Repos = Space['repos'];

const repoName = (repo: Repos[number]) => repo.repoFullName.split('/').pop()!;

/** The to-do's tagged repositories that are still in the project, in the project's order. */
const taggedRepos = (repos: Repos, tagged: string[]) => repos.filter((repo) => tagged.includes(repo.id));

/** Optional: with none tagged, Anton picks the repository from the to-do's words when a thread starts. */
function TodoRepoPicker({ repos, value, onChange }: { repos: Repos; value: string[]; onChange: (repos: string[]) => void }) {
	const chosen = taggedRepos(repos, value);
	const label = chosen.length === 0 ? 'Anton picks' : chosen.length === 1 ? repoName(chosen[0]!) : `${chosen.length} repositories`;
	const toggle = (id: string) => onChange(value.includes(id) ? value.filter((other) => other !== id) : repos.map((repo) => repo.id).filter((other) => other === id || value.includes(other)));
	return (
		<Menu>
			<MenuTrigger asChild>
				<PickerChip icon={FolderGit2} label={label} aria-label={`Repositories: ${chosen.length ? chosen.map((repo) => repo.repoFullName).join(', ') : 'Anton picks'}`} />
			</MenuTrigger>
			<MenuContent align="end" className="max-h-[320px] min-w-[240px] overflow-y-auto">
				<MenuItem checked={chosen.length === 0} onSelect={() => onChange([])}>
					Let Anton pick
				</MenuItem>
				<MenuSeparator />
				{repos.map((repo) => (
					<MenuItem
						key={repo.id}
						role="menuitemcheckbox"
						aria-checked={value.includes(repo.id)}
						checked={value.includes(repo.id)}
						onSelect={(event) => {
							// Several can be tagged, so the menu stays open.
							event.preventDefault();
							toggle(repo.id);
						}}
					>
						{repo.repoFullName}
					</MenuItem>
				))}
			</MenuContent>
		</Menu>
	);
}

function TodoRunOnPicker({ sandbox, value, onChange }: { sandbox: string; value: RunOn; onChange: (next: RunOn) => void }) {
	const provider = RUN_ON_PROVIDERS[sandbox] ?? sandbox;
	const label = value === 'host' ? 'This server' : 'Sandbox';
	return (
		<Menu>
			<MenuTrigger asChild>
				<PickerChip icon={value === 'host' ? Server : Cloud} label={label} aria-label={`Run on: ${label}`} />
			</MenuTrigger>
			<MenuContent align="end" className="w-[260px]">
				<MenuItem role="menuitemradio" aria-checked={value === 'sandbox'} checked={value === 'sandbox'} icon={Cloud} onSelect={() => onChange('sandbox')}>
					Sandbox <span className="text-(--text-3)">· {provider}</span>
				</MenuItem>
				<MenuItem role="menuitemradio" aria-checked={value === 'host'} checked={value === 'host'} icon={Server} onSelect={() => onChange('host')}>
					This server
				</MenuItem>
				<MenuSeparator />
				<p className="m-0 px-2 pt-0.5 pb-1 text-micro leading-[15px] text-pretty text-(--text-3)">{RUN_ON_NOTE}</p>
			</MenuContent>
		</Menu>
	);
}

function TodoDialog({ spaceId, repos, todo, onSave, onClose }: { spaceId: string; repos: Repos; todo: SpaceTodo | null; onSave: (draft: TodoDraft) => void; onClose: () => void }) {
	const [title, setTitle] = useState(todo?.title ?? '');
	const [description, setDescription] = useState(todo?.description ?? '');
	const [threadModel, setThreadModel] = useState<SpaceTodo['threadModel']>(todo?.threadModel ?? null);
	// Tags for repositories since removed from the project are dropped on the next save.
	const [tagged, setTagged] = useState<string[]>(() => taggedRepos(repos, todo?.repos ?? []).map((repo) => repo.id));
	const [runOn, setRunOn] = useState<RunOn>(todo?.runOn ?? 'sandbox');
	const runners = useQuery({ queryKey: ['runners'], queryFn: api.runners, staleTime: 5 * 60_000 });
	const [dialog, setDialog] = useState<HTMLDivElement | null>(null);
	const [kept, setKept] = useState<TodoAttachment[]>(todo?.attachments ?? []);
	const attachments = useAttachments({ overflowImagesAsFiles: true });
	const over = kept.length + attachments.count - MAX_TODO_ATTACHMENTS;
	const limit = over > 0 ? `Remove ${over} file${over === 1 ? '' : 's'} (up to ${MAX_TODO_ATTACHMENTS} per to-do).` : attachments.limitError;
	const ready = Boolean(title.trim()) && !limit && attachments.reading === 0;
	const submit = (event: FormEvent) => {
		event.preventDefault();
		if (!ready) return;
		onSave({ title, description, threadModel, repos: tagged, runOn, kept, uploads: [...attachments.images.map(imageFile), ...attachments.files.map((file) => file.file)] });
		onClose();
	};
	return (
		<Dialog.Root open onOpenChange={(open) => !open && onClose()}>
			<Dialog.Portal>
				<Dialog.Overlay className="fixed inset-0 z-40 bg-(--bg-scrim)" />
				<Dialog.Content ref={setDialog} aria-describedby={undefined} className="in-pop in-pop--modal fixed inset-x-0 top-[10vh] z-50 mx-auto flex max-h-[85dvh] w-[calc(100%-2rem)] max-w-[520px] flex-col">
					<form onSubmit={submit} className="flex min-h-0 flex-col" {...attachments.dropZone}>
						<header className="flex shrink-0 items-center gap-2 border-b border-(--line) px-4 py-3">
							<Icon icon={ListTodo} size={14} className="text-(--text-3)" />
							<Dialog.Title className="flex-1 text-body-lg font-medium">{todo ? 'Edit to-do' : 'New to-do'}</Dialog.Title>
							<IconBtn icon={X} size="sm" label="Close" onClick={onClose} />
						</header>
						<div className="flex min-h-0 flex-col gap-3 overflow-y-auto px-4 py-3.5 [&>*]:shrink-0">
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
							<div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
								<span className="text-small font-medium text-(--text-2)">Main thread model</span>
								<div className="flex min-w-0 flex-wrap items-center gap-1">
									<FloatingLayerContainer.Provider value={dialog}>
										<ModelPicker
											label="Main thread model"
											emptyLabel="Project default"
											value={threadModel ?? { model: '', reasoning: null }}
											onChange={(change) => setThreadModel((current) => ({ model: '', reasoning: null, ...current, ...change }))}
											side="bottom"
										/>
									</FloatingLayerContainer.Provider>
									{threadModel ? <IconBtn icon={RotateCcw} size="xs" label="Use project default" onClick={() => setThreadModel(null)} /> : null}
								</div>
							</div>
							{repos.length > 1 ? (
								<div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
									<span className="text-small font-medium text-(--text-2)">Repositories</span>
									<FloatingLayerContainer.Provider value={dialog}>
										<TodoRepoPicker repos={repos} value={tagged} onChange={setTagged} />
									</FloatingLayerContainer.Provider>
								</div>
							) : null}
							{runners.data?.host ? (
								<div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
									<span className="text-small font-medium text-(--text-2)">Run on</span>
									<FloatingLayerContainer.Provider value={dialog}>
										<TodoRunOnPicker sandbox={runners.data.sandbox} value={runOn} onChange={setRunOn} />
									</FloatingLayerContainer.Provider>
								</div>
							) : null}
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
						<footer className="flex shrink-0 items-center gap-2 border-t border-(--line) px-4 py-2.5">
							<AttachButton attachments={attachments} label="Attach screenshots or files" />
							<span className="flex-1" />
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

type TodoActions = {
	onOpenCoordinator: () => void;
	onHandTodo: (todoId: string) => void;
	onHandoffFocus?: () => void;
};

function TodoCard({ spaceId, repos, todo, saves, onEdit, onOpenCoordinator, onHandTodo, onHandoffFocus, handingOff }: TodoActions & { spaceId: string; repos: Repos; todo: SpaceTodo; saves: TodoSaves; onEdit: () => void; handingOff: boolean }) {
	const queryClient = useQueryClient();
	const openThread = useOpenThread();
	const focusAfterHandoff = useRef(false);
	const refresh = () => queryClient.invalidateQueries({ queryKey: ['space-todos', spaceId] });
	const save = saves.stateOf(todo);
	// Not on the server yet, or a change to it still on the way: starting or editing it now would work from the old one.
	const unsaved = todoIsUnsaved(save);
	const start = useMutation({
		mutationKey: [...todoThreadStartKey(spaceId), todo.id],
		mutationFn: () => api.startSpaceTodo(spaceId, todo.id, 'thread'),
		onSuccess: (result) => {
			cacheStartedTodo(queryClient, spaceId, result.todo);
			void refresh();
			if (result.thread) openThread(result.thread);
		},
	});
	const startingThread = start.isPending || saves.isStartingThread(todo.id);
	const canStart = canStartTodo(todo, save) && !handingOff && !startingThread;
	const withCoordinator = todo.status === 'in_progress';
	const tagged = taggedRepos(repos, todo.repos);
	return (
		<article aria-label={todo.title} aria-busy={save?.saving || undefined} className={`flex min-w-0 flex-col gap-1.5 p-2.5 ${CARD}`}>
			<div className="flex min-w-0 items-start gap-1">
				<button type="button" onClick={onEdit} disabled={unsaved} className="flex min-w-0 flex-1 flex-col gap-1 text-left outline-none focus-visible:shadow-(--focus)">
					<span className="line-clamp-2 text-body leading-[18px] font-medium text-(--text)">{todo.title}</span>
					{todo.description ? <span className="line-clamp-2 text-small leading-[16px] text-(--text-3)">{todo.description}</span> : null}
					{tagged.length ? (
						<span className="flex min-w-0 items-center gap-1 text-small text-(--text-3)" title={tagged.map((repo) => repo.repoFullName).join('\n')}>
							<Icon icon={FolderGit2} size={11} className="shrink-0" />
							<span className="min-w-0 truncate">{tagged.map(repoName).join(', ')}</span>
						</span>
					) : null}
					{todo.runOn === 'host' ? (
						<span className="flex min-w-0 items-center gap-1 text-small text-(--text-3)">
							<Icon icon={Server} size={11} className="shrink-0" />
							<span className="min-w-0 truncate">This server</span>
						</span>
					) : null}
					{todo.attachments.length ? (
						<span className="flex min-w-0 items-center gap-1 text-small text-(--text-3)" title={todo.attachments.map((file) => file.name).join('\n')}>
							<Icon icon={Paperclip} size={11} className="shrink-0" />
							<span className="min-w-0 truncate">{todo.attachments.length === 1 ? todo.attachments[0]!.name : `${todo.attachments.length} files`}</span>
						</span>
					) : null}
				</button>
				<Menu>
					<MenuTrigger asChild>
						<IconBtn icon={MoreHorizontal} size="xs" label={`Actions for ${todo.title}`} disabled={handingOff || startingThread || save?.pending} />
					</MenuTrigger>
					<MenuContent align="end" onCloseAutoFocus={(event) => {
						if (focusAfterHandoff.current && onHandoffFocus) {
							// During handoff the menu's trigger is disabled, or covered by the dock.
							event.preventDefault();
							onHandoffFocus();
						}
						focusAfterHandoff.current = false;
					}}>
						{withCoordinator ? (
							<MenuItem icon={RotateCcw} onSelect={() => saves.setStatus(todo, 'open')}>
								Move back to To do
							</MenuItem>
						) : (
							<>
								<MenuItem icon={Play} disabled={!canStart} onSelect={() => start.mutate()}>
									Start a thread
								</MenuItem>
								<MenuItem icon={Waypoints} disabled={!canStart} onSelect={() => {
									focusAfterHandoff.current = true;
									onHandTodo(todo.id);
								}}>
									Hand to the coordinator
								</MenuItem>
							</>
						)}
						<MenuItem icon={Pencil} disabled={unsaved} onSelect={onEdit}>
							Edit
						</MenuItem>
						<MenuItem icon={CircleCheck} onSelect={() => saves.setStatus(todo, 'done')}>
							Mark done
						</MenuItem>
						<MenuSeparator />
						<MenuItem icon={Trash2} onSelect={() => saves.remove(todo)}>
							Delete
						</MenuItem>
					</MenuContent>
				</Menu>
			</div>
			{withCoordinator || handingOff || startingThread ? (
				<button type="button" onClick={onOpenCoordinator} className="flex items-center gap-1.5 text-small text-(--accent-text) outline-none hover:underline">
					<Icon icon={Waypoints} size={11} />
					{startingThread ? 'Starting…' : withCoordinator ? 'With the coordinator' : 'Handing off…'}
				</button>
			) : null}
			{save?.error ? (
				<span role="alert" className="flex flex-wrap items-center gap-x-2 text-small text-(--bad)">
					<span className="min-w-0">
						{save.pending ? 'Not saved' : 'Change not saved'}: {save.error}
					</span>
					<button type="button" onClick={save.retry} className="font-medium outline-none hover:underline focus-visible:underline">
						Retry
					</button>
					<button type="button" onClick={save.dismiss} className="text-(--text-3) outline-none hover:underline focus-visible:underline">
						{save.pending ? 'Discard' : 'Dismiss'}
					</button>
				</span>
			) : save?.pending ? (
				<span className="text-small text-(--text-3)">Saving…</span>
			) : null}
			{start.error ? <span className="text-small text-(--bad)">{start.error.message}</span> : null}
		</article>
	);
}

function TodoColumn({ spaceId, repos, saves, handingOff, ...actions }: TodoActions & { spaceId: string; repos: Repos; saves: TodoSaves; handingOff?: ReadonlySet<string> }) {
	const todos = saves.todos;
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
					<TodoCard key={todo.id} spaceId={spaceId} repos={repos} todo={todo} saves={saves} onEdit={() => setEditing(todo)} handingOff={handingOff?.has(todo.id) ?? false} {...actions} />
				))}
				{shown.length === 0 ? (
					<button type="button" onClick={() => setEditing('new')} className="rounded-card px-2.5 py-2 text-left text-small text-(--text-3) shadow-[inset_0_0_0_1px_var(--line)] outline-none hover:text-(--text) focus-visible:shadow-(--focus)">
						Add work to start later
					</button>
				) : null}
				{done ? <span className="px-1 text-small text-(--text-3)">{done} done</span> : null}
			</div>
			{editing ? (
				<TodoDialog
					spaceId={spaceId}
					repos={repos}
					todo={editing === 'new' ? null : editing}
					onSave={(draft) => (editing === 'new' ? saves.create(draft) : saves.edit(editing, draft))}
					onClose={() => setEditing(null)}
				/>
			) : null}
		</section>
	);
}

export function ProjectBoard({
	space,
	threads,
	saves,
	onNewThread,
	handingOff,
	...actions
}: TodoActions & {
	space: Space;
	threads: Session[];
	saves: TodoSaves;
	onNewThread: () => void;
	handingOff?: ReadonlySet<string>;
}) {
	const [adding, setAdding] = useState(false);
	if (threads.length === 0 && saves.todos.length === 0) {
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
				{adding ? <TodoDialog spaceId={space.id} repos={space.repos} todo={null} onSave={saves.create} onClose={() => setAdding(false)} /> : null}
			</div>
		);
	}
	return (
		<div className="h-full overflow-auto p-4">
			<div className="grid h-full grid-flow-col auto-cols-[minmax(184px,1fr)] gap-3">
				<TodoColumn spaceId={space.id} repos={space.repos} saves={saves} handingOff={handingOff} {...actions} />
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

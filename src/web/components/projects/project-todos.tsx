import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
	ArrowDown,
	ArrowUp,
	Calendar,
	Check,
	CircleAlert,
	CircleCheck,
	CircleDashed,
	ExternalLink,
	Flag,
	Flame,
	FolderGit2,
	ListChecks,
	ListTodo,
	MessageSquare,
	Paperclip,
	Pencil,
	Plus,
	RotateCcw,
	Tag,
	Trash2,
	Waypoints,
	Workflow,
	X,
} from '@/lib/icons';
import { type FormEvent, type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import { ModelPicker } from '@/components/composer/model-picker';
import { Chip, Segmented, SegmentedItem, Status } from '@/components/kit/instrument';
import {
	Badge,
	Btn,
	EmptyState,
	FilterMenu,
	Icon,
	IconBtn,
	Menu,
	MenuContent,
	MenuItem,
	MenuLabel,
	MenuSeparator,
	MenuSub,
	MenuSubContent,
	MenuSubTrigger,
	MenuTrigger,
	PickerChip,
	SearchField,
	Switch,
} from '@/components/kit/signal';
import { ThreadGlyph } from '@/components/marks/thread-glyph';
import { ThreadChip } from '@/components/projects/thread-card';
import { api } from '@/lib/api';
import type { ModelChoice } from '@/lib/api/plans';
import type { Session } from '@/lib/api/sessions';
import type { AssignSpaceTodoInput, Space, SpaceTodo, TodoPriority } from '@/lib/api/spaces';
import { useModels } from '@/lib/models';
import { cn } from '@/lib/utils';
import { PRIORITY_LABEL, PRIORITY_RANK, TODO_NO_REPO, TODO_PRIORITIES } from '../../../core/space-todos';

const PRIORITY_TONE: Record<TodoPriority, 'danger' | 'warning' | 'accent' | 'neutral'> = {
	urgent: 'danger',
	high: 'warning',
	medium: 'accent',
	low: 'neutral',
};

export function PriorityBadge({ priority, compact = false }: { priority: TodoPriority | null; compact?: boolean }) {
	if (!priority) return null;
	const icon = priority === 'urgent' ? Flame : Flag;
	if (compact) {
		return (
			<Chip icon={icon} tone={PRIORITY_TONE[priority]} title={`Priority: ${PRIORITY_LABEL[priority]}`}>
				{PRIORITY_LABEL[priority]}
			</Chip>
		);
	}
	return (
		<Badge tone={PRIORITY_TONE[priority]}>
			<Icon icon={icon} size={11} />
			<span>{PRIORITY_LABEL[priority]}</span>
		</Badge>
	);
}

export function repoLabelFor(space: Space, projectId: string | null): string | null {
	if (!projectId) return null;
	if (projectId === TODO_NO_REPO) return 'No repository';
	const repo = space.repos.find((item) => item.id === projectId);
	return repo ? repo.repoFullName.split('/').pop() ?? repo.repoFullName : null;
}

function dueTone(dueAt: string): 'danger' | 'warning' | 'neutral' {
	const today = new Date().toISOString().slice(0, 10);
	const day = dueAt.slice(0, 10);
	if (day < today) return 'danger';
	if (day === today) return 'warning';
	return 'neutral';
}

function formatDue(dueAt: string): string {
	const day = dueAt.slice(0, 10);
	const parsed = new Date(`${day}T00:00:00Z`);
	if (Number.isNaN(parsed.getTime())) return day;
	return parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export function TodoAssignMenu({
	space,
	todo,
	threads,
	size = 'xs',
	variant = 'secondary',
	onAssigned,
	onOpenCoordinator,
	beforeAssign,
}: {
	space: Space;
	todo: SpaceTodo;
	threads: Session[];
	size?: 'xs' | 'sm';
	variant?: 'primary' | 'secondary' | 'ghost';
	onAssigned?: (target: AssignSpaceTodoInput['target']) => void;
	onOpenCoordinator?: () => void;
	beforeAssign?: () => Promise<void>;
}) {
	const queryClient = useQueryClient();
	const assign = useMutation({
		mutationFn: async (input: AssignSpaceTodoInput) => {
			if (beforeAssign) await beforeAssign();
			return api.assignSpaceTodo(space.id, todo.id, input);
		},
		onSuccess: (_result, input) => {
			void queryClient.invalidateQueries({ queryKey: ['space-todos', space.id] });
			void queryClient.invalidateQueries({ queryKey: ['sessions'] });
			void queryClient.invalidateQueries({ queryKey: ['space', space.id] });
			if (input.target === 'coordinator') onOpenCoordinator?.();
			onAssigned?.(input.target);
		},
	});
	const openThreads = useMemo(
		() => threads.filter((thread) => thread.threadState !== 'resolved').slice(0, 12),
		[threads],
	);
	const archived = space.state === 'archived';
	return (
		<span className="inline-flex items-center gap-1" onClick={(event) => event.stopPropagation()}>
			<Menu>
				<MenuTrigger asChild>
					<Btn size={size} variant={variant} icon={Workflow} disabled={archived || assign.isPending} aria-label={`Assign ${todo.title}`}>
						{assign.isPending ? 'Assigning…' : 'Assign'}
					</Btn>
				</MenuTrigger>
				<MenuContent align="end" className="min-w-[220px]">
					<MenuLabel>Start working on this to-do</MenuLabel>
					<MenuItem icon={Workflow} onSelect={() => assign.mutate({ target: 'coordinator' })}>
						Send to coordinator
					</MenuItem>
					<MenuItem icon={Waypoints} onSelect={() => assign.mutate({ target: 'new-thread' })}>
						Start new thread
					</MenuItem>
					<MenuSeparator />
					{openThreads.length > 0 ? (
						<MenuSub>
							<MenuSubTrigger icon={MessageSquare} hint={String(openThreads.length)}>
								Add to existing thread
							</MenuSubTrigger>
							<MenuSubContent className="max-w-[280px]">
								{openThreads.map((thread) => (
									<MenuItem key={thread.id} onSelect={() => assign.mutate({ target: 'thread', threadId: thread.id })}>
										<span className="flex min-w-0 items-center gap-2">
											<ThreadGlyph thread={thread} size={12} />
											<span className="truncate">{thread.title}</span>
										</span>
									</MenuItem>
								))}
							</MenuSubContent>
						</MenuSub>
					) : (
						<MenuItem icon={MessageSquare} disabled>
							No active threads
						</MenuItem>
					)}
				</MenuContent>
			</Menu>
			{assign.isError ? (
				<span role="alert" className="text-micro text-(--bad)">
					{assign.error.message}
				</span>
			) : null}
		</span>
	);
}

export function TodoEditorDialog({
	space,
	threads,
	todo,
	initialTitle = '',
	onClose,
	onOpenCoordinator,
}: {
	space: Space;
	threads: Session[];
	todo: SpaceTodo | null;
	initialTitle?: string;
	onClose: () => void;
	onOpenCoordinator?: () => void;
}) {
	const queryClient = useQueryClient();
	const models = useModels();
	const spaceFiles = useQuery({ queryKey: ['space-files', space.id], queryFn: () => api.spaceFiles(space.id) });
	const [title, setTitle] = useState(todo?.title ?? initialTitle);
	const [description, setDescription] = useState(todo?.description ?? '');
	const [priority, setPriority] = useState<TodoPriority | null>(todo?.priority ?? null);
	const [projectId, setProjectId] = useState<string | null>(todo?.projectId ?? null);
	const [choice, setChoice] = useState<ModelChoice>({
		model: todo?.model ?? '',
		reasoning: todo?.reasoning ?? null,
	});
	const [planMode, setPlanMode] = useState(todo?.planMode ?? false);
	const [tags, setTags] = useState<string[]>(todo?.tags ?? []);
	const [tagInput, setTagInput] = useState('');
	const [dueAt, setDueAt] = useState(todo?.dueAt ? todo.dueAt.slice(0, 10) : '');
	const [sourceUrl, setSourceUrl] = useState(todo?.sourceUrl ?? '');
	const [files, setFiles] = useState<string[]>(todo?.files ?? []);
	const titleRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		titleRef.current?.focus();
	}, []);

	useEffect(() => {
		const onKey = (event: globalThis.KeyboardEvent) => {
			if (event.key === 'Escape') onClose();
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, [onClose]);

	const invalidate = () => {
		void queryClient.invalidateQueries({ queryKey: ['space-todos', space.id] });
		void queryClient.invalidateQueries({ queryKey: ['space', space.id] });
	};

	const buildPayload = () => ({
		title: title.trim(),
		description: description.trim(),
		priority,
		projectId,
		model: choice.model || null,
		reasoning: choice.reasoning,
		planMode: projectId === TODO_NO_REPO ? false : planMode,
		tags,
		files,
		dueAt: dueAt.trim() || null,
		sourceUrl: sourceUrl.trim() || null,
	});

	const save = useMutation({
		mutationFn: async () => {
			const payload = buildPayload();
			return todo ? api.editSpaceTodo(space.id, todo.id, payload) : api.createSpaceTodo(space.id, payload);
		},
		onSuccess: () => {
			invalidate();
			onClose();
		},
	});

	const remove = useMutation({
		mutationFn: () => (todo ? api.deleteSpaceTodo(space.id, todo.id) : Promise.resolve()),
		onSuccess: () => {
			invalidate();
			onClose();
		},
	});

	const toggleDone = useMutation({
		mutationFn: async () => {
			if (!todo) return;
			await api.editSpaceTodo(space.id, todo.id, { status: todo.status === 'done' ? 'open' : 'done' });
		},
		onSuccess: () => {
			invalidate();
			onClose();
		},
	});

	const addTag = () => {
		const cleaned = tagInput.trim();
		if (!cleaned) return;
		if (!tags.some((item) => item.toLowerCase() === cleaned.toLowerCase())) {
			setTags((current) => [...current, cleaned]);
		}
		setTagInput('');
	};

	const onTagKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		if (event.key === 'Enter' || event.key === ',') {
			event.preventDefault();
			addTag();
		} else if (event.key === 'Backspace' && !tagInput && tags.length > 0) {
			setTags((current) => current.slice(0, -1));
		}
	};

	const linkedThreads = useMemo(
		() => (todo ? todo.threadIds.map((id) => threads.find((item) => item.id === id)).filter((item): item is Session => Boolean(item)) : []),
		[todo, threads],
	);

	const repoLabel =
		projectId === TODO_NO_REPO
			? 'No repository'
			: projectId
				? (space.repos.find((item) => item.id === projectId)?.repoFullName.split('/').pop() ?? 'Repository')
				: space.repos.length > 0
					? 'Auto (project default)'
					: 'No repository';

	const availableFiles = spaceFiles.data?.files ?? [];
	const canSave = title.trim().length > 0 && !save.isPending;

	const saveBeforeAssign = async () => {
		if (!todo || !title.trim()) return;
		await api.editSpaceTodo(space.id, todo.id, buildPayload());
	};

	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4"
			onClick={(event) => {
				if (event.target === event.currentTarget) onClose();
			}}
		>
			<div
				role="dialog"
				aria-modal="true"
				aria-label={todo ? `Edit to-do: ${todo.title}` : 'New to-do'}
				className="in-pop in-pop--modal flex max-h-[min(680px,90vh)] w-[min(620px,100%)] flex-col overflow-hidden"
			>
				<header className="flex h-11 shrink-0 items-center gap-2 border-b border-(--line) px-4">
					<Icon icon={ListTodo} size={15} className="text-(--text-3)" />
					<h2 className="m-0 min-w-0 flex-1 truncate text-body font-semibold text-(--text)">{todo ? 'Edit to-do' : 'New to-do'}</h2>
					{todo && todo.status !== 'open' ? (
						<Badge tone={todo.status === 'done' ? 'success' : todo.status === 'triaging' ? 'accent' : 'neutral'}>
							{todo.status === 'triaging' ? 'Coordinating' : todo.status === 'in_progress' ? 'In progress' : todo.status === 'done' ? 'Done' : 'Cancelled'}
						</Badge>
					) : null}
					<IconBtn icon={X} size="sm" label="Close" onClick={onClose} />
				</header>

				<form
					className="flex min-h-0 flex-1 flex-col overflow-hidden"
					onSubmit={(event: FormEvent) => {
						event.preventDefault();
						if (canSave) save.mutate();
					}}
				>
					<div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-4 py-4">
						<div className="flex flex-col gap-1.5">
							<label htmlFor="todo-title" className="text-small font-medium text-(--text-2)">
								Title
							</label>
							<input
								id="todo-title"
								ref={titleRef}
								value={title}
								onChange={(event) => setTitle(event.target.value)}
								placeholder="What needs to get done?"
								maxLength={200}
								className="sg-field h-8 px-2.5 text-body text-(--text)"
							/>
						</div>

						<div className="flex flex-col gap-1.5">
							<label htmlFor="todo-desc" className="text-small font-medium text-(--text-2)">
								Brief / acceptance criteria
							</label>
							<textarea
								id="todo-desc"
								value={description}
								onChange={(event) => setDescription(event.target.value)}
								placeholder="Add context, requirements, or acceptance criteria. This becomes the thread's brief when assigned."
								rows={4}
								className="sg-field min-h-[96px] resize-y px-2.5 py-2 text-body leading-[19px] text-(--text)"
							/>
						</div>

						<div className="flex flex-wrap items-center gap-2">
							<Menu>
								<MenuTrigger asChild>
									<PickerChip icon={priority === 'urgent' ? Flame : Flag} label={priority ? PRIORITY_LABEL[priority] : 'Priority'} height={28} />
								</MenuTrigger>
								<MenuContent align="start">
									<MenuItem checked={priority === null} onSelect={() => setPriority(null)}>
										No priority
									</MenuItem>
									{TODO_PRIORITIES.map((item) => (
										<MenuItem key={item} icon={item === 'urgent' ? Flame : Flag} checked={priority === item} onSelect={() => setPriority(item)}>
											{PRIORITY_LABEL[item]}
										</MenuItem>
									))}
								</MenuContent>
							</Menu>

							<Menu>
								<MenuTrigger asChild>
									<PickerChip icon={FolderGit2} label={repoLabel} height={28} />
								</MenuTrigger>
								<MenuContent align="start" className="min-w-[220px]">
									{space.repos.length > 0 ? (
										<MenuItem checked={projectId === null} onSelect={() => setProjectId(null)}>
											Auto (project default)
										</MenuItem>
									) : null}
									{space.repos.map((repo) => (
										<MenuItem key={repo.id} checked={projectId === repo.id} onSelect={() => setProjectId(repo.id)}>
											{repo.repoFullName}
										</MenuItem>
									))}
									<MenuSeparator />
									<MenuItem checked={projectId === TODO_NO_REPO || (space.repos.length === 0 && projectId === null)} onSelect={() => setProjectId(TODO_NO_REPO)}>
										No repository (chat)
									</MenuItem>
								</MenuContent>
							</Menu>

							<ModelPicker
								value={{ model: choice.model || space.threadModel || models.data?.default || '', reasoning: choice.reasoning }}
								onChange={(change) => setChoice((current) => ({ ...current, ...change }))}
								side="bottom"
							/>

							{projectId !== TODO_NO_REPO && space.repos.length > 0 ? (
								<Switch checked={planMode} onChange={setPlanMode} label={<span className="text-small text-(--text-2)">Plan first</span>} className="ml-1" />
							) : null}
						</div>

						<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
							<div className="flex flex-col gap-1.5">
								<label htmlFor="todo-due" className="text-small font-medium text-(--text-2)">
									Due date
								</label>
								<input
									id="todo-due"
									type="date"
									value={dueAt}
									onChange={(event) => setDueAt(event.target.value)}
									className="sg-field h-7 px-2 text-small text-(--text)"
								/>
							</div>

							<div className="flex flex-col gap-1.5">
								<label htmlFor="todo-source" className="text-small font-medium text-(--text-2)">
									Source link
								</label>
								<input
									id="todo-source"
									type="url"
									value={sourceUrl}
									onChange={(event) => setSourceUrl(event.target.value)}
									placeholder="https://github.com/..."
									className="sg-field h-7 px-2 text-small text-(--text)"
								/>
							</div>
						</div>

						<div className="flex flex-col gap-1.5">
							<label htmlFor="todo-tags" className="text-small font-medium text-(--text-2)">
								Tags
							</label>
							<div className="sg-field flex min-h-8 flex-wrap items-center gap-1.5 px-2 py-1">
								{tags.map((tag) => (
									<span
										key={tag}
										className="inline-flex h-[20px] items-center gap-1 rounded-inner bg-(--bg-active) px-1.5 text-micro font-medium text-(--text-2)"
									>
										<Icon icon={Tag} size={10} className="text-(--text-3)" />
										<span>{tag}</span>
										<button
											type="button"
											aria-label={`Remove tag ${tag}`}
											onClick={() => setTags((current) => current.filter((item) => item !== tag))}
											className="inline-flex items-center justify-center rounded-mark text-(--text-3) hover:text-(--text)"
										>
											<Icon icon={X} size={10} />
										</button>
									</span>
								))}
								<input
									id="todo-tags"
									value={tagInput}
									onChange={(event) => setTagInput(event.target.value)}
									onKeyDown={onTagKeyDown}
									onBlur={addTag}
									placeholder={tags.length ? 'Add tag…' : 'e.g. bug, ui, api (press Enter)'}
									className="min-w-[120px] flex-1 border-0 bg-transparent p-0 text-small text-(--text) outline-none placeholder:text-(--text-4)"
								/>
							</div>
						</div>

						{availableFiles.length > 0 ? (
							<div className="flex flex-col gap-1.5">
								<div className="flex items-center justify-between gap-2">
									<span className="text-small font-medium text-(--text-2)">Project files</span>
									<Menu>
										<MenuTrigger asChild>
											<Btn size="xs" variant="ghost" icon={Paperclip}>
												{files.length ? `${files.length} attached` : 'Attach file'}
											</Btn>
										</MenuTrigger>
										<MenuContent align="end" className="max-h-[240px] min-w-[220px] overflow-y-auto">
											{availableFiles.map((file) => {
												const picked = files.includes(file.path);
												return (
													<MenuItem
														key={file.path}
														checked={picked}
														onSelect={() =>
															setFiles((current) => (picked ? current.filter((item) => item !== file.path) : [...current, file.path]))
														}
													>
														{file.path}
													</MenuItem>
												);
											})}
										</MenuContent>
									</Menu>
								</div>
								{files.length > 0 ? (
									<div className="flex flex-wrap gap-1.5">
										{files.map((path) => (
											<span
												key={path}
												className="inline-flex h-[20px] items-center gap-1 rounded-inner bg-(--bg-hover) px-1.5 text-micro text-(--text-2) shadow-[inset_0_0_0_1px_var(--line)]"
											>
												<Icon icon={Paperclip} size={10} className="text-(--text-3)" />
												<span className="max-w-[180px] truncate">{path}</span>
												<button
													type="button"
													aria-label={`Detach ${path}`}
													onClick={() => setFiles((current) => current.filter((item) => item !== path))}
													className="text-(--text-3) hover:text-(--text)"
												>
													<Icon icon={X} size={10} />
												</button>
											</span>
										))}
									</div>
								) : null}
							</div>
						) : null}

						{linkedThreads.length > 0 ? (
							<div className="flex flex-col gap-1.5 border-t border-(--line) pt-3">
								<span className="text-small font-medium text-(--text-2)">Linked threads</span>
								<div className="flex flex-wrap gap-1.5">
									{linkedThreads.map((thread) => (
										<ThreadChip key={thread.id} thread={thread}>
											{thread.title}
										</ThreadChip>
									))}
								</div>
							</div>
						) : null}

						{save.isError ? (
							<div role="alert" className="text-small text-(--bad)">
								{save.error.message}
							</div>
						) : null}
					</div>

					<footer className="flex shrink-0 flex-wrap items-center gap-2 border-t border-(--line) px-4 py-2.5">
						{todo ? (
							<>
								<Btn size="sm" variant="dangerGhost" icon={Trash2} disabled={remove.isPending} onClick={() => remove.mutate()}>
									Delete
								</Btn>
								<Btn
									size="sm"
									variant="ghost"
									icon={todo.status === 'done' ? RotateCcw : Check}
									disabled={toggleDone.isPending}
									onClick={() => toggleDone.mutate()}
								>
									{todo.status === 'done' ? 'Reopen' : 'Mark done'}
								</Btn>
							</>
						) : null}
						<span className="flex-1" />
						{todo && todo.status === 'open' ? (
							<TodoAssignMenu
								space={space}
								todo={todo}
								threads={threads}
								size="sm"
								variant="secondary"
								beforeAssign={saveBeforeAssign}
								onAssigned={() => onClose()}
								onOpenCoordinator={onOpenCoordinator}
							/>
						) : null}
						<Btn size="sm" variant="ghost" onClick={onClose}>
							Cancel
						</Btn>
						<Btn type="submit" size="sm" variant="primary" disabled={!canSave}>
							{todo ? 'Save' : 'Add to-do'}
						</Btn>
					</footer>
				</form>
			</div>
		</div>
	);
}

export function TodoQuickAdd({
	space,
	onOpenDetails,
	autoFocus = false,
	placeholder = 'Add a to-do…',
}: {
	space: Space;
	onOpenDetails?: (title: string) => void;
	autoFocus?: boolean;
	placeholder?: string;
}) {
	const queryClient = useQueryClient();
	const [title, setTitle] = useState('');
	const [priority, setPriority] = useState<TodoPriority | null>(null);
	const [projectId, setProjectId] = useState<string | null>(null);
	const create = useMutation({
		mutationFn: () =>
			api.createSpaceTodo(space.id, {
				title: title.trim(),
				priority,
				projectId,
			}),
		onSuccess: () => {
			setTitle('');
			setPriority(null);
			void queryClient.invalidateQueries({ queryKey: ['space-todos', space.id] });
			void queryClient.invalidateQueries({ queryKey: ['space', space.id] });
		},
	});

	const submit = (event: FormEvent) => {
		event.preventDefault();
		if (!title.trim() || create.isPending) return;
		create.mutate();
	};

	const repoLabel = repoLabelFor(space, projectId) ?? (space.repos.length > 0 ? 'Auto repo' : 'No repo');

	return (
		<form onSubmit={submit} className="in-card flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center">
			<div className="flex min-w-0 flex-1 items-center gap-2">
				<Icon icon={Plus} size={14} className="shrink-0 text-(--text-3)" />
				<input
					autoFocus={autoFocus}
					value={title}
					onChange={(event) => setTitle(event.target.value)}
					placeholder={placeholder}
					aria-label="New to-do title"
					maxLength={200}
					className="min-w-0 flex-1 border-0 bg-transparent p-0 text-body text-(--text) outline-none placeholder:text-(--text-4)"
				/>
			</div>
			<div className="flex shrink-0 flex-wrap items-center gap-1">
				<Menu>
					<MenuTrigger asChild>
						<PickerChip icon={priority === 'urgent' ? Flame : Flag} label={priority ? PRIORITY_LABEL[priority] : 'Priority'} />
					</MenuTrigger>
					<MenuContent align="end">
						<MenuItem checked={priority === null} onSelect={() => setPriority(null)}>
							No priority
						</MenuItem>
						{TODO_PRIORITIES.map((item) => (
							<MenuItem key={item} icon={item === 'urgent' ? Flame : Flag} checked={priority === item} onSelect={() => setPriority(item)}>
								{PRIORITY_LABEL[item]}
							</MenuItem>
						))}
					</MenuContent>
				</Menu>
				{space.repos.length > 0 ? (
					<Menu>
						<MenuTrigger asChild>
							<PickerChip icon={FolderGit2} label={repoLabel} />
						</MenuTrigger>
						<MenuContent align="end" className="min-w-[200px]">
							<MenuItem checked={projectId === null} onSelect={() => setProjectId(null)}>
								Auto (project default)
							</MenuItem>
							{space.repos.map((repo) => (
								<MenuItem key={repo.id} checked={projectId === repo.id} onSelect={() => setProjectId(repo.id)}>
									{repo.repoFullName}
								</MenuItem>
							))}
							<MenuSeparator />
							<MenuItem checked={projectId === TODO_NO_REPO} onSelect={() => setProjectId(TODO_NO_REPO)}>
								No repository
							</MenuItem>
						</MenuContent>
					</Menu>
				) : null}
				{onOpenDetails ? (
					<Btn size="xs" variant="ghost" onClick={() => onOpenDetails(title.trim())}>
						Details
					</Btn>
				) : null}
				<Btn type="submit" size="xs" variant="primary" disabled={!title.trim() || create.isPending}>
					Add
				</Btn>
			</div>
			{create.isError ? (
				<span role="alert" className="basis-full text-small text-(--bad)">
					{create.error.message}
				</span>
			) : null}
		</form>
	);
}

type TodoFilter = 'open' | 'active' | 'done' | 'all';

function TodoListRow({
	space,
	todo,
	threads,
	canMoveUp,
	canMoveDown,
	onMove,
	onEdit,
	onOpenCoordinator,
}: {
	space: Space;
	todo: SpaceTodo;
	threads: Session[];
	canMoveUp: boolean;
	canMoveDown: boolean;
	onMove: (direction: -1 | 1) => void;
	onEdit: () => void;
	onOpenCoordinator?: () => void;
}) {
	const queryClient = useQueryClient();
	const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['space-todos', space.id] });
	const toggleDone = useMutation({
		mutationFn: () => api.editSpaceTodo(space.id, todo.id, { status: todo.status === 'done' ? 'open' : 'done' }),
		onSuccess: invalidate,
	});
	const remove = useMutation({
		mutationFn: () => api.deleteSpaceTodo(space.id, todo.id),
		onSuccess: invalidate,
	});
	const linkedThreads = todo.threadIds
		.map((id) => threads.find((item) => item.id === id))
		.filter((item): item is Session => Boolean(item));
	const repo = repoLabelFor(space, todo.projectId);
	const isDone = todo.status === 'done' || todo.status === 'cancelled';

	return (
		<div className="group/todo flex items-start gap-2.5 border-t border-(--line) px-3.5 py-2.5 first:border-t-0 hover:bg-(--bg-hover)">
			<button
				type="button"
				aria-label={isDone ? `Reopen ${todo.title}` : `Mark ${todo.title} done`}
				disabled={toggleDone.isPending}
				onClick={() => toggleDone.mutate()}
				className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-inner text-(--text-3) outline-none hover:text-(--text) focus-visible:shadow-(--focus)"
			>
				<Icon icon={isDone ? CircleCheck : CircleDashed} size={15} className={isDone ? 'text-(--ok)' : undefined} />
			</button>

			<div className="flex min-w-0 flex-1 flex-col gap-1">
				<div className="flex min-w-0 items-start gap-2">
					<button
						type="button"
						onClick={onEdit}
						className={cn(
							'min-w-0 flex-1 rounded-inner text-left text-body leading-[19px] font-medium outline-none hover:underline focus-visible:shadow-(--focus)',
							isDone ? 'text-(--text-3) line-through' : 'text-(--text)',
						)}
					>
						{todo.title}
					</button>
					{todo.status === 'triaging' ? (
						<button
							type="button"
							onClick={() => onOpenCoordinator?.()}
							className="shrink-0 rounded-control outline-none focus-visible:shadow-(--focus)"
						>
							<Status tone="accent" pulse>
								Coordinating
							</Status>
						</button>
					) : null}
				</div>

				{todo.description ? (
					<p className="m-0 line-clamp-2 text-small leading-[17px] text-(--text-3)">{todo.description}</p>
				) : null}

				<div className="flex min-w-0 flex-wrap items-center gap-1.5">
					<PriorityBadge priority={todo.priority} compact />
					{repo ? (
						<Chip icon={todo.projectId === TODO_NO_REPO ? MessageSquare : FolderGit2}>{repo}</Chip>
					) : null}
					{todo.planMode ? <Chip icon={ListChecks}>Plans first</Chip> : null}
					{todo.tags.map((tag) => (
						<Chip key={tag} icon={Tag}>
							{tag}
						</Chip>
					))}
					{todo.dueAt ? (
						<Chip icon={Calendar} tone={isDone ? 'neutral' : dueTone(todo.dueAt)}>
							{formatDue(todo.dueAt)}
						</Chip>
					) : null}
					{todo.files.length > 0 ? (
						<Chip icon={Paperclip} mono>
							{todo.files.length}
						</Chip>
					) : null}
					{todo.sourceUrl ? (
						<a
							href={todo.sourceUrl}
							target="_blank"
							rel="noreferrer"
							className="inline-flex h-[18px] items-center gap-1 rounded-inner px-1.5 text-micro text-(--text-3) hover:bg-(--bg-active) hover:text-(--text)"
						>
							<Icon icon={ExternalLink} size={11} />
							<span>Link</span>
						</a>
					) : null}
					{linkedThreads.map((thread) => (
						<ThreadChip key={thread.id} thread={thread}>
							{thread.title}
						</ThreadChip>
					))}
				</div>
			</div>

			<div className="flex shrink-0 items-center gap-1">
				{todo.status === 'open' ? (
					<TodoAssignMenu
						space={space}
						todo={todo}
						threads={threads}
						size="xs"
						variant="secondary"
						onOpenCoordinator={onOpenCoordinator}
					/>
				) : null}
				<span className="hidden items-center gap-0.5 group-focus-within/todo:flex group-hover/todo:flex pointer-coarse:flex">
					{canMoveUp ? <IconBtn icon={ArrowUp} size="xs" label={`Move ${todo.title} up`} onClick={() => onMove(-1)} /> : null}
					{canMoveDown ? <IconBtn icon={ArrowDown} size="xs" label={`Move ${todo.title} down`} onClick={() => onMove(1)} /> : null}
					<IconBtn icon={Pencil} size="xs" label={`Edit ${todo.title}`} onClick={onEdit} />
					<IconBtn icon={Trash2} size="xs" label={`Delete ${todo.title}`} disabled={remove.isPending} onClick={() => remove.mutate()} />
				</span>
			</div>
		</div>
	);
}

export function ProjectTodos({
	space,
	threads,
	todos,
	onOpenCoordinator,
}: {
	space: Space;
	threads: Session[];
	todos: SpaceTodo[];
	onOpenCoordinator?: () => void;
}) {
	const queryClient = useQueryClient();
	const [filter, setFilter] = useState<TodoFilter>('open');
	const [search, setSearch] = useState('');
	const [priorityFilter, setPriorityFilter] = useState<string | null>(null);
	const [tagFilter, setTagFilter] = useState<string | null>(null);
	const [repoFilter, setRepoFilter] = useState<string | null>(null);
	const [editing, setEditing] = useState<{ mode: 'edit'; todo: SpaceTodo } | { mode: 'new'; title: string } | null>(null);

	const reorder = useMutation({
		mutationFn: (ids: string[]) => api.reorderSpaceTodos(space.id, ids),
		onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['space-todos', space.id] }),
	});

	const counts = useMemo(() => {
		let open = 0;
		let active = 0;
		let done = 0;
		for (const todo of todos) {
			if (todo.status === 'open') open += 1;
			else if (todo.status === 'triaging' || todo.status === 'in_progress') active += 1;
			else done += 1;
		}
		return { open, active, done, all: todos.length };
	}, [todos]);

	const allTags = useMemo(() => {
		const countsByTag = new Map<string, number>();
		for (const todo of todos) {
			for (const tag of todo.tags) countsByTag.set(tag, (countsByTag.get(tag) ?? 0) + 1);
		}
		return [...countsByTag.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
	}, [todos]);

	const filtered = useMemo(() => {
		const query = search.trim().toLowerCase();
		return todos
			.filter((todo) => {
				if (filter === 'open' && todo.status !== 'open') return false;
				if (filter === 'active' && todo.status !== 'triaging' && todo.status !== 'in_progress') return false;
				if (filter === 'done' && todo.status !== 'done' && todo.status !== 'cancelled') return false;
				if (priorityFilter && todo.priority !== priorityFilter) return false;
				if (tagFilter && !todo.tags.includes(tagFilter)) return false;
				if (repoFilter && todo.projectId !== repoFilter) return false;
				if (query) {
					const haystack = `${todo.title} ${todo.description} ${todo.tags.join(' ')}`.toLowerCase();
					if (!haystack.includes(query)) return false;
				}
				return true;
			})
			.sort((a, b) => {
				if (filter === 'open') return a.position - b.position || b.createdAt.localeCompare(a.createdAt);
				const pa = a.priority ? PRIORITY_RANK[a.priority] : 99;
				const pb = b.priority ? PRIORITY_RANK[b.priority] : 99;
				return pa - pb || b.updatedAt.localeCompare(a.updatedAt);
			});
	}, [todos, filter, priorityFilter, tagFilter, repoFilter, search]);

	const canReorder = filter === 'open' && !search.trim() && !priorityFilter && !tagFilter && !repoFilter;

	const moveItem = (index: number, direction: -1 | 1) => {
		const target = index + direction;
		if (target < 0 || target >= filtered.length) return;
		const next = [...filtered];
		const [item] = next.splice(index, 1);
		next.splice(target, 0, item);
		reorder.mutate(next.map((entry) => entry.id));
	};

	const hasFilters = Boolean(search.trim() || priorityFilter || tagFilter || repoFilter);

	return (
		<div className="flex flex-col gap-3">
			<div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
				<div className="max-w-full overflow-x-auto">
					<Segmented label="To-do status filter">
						<SegmentedItem on={filter === 'open'} onClick={() => setFilter('open')}>
							Open <span className="in-num text-micro text-(--text-3)">{counts.open}</span>
						</SegmentedItem>
						<SegmentedItem on={filter === 'active'} onClick={() => setFilter('active')}>
							Active <span className="in-num text-micro text-(--text-3)">{counts.active}</span>
						</SegmentedItem>
						<SegmentedItem on={filter === 'done'} onClick={() => setFilter('done')}>
							Done <span className="in-num text-micro text-(--text-3)">{counts.done}</span>
						</SegmentedItem>
						<SegmentedItem on={filter === 'all'} onClick={() => setFilter('all')}>
							All <span className="in-num text-micro text-(--text-3)">{counts.all}</span>
						</SegmentedItem>
					</Segmented>
				</div>

				<div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 sm:justify-end">
					<SearchField value={search} onChange={setSearch} placeholder="Filter to-dos" size="sm" className="w-full sm:w-[180px]" />
					<FilterMenu
						icon={Flag}
						label="Priority"
						anyLabel="Any priority"
						value={priorityFilter}
						valueLabel={priorityFilter ? PRIORITY_LABEL[priorityFilter as TodoPriority] : null}
						options={TODO_PRIORITIES.map((item) => ({ id: item, label: PRIORITY_LABEL[item] }))}
						onPick={setPriorityFilter}
					/>
					{allTags.length > 0 ? (
						<FilterMenu
							icon={Tag}
							label="Tag"
							anyLabel="Any tag"
							value={tagFilter}
							valueLabel={tagFilter}
							options={allTags.map(([tag, count]) => ({ id: tag, label: tag, hint: count }))}
							onPick={setTagFilter}
						/>
					) : null}
					{space.repos.length > 1 ? (
						<FilterMenu
							icon={FolderGit2}
							label="Repo"
							anyLabel="Any repository"
							value={repoFilter}
							valueLabel={repoFilter ? repoLabelFor(space, repoFilter) : null}
							options={[
								...space.repos.map((repo) => ({ id: repo.id, label: repo.repoFullName.split('/').pop() ?? repo.repoFullName })),
								{ id: TODO_NO_REPO, label: 'No repository' },
							]}
							onPick={setRepoFilter}
						/>
					) : null}
					{hasFilters ? (
						<Btn
							size="xs"
							variant="ghost"
							onClick={() => {
								setSearch('');
								setPriorityFilter(null);
								setTagFilter(null);
								setRepoFilter(null);
							}}
						>
							Clear
						</Btn>
					) : null}
				</div>
			</div>

			<TodoQuickAdd space={space} onOpenDetails={(initial) => setEditing({ mode: 'new', title: initial })} />

			{filtered.length === 0 ? (
				<EmptyState
					icon={hasFilters ? CircleAlert : ListTodo}
					title={
						hasFilters
							? 'No matching to-dos'
							: filter === 'open'
								? 'No open to-dos'
								: filter === 'active'
									? 'No assigned to-dos running'
									: filter === 'done'
										? 'No completed to-dos yet'
										: 'No to-dos yet'
					}
					body={
						hasFilters
							? 'Try clearing a filter or search term.'
							: filter === 'open'
								? 'Add items above, then assign them to the coordinator or a thread to track them on the board.'
								: 'Once you assign a to-do, it leaves the To do list and tracks through the board as threads.'
					}
					className="mt-6"
				/>
			) : (
				<section aria-label="Project to-dos" className="in-card overflow-hidden">
					{filtered.map((todo, index) => (
						<TodoListRow
							key={todo.id}
							space={space}
							todo={todo}
							threads={threads}
							canMoveUp={canReorder && index > 0}
							canMoveDown={canReorder && index < filtered.length - 1}
							onMove={(direction) => moveItem(index, direction)}
							onEdit={() => setEditing({ mode: 'edit', todo })}
							onOpenCoordinator={onOpenCoordinator}
						/>
					))}
				</section>
			)}

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

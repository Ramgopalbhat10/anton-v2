import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { ChevronDown, ChevronRight, Cpu, FolderGit2, GitPullRequest, type LucideIcon, Plus, Search, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { TasksArt } from '@/components/illustrations';
import { useModelName } from '@/components/model-picker';
import { MenuButton } from '@/components/nav';
import { EmptyState, Icon, Kbd, Menu, MenuContent, MenuItem, MenuTrigger, SearchField, Spinner } from '@/components/signal';
import { TaskRow } from '@/components/task-row';
import { glyphKind, type GlyphKind } from '@/components/thread-glyph';
import { api, isChat, SAFETY_NET_MS, type Session } from '@/lib/api';
import { threadActiveAt } from '@/lib/spaces';
import { cn } from '@/lib/utils';

/**
 * Tasks is a dense, grouped list: the kind tabs and the search sit in the
 * top bar, the attribute filters are chips under it, and the rows are one
 * line each under a header per state group. J and K move the cursor, Enter
 * opens the task under it.
 */

/** The tabs across the top: what kind of work the list holds. */
const KINDS = [
	{ id: 'all', label: 'All', test: () => true },
	{ id: 'repo', label: 'Repository', test: (session: Session) => !isChat(session) },
	{ id: 'chat', label: 'Chats', test: isChat },
	{ id: 'automation', label: 'Automations', test: (session: Session) => Boolean(session.automationId) },
] as const;
type KindId = (typeof KINDS)[number]['id'];

/** The state groups the list falls into, in the order they matter: what waits on you first, what is done last. */
const GROUPS: Array<{ id: string; label: string; kinds: GlyphKind[] }> = [
	{ id: 'needs', label: 'Needs you', kinds: ['waiting', 'failed', 'review'] },
	{ id: 'running', label: 'Running', kinds: ['working', 'queued', 'landing'] },
	{ id: 'idle', label: 'Idle', kinds: ['idle'] },
	{ id: 'done', label: 'Done', kinds: ['resolved'] },
];

/** The PR states a chip can narrow to; `checks` is the checks on the head commit. */
const PR_STATES: Array<{ id: string; label: string; test: (session: Session) => boolean }> = [
	{ id: 'open', label: 'Open', test: (session) => session.pullRequest?.state === 'open' },
	{ id: 'draft', label: 'Draft', test: (session) => session.pullRequest?.state === 'draft' },
	{ id: 'merged', label: 'Merged', test: (session) => session.pullRequest?.state === 'merged' },
	{ id: 'closed', label: 'Closed', test: (session) => session.pullRequest?.state === 'closed' },
	{ id: 'conflicts', label: 'Conflicts', test: (session) => session.pullRequest?.conflicts === true },
	{ id: 'checks-failed', label: 'Checks failing', test: (session) => session.pullRequest?.checks === 'failed' },
];

function matches(session: Session, query: string): boolean {
	const text = `${session.title} ${isChat(session) ? 'chat' : `${session.repo} ${session.branch}`} ${session.model}`.toLowerCase();
	return text.includes(query.trim().toLowerCase());
}

/** One attribute filter: a hairline chip that opens a menu of what it can be, tinted when it is set. */
function FilterMenu({
	icon,
	label,
	anyLabel,
	value,
	valueLabel,
	options,
	onPick,
}: {
	icon: LucideIcon;
	label: string;
	anyLabel: string;
	value: string | null;
	valueLabel: string | null;
	options: Array<{ id: string; label: string; hint?: number }>;
	onPick: (id: string | null) => void;
}) {
	return (
		<Menu>
			<MenuTrigger asChild>
				<button
					type="button"
					className={cn(
						'inline-flex h-6 max-w-[220px] shrink-0 items-center gap-1.5 rounded-control px-2 text-small whitespace-nowrap outline-none transition-colors duration-(--t-fast) focus-visible:shadow-(--focus)',
						value
							? 'bg-(--accent-soft) text-(--accent-text) shadow-[inset_0_0_0_1px_var(--accent-line)]'
							: 'text-(--text-2) shadow-[inset_0_0_0_1px_var(--line-strong)] hover:bg-(--bg-hover) hover:text-(--text)',
					)}
				>
					<Icon icon={icon} size={12} className="shrink-0" />
					<span className="truncate">{value ? `${label}: ${valueLabel}` : label}</span>
					<Icon icon={ChevronDown} size={12} className="shrink-0 text-(--text-3)" />
				</button>
			</MenuTrigger>
			<MenuContent align="start">
				<MenuItem checked={value === null} onSelect={() => onPick(null)}>
					{anyLabel}
				</MenuItem>
				{options.map((option) => (
					<MenuItem key={option.id} checked={value === option.id} onSelect={() => onPick(option.id)} hint={option.hint}>
						{option.label}
					</MenuItem>
				))}
			</MenuContent>
		</Menu>
	);
}

export function TasksPage() {
	const sessions = useQuery({ queryKey: ['sessions'], queryFn: api.sessions, refetchInterval: SAFETY_NET_MS });
	const modelName = useModelName();
	const navigate = useNavigate();
	const searchRef = useRef<HTMLInputElement>(null);
	const [query, setQuery] = useState('');
	const [kind, setKind] = useState<KindId>('all');
	const [repo, setRepo] = useState<string | null>(null);
	const [model, setModel] = useState<string | null>(null);
	const [pr, setPr] = useState<string | null>(null);
	const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
	const [cursor, setCursor] = useState(-1);

	const all = useMemo(() => sessions.data?.sessions ?? [], [sessions.data]);
	const searched = useMemo(() => all.filter((session) => matches(session, query)), [all, query]);
	const kinded = useMemo(() => searched.filter(KINDS.find((entry) => entry.id === kind)!.test), [searched, kind]);
	const filtered = useMemo(
		() =>
			kinded.filter(
				(session) =>
					(repo === null || session.repo === repo) &&
					(model === null || session.model === model) &&
					(pr === null || PR_STATES.find((state) => state.id === pr)?.test(session)),
			),
		[kinded, repo, model, pr],
	);
	const groups = useMemo(() => {
		const laidOut: Array<{ id: string; label: string; rows: Session[]; start: number }> = [];
		let at = 0;
		for (const group of GROUPS) {
			const rows = filtered
				.filter((session) => group.kinds.includes(glyphKind(session)))
				.sort((a, b) => threadActiveAt(b).localeCompare(threadActiveAt(a)));
			if (rows.length) laidOut.push({ ...group, rows, start: at });
			at += rows.length;
		}
		return laidOut;
	}, [filtered]);
	const flat = useMemo(() => groups.flatMap((group) => group.rows), [groups]);

	// The chips' options come from what the search leaves, so a pick never empties the list by itself.
	const repoOptions = useMemo(() => {
		const counts = new Map<string, number>();
		for (const session of searched) if (!isChat(session)) counts.set(session.repo, (counts.get(session.repo) ?? 0) + 1);
		return [...counts.entries()].map(([id, hint]) => ({ id, label: id.split('/').pop() ?? id, hint })).sort((a, b) => a.label.localeCompare(b.label));
	}, [searched]);
	const modelOptions = useMemo(() => {
		const counts = new Map<string, number>();
		for (const session of searched) if (session.model) counts.set(session.model, (counts.get(session.model) ?? 0) + 1);
		return [...counts.entries()].map(([id, hint]) => ({ id, label: modelName(id), hint })).sort((a, b) => a.label.localeCompare(b.label));
	}, [searched, modelName]);
	const prLabel = PR_STATES.find((state) => state.id === pr)?.label ?? null;
	const filteredChips = repo !== null || model !== null || pr !== null;

	// J and K move the cursor through the rows as they lie on screen; Enter opens the one under it.
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.metaKey || event.ctrlKey || event.altKey) return;
			const target = event.target;
			if (target instanceof HTMLElement && target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"], [role="listbox"]')) return;
			if (event.key === '/' && flat.length) {
				event.preventDefault();
				searchRef.current?.focus();
				return;
			}
			if (event.key === 'j' || event.key === 'J' || event.key === 'ArrowDown') {
				event.preventDefault();
				setCursor((at) => Math.min(flat.length - 1, at + 1));
			} else if (event.key === 'k' || event.key === 'K' || event.key === 'ArrowUp') {
				event.preventDefault();
				setCursor((at) => Math.max(-1, at - 1));
			} else if (event.key === 'Enter' && cursor >= 0 && cursor < flat.length) {
				void navigate({ to: '/agents/$sessionId', params: { sessionId: flat[cursor].id }, search: { app: 'code' } });
			}
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, [flat, cursor, navigate]);

	useEffect(() => {
		if (cursor < 0 || cursor >= flat.length) return;
		document.getElementById(`task-row-${flat[cursor].id}`)?.scrollIntoView({ block: 'nearest' });
	}, [cursor, flat]);

	const toggle = (id: string) =>
		setClosed((current) => {
			const next = new Set(current);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<header className="flex h-11 shrink-0 items-center gap-2 border-b border-(--line) pr-3 pl-2 md:pl-4">
				<MenuButton />
				<nav aria-label="Where you are" className="flex min-w-0 shrink-0 items-center text-body">
					<span className="font-medium text-(--text)">Tasks</span>
				</nav>
				<div role="tablist" aria-label="Kind of tasks" className="ml-2 flex min-w-0 items-center gap-0.5 overflow-x-auto [scrollbar-width:none]">
					{KINDS.map((entry) => {
						const count = searched.filter(entry.test).length;
						const on = kind === entry.id;
						return (
							<button
								key={entry.id}
								type="button"
								role="tab"
								aria-selected={on}
								onClick={() => {
									setKind(entry.id);
									setCursor(-1);
								}}
								className={cn(
									'inline-flex h-[26px] shrink-0 items-center gap-1.5 rounded-control px-2.5 text-small font-medium whitespace-nowrap outline-none transition-colors duration-(--t-fast) focus-visible:shadow-(--focus)',
									on ? 'bg-(--bg-active) text-(--text)' : 'text-(--text-3) hover:bg-(--bg-hover) hover:text-(--text)',
								)}
							>
								{entry.label}
								<span className="in-num text-micro text-(--text-3)">{count}</span>
							</button>
						);
					})}
				</div>
				<span className="min-w-2 flex-1" />
				<SearchField
					value={query}
					onChange={(next) => {
						setQuery(next);
						setCursor(-1);
					}}
					placeholder="Search tasks"
					label="Search tasks"
					inputRef={searchRef}
					trailing={<Kbd keys="/" size="sm" />}
					className="hidden w-[220px] shrink-0 md:flex"
				/>
				<Link to="/" className="sg-btn sg-btn--primary sg-btn--sm shrink-0">
					<Icon icon={Plus} size={13} />
					New task
				</Link>
			</header>

			<div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-(--line) px-4">
				<FilterMenu icon={FolderGit2} label="Repo" anyLabel="Any repository" value={repo} valueLabel={repo ? (repo.split('/').pop() ?? repo) : null} options={repoOptions} onPick={setRepo} />
				<FilterMenu icon={Cpu} label="Model" anyLabel="Any model" value={model} valueLabel={model ? modelName(model) : null} options={modelOptions} onPick={setModel} />
				<FilterMenu icon={GitPullRequest} label="PR state" anyLabel="Any pull request" value={pr} valueLabel={prLabel} options={PR_STATES.map((state) => ({ id: state.id, label: state.label }))} onPick={setPr} />
				{filteredChips ? (
					<button
						type="button"
						onClick={() => {
							setRepo(null);
							setModel(null);
							setPr(null);
							setCursor(-1);
						}}
						className="ml-1 inline-flex h-6 shrink-0 items-center gap-1 rounded-control px-2 text-small text-(--text-3) outline-none hover:bg-(--bg-hover) hover:text-(--text) focus-visible:shadow-(--focus)"
					>
						<Icon icon={X} size={12} />
						Clear
					</button>
				) : null}
			</div>

			<div className="min-h-0 flex-1 overflow-y-auto">
				{sessions.isPending ? (
					<div className="p-4">
						<Spinner size={13} />
					</div>
				) : all.length === 0 ? (
					<EmptyState art={<TasksArt className="w-full max-w-[320px]" />} title="No tasks yet" body="Tasks you and your projects start show up here, grouped by what each waits on." />
				) : flat.length === 0 ? (
					<EmptyState icon={Search} title="No tasks match" body="Try another search, or clear the filters." />
				) : (
					groups.map((group) => {
						const shut = closed.has(group.id);
						return (
							<section key={group.id} aria-label={group.label}>
								<button
									type="button"
									aria-expanded={!shut}
									onClick={() => toggle(group.id)}
									className="flex h-8 w-full items-center gap-2 bg-(--bg-hover) px-3 text-left text-small font-medium text-(--text-2) outline-none hover:text-(--text) focus-visible:shadow-(--focus-inset)"
								>
									<Icon icon={shut ? ChevronRight : ChevronDown} size={12} className="text-(--text-3)" />
									{group.label}
									<span className="in-num text-(--text-3)">{group.rows.length}</span>
								</button>
								{shut ? null : (
									<div>
										{group.rows.map((session, index) => (
											<div key={session.id} id={`task-row-${session.id}`} className={cn(index > 0 && 'border-t border-(--line)')}>
												<TaskRow session={session} modelName={modelName} active={cursor === group.start + index} />
											</div>
										))}
									</div>
								)}
							</section>
						);
					})
				)}
			</div>

			{all.length ? (
				<footer className="flex h-8 shrink-0 items-center gap-3 border-t border-(--line) px-4 text-small text-(--text-4)">
					<span className="in-num">
						{flat.length} of {all.length}
					</span>
					<span className="min-w-0 flex-1" />
					<span className="hidden items-center gap-1.5 sm:flex">
						<Kbd keys="j" size="sm" />
						<Kbd keys="k" size="sm" />
						move
					</span>
					<span className="hidden items-center gap-1.5 sm:flex">
						<Kbd keys="enter" size="sm" />
						open
					</span>
				</footer>
			) : null}
		</div>
	);
}

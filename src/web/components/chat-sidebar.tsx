import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { List, PanelLeft, Plus, Search, Settings, Square, X } from 'lucide-react';
import { useState } from 'react';
import { Avatar, Icon, IconBtn, SectionLabel } from '@/components/signal';
import { isLive, liveLabel, TaskStatusIcon } from '@/components/task-status';
import { api } from '@/lib/api';
import { age, dollars } from '@/lib/format';
import { cn } from '@/lib/utils';

/** Today's spend against the daily cap, so it is visible before it blocks anything. */
function SpentToday() {
	const budget = useQuery({ queryKey: ['budget'], queryFn: () => api.budget(), refetchInterval: 30_000 });
	if (!budget.data) return null;
	const { today, limits } = budget.data;
	return (
		<span className={cn('shrink-0 text-[11px]', budget.data.blocked ? 'text-(--danger-text)' : 'text-(--text-tertiary)')} title="Spent today">
			{dollars(today)}
			{limits.dailyUsd !== null ? ` / $${limits.dailyUsd}` : ''}
		</span>
	);
}

export function Logo({ size = 20 }: { size?: number }) {
	return (
		<div
			className="flex shrink-0 items-center justify-center rounded-md bg-(--accent-base) text-[11px] font-semibold text-(--accent-fg)"
			style={{ width: size, height: size }}
		>
			A
		</div>
	);
}

/** Collapsed sidebar: a 48px rail with the mark, show-sidebar and new-task. */
export function SidebarRail({ onExpand }: { onExpand: () => void }) {
	const navigate = useNavigate();
	return (
		<nav className="hidden w-12 shrink-0 flex-col items-center gap-1 border-r border-(--border-subtle) bg-(--bg-surface) py-2 md:flex">
			<div className="mb-2">
				<Logo />
			</div>
			<IconBtn icon={PanelLeft} size="sm" label="Show sidebar" onClick={onExpand} />
			<IconBtn icon={Plus} size="sm" label="New task" onClick={() => void navigate({ to: '/' })} />
		</nav>
	);
}

export function ChatSidebar({
	open,
	onNavigate,
	onCollapse,
	onOpenPalette,
}: {
	open: boolean;
	onNavigate: () => void;
	onCollapse: () => void;
	onOpenPalette: () => void;
}) {
	const params = useParams({ strict: false }) as { sessionId?: string };
	const queryClient = useQueryClient();
	const sessionsQuery = useQuery({ queryKey: ['sessions'], queryFn: api.sessions, refetchInterval: 5000 });
	const stop = useMutation({
		mutationFn: (id: string) => api.stopSession(id),
		onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['sessions'] }),
	});
	const [searching, setSearching] = useState(false);
	const [query, setQuery] = useState('');
	const sessions = sessionsQuery.data?.sessions ?? [];
	const running = sessions.filter(isLive);
	const recent = sessions
		.filter((session) => !isLive(session))
		.filter((session) => session.title.toLowerCase().includes(query.trim().toLowerCase()));

	return (
		<aside
			className={cn(
				'w-60 min-w-0 shrink-0 flex-col border-r border-(--border-subtle) bg-(--bg-surface)',
				open ? 'fixed inset-y-0 left-0 z-30 flex shadow-(--shadow-modal) md:static md:shadow-none' : 'hidden md:flex',
			)}
		>
			<div className="flex h-11 shrink-0 items-center gap-1.5 pr-2 pl-3">
				<Logo />
				<div className="min-w-0 truncate text-[13px] font-medium">Anton</div>
				<div className="min-w-1 flex-[1_1_4px]" />
				<IconBtn icon={Search} size="xs" label="Command palette" onClick={onOpenPalette} />
				<IconBtn icon={PanelLeft} size="xs" label="Hide sidebar" onClick={onCollapse} className="hidden md:inline-flex" />
				<IconBtn icon={X} size="xs" label="Close sidebar" onClick={onNavigate} className="md:hidden" />
			</div>

			<div className="px-2 pb-2">
				<Link
					to="/"
					onClick={onNavigate}
					className="flex h-8 items-center justify-center gap-1.5 rounded-lg bg-(--bg-overlay) text-[13px] font-medium text-(--text-primary) transition-colors duration-(--duration-micro) outline-none hover:bg-(--neutral-700) focus-visible:shadow-(--focus-ring)"
				>
					<Icon icon={Plus} />
					<span>New task</span>
				</Link>
			</div>

			<div className="flex flex-col gap-0.5 px-2 py-1">
				<Link
					to="/"
					activeOptions={{ exact: true }}
					onClick={onNavigate}
					className="group relative flex h-[30px] items-center gap-2 rounded-lg px-2 text-(--text-secondary) outline-none hover:bg-(--bg-hover) hover:text-(--text-primary) focus-visible:shadow-(--focus-ring) data-[status=active]:bg-(--alpha-white-6)"
				>
					<Icon icon={List} className="text-(--icon-tertiary)" />
					<div className="min-w-0 flex-1 truncate text-[13px]">Tasks</div>
					<div className="text-[11px] text-(--text-tertiary)">{sessions.length}</div>
				</Link>
			</div>

			<div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
				<div className="flex items-center gap-0.5 pt-4 pr-1.5 pb-1.5 pl-4">
					<SectionLabel className="flex-1">Running</SectionLabel>
				</div>
				<div className="flex flex-col gap-0.5 px-2">
					{sessionsQuery.isError ? (
						<div className="px-2 py-1.5 text-[12px] text-(--danger-text)">Could not load tasks.</div>
					) : sessionsQuery.isPending ? (
						<div className="flex flex-col gap-1 px-1">
							<div className="h-11 rounded-lg bg-(--bg-skeleton)" />
						</div>
					) : running.length === 0 ? (
						<div className="px-2 py-1.5 text-[12px] text-(--text-disabled)">Nothing is running.</div>
					) : (
						running.map((session) => {
							const active = params.sessionId === session.id;
							return (
								<div key={session.id} className="group relative flex h-11 items-center rounded-lg hover:bg-(--bg-hover)">
									{active ? <div className="absolute inset-0 rounded-lg bg-(--alpha-white-6)" /> : null}
									<Link
										to="/agents/$sessionId"
										params={{ sessionId: session.id }}
										search={{ app: 'code' }}
										onClick={onNavigate}
										className="relative flex h-full min-w-0 flex-1 items-center gap-2 rounded-lg pr-1.5 pl-2 outline-none focus-visible:shadow-(--focus-ring)"
									>
										<span className="inline-flex shrink-0 text-(--accent-text)">
											<TaskStatusIcon session={session} />
										</span>
										<div className="flex min-w-0 flex-1 flex-col gap-px">
											<div className="truncate text-[13px] text-(--text-primary)">{session.title}</div>
											<div className="truncate text-[11px] tracking-[0.02em] text-(--text-tertiary)">
												{liveLabel(session)} · {age(session.createdAt)} · {session.repo.split('/').pop()}
											</div>
										</div>
									</Link>
									<div className="relative hidden shrink-0 items-center gap-px pr-1.5 group-hover:flex group-focus-within:flex">
										<IconBtn
											icon={Square}
											size="xs"
											label="Stop sandbox"
											onClick={() => stop.mutate(session.id)}
											disabled={stop.isPending}
										/>
									</div>
								</div>
							);
						})
					)}
				</div>

				{searching ? (
					<div className="mx-2 mt-3.5 mb-1.5 ml-3 flex h-7 items-center gap-2 rounded-lg bg-(--bg-raised) px-2">
						<Icon icon={Search} size={12} className="text-(--icon-tertiary)" />
						<input
							autoFocus
							value={query}
							onChange={(event) => setQuery(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === 'Escape') {
									setQuery('');
									setSearching(false);
								}
							}}
							placeholder="Search recent tasks"
							className="min-w-0 flex-1 border-0 bg-transparent p-0 text-[13px] text-(--text-primary) outline-none"
						/>
						<button
							type="button"
							aria-label="Close search"
							onClick={() => {
								setQuery('');
								setSearching(false);
							}}
							className="inline-flex shrink-0 text-(--icon-tertiary) hover:text-(--text-primary)"
						>
							<Icon icon={X} size={12} />
						</button>
					</div>
				) : (
					<div className="flex items-center gap-0.5 pt-4 pr-1.5 pb-1.5 pl-4">
						<SectionLabel className="min-w-0 flex-1">Recent</SectionLabel>
						<IconBtn icon={Search} size="xs" label="Search recent tasks" onClick={() => setSearching(true)} />
					</div>
				)}
				<div className="flex flex-col gap-0.5 px-2 pb-2">
					{recent.length === 0 ? (
						<div className="px-2 py-1.5 text-[12px] text-(--text-disabled)">
							{query ? 'No recent task matches that search.' : 'Stopped tasks show up here.'}
						</div>
					) : (
						recent.map((session) => (
							<Link
								key={session.id}
								to="/agents/$sessionId"
								params={{ sessionId: session.id }}
								search={{ app: 'code' }}
								onClick={onNavigate}
								className={cn(
									'relative flex h-[30px] items-center gap-2 rounded-lg pr-1.5 pl-2 text-(--text-secondary) outline-none hover:bg-(--bg-hover) hover:text-(--text-primary) focus-visible:shadow-(--focus-ring)',
									params.sessionId === session.id && 'bg-(--alpha-white-6) text-(--text-primary)',
								)}
							>
								<TaskStatusIcon session={session} size={12} />
								<div className="min-w-0 flex-1 truncate text-[13px]">{session.title}</div>
								<div className="shrink-0 text-[11px] text-(--text-disabled)">{age(session.createdAt)}</div>
							</Link>
						))
					)}
				</div>
			</div>

			<div className="flex shrink-0 items-center gap-2 p-2">
				<Avatar name="Anton Dev" />
				<div className="min-w-0 flex-1 truncate text-[12px] text-(--text-secondary)">Anton Dev</div>
				<SpentToday />
				<Link to="/settings" onClick={onNavigate} aria-label="Settings" title="Settings" className="sg-btn sg-icon-btn sg-btn--ghost sg-btn--sm">
					<Icon icon={Settings} size={14} />
				</Link>
			</div>
		</aside>
	);
}

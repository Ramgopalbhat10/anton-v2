import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { CircleCheck, Loader, Plus, Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon, Kbd } from '@/components/signal';
import { api } from '@/lib/api';
import { age } from '@/lib/format';
import { useCreateChat } from '@/lib/create-chat';
import { chooseProject, useProjects } from '@/lib/projects';
import { cn } from '@/lib/utils';

type Entry = { id: string; label: string; meta: string; running: boolean; onSelect: () => void };

/** ⌘K palette: describe a task to start it, or jump to an existing one. */
export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
	const navigate = useNavigate();
	const create = useCreateChat();
	const sessions = useQuery({ queryKey: ['sessions'], queryFn: api.sessions, enabled: open });
	const project = chooseProject(useProjects().data?.projects ?? []);
	const [query, setQuery] = useState('');
	const [index, setIndex] = useState(0);
	const input = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (!open) {
			setQuery('');
			setIndex(0);
			return;
		}
		// A menu closing underneath can hand focus back to its trigger; take it after.
		const frame = requestAnimationFrame(() => input.current?.focus());
		function onKey(event: KeyboardEvent) {
			if (event.key === 'Escape') onClose();
		}
		window.addEventListener('keydown', onKey);
		return () => {
			cancelAnimationFrame(frame);
			window.removeEventListener('keydown', onKey);
		};
	}, [open, onClose]);

	const jumps = useMemo<Entry[]>(() => {
		const needle = query.trim().toLowerCase();
		return (sessions.data?.sessions ?? [])
			.filter((session) => !needle || session.title.toLowerCase().includes(needle))
			.slice(0, 8)
			.map((session) => ({
				id: session.id,
				label: session.title,
				meta: `${session.repo.split('/').pop()} · ${age(session.createdAt)}`,
				running: session.status === 'running' || session.status === 'starting',
				onSelect: () => {
					onClose();
					void navigate({ to: '/agents/$sessionId', params: { sessionId: session.id }, search: { app: 'code' } });
				},
			}));
	}, [sessions.data, query, navigate, onClose]);

	if (!open) return null;

	function start() {
		onClose();
		const prompt = query.trim();
		if (prompt && project) create.mutate({ prompt, projectId: project.id });
		else void navigate({ to: '/' });
	}

	const count = jumps.length + 1;

	return (
		<div
			className="fixed inset-0 z-[200] flex items-start justify-center bg-(--bg-scrim) px-4 pt-[14vh] pb-4"
			onMouseDown={(event) => {
				if (event.target === event.currentTarget) onClose();
			}}
		>
			<div
				role="dialog"
				aria-label="Command palette"
				className="flex w-[min(560px,100%)] flex-col overflow-hidden rounded-lg bg-(--bg-overlay) shadow-(--shadow-modal)"
			>
				<div className="flex h-12 items-center gap-2.5 px-3.5 shadow-[inset_0_-1px_0_var(--border-subtle)]">
					<Icon icon={Search} className="text-(--icon-tertiary)" />
					<input
						ref={input}
						autoFocus
						value={query}
						onChange={(event) => {
							setQuery(event.target.value);
							setIndex(0);
						}}
						onKeyDown={(event) => {
							if (event.key === 'ArrowDown') {
								event.preventDefault();
								setIndex((current) => (current + 1) % count);
							} else if (event.key === 'ArrowUp') {
								event.preventDefault();
								setIndex((current) => (current - 1 + count) % count);
							} else if (event.key === 'Enter') {
								event.preventDefault();
								if (index === 0) start();
								else jumps[index - 1]?.onSelect();
							}
						}}
						placeholder="Type a command, or describe a task"
						className="min-w-0 flex-1 border-0 bg-transparent p-0 text-[14px] text-(--text-primary) outline-none"
					/>
				</div>
				<div className="flex max-h-[52vh] flex-col gap-px overflow-y-auto p-1.5">
					<button
						type="button"
						onMouseEnter={() => setIndex(0)}
						onClick={start}
						className={cn(
							'relative flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-left',
							index === 0 ? 'bg-(--bg-selected)' : 'hover:bg-(--bg-hover)',
						)}
					>
						<Icon icon={Plus} className="text-(--accent-text)" />
						<div className="min-w-0 flex-1 truncate text-[13px]">
							Start a task{' '}
							<span className="text-(--text-tertiary)">{query.trim() ? `“${query.trim()}”` : 'with a prompt…'}</span>
						</div>
						<Kbd keys="enter" />
					</button>
					{jumps.length > 0 ? (
						<div className="px-2.5 pt-3 pb-1 text-[11px] font-medium tracking-[0.06em] text-(--text-disabled) uppercase">Jump to</div>
					) : null}
					{jumps.map((entry, position) => (
						<button
							type="button"
							key={entry.id}
							onMouseEnter={() => setIndex(position + 1)}
							onClick={entry.onSelect}
							className={cn(
								'flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-left text-(--text-secondary)',
								index === position + 1 && 'bg-(--bg-hover) text-(--text-primary)',
							)}
						>
							<Icon icon={entry.running ? Loader : CircleCheck} size={12} className="text-(--icon-tertiary)" />
							<div className="min-w-0 flex-1 truncate text-[13px]">{entry.label}</div>
							<div className="text-[11px] whitespace-nowrap text-(--text-disabled)">{entry.meta}</div>
						</button>
					))}
				</div>
				<div className="flex h-9 items-center gap-3 px-3 shadow-[inset_0_1px_0_var(--border-subtle)]">
					<div className="flex items-center gap-1.5">
						<Kbd keys="↑+↓" />
						<span className="text-[11px] text-(--text-disabled)">Navigate</span>
					</div>
					<div className="flex items-center gap-1.5">
						<Kbd keys="esc" />
						<span className="text-[11px] text-(--text-disabled)">Close</span>
					</div>
					<div className="flex-1" />
					<span className="hidden text-[11px] text-(--text-disabled) sm:inline">Describing a task starts it in a fresh sandbox</span>
				</div>
			</div>
		</div>
	);
}

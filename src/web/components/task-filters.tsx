import { CalendarDays, CircleDot, Cpu, FolderGit2, GitPullRequest, type LucideIcon, Server, X } from 'lucide-react';
import { Icon, MenuItem, MenuSub, MenuSubContent, MenuSubTrigger } from '@/components/signal';
import type { Session } from '@/lib/api';
import { FACET_KEYS, FACETS, type FacetKey, optionLabel, type TaskView } from '@/lib/task-view';

/*
 * Filters over a list of tasks, shared by the sidebar's Tasks and a project's
 * threads: a submenu per facet, and the filters in use as chips that remove
 * themselves.
 */

type Filters = TaskView['filters'];

export const FACET_ICON: Record<FacetKey, LucideIcon> = { status: CircleDot, sandbox: Server, pr: GitPullRequest, repo: FolderGit2, model: Cpu, created: CalendarDays };

/**
 * A submenu per facet, each option with how many tasks it matches. Picking one
 * keeps the menu open, so several can be picked.
 */
export function FacetSubmenus({ filters, onToggle, tasks, keys = FACET_KEYS }: { filters: Filters; onToggle: (key: FacetKey, value: string) => void; tasks: Session[]; keys?: FacetKey[] }) {
	return keys.map((key) => {
		const options = FACETS[key].options(tasks);
		return (
			<MenuSub key={key}>
				<MenuSubTrigger icon={FACET_ICON[key]} hint={filters[key].length || undefined}>
					{FACETS[key].label}
				</MenuSubTrigger>
				<MenuSubContent>
					{options.length ? (
						options.map((option) => (
							<MenuItem
								key={option.value}
								checked={filters[key].includes(option.value)}
								hint={tasks.filter((task) => FACETS[key].test(task, option.value)).length}
								onSelect={(event) => {
									event.preventDefault();
									onToggle(key, option.value);
								}}
							>
								{option.label}
							</MenuItem>
						))
					) : (
						<MenuItem disabled>No tasks yet</MenuItem>
					)}
				</MenuSubContent>
			</MenuSub>
		);
	});
}

/** The filters in use, each a chip that removes itself. */
export function FilterChips({ filters, onToggle, tasks }: { filters: Filters; onToggle: (key: FacetKey, value: string) => void; tasks: Session[] }) {
	const chips = FACET_KEYS.flatMap((key) => filters[key].map((value) => ({ key, value, label: optionLabel(key, value, tasks) })));
	return (
		<div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
			{chips.map(({ key, value, label }) => (
				<button
					key={`${key}:${value}`}
					type="button"
					aria-label={`Remove the ${label} filter`}
					onClick={() => onToggle(key, value)}
					className="flex h-5 max-w-full items-center gap-1 rounded-inner bg-(--accent-soft) pr-1 pl-1.5 text-micro font-medium text-(--accent-text) outline-none focus-visible:shadow-(--focus)"
				>
					<Icon icon={FACET_ICON[key]} size={10} />
					<span className="truncate">{label}</span>
					<Icon icon={X} size={10} />
				</button>
			))}
		</div>
	);
}

import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ChevronRight } from 'lucide-react';
import { Icon } from '@/components/signal';
import { api } from '@/lib/api';
import { dollars } from '@/lib/format';
import { useProjects } from '@/lib/projects';
import { size } from './parts';
import { GROUPS, SECTIONS } from './sections';

function Stat({ label, value }: { label: string; value: string | undefined }) {
	return (
		<div className="flex flex-col gap-1 px-3 py-2.5">
			<div className="text-[11px] font-medium tracking-[0.06em] text-(--text-disabled) uppercase">{label}</div>
			<div className="text-[16px] font-medium tabular-nums">{value ?? '…'}</div>
		</div>
	);
}

function Stats() {
	const budget = useQuery({ queryKey: ['budget'], queryFn: () => api.budget() });
	const sessions = useQuery({ queryKey: ['sessions'], queryFn: api.sessions });
	const storage = useQuery({ queryKey: ['storage'], queryFn: api.storage });
	const projects = useProjects();
	const running = sessions.data?.sessions.filter((session) => session.status === 'running').length;
	return (
		<div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-0.5 rounded-lg border border-(--border-subtle) bg-(--bg-surface) p-1">
			<Stat label="Spent today" value={budget.data && dollars(budget.data.today)} />
			<Stat label="Sandboxes running" value={running?.toString()} />
			<Stat label="Repositories" value={projects.data?.projects.length.toString()} />
			<Stat label="Storage" value={storage.data && size(storage.data.bytes)} />
		</div>
	);
}

/** Every settings page by group, with a few numbers worth seeing first. */
export function SettingsOverview() {
	return (
		<div className="flex flex-col gap-6">
			<div className="flex flex-col gap-1.5">
				<h1 className="m-0 text-[24px] leading-[30px] font-semibold tracking-[-0.022em]">Settings</h1>
				<p className="m-0 text-[13px] leading-[19px] text-pretty text-(--text-tertiary)">
					Anton runs every task in its own sandbox, on its own branch. What you set here decides what it may spend, which repositories it works on,
					and what it keeps between tasks.
				</p>
			</div>
			<Stats />
			{GROUPS.map((group) => (
				<section key={group.id} className="flex flex-col gap-2.5">
					<div className="flex flex-col gap-1">
						<h2 className="m-0 text-[16px] font-semibold tracking-[-0.011em]">{group.label}</h2>
						<p className="m-0 text-[13px] text-pretty text-(--text-tertiary)">{group.desc}</p>
					</div>
					<div className="flex flex-col gap-0.5 rounded-lg border border-(--border-subtle) bg-(--bg-surface) p-1">
						{SECTIONS.filter((section) => section.group === group.id).map((section) => (
							<Link
								key={section.id}
								to="/settings/$section"
								params={{ section: section.id }}
								className="flex min-h-12 items-center gap-3 rounded-lg px-2.5 py-1.5 outline-none hover:bg-(--bg-hover) focus-visible:shadow-(--focus-ring)"
							>
								<Icon icon={section.icon} className="text-(--icon-secondary)" />
								<div className="flex min-w-0 flex-1 flex-col gap-0.5">
									<div className="truncate text-[13px] font-medium">{section.label}</div>
									<div className="truncate text-[12px] text-(--text-tertiary)">{section.desc}</div>
								</div>
								<Icon icon={ChevronRight} size={12} className="text-(--icon-disabled)" />
							</Link>
						))}
					</div>
				</section>
			))}
		</div>
	);
}

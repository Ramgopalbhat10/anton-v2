import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Activity, ArrowUpRight, Box, ChevronRight, Folder, HardDrive } from 'lucide-react';
import type { ReactNode } from 'react';
import { ArcDial, DotMatrix, lastDays } from '@/components/charts';
import { SandboxArt } from '@/components/illustrations';
import { Caption, Card, CardFooter, CardSection, Figure, type Part, ShareRow, SplitBar, Status, usedTone, Well } from '@/components/instrument';
import { Icon } from '@/components/signal';
import { isLive } from '@/components/task-status';
import { api } from '@/lib/api';
import { age, dollars } from '@/lib/format';
import { useProjects } from '@/lib/projects';
import { size } from './parts';
import { GROUPS, SECTIONS } from './sections';

function Open({ section, children }: { section: string; children: ReactNode }) {
	return (
		<Link
			to="/settings/$section"
			params={{ section }}
			className="inline-flex h-7 items-center gap-1 rounded-full bg-(--bg-overlay) px-3 text-[12px] font-medium text-(--text-secondary) outline-none hover:bg-(--neutral-700) hover:text-(--text-primary) focus-visible:shadow-(--focus-ring)"
		>
			{children}
			<Icon icon={ArrowUpRight} size={12} />
		</Link>
	);
}

/** Today's spend against the daily cap, and the shape of the last 30 days. */
function SpendCard() {
	const budget = useQuery({ queryKey: ['budget'], queryFn: () => api.budget() });
	const usage = useQuery({ queryKey: ['usage'], queryFn: api.usage });
	const today = budget.data?.today ?? 0;
	const cap = budget.data?.limits.dailyUsd ?? null;
	const used = cap ? today / cap : 0;
	const days = lastDays(30);
	const trend = days.map((day) => ({ key: day, value: (usage.data?.daily ?? []).filter((row) => row.day === day).reduce((sum, row) => sum + row.cost, 0) }));
	return (
		<Card
			icon={Activity}
			title="Spend today"
			sub="all tasks"
			status={cap === null ? <Status>No cap</Status> : <Status tone={usedTone(used)}>{Math.round(used * 100)}% of cap</Status>}
			footer={
				<CardFooter caption="Resets at midnight">
					<Open section="usage">Usage</Open>
				</CardFooter>
			}
		>
			<CardSection ruled={false} className="pt-1">
				<div className="flex items-center justify-between gap-4">
					<div className="flex min-w-0 flex-col gap-2">
						<Figure value={budget.data ? dollars(today) : '…'} unit={cap !== null ? `of $${cap}` : undefined} />
						<Caption className="tracking-normal normal-case">
							{cap === null ? 'No daily cap is set.' : `Agents stop for the day at $${cap}.`}
						</Caption>
					</div>
					{cap !== null ? (
						<ArcDial label="Today's spend against the daily cap" value={today} max={cap}>
							<span className="in-num text-[15px] leading-none text-(--text-primary)">{dollars(Math.max(0, cap - today))}</span>
							<span className="in-caption">left</span>
						</ArcDial>
					) : null}
				</div>
			</CardSection>
			<CardSection label="Last 30 days" hint={usage.data ? dollars(usage.data.month) + ' this month' : undefined}>
				<DotMatrix values={trend} format={dollars} label="Spend per day over the last 30 days" />
			</CardSection>
		</Card>
	);
}

/** Tasks by state, and how many hold a sandbox right now. */
function TasksCard() {
	const sessions = useQuery({ queryKey: ['sessions'], queryFn: api.sessions });
	const all = sessions.data?.sessions ?? [];
	const running = all.filter((session) => session.status === 'running').length;
	const parts: Part[] = [
		{ key: 'live', label: 'Running', value: all.filter(isLive).length, color: 'var(--accent-base)' },
		{ key: 'stopped', label: 'Stopped', value: all.filter((session) => !isLive(session) && session.status !== 'error').length, color: 'var(--neutral-500)' },
		{ key: 'failed', label: 'Failed', value: all.filter((session) => session.status === 'error').length, color: 'var(--danger-base)' },
	];
	return (
		<Card
			icon={Box}
			title="Sandboxes"
			sub="running now"
			status={running ? <Status tone="success" pulse>Live</Status> : <Status>Idle</Status>}
			footer={
				<CardFooter caption={`${all.length} tasks in all`}>
					<Open section="compute">Compute</Open>
				</CardFooter>
			}
		>
			<CardSection ruled={false} className="pt-1">
				<Figure value={sessions.data ? String(running) : '…'} unit={running === 1 ? 'sandbox' : 'sandboxes'} />
				<SplitBar label="Tasks by state" parts={parts} />
			</CardSection>
			<CardSection className="flex-1 pt-3">
				{running ? (
					<div className="flex flex-col gap-1">
						{all
							.filter((session) => session.status === 'running')
							.slice(0, 4)
							.map((session) => (
								<Link
									key={session.id}
									to="/agents/$sessionId"
									params={{ sessionId: session.id }}
									search={{ app: 'code' }}
									className="flex min-h-8 items-center gap-2 rounded-lg px-1 text-[12px] outline-none hover:bg-(--bg-hover) focus-visible:shadow-(--focus-ring)"
								>
									<span className="in-pulse size-1.5 shrink-0 rounded-full bg-(--success-base)" />
									<span className="min-w-0 flex-1 truncate">{session.title}</span>
									<Caption className="tracking-normal normal-case">{age(session.createdAt)}</Caption>
								</Link>
							))}
					</div>
				) : (
					<Well grid className="flex flex-1 items-center justify-center py-3">
						<SandboxArt className="w-full max-w-[230px]" />
					</Well>
				)}
			</CardSection>
		</Card>
	);
}

/** Repositories, ranked by how many tasks have worked on each. */
function ReposCard() {
	const projects = useProjects();
	const sessions = useQuery({ queryKey: ['sessions'], queryFn: api.sessions });
	const counts = (projects.data?.projects ?? [])
		.map((project) => ({ project, tasks: (sessions.data?.sessions ?? []).filter((session) => session.projectId === project.id).length }))
		.sort((a, b) => b.tasks - a.tasks);
	const most = Math.max(1, ...counts.map((entry) => entry.tasks));
	return (
		<Card
			icon={Folder}
			title="Repositories"
			sub="by tasks"
			footer={
				<CardFooter caption="Each with its own settings">
					<Open section="repos">Repositories</Open>
				</CardFooter>
			}
		>
			<CardSection ruled={false} className="gap-1 pt-1">
				<Figure value={projects.data ? String(projects.data.projects.length) : '…'} unit={projects.data?.projects.length === 1 ? 'repository' : 'repositories'} />
				{counts.slice(0, 3).map(({ project, tasks }) => (
					<ShareRow key={project.id} label={project.repoFullName.split('/').pop()} sub={project.repoFullName.split('/')[0]} share={tasks / most} value={`${tasks} ${tasks === 1 ? 'task' : 'tasks'}`} />
				))}
			</CardSection>
		</Card>
	);
}

function StorageCard() {
	const storage = useQuery({ queryKey: ['storage'], queryFn: api.storage });
	const data = storage.data;
	return (
		<Card
			icon={HardDrive}
			title="Storage"
			sub="checkpoints and files"
			footer={
				<CardFooter caption={data?.lastCleanup ? `Cleaned ${age(data.lastCleanup.at)} ago` : 'Cleans up daily'}>
					<Open section="storage">Storage</Open>
				</CardFooter>
			}
		>
			<CardSection ruled={false} className="pt-1">
				<Figure value={data ? size(data.bytes) : '…'} unit={data ? `${data.objects.toLocaleString()} objects` : undefined} />
				<Caption className="tracking-normal normal-case">
					{data?.lastCleanup ? `Last cleanup freed ${size(data.lastCleanup.freedBytes)} from ${data.lastCleanup.removed} objects.` : 'Nothing cleaned up yet.'}
				</Caption>
			</CardSection>
		</Card>
	);
}

/** Every settings page by group, with a few numbers worth seeing first. */
export function SettingsOverview() {
	return (
		<div className="flex flex-col gap-6">
			<div className="flex flex-col gap-2">
				<h1 className="m-0 text-[26px] leading-[32px] font-semibold tracking-[-0.022em]">Settings</h1>
				<p className="m-0 max-w-[72ch] text-[13px] leading-[20px] text-pretty text-(--text-tertiary)">
					Anton runs every task in its own sandbox, on its own branch. What you set here decides what it may spend, which repositories it works on,
					and what it keeps between tasks.
				</p>
			</div>
			<div className="grid gap-3 sm:grid-cols-2">
				<SpendCard />
				<TasksCard />
				<ReposCard />
				<StorageCard />
			</div>
			{GROUPS.map((group) => (
				<Card key={group.id} title={group.label} sub={group.desc}>
					<nav aria-label={group.label} className="grid gap-px px-1.5 pb-1.5 sm:grid-cols-2">
						{SECTIONS.filter((section) => section.group === group.id).map((section) => (
							<Link
								key={section.id}
								to="/settings/$section"
								params={{ section: section.id }}
								className="group/row flex min-h-14 items-center gap-3 rounded-[10px] px-2.5 py-2 outline-none hover:bg-(--bg-hover) focus-visible:shadow-(--focus-ring)"
							>
								<span className="inline-flex size-8 shrink-0 items-center justify-center rounded-[9px] border border-(--border-subtle) bg-(--well-bg) text-(--icon-secondary) group-hover/row:text-(--accent-text)">
									<Icon icon={section.icon} size={14} />
								</span>
								<div className="flex min-w-0 flex-1 flex-col gap-0.5">
									<div className="truncate text-[13px] font-medium">{section.label}</div>
									<div className="line-clamp-2 text-[12px] leading-4 text-(--text-tertiary)">{section.desc}</div>
								</div>
								<Icon icon={ChevronRight} size={12} className="text-(--icon-disabled) group-hover/row:text-(--icon-secondary)" />
							</Link>
						))}
					</nav>
				</Card>
			))}
		</div>
	);
}

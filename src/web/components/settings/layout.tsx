import { Link, Outlet, useParams, useRouterState, useSearch } from '@tanstack/react-router';
import { ChevronRight, List } from 'lucide-react';
import { Fragment, type ReactNode } from 'react';
import { MenuButton } from '@/components/nav';
import { EmptyState, Icon, SectionLabel } from '@/components/signal';
import { useProjects } from '@/lib/projects';
import { cn } from '@/lib/utils';
import { GROUPS, SECTIONS, sectionById } from './sections';
import { pickOf, usePreview } from './skill-detail';
import type { ViewSearch } from './skills';

const NAV_ITEM =
	'relative flex h-7 items-center gap-2 rounded-lg px-2 text-[13px] text-(--text-secondary) outline-none hover:bg-(--bg-hover) hover:text-(--text-primary) focus-visible:shadow-(--focus-ring) data-[status=active]:bg-(--alpha-white-6) data-[status=active]:text-(--text-primary)';

function Nav() {
	return (
		<nav aria-label="Settings" className="hidden w-[224px] shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-(--border-subtle) pt-2 pr-2 pb-4 pl-3 md:flex">
			<Link to="/settings" activeOptions={{ exact: true }} className={NAV_ITEM}>
				<Icon icon={List} size={12} className="text-(--icon-tertiary)" />
				All settings
			</Link>
			{GROUPS.map((group) => (
				<Fragment key={group.id}>
					<SectionLabel className="px-2 pt-3.5 pb-1">{group.label}</SectionLabel>
					{SECTIONS.filter((section) => section.group === group.id).map((section) => (
						<Link key={section.id} to="/settings/$section" params={{ section: section.id }} className={NAV_ITEM}>
							<Icon icon={section.icon} size={12} className="text-(--icon-tertiary)" />
							<span className="min-w-0 flex-1 truncate">{section.label}</span>
						</Link>
					))}
				</Fragment>
			))}
		</nav>
	);
}

const usePath = () => useRouterState({ select: (state) => state.location.pathname });

/** The plugin a skill page shows, named once it has been read. */
function PluginCrumb() {
	const search = useSearch({ strict: false }) as ViewSearch;
	const preview = usePreview(pickOf(search));
	return <>{preview.data?.name ?? search.name ?? search.address ?? 'Plugin'}</>;
}

/** Settings › Section › Repository or plugin, each step a way back. */
function Crumbs() {
	const { section, projectId } = useParams({ strict: false }) as { section?: string; projectId?: string };
	const projects = useProjects();
	const path = usePath();
	const repo = projectId ? projects.data?.projects.find((project) => project.id === projectId)?.repoFullName : undefined;
	const steps: ReactNode[] = [];
	if (projectId) steps.push(<CrumbLink to="repos">Repositories</CrumbLink>, repo ?? 'Repository');
	else if (path === '/settings/skills/view') steps.push(<CrumbLink to="skills">Skills</CrumbLink>, <PluginCrumb />);
	else if (section) steps.push(sectionById(section)?.label ?? 'Not found');
	return (
		<div className="flex min-w-0 items-center gap-2">
			<Link to="/settings" className="shrink-0 text-(--text-secondary) outline-none hover:text-(--text-primary) focus-visible:shadow-(--focus-ring)">
				Settings
			</Link>
			{steps.map((step, index) => (
				<Fragment key={index}>
					<Icon icon={ChevronRight} size={12} className="text-(--icon-disabled)" />
					<span className="min-w-0 truncate text-(--text-primary)">{step}</span>
				</Fragment>
			))}
		</div>
	);
}

function CrumbLink({ to, children }: { to: string; children: ReactNode }) {
	return (
		<Link to="/settings/$section" params={{ section: to }} className="text-(--text-secondary) outline-none hover:text-(--text-primary)">
			{children}
		</Link>
	);
}

/** The settings frame: breadcrumbs, the grouped nav, and the page beside it. */
export function SettingsLayout() {
	// Skills lay plugins out as cards and files side by side, so they get more room.
	const wide = usePath().startsWith('/settings/skills');
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<header className="flex h-11 shrink-0 items-center gap-1 border-b border-(--border-subtle) pr-4 pl-2 text-[13px] font-medium md:pl-4">
				<MenuButton />
				<Crumbs />
			</header>
			<div className="flex min-h-0 flex-1">
				<Nav />
				<div className="min-h-0 min-w-0 flex-1 overflow-y-auto px-4 pt-4 pb-12 md:px-6">
					<div className={cn('flex flex-col gap-6', wide ? 'max-w-[1080px]' : 'max-w-[820px]')}>
						<Outlet />
					</div>
				</div>
			</div>
		</div>
	);
}

export function SectionPage() {
	const { section } = useParams({ from: '/settings/$section' });
	const found = sectionById(section);
	if (!found) return <EmptyState title="No such settings page" body="It may have moved. All settings are listed on the left." />;
	return <found.Page />;
}

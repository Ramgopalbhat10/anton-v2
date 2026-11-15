import { Link, Outlet, useParams, useRouterState, useSearch } from '@tanstack/react-router';
import { ChevronRight, List, type LucideIcon, X } from 'lucide-react';
import { Fragment, type ReactNode, useState } from 'react';
import { EmptyState, Icon, IconBtn, Kbd, SearchField, SectionLabel } from '@/components/signal';
import { closeSettings } from '@/lib/settings-modal';
import { useProjects } from '@/lib/projects';
import { cn } from '@/lib/utils';
import { GROUPS, SECTIONS, sectionById } from './sections';
import { ConnectorCrumb } from './connectors';
import { pickOf, usePreview } from './skill-detail';
import type { ViewSearch } from './skills';

const NAV_ITEM =
	'group/nav relative flex h-7 shrink-0 items-center gap-2 rounded-control px-2 text-body font-medium text-(--text-2) outline-none hover:bg-(--bg-hover) hover:text-(--text) focus-visible:shadow-(--focus) data-[status=active]:bg-(--bg-active) data-[status=active]:text-(--text)';

/** A nav item's bare icon, lit on the page you are on. */
function NavIcon({ icon }: { icon: LucideIcon }) {
	return (
		<span className="inline-flex shrink-0 text-(--text-3) group-hover/nav:text-(--text-2) group-data-[status=active]/nav:text-(--text)">
			<Icon icon={icon} size={14} />
		</span>
	);
}

/** A search hit: the page's name over what it decides, since the words that matched may be in the second line. */
function SearchHit({ section }: { section: (typeof SECTIONS)[number] }) {
	return (
		<Link to="/settings/$section" params={{ section: section.id }} className={cn(NAV_ITEM, 'h-auto flex-col items-start gap-0.5 py-1.5')}>
			<span className="flex w-full min-w-0 items-center gap-2">
				<NavIcon icon={section.icon} />
				<span className="min-w-0 flex-1 truncate">{section.label}</span>
			</span>
			<span className="w-full truncate pl-[22px] text-micro font-normal text-(--text-4)">{section.desc}</span>
		</Link>
	);
}

function Nav() {
	const [query, setQuery] = useState('');
	const words = query.trim().toLowerCase();
	const hits = words ? SECTIONS.filter((section) => `${section.label} ${section.desc}`.toLowerCase().includes(words)) : [];
	return (
		<nav aria-label="Settings" className="hidden w-[220px] shrink-0 flex-col gap-px overflow-y-auto border-r border-(--line) bg-(--bg-panel) px-2 pt-3 pb-4 md:flex">
			<div className="pb-2" onKeyDown={(event) => event.key === 'Escape' && words && (setQuery(''), event.stopPropagation())}>
				<SearchField value={query} onChange={setQuery} placeholder="Search settings" label="Search settings" size="sm" />
			</div>
			<Link to="/settings" activeOptions={{ exact: true }} className={NAV_ITEM}>
				<NavIcon icon={List} />
				All settings
			</Link>
			{words ? (
				hits.length ? (
					<div className="flex flex-col gap-px pt-1">{hits.map((section) => <SearchHit key={section.id} section={section} />)}</div>
				) : (
					<div className="px-2 pt-3 text-small text-(--text-4)">No settings match “{query.trim()}”.</div>
				)
			) : (
				GROUPS.map((group) => (
					<Fragment key={group.id}>
						<SectionLabel className="flex h-6 items-center px-2 not-first:mt-3">{group.label}</SectionLabel>
						{SECTIONS.filter((section) => section.group === group.id).map((section) => (
							<Link key={section.id} to="/settings/$section" params={{ section: section.id }} className={NAV_ITEM}>
								<NavIcon icon={section.icon} />
								<span className="min-w-0 flex-1 truncate">{section.label}</span>
							</Link>
						))}
					</Fragment>
				))
			)}
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
	else if (path === '/settings/connectors/view') steps.push(<CrumbLink to="connectors">Connectors</CrumbLink>, <ConnectorCrumb />);
	else if (section) steps.push(sectionById(section)?.label ?? 'Not found');
	return (
		<div className="flex min-w-0 items-center gap-2">
			<Link to="/settings" className="shrink-0 text-(--text-2) outline-none hover:text-(--text) focus-visible:shadow-(--focus)">
				Settings
			</Link>
			{steps.map((step, index) => (
				<Fragment key={index}>
					<Icon icon={ChevronRight} size={12} className="text-(--text-4)" />
					<span className="min-w-0 truncate text-(--text)">{step}</span>
				</Fragment>
			))}
		</div>
	);
}

function CrumbLink({ to, children }: { to: string; children: ReactNode }) {
	return (
		<Link to="/settings/$section" params={{ section: to }} className="text-(--text-2) outline-none hover:text-(--text)">
			{children}
		</Link>
	);
}

/** The settings frame, as the Settings card shows it: breadcrumbs and a close button, the grouped nav, and the page beside it. */
export function SettingsLayout() {
	// Skills and Connectors lay cards out side by side, and a page beside its facts, so they get more room.
	const path = usePath();
	const wide = path.startsWith('/settings/skills') || path.startsWith('/settings/connectors');
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<header className="flex h-12 shrink-0 items-center gap-1 border-b border-(--line) pr-2 pl-4 text-body font-medium">
				<Crumbs />
				<span className="flex-1" />
				<Kbd keys="esc" size="sm" />
				<IconBtn icon={X} size="sm" label="Close settings" onClick={closeSettings} />
			</header>
			<div className="flex min-h-0 flex-1">
				<Nav />
				<div data-settings-scroll className="min-h-0 min-w-0 flex-1 scroll-pt-12 overflow-y-auto px-4 pb-12 md:px-6">
					<div className={cn('@container/settings flex flex-col gap-6 pt-4', wide ? 'max-w-[1080px]' : 'max-w-[880px]')}>
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

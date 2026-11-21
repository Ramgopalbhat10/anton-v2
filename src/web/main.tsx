import { QueryClientProvider } from '@tanstack/react-query';
import {
	RouterProvider,
	createRootRoute,
	createRoute,
	createRouter,
	lazyRouteComponent,
	redirect,
} from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import type { ArtifactsSearch } from '@/components/pages/artifacts-page';
import { connectorViewSearch, sectionSearch, skillViewSearch } from '@/components/settings/routes';
import { openProjectSettings } from '@/lib/project-settings-modal';
import { openSettings } from '@/lib/settings-modal';
import { bootTheme } from '@/lib/theme';
import { OutputViewerHost } from '@/components/content/output-viewer';
import { RouteError } from '@/components/kit/error-boundary';
import { AppShell, HomePage, SessionPage } from '@/components/shell/shell';
import { TitleTips } from '@/components/shell/title-tips';
import { TooltipProvider } from '@/components/ui/tooltip';
import { type PanelName, panels } from '@/components/workspace/vm-panel';
import { CATEGORIES } from '@/lib/artifacts';
import { installReturnRefetch } from '@/lib/live-updates';
import { persistQueries } from '@/lib/persist';
import { appQueryClient } from '@/lib/task-sync';
import './styles.css';

const queryClient = appQueryClient();
installReturnRefetch();
bootTheme();

/* Home and a task are in the first download; every other page loads its code on first visit. */
const IncognitoPage = lazyRouteComponent(() => import('@/components/pages/incognito'), 'IncognitoPage');
const ProjectsPage = lazyRouteComponent(() => import('@/components/projects/projects-page'), 'ProjectsPage');
const ProjectPage = lazyRouteComponent(() => import('@/components/projects/project-page'), 'ProjectPage');
const ThreadPage = lazyRouteComponent(() => import('@/components/projects/project-page'), 'ThreadPage');
const TasksPage = lazyRouteComponent(() => import('@/components/pages/tasks-page'), 'TasksPage');
const ArtifactsPage = lazyRouteComponent(() => import('@/components/pages/artifacts-page'), 'ArtifactsPage');
const ArtifactView = lazyRouteComponent(() => import('@/components/pages/artifacts-page'), 'ArtifactView');
const ReviewsPage = lazyRouteComponent(() => import('@/components/pages/reviews-page'), 'ReviewsPage');
const InboxPage = lazyRouteComponent(() => import('@/components/pages/inbox-page'), 'InboxPage');
const SettingsLayout = lazyRouteComponent(() => import('@/components/settings/layout'), 'SettingsLayout');
const SectionPage = lazyRouteComponent(() => import('@/components/settings/layout'), 'SectionPage');
const SettingsOverview = lazyRouteComponent(() => import('@/components/settings/overview'), 'SettingsOverview');
const SkillDetailPage = lazyRouteComponent(() => import('@/components/settings/skill-detail'), 'SkillDetailPage');
const ConnectorDetailPage = lazyRouteComponent(() => import('@/components/settings/connectors'), 'ConnectorDetailPage');
const RepoSettingsPage = lazyRouteComponent(() => import('@/components/settings/repo-settings'), 'RepoSettingsPage');

const rootRoute = createRootRoute({
	component: () => (
		<QueryClientProvider client={queryClient}>
			<TooltipProvider>
				<AppShell />
				<OutputViewerHost />
				<TitleTips />
			</TooltipProvider>
		</QueryClientProvider>
	),
});

const indexRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/',
	component: HomePage,
});

const incognitoRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/incognito',
	component: IncognitoPage,
});

const sessionRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/agents/$sessionId',
	// A fresh page per task, so drafts and panel state never carry over to another task.
	remountDeps: ({ params }) => params.sessionId,
	// `panel` opens one of the workspace panels, such as History from the sidebar's Rewind.
	validateSearch: (search: Record<string, unknown>): { app?: 'code' | 'closed'; panel?: PanelName } => ({
		app: search.app === 'closed' ? 'closed' : 'code',
		panel: panels.find((panel) => panel.name === search.panel)?.name,
	}),
	component: SessionPage,
});

const projectsRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/projects',
	// `create` opens the New project dialog, as the sidebar's + does.
	validateSearch: (search: Record<string, unknown>): { create?: boolean } => ({ create: search.create === true || search.create === 'true' ? true : undefined }),
	component: ProjectsPage,
});

const projectRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/projects/$spaceId',
	remountDeps: ({ params }) => params.spaceId,
	// `ask` is a first message for the coordinator, from the New project dialog; `new` opens the New thread form.
	validateSearch: (search: Record<string, unknown>): { ask?: string; new?: boolean } => ({
		ask: typeof search.ask === 'string' && search.ask ? search.ask : undefined,
		new: search.new === true || search.new === 'true' ? true : undefined,
	}),
	component: ProjectPage,
});

const threadRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/projects/$spaceId/threads/$threadId',
	// A fresh page per thread, so each keeps its own draft and panels.
	remountDeps: ({ params }) => params.threadId,
	validateSearch: (search: Record<string, unknown>): { panel?: PanelName } => ({ panel: panels.find((panel) => panel.name === search.panel)?.name }),
	component: ThreadPage,
});

/** A project's settings open as a card over its page (ProjectSettingsModal in the shell), not as a page of their own. */
const projectSettingsRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/projects/$spaceId/settings',
	beforeLoad: ({ params, preload }) => {
		if (preload) return;
		openProjectSettings(params.spaceId);
		throw redirect({ to: '/projects/$spaceId', params: { spaceId: params.spaceId }, replace: true });
	},
});

const tasksRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/tasks',
	component: TasksPage,
});

const artifactsRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/artifacts',
	// `type` narrows the page to one kind (apps, documents…), `q` searches it.
	validateSearch: (search: Record<string, unknown>): ArtifactsSearch => ({
		type: CATEGORIES.find((category) => category.key === search.type)?.key,
		q: typeof search.q === 'string' && search.q ? search.q : undefined,
	}),
	component: ArtifactsPage,
});

const artifactRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/artifacts/$taskId',
	validateSearch: (search: Record<string, unknown>): { path: string } => ({ path: typeof search.path === 'string' ? search.path : '' }),
	component: ArtifactView,
});

const reviewsRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/reviews',
	component: ReviewsPage,
});

const inboxRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/inbox',
	component: InboxPage,
});

/** Settings opens as a card over the page you are on (SettingsModal in the shell); its address opens the card there, or over Home when you arrived by it. */
const settingsRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/settings',
	beforeLoad: ({ location, preload }) => {
		if (preload) return;
		openSettings(location.href);
		const from = router.state.resolvedLocation;
		throw redirect({ href: from && !from.pathname.startsWith('/settings') ? from.href : '/', replace: true });
	},
	component: SettingsLayout,
});

const settingsIndexRoute = createRoute({
	getParentRoute: () => settingsRoute,
	path: '/',
	component: SettingsOverview,
});

const settingsSectionRoute = createRoute({
	getParentRoute: () => settingsRoute,
	path: '$section',
	validateSearch: sectionSearch,
	component: SectionPage,
});

const skillRoute = createRoute({
	getParentRoute: () => settingsRoute,
	path: 'skills/view',
	validateSearch: skillViewSearch,
	component: SkillDetailPage,
});

const connectorRoute = createRoute({
	getParentRoute: () => settingsRoute,
	path: 'connectors/view',
	validateSearch: connectorViewSearch,
	component: ConnectorDetailPage,
});

const repoSettingsRoute = createRoute({
	getParentRoute: () => settingsRoute,
	path: 'repos/$projectId',
	component: RepoSettingsPage,
});

/** Repository settings used to live at /repos/:id. */
const oldRepoSettingsRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/repos/$projectId',
	beforeLoad: ({ params }) => {
		throw redirect({ to: '/settings/repos/$projectId', params });
	},
});

const routeTree = rootRoute.addChildren([
	indexRoute,
	incognitoRoute,
	sessionRoute,
	tasksRoute,
	projectsRoute,
	projectRoute,
	threadRoute,
	projectSettingsRoute,
	reviewsRoute,
	inboxRoute,
	artifactsRoute,
	artifactRoute,
	oldRepoSettingsRoute,
	settingsRoute.addChildren([settingsIndexRoute, settingsSectionRoute, skillRoute, connectorRoute, repoSettingsRoute]),
]);
const router = createRouter({ routeTree, defaultErrorComponent: RouteError });

declare module '@tanstack/react-router' {
	interface Register {
		router: typeof router;
	}
}

const el = document.getElementById('root');
if (!el) throw new Error('root missing');
// The lists kept from last time are drawn in the first frame (waiting a moment at most), then read again.
void persistQueries(queryClient).finally(() =>
	createRoot(el).render(
		<StrictMode>
			<RouterProvider router={router} />
		</StrictMode>,
	),
);

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
	RouterProvider,
	createRootRoute,
	createRoute,
	createRouter,
	redirect,
} from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RepoSettingsPage } from '@/components/repo-settings';
import { SectionPage, SettingsLayout } from '@/components/settings/layout';
import { SettingsOverview } from '@/components/settings/overview';
import { SkillDetailPage } from '@/components/settings/skill-detail';
import type { SkillsTab, ViewSearch } from '@/components/settings/skills';
import { ProjectPage, ThreadPage } from '@/components/project-page';
import { ProjectSettingsPage } from '@/components/project-settings';
import { ProjectsPage } from '@/components/projects-page';
import { ReviewsPage } from '@/components/reviews-page';
import { AppShell, HomePage, SessionPage } from '@/components/shell';
import { TasksPage } from '@/components/tasks-page';
import { TooltipProvider } from '@/components/ui/tooltip';
import { type PanelName, panels } from '@/components/vm-panel';
import './styles.css';

const queryClient = new QueryClient();

const rootRoute = createRootRoute({
	component: () => (
		<QueryClientProvider client={queryClient}>
			<TooltipProvider>
				<AppShell />
			</TooltipProvider>
		</QueryClientProvider>
	),
});

const indexRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/',
	component: HomePage,
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

const projectSettingsRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/projects/$spaceId/settings',
	component: ProjectSettingsPage,
});

const tasksRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/tasks',
	component: TasksPage,
});

const reviewsRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/reviews',
	component: ReviewsPage,
});

const settingsRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/settings',
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
	// The Skills page keeps its tab and search here, so coming back from a plugin finds them again.
	validateSearch: (search: Record<string, unknown>): { tab?: SkillsTab; q?: string } => ({
		tab: search.tab === 'installed' || search.tab === 'discover' ? search.tab : undefined,
		q: typeof search.q === 'string' && search.q ? search.q : undefined,
	}),
	component: SectionPage,
});

const skillRoute = createRoute({
	getParentRoute: () => settingsRoute,
	path: 'skills/view',
	validateSearch: (search: Record<string, unknown>): ViewSearch =>
		Object.fromEntries(['marketplace', 'name', 'address', 'plugin'].flatMap((key) => (typeof search[key] === 'string' ? [[key, search[key]]] : []))),
	component: SkillDetailPage,
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
	sessionRoute,
	tasksRoute,
	projectsRoute,
	projectRoute,
	threadRoute,
	projectSettingsRoute,
	reviewsRoute,
	oldRepoSettingsRoute,
	settingsRoute.addChildren([settingsIndexRoute, settingsSectionRoute, skillRoute, repoSettingsRoute]),
]);
const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
	interface Register {
		router: typeof router;
	}
}

const el = document.getElementById('root');
if (!el) throw new Error('root missing');
createRoot(el).render(
	<StrictMode>
		<RouterProvider router={router} />
	</StrictMode>,
);

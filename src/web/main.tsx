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
import { AppShell, HomePage, SessionPage } from '@/components/shell';
import { TooltipProvider } from '@/components/ui/tooltip';
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
	validateSearch: (search: Record<string, unknown>): { app?: 'code' | 'closed' } => ({
		app: search.app === 'closed' ? 'closed' : 'code',
	}),
	component: SessionPage,
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
	component: SectionPage,
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
	oldRepoSettingsRoute,
	settingsRoute.addChildren([settingsIndexRoute, settingsSectionRoute, repoSettingsRoute]),
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

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
	RouterProvider,
	createRootRoute,
	createRoute,
	createRouter,
} from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RepoSettingsPage } from '@/components/repo-settings';
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
	validateSearch: (search: Record<string, unknown>): { app?: 'code' | 'closed' } => ({
		app: search.app === 'closed' ? 'closed' : 'code',
	}),
	component: SessionPage,
});

const repoSettingsRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/repos/$projectId',
	component: RepoSettingsPage,
});

const routeTree = rootRoute.addChildren([indexRoute, sessionRoute, repoSettingsRoute]);
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

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
	RouterProvider,
	createRootRoute,
	createRoute,
	createRouter,
} from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AppShell, HomePage, SessionPage } from '@/components/shell';
import './styles.css';

const queryClient = new QueryClient();

const rootRoute = createRootRoute({
	component: () => (
		<QueryClientProvider client={queryClient}>
			<AppShell />
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

const routeTree = rootRoute.addChildren([indexRoute, sessionRoute]);
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

import { type AnyRouter, createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider, useLocation, useRouter } from '@tanstack/react-router';
import { createContext, useContext, useEffect, useState } from 'react';
import { RepoSettingsPage } from '@/components/repo-settings';
import { closeSettings } from '@/lib/settings-modal';
import { ConnectorDetailPage } from './connectors';
import { SectionPage, SettingsLayout } from './layout';
import { SettingsOverview } from './overview';
import { connectorViewSearch, sectionSearch, skillViewSearch } from './routes';
import { SkillDetailPage } from './skill-detail';

/*
 * Settings as a card over the page you are on. The card runs the settings
 * pages on a router of its own, in memory, so moving between sections never
 * disturbs the page behind; a link inside it to anywhere else in the app
 * closes the card and goes there in the app itself.
 */

const AppRouter = createContext<AnyRouter | null>(null);

/** Inside the card, an address that is not a settings page belongs to the app: close the card and go there. */
function LeaveSettings() {
	const app = useContext(AppRouter);
	const location = useLocation();
	useEffect(() => {
		closeSettings();
		void app?.navigate({ href: location.href });
	}, []);
	return null;
}

function settingsRouter(href: string) {
	const root = createRootRoute({ component: Outlet, notFoundComponent: LeaveSettings });
	const settings = createRoute({ getParentRoute: () => root, path: '/settings', component: SettingsLayout });
	const tree = root.addChildren([
		createRoute({ getParentRoute: () => root, path: '/', component: LeaveSettings }),
		settings.addChildren([
			createRoute({ getParentRoute: () => settings, path: '/', component: SettingsOverview }),
			createRoute({ getParentRoute: () => settings, path: '$section', validateSearch: sectionSearch, component: SectionPage }),
			createRoute({ getParentRoute: () => settings, path: 'skills/view', validateSearch: skillViewSearch, component: SkillDetailPage }),
			createRoute({ getParentRoute: () => settings, path: 'connectors/view', validateSearch: connectorViewSearch, component: ConnectorDetailPage }),
			createRoute({ getParentRoute: () => settings, path: 'repos/$projectId', component: RepoSettingsPage }),
		]),
	]);
	return createRouter({ routeTree: tree, history: createMemoryHistory({ initialEntries: [href] }) });
}

export function SettingsCard({ href }: { href: string }) {
	const app = useRouter();
	const [router] = useState(() => settingsRouter(href));
	// Opened again at another section while open (a link elsewhere in the app): go there in the card.
	useEffect(() => {
		if (router.state.location.href !== href) void router.navigate({ href });
	}, [href]);
	return (
		<AppRouter.Provider value={app}>
			<RouterProvider router={router} />
		</AppRouter.Provider>
	);
}


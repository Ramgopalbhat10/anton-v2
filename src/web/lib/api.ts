import { settingsApi } from './api/settings';
import { plansApi } from './api/plans';
import { connectorsApi } from './api/connectors';
import { pluginsApi } from './api/plugins';
import { projectsApi } from './api/projects';
import { sessionsApi } from './api/sessions';
import { workspaceApi } from './api/workspace';
import { outputsApi } from './api/outputs';
import { spacesApi } from './api/spaces';
import { incognitoApi } from './api/incognito';
import { notifyApi } from './api/notify';
import type { Source } from './api/workspace';

export const api = {
	...settingsApi,
	...plansApi,
	...connectorsApi,
	...pluginsApi,
	...projectsApi,
	...sessionsApi,
	...workspaceApi,
	...outputsApi,
	...spacesApi,
	...incognitoApi,
	...notifyApi,
};

/** Pages refetch on server events (live-updates.ts); polling is only a safety net for changes nobody announces, like an idle sandbox stopping or terminal edits. */
export const SAFETY_NET_MS = 60_000;

/** A live sandbox can change under the terminal, so its views are checked more often. */
export const refreshFor = (source: Source | undefined) => (source === 'live' ? 15_000 : SAFETY_NET_MS);

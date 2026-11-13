import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { mockApi } from '../perf/mock-api.ts';

/**
 * The UI fixture: the real web app on Vite's dev server, with `@flue/sdk`
 * swapped for scripted conversations (`chat-sdk.ts`) and the API mocked
 * (`../perf/mock-api.ts`), so a page can be opened and checked in a browser
 * with no server, keys or sandbox of its own. `npm run ui:fixture` starts it,
 * on the first of $ANTON_PREVIEW_PORTS in a task's sandbox (so Preview shows
 * it), else on $UI_FIXTURE_PORT or 43160.
 */
const port = Number(process.env.UI_FIXTURE_PORT ?? process.env.ANTON_PREVIEW_PORTS?.split(/[\s,]+/).find(Boolean) ?? 43160);

export default defineConfig({
	root: new URL('../../src/web', import.meta.url).pathname,
	cacheDir: new URL('../../node_modules/.vite/ui-fixture', import.meta.url).pathname,
	plugins: [react(), tailwindcss(), mockApi()],
	resolve: {
		alias: {
			'@flue/sdk': new URL('./chat-sdk.ts', import.meta.url).pathname,
			'@': new URL('../../src/web', import.meta.url).pathname,
		},
	},
	// Preview's hostnames come from the sandbox (__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS), which Vite allows already.
	server: { host: '0.0.0.0', port, strictPort: true },
});

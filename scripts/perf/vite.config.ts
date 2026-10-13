import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { mockApi } from './mock-api.ts';

/**
 * The UI as production builds it (React's production build), unminified so
 * the profile names components, with `@flue/sdk` swapped for the scripted
 * conversation and the API mocked. `node scripts/perf/profile.ts` drives it.
 */
export default defineConfig({
	root: new URL('../../src/web', import.meta.url).pathname,
	cacheDir: new URL('../../node_modules/.vite/perf', import.meta.url).pathname,
	plugins: [react(), tailwindcss(), mockApi()],
	resolve: {
		alias: {
			'@flue/sdk': new URL('./fake-flue-sdk.ts', import.meta.url).pathname,
			'@': new URL('../../src/web', import.meta.url).pathname,
		},
	},
	preview: { host: '127.0.0.1', port: 43150, strictPort: true },
	build: {
		outDir: process.env.PERF_DIST ?? new URL('../../node_modules/.perf-dist', import.meta.url).pathname,
		emptyOutDir: true,
		minify: false,
	},
});

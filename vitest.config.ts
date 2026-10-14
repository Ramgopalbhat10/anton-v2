import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/** React component tests, in a simulated DOM. Server tests run with `npm test`. */
export default defineConfig({
	plugins: [react()],
	resolve: { alias: { '@': new URL('./src/web', import.meta.url).pathname } },
	test: {
		environment: 'happy-dom',
		// Frames (an agent's page, live) stay empty: there is no server behind them here.
		environmentOptions: { happyDOM: { settings: { disableIframePageLoading: true } } },
		include: ['tests/ui/**/*.test.tsx'],
		setupFiles: ['tests/ui/setup.ts'],
	},
});

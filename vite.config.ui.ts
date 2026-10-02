import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const api = 'http://127.0.0.1:43128';

export default defineConfig({
	root: 'src/web',
	plugins: [react(), tailwindcss()],
	resolve: {
		alias: {
			'@': new URL('./src/web', import.meta.url).pathname,
		},
	},
	server: {
		host: '127.0.0.1',
		port: 43127,
		strictPort: true,
		proxy: {
			'/api': { target: api, changeOrigin: true },
			// Host stays as the browser sent it, so the terminal's same-origin check passes.
			'/vm': { target: api, ws: true },
		},
	},
	build: {
		outDir: '../../dist/client',
		emptyOutDir: true,
	},
});

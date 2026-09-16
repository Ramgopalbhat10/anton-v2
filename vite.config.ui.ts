import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
	root: 'src/web',
	plugins: [react(), tailwindcss()],
	resolve: {
		alias: {
			'@': new URL('./src/web', import.meta.url).pathname,
		},
	},
	server: {
		host: '0.0.0.0',
		port: 43127,
		strictPort: true,
		proxy: {
			'/api': {
				target: 'http://127.0.0.1:43128',
				changeOrigin: true,
				ws: true,
			},
		},
	},
	build: {
		outDir: '../../dist/client',
		emptyOutDir: true,
	},
});

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { antonVmUiPlugin } from './src/lib/vm-ui-plugin.ts';

export default defineConfig({
	root: 'src/web',
	plugins: [react(), tailwindcss(), antonVmUiPlugin()],
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
			},
		},
	},
	build: {
		outDir: '../../dist/client',
		emptyOutDir: true,
	},
});

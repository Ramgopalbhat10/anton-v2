import { flue } from '@flue/vite';
import { defineConfig } from 'vite';
import { terminalPlugin } from './src/dev/terminal-plugin.ts';

export default defineConfig({
	plugins: [flue(), terminalPlugin()],
	server: {
		host: '127.0.0.1',
		port: 43128,
		strictPort: true,
	},
});

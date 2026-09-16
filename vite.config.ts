import { flue } from '@flue/vite';
import { defineConfig } from 'vite';
import { antonPtyPlugin } from './src/lib/pty-plugin.ts';

export default defineConfig({
	plugins: [flue(), antonPtyPlugin()],
	server: {
		host: '127.0.0.1',
		port: 43128,
		strictPort: true,
	},
});

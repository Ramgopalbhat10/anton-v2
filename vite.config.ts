import { flue } from '@flue/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [flue()],
	server: {
		host: '127.0.0.1',
		port: 43128,
		strictPort: true,
	},
});

import type { Server } from 'node:http';
import type { Plugin } from 'vite';
import { attachTerminal } from '../services/terminal.ts';

/** Serves the terminal WebSocket from the dev API server, as src/server.ts does in production. */
export function terminalPlugin(): Plugin {
	return {
		name: 'anton-terminal',
		configureServer(server) {
			if (server.httpServer) attachTerminal(server.httpServer as Server);
		},
	};
}

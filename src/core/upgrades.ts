import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';

export type UpgradeHandler = (request: IncomingMessage, socket: Duplex, head: Buffer) => void;

/**
 * The HTTP server is loaded outside the app's module graph (Vite's SSR
 * loader in dev, the built bundle in production). The app publishes its
 * WebSocket handler here, so sockets share the app's one copy of its state
 * (database client, machine cache) instead of importing a second copy.
 */
const SLOT = Symbol.for('anton.upgrade-handler');
const slot = globalThis as { [SLOT]?: UpgradeHandler };

export function publishUpgradeHandler(handler: UpgradeHandler): void {
	slot[SLOT] = handler;
}

/** Routes upgrades under `prefix` to the published handler; other upgrades (such as Vite's HMR) are left alone. */
export function routeUpgrades(server: Server, prefix: string): void {
	server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
		if (!request.url?.startsWith(prefix)) return;
		const handler = slot[SLOT];
		if (handler) handler(request, socket, head);
		else socket.end('HTTP/1.1 503 Service Unavailable\r\n\r\n');
	});
}

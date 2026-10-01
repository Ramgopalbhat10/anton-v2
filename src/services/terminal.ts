import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { type RawData, type WebSocket, WebSocketServer } from 'ws';
import { saveCheckpoint } from './checkpoints.ts';
import { repoDir } from './git.ts';
import { invalidateRunning } from './sessions.ts';
import { machineFor } from './workspace.ts';

const PATH = /^\/vm\/([\w-]+)\/pty$/;

/** Only pages served from this host may open a shell (blocks cross-site WebSocket hijacking). */
export function isSameOrigin(request: IncomingMessage): boolean {
	const origin = request.headers.origin;
	if (!origin || !request.headers.host) return false;
	return new URL(origin).host === request.headers.host;
}

type Control = { type: 'resize'; cols: number; rows: number };

async function bridge(socket: WebSocket, id: string, size: { cols: number; rows: number }): Promise<void> {
	const machine = await machineFor(id);
	invalidateRunning();
	const pty = await machine.openPty({ ...size, cwd: repoDir(machine) });
	pty.onData((chunk) => socket.readyState === socket.OPEN && socket.send(chunk));
	pty.onExit(() => socket.close());
	socket.on('message', (data: RawData, isBinary: boolean) => {
		if (isBinary) return pty.write(new Uint8Array(data as Buffer));
		const control = JSON.parse(String(data)) as Control;
		if (control.type === 'resize') void pty.resize(control.cols, control.rows).catch(() => undefined);
	});
	socket.on('close', () => {
		pty.close();
		void saveCheckpoint(id, machine).catch((error: unknown) => console.warn('[anton] checkpoint after terminal failed', error));
	});
}

/**
 * Serves `/vm/:id/pty` on an HTTP server: binary frames carry keystrokes and
 * output, text frames carry `{ type: 'resize' }`. Opening a terminal is an
 * explicit request for a machine, so it starts one when needed.
 */
export function attachTerminal(server: Server): void {
	const wss = new WebSocketServer({ noServer: true });
	server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
		const url = new URL(request.url ?? '/', 'http://localhost');
		const match = PATH.exec(url.pathname);
		if (!match) return;
		if (!isSameOrigin(request)) {
			socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
			return;
		}
		const size = { cols: Number(url.searchParams.get('cols')) || 80, rows: Number(url.searchParams.get('rows')) || 24 };
		wss.handleUpgrade(request, socket, head, (ws) => {
			bridge(ws, match[1], size).catch((error: unknown) => {
				ws.send(new TextEncoder().encode(`\r\n${error instanceof Error ? error.message : String(error)}\r\n`));
				ws.close(1011);
			});
		});
	});
}

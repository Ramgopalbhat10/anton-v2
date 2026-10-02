import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { type RawData, type WebSocket, WebSocketServer } from 'ws';
import type { Pty } from '../core/ports.ts';
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

type Size = { cols: number; rows: number };
type Control = Size & { type: 'resize' };

/** A resize with sane bounds, or null for anything else. */
function parseControl(raw: string): Control | null {
	try {
		const control = JSON.parse(raw) as Partial<Control>;
		const valid = control.type === 'resize' && [control.cols, control.rows].every((n) => Number.isInteger(n) && n! > 0 && n! < 1000);
		return valid ? (control as Control) : null;
	} catch {
		return null;
	}
}

/**
 * What the browser sent before the shell existed. Starting a machine can take
 * minutes, and keystrokes or resizes sent meanwhile must not be dropped.
 */
function earlyFrames(socket: WebSocket, size: Size) {
	const state = { size, input: [] as Uint8Array[], closed: false };
	const onMessage = (data: RawData, isBinary: boolean) => {
		if (isBinary) state.input.push(new Uint8Array(data as Buffer));
		else state.size = parseControl(String(data)) ?? state.size;
	};
	socket.on('message', onMessage);
	socket.once('close', () => (state.closed = true));
	return { state, stop: () => socket.off('message', onMessage) };
}

function connect(socket: WebSocket, pty: Pty): void {
	pty.onData((chunk) => socket.readyState === socket.OPEN && socket.send(chunk));
	pty.onExit(() => socket.close());
	socket.on('message', (data: RawData, isBinary: boolean) => {
		if (isBinary) return pty.write(new Uint8Array(data as Buffer));
		const control = parseControl(String(data));
		if (control) void pty.resize(control.cols, control.rows).catch(() => undefined);
	});
}

async function bridge(socket: WebSocket, id: string, size: Size): Promise<void> {
	const early = earlyFrames(socket, size);
	const machine = await machineFor(id);
	invalidateRunning();
	// The user left while the machine started; opening a shell now would leak it.
	if (early.state.closed) return;
	const opened = early.state.size;
	const pty = await machine.openPty({ ...opened, cwd: repoDir(machine) });
	early.stop();
	if (early.state.closed) return pty.close();
	connect(socket, pty);
	const { size: latest, input } = early.state;
	if (latest !== opened) void pty.resize(latest.cols, latest.rows).catch(() => undefined);
	for (const chunk of input) pty.write(chunk);
	socket.on('close', () => {
		pty.close();
		void saveCheckpoint(id, machine).catch((error: unknown) => console.warn('[anton] checkpoint after terminal failed', error));
	});
}

const wss = new WebSocketServer({ noServer: true });

/**
 * Handles an upgrade to `/vm/:id/pty`: binary frames carry keystrokes and
 * output, text frames carry `{ type: 'resize' }`. Opening a terminal is an
 * explicit request for a machine, so it starts one when needed.
 */
export function handleTerminalUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
	const url = new URL(request.url ?? '/', 'http://localhost');
	const match = PATH.exec(url.pathname);
	if (!match || !isSameOrigin(request)) {
		socket.end(`HTTP/1.1 ${match ? '403 Forbidden' : '404 Not Found'}\r\n\r\n`);
		return;
	}
	const size = { cols: Number(url.searchParams.get('cols')) || 80, rows: Number(url.searchParams.get('rows')) || 24 };
	wss.handleUpgrade(request, socket, head, (ws) => {
		bridge(ws, match[1], size).catch((error: unknown) => {
			ws.send(new TextEncoder().encode(`\r\n${error instanceof Error ? error.message : String(error)}\r\n`));
			ws.close(1011);
		});
	});
}

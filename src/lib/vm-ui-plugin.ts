import { spawn } from 'node:child_process';
import type { Plugin } from 'vite';
import { WebSocketServer } from 'ws';
import { getProject, getSession } from './sessions.ts';

/**
 * PTY lives on the UI origin (43127), not behind the Flue Vite proxy.
 * Cursor/Devin attach xterm to a VM PTY over one websocket; they do not
 * tunnel that through the agent HTTP router.
 */
export function antonVmUiPlugin(): Plugin {
	return {
		name: 'anton-vm-ui',
		configureServer(server) {
			const wss = new WebSocketServer({ noServer: true });
			const httpServer = server.httpServer;
			if (!httpServer) return;
			httpServer.prependListener('upgrade', (request, socket, head) => {
				const host = request.headers.host ?? '127.0.0.1';
				const url = new URL(request.url ?? '/', `http://${host}`);
				const match = url.pathname.match(/^\/vm\/([^/]+)\/pty$/);
				if (!match) return;
				wss.handleUpgrade(request, socket, head, (ws) => {
					void (async () => {
						const session = await getSession(match[1]);
						if (!session || session.status !== 'running') {
							ws.close(1011, 'VM unavailable');
							return;
						}
						const project = await getProject(session.projectId);
						if (!project) {
							ws.close(1011, 'Project not found');
							return;
						}
						const shell = spawn('script', ['-qfc', 'bash', '/dev/null'], {
							cwd: project.workspacePath,
							env: { ...process.env, TERM: 'xterm-256color', PS1: '\\w $ ' },
							stdio: ['pipe', 'pipe', 'pipe'],
						});
						const send = (chunk: Buffer) => {
							if (ws.readyState === ws.OPEN) ws.send(chunk);
						};
						shell.stdout?.on('data', send);
						shell.stderr?.on('data', send);
						shell.on('error', (error) => {
							send(Buffer.from(`\r\n${error.message}\r\n`));
						});
						shell.on('close', () => ws.close());
						ws.on('message', (data) => {
							const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
							shell.stdin?.write(buf);
						});
						ws.on('close', () => {
							shell.kill();
						});
					})();
				});
			});
		},
	};
}

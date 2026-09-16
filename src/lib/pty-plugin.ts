import { spawn } from 'node:child_process';
import type { Plugin } from 'vite';
import { WebSocketServer } from 'ws';
import { getProject, getSession } from './sessions.ts';

export function antonPtyPlugin(): Plugin {
	return {
		name: 'anton-pty',
		configureServer(server) {
			const wss = new WebSocketServer({ noServer: true });
			server.httpServer?.on('upgrade', (request, socket, head) => {
				const host = request.headers.host ?? '127.0.0.1';
				const url = new URL(request.url ?? '/', `http://${host}`);
				const match = url.pathname.match(/^\/api\/vm\/([^/]+)\/pty$/);
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
						const shell = spawn('bash', ['-i'], {
							cwd: project.workspacePath,
							env: { ...process.env, TERM: 'xterm-256color' },
							stdio: ['pipe', 'pipe', 'pipe'],
						});
						shell.stdout?.on('data', (chunk: Buffer) => {
							ws.send(chunk.toString('utf8'));
						});
						shell.stderr?.on('data', (chunk: Buffer) => {
							ws.send(chunk.toString('utf8'));
						});
						shell.on('close', () => ws.close());
						ws.on('message', (data) => {
							shell.stdin?.write(data.toString());
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

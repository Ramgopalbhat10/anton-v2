/**
 * The API the profiled page talks to, as a Vite plugin: a task with a real
 * file tree (this repository and part of node_modules), a real diff, files
 * read from disk, three subagents at work, and `/api/events` announcing
 * changes as the server does while a turn runs (subagents every 400 ms, a
 * tool event every 300 ms, the task's state every few seconds).
 */
import { execSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join, relative } from 'node:path';
import type { Plugin } from 'vite';
import { PHASES, runsAt, SESSION_ID } from './scenario.ts';

const root = new URL('../..', import.meta.url).pathname;

function walk(dir: string, out: string[], limit: number) {
	for (const name of readdirSync(dir)) {
		if (out.length >= limit) return;
		const full = join(dir, name);
		if (statSync(full).isDirectory()) walk(full, out, limit);
		else out.push(relative(root, full));
	}
}

function paths(): string[] {
	const tracked = execSync('git ls-files', { cwd: root, encoding: 'utf8' }).trim().split('\n');
	const vendored: string[] = [];
	for (const dir of ['node_modules/@tanstack', 'node_modules/radix-ui', 'node_modules/@radix-ui', 'node_modules/lucide-react/dist/esm/icons']) walk(join(root, dir), vendored, 3000 + vendored.length);
	return [...tracked, ...vendored.slice(0, 3000)].sort();
}

const session = {
	id: SESSION_ID,
	projectId: 'perf-project',
	repo: 'ramgopalbhat10/anton-v2',
	title: 'Make the app fast while agents stream',
	model: 'openrouter/~deepseek/deepseek-flash-latest',
	reasoning: null,
	branch: 'anton/perf',
	baseBranch: 'main',
	baseSha: 'abc123',
	status: 'running',
	working: true,
	workspace: true,
	planMode: false,
	prUrl: null,
	errorMessage: null,
	checkpointAt: null,
	createdAt: '2026-10-13T00:00:00.000Z',
	pinnedAt: null,
	pullRequest: null,
	usage: { inputTokens: 300_000, outputTokens: 20_000, cost: 0.4 },
	lastInput: 'Make the app fast while agents stream.',
	lastInputAt: '2026-10-13T00:00:00.000Z',
	spaceId: null,
	threadState: null,
};

const others = Array.from({ length: 30 }, (_, index) => ({
	...session,
	id: `other-${index}`,
	title: `Earlier task number ${index}`,
	working: index < 2,
	status: index < 4 ? 'running' : 'stopped',
	createdAt: new Date(Date.parse(session.createdAt) - index * 3_600_000).toISOString(),
}));

const models = Array.from({ length: 300 }, (_, index) => ({
	id: index === 0 ? session.model : `vendor-${index % 20}/model-${index}`,
	name: `Model ${index}`,
	vendor: `vendor-${index % 20}`,
	description: 'A model',
	createdAt: 1_700_000_000 + index,
	contextLength: 200_000,
	maxOutput: 32_000,
	price: { input: 1, output: 4 },
	vision: true,
	reasoning: ['off', 'low', 'high'],
	defaultReasoning: 'low',
}));

export function mockApi(): Plugin {
	const tree = paths();
	const patch = execSync('git diff HEAD~10 HEAD -- src/web/components/thread.tsx src/web/components/subagents.tsx src/web/components/files-tab.tsx src/web/lib', { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 });
	const changed = [...patch.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((match) => ({ path: match[1], status: 'M' }));
	let startedAt = 0;
	const elapsed = () => (startedAt ? Date.now() - startedAt : -1);
	const clients = new Set<ServerResponse>();
	let ticks = 0;
	setInterval(() => {
		const at = elapsed();
		if (at < 0 || at > PHASES.end + 1000) return;
		ticks++;
		const send = (change: object) => {
			for (const client of clients) client.write(`data: ${JSON.stringify(change)}\n\n`);
		};
		const inSubagents = at >= PHASES.subagents[0] && at <= PHASES.subagents[1] + 500;
		if (inSubagents && ticks % 4 === 0) send({ kind: 'task', id: SESSION_ID, what: 'subagents' });
		if ((inSubagents || at >= PHASES.answer[0]) && ticks % 3 === 0) send({ kind: 'task', id: SESSION_ID, what: 'files' });
		if (ticks % 30 === 0) send({ kind: 'task', id: SESSION_ID, what: 'state' });
	}, 100).unref();

	const json = (res: ServerResponse, body: unknown) => {
		res.setHeader('content-type', 'application/json');
		res.end(JSON.stringify(body));
	};

	const handle = (req: IncomingMessage, res: ServerResponse, next: () => void) => {
		const url = new URL(req.url ?? '/', 'http://local');
		const path = url.pathname;
		if (path === '/__perf/start') {
			startedAt = Date.now();
			return json(res, { ok: true });
		}
		if (!path.startsWith('/api/')) return next();
		if (path === '/api/events') {
			res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
			res.write(': hello\n\n');
			clients.add(res);
			req.on('close', () => clients.delete(res));
			return;
		}
		const task = `/api/sessions/${SESSION_ID}`;
		if (path === '/api/health') return json(res, { ok: true, openRouter: true, providers: { sandbox: 'local', store: 'disk', git: 'github' } });
		if (path === '/api/sessions') return json(res, { sessions: [{ ...session }, ...others] });
		if (path === task) return json(res, session);
		if (path === `${task}/files`) return json(res, { source: 'live', at: null, paths: tree, changes: changed });
		if (path === `${task}/file`) {
			const file = url.searchParams.get('path') ?? '';
			try {
				res.end(readFileSync(join(root, file)));
			} catch {
				res.statusCode = 404;
				res.end('{"error":"missing"}');
			}
			return;
		}
		if (path === `${task}/changes`) return json(res, { source: 'live', at: null, branch: 'anton/perf', baseBranch: 'main', patch, log: [{ sha: 'abcdef1234567', subject: 'Work in progress', at: session.createdAt }] });
		if (path === `${task}/subagents`) return json(res, { runs: runsAt(elapsed(), startedAt) });
		if (path === `${task}/outputs`) return json(res, { source: 'live', at: null, outputs: [] });
		if (path === `${task}/previews`) return json(res, { live: true, previews: [] });
		if (path === `${task}/checkpoints`) return json(res, { checkpoints: [] });
		if (path === `${task}/pull-request`) return json(res, null);
		if (path === `${task}/context`) return json(res, { model: session.model, window: 200_000, used: 64_000, autocompactAt: 180_000, parts: [{ key: 'messages', tokens: 50_000 }, { key: 'tools', tokens: 14_000 }], at: null });
		if (path === `${task}/browser`) return json(res, { available: false, browser: null });
		if (path === `${task}/skills`) return json(res, { skills: [] });
		if (path === '/api/budget') return json(res, { limits: { dailyUsd: 20, taskUsd: null }, today: 1.2, task: 0.4, blocked: null });
		if (path === '/api/usage') return json(res, { since: session.createdAt, today: 1.2, month: 20, byRepo: [], byModel: [], daily: [], plans: [] });
		if (path === '/api/models') return json(res, { models, default: session.model, pinned: [] });
		if (path === '/api/subscriptions') return json(res, { subscriptions: [] });
		if (path === '/api/settings/commands') return json(res, { commands: [] });
		if (path === '/api/profile') return json(res, { name: 'Perf' });
		if (path === '/api/spaces') return json(res, { spaces: [] });
		if (path === '/api/compute') return json(res, { provider: 'local', app: null, running: [], others: 0 });
		if (path === '/api/projects') return json(res, { projects: [] });
		if (path === '/api/reviews') return json(res, { reviews: [] });
		if (path === '/api/connectors') return json(res, { accounts: [], mailboxes: [], mcpServers: [] });
		if (path === `${task}/todos`) return json(res, { list: null });
		if (path === `${task}/joins`) return json(res, { joins: [] });
		if (path === `${task}/now`) return json(res, { now: null });
		if (path === '/api/push/presence') return json(res, { ok: true });
		console.warn(`[perf] unmocked ${req.method} ${path}`);
		return json(res, {});
	};

	return {
		name: 'anton-perf-mock-api',
		configureServer: (server) => void server.middlewares.use(handle),
		configurePreviewServer: (server) => void server.middlewares.use(handle),
	};
}

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

/* Projects and their threads, so the Projects page and a project's Overview have something to show. */
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const thread = (id: string, spaceId: string, title: string, threadState: string, patch: Record<string, unknown> = {}) => ({
	...session,
	id,
	spaceId,
	title,
	threadState,
	repo: '',
	branch: '',
	baseBranch: '',
	baseSha: '',
	prUrl: null,
	pullRequest: null,
	status: threadState === 'working' ? 'running' : 'stopped',
	working: threadState === 'working',
	createdAt: ago(60 * 24 * 3),
	lastInputAt: ago(30),
	checkpointAt: null,
	resolvedAt: null,
	...patch,
});
const onRepo = (projectId: string, repo: string, slug: string) => ({ projectId, repo, branch: `anton/${slug}`, baseBranch: 'main', baseSha: 'abc123' });
const spaceThreads = [
	thread('th-invoices', 'space-billing', 'Name the invoices table', 'waiting', { ...onRepo('p-billing', 'acme/billing-api', 'invoices-table'), asking: 'Invoices or billing for the table name?', lastReply: 'The schema is in. Before I write the migration: should the table be `invoices` or `billing_documents`?', lastInputAt: ago(42) }),
	thread('th-schema', 'space-billing', 'Migrate the ledger schema', 'working', { ...onRepo('p-billing', 'acme/billing-api', 'ledger-schema'), working: true, status: 'running', lastReply: 'Rerunning the migration tests against the new ledger columns.', lastInputAt: ago(4) }),
	thread('th-api', 'space-billing', 'Expose invoices over the API', 'review', { ...onRepo('p-billing', 'acme/billing-api', 'invoices-api'), prUrl: 'https://github.com/acme/billing-api/pull/12', pullRequest: { state: 'open', checks: 'passed', runs: [] }, lastReply: 'Opened PR #12 with the invoices endpoints; checks are green.', lastInputAt: ago(95) }),
	thread('th-settings', 'space-billing', 'Settings page for billing', 'idle', { ...onRepo('p-billing', 'acme/billing-api', 'billing-settings'), lastReply: 'The settings page is up for review whenever you want a look.', lastInputAt: ago(60 * 26) }),
	thread('th-cleanup', 'space-billing', 'Prune stale webhook retries', 'resolved', { ...onRepo('p-billing', 'acme/billing-api', 'webhook-retries'), resolvedAt: ago(60 * 30), lastInputAt: ago(60 * 31), lastReply: 'Done: retries are pruned after 7 days.' }),
	thread('th-docs-audit', 'space-docs', 'Audit the getting-started guide', 'idle', { lastReply: 'Read through the guide; a few sections still describe the old CLI.', lastInputAt: ago(60 * 50) }),
	thread('th-docs-voice', 'space-docs', 'Tighten the docs voice', 'resolved', { resolvedAt: ago(60 * 70), lastInputAt: ago(60 * 71), lastReply: 'Rewrote the voice section in the imperative.' }),
	thread('th-mobile-shell', 'space-mobile', 'App shell and navigation', 'resolved', { ...onRepo('p-mobile', 'acme/mobile', 'app-shell'), resolvedAt: ago(60 * 24 * 20), lastInputAt: ago(60 * 24 * 20), lastReply: 'Shell is in with tab navigation.' }),
	thread('th-mobile-theme', 'space-mobile', 'Dark theme pass', 'resolved', { ...onRepo('p-mobile', 'acme/mobile', 'dark-theme'), resolvedAt: ago(60 * 24 * 18), lastInputAt: ago(60 * 24 * 18), lastReply: 'Theme tokens applied across screens.' }),
];
const counts = (threads: typeof spaceThreads) =>
	threads.reduce(
		(acc, item) => {
			acc[item.threadState as keyof typeof acc] += 1;
			return acc;
		},
		{ waiting: 0, working: 0, queued: 0, review: 0, landing: 0, idle: 0, resolved: 0 },
	);
const space = (id: string, name: string, goal: string, state: string, repoIds: string[], repos: Array<{ id: string; repoFullName: string; defaultBranch: string }>, threads: typeof spaceThreads, createdDaysAgo: number) => ({
	id,
	name,
	icon: null,
	goal,
	instructions: '',
	memory: '',
	coordinatorModel: null,
	coordinatorReasoning: null,
	threadModel: null,
	threadReasoning: null,
	agentModels: { explorer: null, tester: null, browser: null, computer: null, reviewer: null },
	maxParallel: 3,
	autonomy: 'start',
	state,
	repoIds,
	repos,
	counts: counts(threads),
	threads: threads.length,
	activeAt: threads.map((item) => item.lastInputAt).sort().at(-1) ?? ago(60 * 24 * createdDaysAgo),
	createdAt: ago(60 * 24 * createdDaysAgo),
	updatedAt: ago(30),
});
const spaces = [
	space('space-billing', 'Billing v2', 'Ship billing v2: invoices, proration, and the settings page.', 'active', ['p-billing'], [{ id: 'p-billing', repoFullName: 'acme/billing-api', defaultBranch: 'main' }], spaceThreads.filter((item) => item.spaceId === 'space-billing'), 12),
	space('space-docs', 'Docs refresh', 'Refresh the docs for the new CLI and tighten the voice.', 'active', [], [], spaceThreads.filter((item) => item.spaceId === 'space-docs'), 30),
	space('space-mobile', 'Mobile app', 'First pass at the mobile app shell and theme.', 'archived', ['p-mobile'], [{ id: 'p-mobile', repoFullName: 'acme/mobile', defaultBranch: 'main' }], spaceThreads.filter((item) => item.spaceId === 'space-mobile'), 60),
];
const notifications = [
	{ id: 'n-ask', kind: 'question', category: 'needs-you', sessionId: 'th-invoices', spaceId: 'space-billing', title: 'Name the invoices table', body: 'The schema is in. Before I write the migration: should the table be `invoices` or `billing_documents`?', url: '/projects/space-billing/threads/th-invoices', createdAt: ago(12), read: false },
	{ id: 'n-checks', kind: 'checks-failed', category: 'failures', sessionId: 'th-api', spaceId: 'space-billing', title: 'Expose invoices over the API', body: 'Checks failed on pull request #12: `ui-tests`.', url: '/projects/space-billing/threads/th-api', createdAt: ago(140), read: false },
	{ id: 'n-reply', kind: 'replied', category: 'replies', sessionId: 'th-schema', spaceId: 'space-billing', title: 'Migrate the ledger schema', body: 'Reran the migration tests against the new ledger columns — all green now. The `ledger_entries` backfill takes about 40s on the fixture dataset.', url: '/projects/space-billing/threads/th-schema', createdAt: ago(300), read: false },
	{ id: 'n-done', kind: 'done', category: 'done', sessionId: 'th-cleanup', spaceId: 'space-billing', title: 'Prune stale webhook retries', body: 'Done: retries are pruned after 7 days.', url: '/projects/space-billing/threads/th-cleanup', createdAt: ago(60 * 30), read: true },
	{ id: 'n-merged', kind: 'merged', category: 'done', sessionId: 'perf-task', spaceId: null, title: 'Make the app fast while agents stream', body: 'Merged: the perf branch landed on main.', url: '/agents/perf-task', createdAt: ago(60 * 26), read: true },
	{ id: 'n-sandbox', kind: 'sandbox-stopped', category: 'sandboxes', sessionId: 'th-mobile-shell', spaceId: 'space-mobile', title: 'App shell and navigation', body: 'Sandbox stopped after 5 idle minutes.', url: '/projects/space-mobile/threads/th-mobile-shell', createdAt: ago(60 * 50), read: true },
];
const notificationUnread = notifications.reduce<Record<string, number>>((acc, item) => {
	if (!item.read) acc[item.category] = (acc[item.category] ?? 0) + 1;
	return acc;
}, {});
const projects = [
	{ id: 'p-billing', repoFullName: 'acme/billing-api', defaultBranch: 'main', memory: '', warmedAt: ago(60 * 24), envKeys: [], setupScript: '', checkCommand: '', previewPorts: [], baseImage: null, followUps: true, reviewOthers: false, fullVm: false },
	{ id: 'p-mobile', repoFullName: 'acme/mobile', defaultBranch: 'main', memory: '', warmedAt: ago(60 * 24 * 5), envKeys: [], setupScript: '', checkCommand: '', previewPorts: [], baseImage: null, followUps: true, reviewOthers: false, fullVm: false },
];

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
		let path = url.pathname;
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
		// Any other task (an incognito chat's, one the UI fixture opens) is answered as the scripted one.
		const other = path.match(/^\/api\/sessions\/([^/]+)(\/.*)?$/);
		if (other && other[1] !== SESSION_ID && !other[2]) return json(res, { ...session, id: other[1] });
		if (other && other[1] !== SESSION_ID) path = `${task}${other[2]}`;
		if (path === '/api/health') return json(res, { ok: true, openRouter: true, providers: { sandbox: 'local', store: 'disk', git: 'github' } });
		if (path === '/api/sessions') return json(res, { sessions: [{ ...session }, ...spaceThreads, ...others] });
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
		if (path === '/api/spaces') return json(res, { spaces });
		const spaceId = path.match(/^\/api\/spaces\/([^/]+)$/)?.[1];
		if (spaceId) {
			const found = spaces.find((item) => item.id === spaceId);
			if (found) return json(res, found);
			res.statusCode = 404;
			return json(res, { error: 'No such project' });
		}
		if (path === '/api/compute') return json(res, { provider: 'local', app: null, running: [], others: 0 });
		if (path === '/api/projects') return json(res, { projects });
		if (path === '/api/reviews') return json(res, { reviews: [] });
		if (path === '/api/connectors') return json(res, { accounts: [], mailboxes: [], mcpServers: [], composio: { configured: false, keyFromEnv: false, accounts: [] } });
		if (path === '/api/notifications') return json(res, { notifications, unread: { 'needs-you': 0, replies: 0, done: 0, failures: 0, sandboxes: 0, ...notificationUnread } });
		if (path === `${task}/waiting`) return json(res, { messages: [] });
		if (path === `${task}/joins`) return json(res, { joins: [] });
		if (path === `${task}/todos`) return json(res, { list: null });
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

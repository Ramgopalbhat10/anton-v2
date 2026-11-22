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
import { mockSetup } from './mock-setup.ts';
import { viewerArtifacts } from '../ui/artifact-fixture.ts';

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
	for (const dir of ['node_modules/@tanstack', 'node_modules/radix-ui', 'node_modules/@radix-ui', 'node_modules/@hugeicons/core-free-icons/dist/esm']) walk(join(root, dir), vendored, 3000 + vendored.length);
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
/** The one pull request the Reviews page lists, as GitHub would describe it. */
const pull = {
	url: 'https://github.com/acme/billing-api/pull/12',
	number: 12,
	repo: 'acme/billing-api',
	title: 'Expose invoices over the API',
	body: 'Adds `GET /invoices` and `GET /invoices/:id`, paged by cursor, behind the billing scope.',
	author: 'anton',
	state: 'open',
	draft: false,
	headBranch: 'anton/invoices-api',
	headSha: 'abcdef1234567',
	baseBranch: 'main',
	createdAt: ago(95),
	mergedAt: null,
	mergedBy: null,
	closedAt: null,
	additions: 118,
	deletions: 50,
	changedFiles: 2,
	mergeable: true,
	approved: false,
	commits: [{ sha: 'abcdef1234567', subject: 'Expose invoices over the API' }],
	checks: [
		{ name: 'test', status: 'passed', summary: 'Passed in 2m', url: 'https://github.com/acme/billing-api/actions' },
		{ name: 'types', status: 'passed', summary: 'Passed in 41s', url: 'https://github.com/acme/billing-api/actions' },
	],
	discussion: [{ id: 'c1', kind: 'comment', author: 'perf', body: 'Should the list be paged by cursor or by offset?', path: null, line: null, at: ago(60), verdict: null }],
};
const review = { sessionId: 'th-api', title: pull.title, repo: pull.repo, url: pull.url, group: 'ready', draft: false, reviewing: null, conflicts: false, checks: { passed: 2, failed: 0, pending: 0 }, comments: 1, createdAt: pull.createdAt };
const spaceThreads = [
	thread('th-invoices', 'space-billing', 'Name the invoices table', 'waiting', { ...onRepo('p-billing', 'acme/billing-api', 'invoices-table'), asking: 'Invoices or billing for the table name?', lastReply: 'The schema is in. Before I write the migration: should the table be `invoices` or `billing_documents`?', lastInputAt: ago(42) }),
	thread('th-schema', 'space-billing', 'Migrate the ledger schema', 'working', { ...onRepo('p-billing', 'acme/billing-api', 'ledger-schema'), working: true, status: 'running', lastReply: 'Rerunning the migration tests against the new ledger columns.', lastInputAt: ago(4) }),
	thread('th-api', 'space-billing', 'Expose invoices over the API', 'review', { ...onRepo('p-billing', 'acme/billing-api', 'invoices-api'), prUrl: 'https://github.com/acme/billing-api/pull/12', pullRequest: { state: 'open', checks: 'passed', runs: [] }, lastReply: 'Opened PR #12 with the invoices endpoints; checks are green.', lastInputAt: ago(95) }),
	thread('th-settings', 'space-billing', 'Settings page for billing', 'idle', { ...onRepo('p-billing', 'acme/billing-api', 'billing-settings'), lastReply: 'The settings page is up for review whenever you want a look.', lastInputAt: ago(60 * 26) }),
	thread('th-cleanup', 'space-billing', 'Prune stale webhook retries', 'resolved', { ...onRepo('p-billing', 'acme/billing-api', 'webhook-retries'), resolvedAt: ago(60 * 30), lastInputAt: ago(60 * 31), lastReply: 'Done: retries are pruned after 7 days.', asking: 'Want me to prune the dead-letter queue too?' }),
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
const spaceTodos: Array<{
	id: string;
	spaceId: string;
	title: string;
	description: string;
	status: 'open' | 'triaging' | 'in_progress' | 'done' | 'cancelled';
	assigneeKind: 'unassigned' | 'coordinator' | 'thread';
	priority: 'urgent' | 'high' | 'medium' | 'low' | null;
	tags: string[];
	projectId: string | null;
	model: string | null;
	reasoning: string | null;
	planMode: boolean;
	files: string[];
	dueAt: string | null;
	sourceUrl: string | null;
	position: number;
	createdBy: 'user' | 'coordinator' | 'routine';
	threadIds: string[];
	assignedAt: string | null;
	completedAt: string | null;
	createdAt: string;
	updatedAt: string;
}> = [
	{
		id: 'todo-proration',
		spaceId: 'space-billing',
		title: 'Add mid-cycle plan proration',
		description: 'Calculate daily proration credits when upgrading or downgrading seats mid-month.',
		status: 'open',
		assigneeKind: 'unassigned',
		priority: 'high',
		tags: ['billing', 'api'],
		projectId: 'p-billing',
		model: null,
		reasoning: null,
		planMode: true,
		files: [],
		dueAt: '2026-11-28',
		sourceUrl: 'https://github.com/acme/billing-api/issues/42',
		position: 0,
		createdBy: 'user',
		threadIds: [],
		assignedAt: null,
		completedAt: null,
		createdAt: ago(60 * 12),
		updatedAt: ago(60 * 12),
	},
	{
		id: 'todo-tax',
		spaceId: 'space-billing',
		title: 'VAT ID validation on checkout',
		description: 'Validate EU VAT numbers before issuing tax-exempt invoices.',
		status: 'open',
		assigneeKind: 'unassigned',
		priority: 'medium',
		tags: ['tax'],
		projectId: 'p-billing',
		model: null,
		reasoning: null,
		planMode: false,
		files: [],
		dueAt: null,
		sourceUrl: null,
		position: 1,
		createdBy: 'user',
		threadIds: [],
		assignedAt: null,
		completedAt: null,
		createdAt: ago(60 * 8),
		updatedAt: ago(60 * 8),
	},
	{
		id: 'todo-ledger-linked',
		spaceId: 'space-billing',
		title: 'Migrate the ledger schema',
		description: 'Move double-entry ledger columns to the v2 layout.',
		status: 'in_progress',
		assigneeKind: 'coordinator',
		priority: 'urgent',
		tags: ['schema'],
		projectId: 'p-billing',
		model: null,
		reasoning: null,
		planMode: false,
		files: [],
		dueAt: null,
		sourceUrl: null,
		position: 2,
		createdBy: 'user',
		threadIds: ['th-schema'],
		assignedAt: ago(45),
		completedAt: null,
		createdAt: ago(60 * 20),
		updatedAt: ago(4),
	},
	{
		id: 'todo-webhook-done',
		spaceId: 'space-billing',
		title: 'Prune stale webhook retries',
		description: 'Clean up retries older than 7 days.',
		status: 'done',
		assigneeKind: 'thread',
		priority: 'low',
		tags: ['cleanup'],
		projectId: 'p-billing',
		model: null,
		reasoning: null,
		planMode: false,
		files: [],
		dueAt: null,
		sourceUrl: null,
		position: 3,
		createdBy: 'user',
		threadIds: ['th-cleanup'],
		assignedAt: ago(60 * 32),
		completedAt: ago(60 * 30),
		createdAt: ago(60 * 40),
		updatedAt: ago(60 * 30),
	},
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
const artifact = (sessionId: string, task: { title: string; spaceId: string | null; chat: boolean }, path: string, title: string, size: number, daysAgo: number, added = false) => ({
	sessionId,
	path,
	title,
	size,
	mtimeMs: Date.now() - daysAgo * 86_400_000,
	task,
	...(added ? { added: true } : {}),
});
const billing = { title: 'Expose invoices over the API', spaceId: 'space-billing', chat: false };
const artifacts = [
	artifact('th-api', billing, 'renders/invoice-dashboard.html', 'Invoice dashboard', 84_000, 0.2),
	artifact('th-schema', { title: 'Migrate the ledger schema', spaceId: 'space-billing', chat: false }, 'reports/migration-plan.md', 'Migration plan', 12_400, 0.8),
	artifact('th-invoices', billing, 'charts/revenue-by-plan.png', 'Revenue by plan', 220_000, 1.4),
	artifact('th-cleanup', billing, 'exports/invoices-2026.csv', 'Invoices export', 96_000, 2.1),
	artifact('th-settings', billing, 'scripts/proration.py', 'Proration calculator', 8_300, 3.5),
	artifact('th-docs-audit', { title: 'Audit the getting-started guide', spaceId: 'space-docs', chat: false }, 'notes/guide-gaps.md', 'Guide gaps', 5_100, 4.2),
	artifact('perf-task', { title: 'Make the app fast while agents stream', spaceId: null, chat: false }, 'benchmarks/stream-latency.json', 'Stream latency bench', 41_000, 5.0),
	artifact('added-files', { title: 'Added by you', spaceId: null, chat: false }, 'skills/day-trading/SKILL.md', 'SKILL.md', 3_200, 6.0, true),
];
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

export function mockApi({ working = true }: { working?: boolean } = {}): Plugin {
	const tree = paths();
	const patch = execSync('git diff HEAD~10 HEAD -- src/web/components/thread/thread.tsx src/web/components/thread/subagents.tsx src/web/components/workspace/files-tab.tsx src/web/lib', { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 });
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

	const attachments = new Map<string, { bytes: Buffer; type: string }>();
	const json = (res: ServerResponse, body: unknown) => {
		res.setHeader('content-type', 'application/json');
		res.end(JSON.stringify(body));
	};

	const handle = (req: IncomingMessage, res: ServerResponse, next: () => void) => {
		const url = new URL(req.url ?? '/', 'http://local');
		let path = url.pathname;
		if (path.startsWith('/__setup/') || path === '/api/connections' || path.startsWith('/api/setup')) {
			void mockSetup(req, res, path, json).then((handled) => (handled ? undefined : next()));
			return;
		}
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
		// Attached files land after a beat, and a stored picture loads after one, as over a real network.
		const stored = path.match(/^\/api\/fixture\/attachments\/([^/]+)$/)?.[1];
		const attaching = /^\/api\/(spaces|sessions)\/[^/]+\/attachments$/.test(path) && req.method === 'POST';
		if ((stored && req.method === 'POST') || attaching) {
			const chunks: Buffer[] = [];
			req.on('data', (chunk: Buffer) => chunks.push(chunk));
			req.on('end', () => {
				const name = stored ? decodeURIComponent(stored) : (url.searchParams.get('name') ?? 'file');
				const bytes = Buffer.concat(chunks);
				attachments.set(name, { bytes, type: String(req.headers['content-type'] ?? 'application/octet-stream') });
				const kind = /\.(png|jpe?g|gif|webp)$/i.test(name) ? `${name.split('.').pop()!.toUpperCase()} image` : 'File';
				setTimeout(() => json(res, { name, path: name, size: bytes.length, kind, text: null, cut: null }), stored ? 0 : 1200);
			});
			return;
		}
		if (stored) {
			const file = attachments.get(decodeURIComponent(stored));
			setTimeout(() => {
				if (!file) return void res.writeHead(404).end();
				res.setHeader('content-type', file.type);
				res.end(file.bytes);
			}, 700);
			return;
		}
		const task = `/api/sessions/${SESSION_ID}`;
		// Any other task (an incognito chat's, one the UI fixture opens) is answered as the scripted one.
		const other = path.match(/^\/api\/sessions\/([^/]+)(\/.*)?$/);
		if (other && other[1] !== SESSION_ID && !other[2]) return json(res, { ...session, working, id: other[1] });
		if (other && other[1] !== SESSION_ID) path = `${task}${other[2]}`;
		if (path === '/api/health') return json(res, { ok: true, openRouter: true, providers: { sandbox: 'local', store: 'disk', git: 'github' } });
		if (path === '/api/sessions') return json(res, { sessions: [{ ...session }, ...spaceThreads, ...others] });
		if (path === task) return json(res, { ...session, working });
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
		if (path === `${task}/outputs`) return json(res, { source: 'live', at: null, outputs: [...viewerArtifacts].map(([path, file]) => ({ path, size: file.body.length, mtimeMs: 1 })) });
		if (path === `${task}/output`) {
			const file = viewerArtifacts.get(url.searchParams.get('path') ?? '');
			if (file) {
				res.setHeader('content-type', file.type);
				return res.end(file.body);
			}
		}
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
		if (path === '/api/settings/background-models') return json(res, { defaults: { webDigest: null, vision: null, compaction: null } });
		if (path === '/api/settings/general')
			return json(res, {
				model: session.model,
				reasoning: null,
				planMode: false,
				reviewPullRequests: true,
				codeMode: true,
				visualReplies: 'some',
				pageNetwork: true,
				imageModel: null,
				titleModel: null,
				titleModelDefault: session.model,
				agentModels: { explorer: null, tester: null, browser: null, computer: null, reviewer: null },
				compactAt: null,
				claudeCodeCompactAt: null,
				backgroundModels: { webDigest: null, vision: null, compaction: null },
				backgroundReasoning: { webDigest: null, vision: null, compaction: null },
			});
		if (path === '/api/profile') return json(res, { name: 'Perf' });
		if (path === '/api/spaces') return json(res, { spaces });
		const todosSpaceId = path.match(/^\/api\/spaces\/([^/]+)\/todos$/)?.[1];
		if (todosSpaceId) {
			if (req.method === 'POST') {
				let raw = '';
				req.on('data', (chunk) => (raw += String(chunk)));
				req.on('end', () => {
					const input = JSON.parse(raw || '{}') as Record<string, unknown>;
					const nowIso = new Date().toISOString();
					const item = {
						id: `todo-${Date.now()}`,
						spaceId: todosSpaceId,
						title: String(input.title ?? ''),
						description: String(input.description ?? ''),
						status: 'open' as const,
						assigneeKind: 'unassigned' as const,
						priority: (input.priority as 'urgent' | 'high' | 'medium' | 'low' | null) ?? null,
						tags: Array.isArray(input.tags) ? input.tags.map(String) : [],
						projectId: (input.projectId as string | null) ?? null,
						model: (input.model as string | null) ?? null,
						reasoning: (input.reasoning as string | null) ?? null,
						planMode: Boolean(input.planMode),
						files: Array.isArray(input.files) ? input.files.map(String) : [],
						dueAt: (input.dueAt as string | null) ?? null,
						sourceUrl: (input.sourceUrl as string | null) ?? null,
						position: spaceTodos.filter((t) => t.spaceId === todosSpaceId).length,
						createdBy: 'user' as const,
						threadIds: [],
						assignedAt: null,
						completedAt: null,
						createdAt: nowIso,
						updatedAt: nowIso,
					};
					spaceTodos.push(item);
					json(res, item);
				});
				return;
			}
			return json(res, { todos: spaceTodos.filter((item) => item.spaceId === todosSpaceId) });
		}
		const todoAssignMatch = path.match(/^\/api\/spaces\/([^/]+)\/todos\/([^/]+)\/assign$/);
		if (todoAssignMatch && req.method === 'POST') {
			let raw = '';
			req.on('data', (chunk) => (raw += String(chunk)));
			req.on('end', () => {
				const [, sId, todoId] = todoAssignMatch;
				const input = JSON.parse(raw || '{}') as { target?: string; threadId?: string };
				const todo = spaceTodos.find((item) => item.spaceId === sId && item.id === todoId);
				if (!todo) {
					res.statusCode = 404;
					return json(res, { error: 'Not found' });
				}
				todo.assignedAt = new Date().toISOString();
				todo.updatedAt = todo.assignedAt;
				if (input.target === 'coordinator') {
					todo.status = 'triaging';
					todo.assigneeKind = 'coordinator';
					return json(res, { todo });
				}
				const threadId = input.target === 'thread' && input.threadId ? input.threadId : `th-todo-${Date.now()}`;
				if (input.target === 'new-thread') {
					spaceThreads.unshift(thread(threadId, sId, todo.title, 'working', { ...onRepo('p-billing', 'acme/billing-api', 'todo-thread'), working: true, status: 'running', lastReply: todo.description || todo.title, lastInputAt: todo.assignedAt }));
				}
				if (!todo.threadIds.includes(threadId)) todo.threadIds.push(threadId);
				todo.status = 'in_progress';
				todo.assigneeKind = 'thread';
				return json(res, { todo });
			});
			return;
		}
		const todoMatch = path.match(/^\/api\/spaces\/([^/]+)\/todos\/([^/]+)$/);
		if (todoMatch) {
			const [, sId, todoId] = todoMatch;
			if (req.method === 'DELETE') {
				const index = spaceTodos.findIndex((item) => item.spaceId === sId && item.id === todoId);
				if (index >= 0) spaceTodos.splice(index, 1);
				return json(res, { ok: true });
			}
			if (req.method === 'PATCH') {
				let raw = '';
				req.on('data', (chunk) => (raw += String(chunk)));
				req.on('end', () => {
					const patch = JSON.parse(raw || '{}') as Record<string, unknown>;
					const todo = spaceTodos.find((item) => item.spaceId === sId && item.id === todoId);
					if (!todo) {
						res.statusCode = 404;
						return json(res, { error: 'Not found' });
					}
					Object.assign(todo, patch, { updatedAt: new Date().toISOString() });
					json(res, todo);
				});
				return;
			}
		}
		if (/^\/api\/spaces\/[^/]+\/files$/.test(path)) return json(res, { files: [] });
		const spaceId = path.match(/^\/api\/spaces\/([^/]+)$/)?.[1];
		if (spaceId) {
			const found = spaces.find((item) => item.id === spaceId);
			if (found) return json(res, found);
			res.statusCode = 404;
			return json(res, { error: 'No such project' });
		}
		if (path === '/api/compute') return json(res, { provider: 'local', app: null, running: [], others: 0 });
		if (path === '/api/projects') return json(res, { projects });
		if (path === '/api/reviews') return json(res, { reviews: [review] });
		if (path === `${task}/pulls`) return json(res, { pulls: [{ url: pull.url, repo: pull.repo, number: pull.number, title: pull.title, head: pull.headBranch, base: pull.baseBranch, state: 'open', openedAt: pull.createdAt, mergedAt: null, current: true }] });
		if (path === `${task}/pulls/12` || path === `${task}/pulls/12/metadata`) return json(res, pull);
		if (path === `${task}/pulls/12/diff`) return json(res, { patch });
		if (/^\/api\/projects\/[^/]+\/branches$/.test(path)) return json(res, { branches: ['main'] });
		if (path === '/api/storage') return json(res, { objects: 1284, bytes: 412_000_000, lastCleanup: { at: ago(60 * 9), removed: 37, freedBytes: 18_400_000 } });
		if (path === '/api/connectors') return json(res, { accounts: [], mailboxes: [], mcpServers: [], composio: { configured: false, keyFromEnv: false, accounts: [] } });
		if (path === '/api/artifacts') return json(res, { artifacts });
		if (path === '/api/outputs') return json(res, { outputs: {} });
		if (path === '/api/settings/sandbox') return json(res, { settings: { cpu: 2, memoryMiB: 4096, idleMinutes: 15, lifetimeHours: 8, region: null, allowedDomains: ['registry.npmjs.org'], baseImage: null, warmImageDays: 7 }, defaultBaseImage: 'node:22-bookworm', provider: 'modal' });
		if (path === '/api/settings/guardrails') return json(res, { hideSecrets: true });
		if (path === '/api/secrets') return json(res, { shared: ['NPM_TOKEN', 'SENTRY_DSN'], repos: [{ projectId: 'p-billing', repo: 'acme/billing-api', names: ['STRIPE_KEY'] }] });
		if (path === '/api/push') return json(res, { publicKey: '', devices: [], finished: false });
		if (path === '/api/plugins') return json(res, { plugins: [], marketplaces: [] });
		if (path === '/api/logs') return json(res, { logs: [] });
		if (path === '/api/image-models') return json(res, { models: [], default: '', available: false });
		if (path === '/api/notifications' || path === '/api/notifications/read') return json(res, { notifications, unread: { 'needs-you': 0, replies: 0, done: 0, failures: 0, sandboxes: 0, ...notificationUnread } });
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

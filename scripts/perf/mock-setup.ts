import type { IncomingMessage, ServerResponse } from 'node:http';

/*
 * Settings › Connections for the UI fixture: the setup and live checks a
 * server answers, held in memory. `POST /__setup/fresh` makes it a new server
 * with nothing set up; `POST /__setup/env` (the default) one set up by its
 * environment, with object storage failing to show the diagnosis. A test
 * fails on any value with "bad" in it, as a vendor would refuse it.
 */

type Field = { env: string; label: string; secret: boolean; optional: boolean; fallback: string | null; source: 'saved' | 'environment' | null; value: string | null; hint: string | null };
type Slot = { id: string; name: string; required: boolean; live: boolean; provider: string | null; restart: boolean; saved: boolean; options: Array<{ id: string; label: string; fields: Field[] }> };
type Check = { id: string; name: string; provider: string; detail: string; state: 'ok' | 'set' | 'off' | 'failing' };

const field = (env: string, label: string, extra: Partial<Field> = {}): Field => ({ env, label, secret: false, optional: false, fallback: null, source: null, value: null, hint: null, ...extra });

function slots(): Slot[] {
	return [
		{ id: 'models', name: 'Models', required: true, live: true, provider: null, restart: false, saved: false, options: [
			{ id: 'openrouter', label: 'OpenRouter', fields: [field('OPENROUTER_API_KEY', 'API key', { secret: true })] },
			{ id: 'vercel', label: 'Vercel AI Gateway', fields: [field('AI_GATEWAY_API_KEY', 'API key', { secret: true })] },
		] },
		{ id: 'git', name: 'Code host', required: true, live: true, provider: 'github', restart: false, saved: false, options: [
			{ id: 'github', label: 'GitHub', fields: [field('ANTON_GITHUB_TOKEN', 'Personal access token', { secret: true }), field('ANTON_GITHUB_API_URL', 'API address', { optional: true, fallback: 'https://api.github.com' })] },
		] },
		{ id: 'sandbox', name: 'Sandboxes', required: true, live: false, provider: 'local', restart: false, saved: false, options: [
			{ id: 'modal', label: 'Modal', fields: [field('MODAL_TOKEN_ID', 'Token ID'), field('MODAL_TOKEN_SECRET', 'Token secret', { secret: true }), field('ANTON_MODAL_APP', 'App name', { optional: true, fallback: 'anton' })] },
			{ id: 'docker', label: 'Docker', fields: [field('ANTON_DOCKER_NETWORK', 'Network', { optional: true })] },
			{ id: 'local', label: 'This server', fields: [] },
		] },
		{ id: 'store', name: 'Object storage', required: true, live: false, provider: 'disk', restart: false, saved: false, options: [
			{ id: 's3', label: 'S3-compatible', fields: [field('TIGRIS_ENDPOINT', 'Endpoint', { fallback: 'https://t3.storage.dev' }), field('TIGRIS_BUCKET', 'Bucket'), field('TIGRIS_ACCESS_KEY_ID', 'Access key ID'), field('TIGRIS_SECRET_ACCESS_KEY', 'Secret access key', { secret: true }), field('TIGRIS_REGION', 'Region', { optional: true, fallback: 'auto' })] },
			{ id: 'disk', label: 'This server', fields: [] },
		] },
		{ id: 'database', name: 'Database', required: false, live: false, provider: 'sqlite', restart: false, saved: false, options: [
			{ id: 'sqlite', label: 'SQLite', fields: [] },
			{ id: 'turso', label: 'Turso', fields: [field('TURSO_DATABASE_URL', 'Database URL'), field('TURSO_AUTH_TOKEN', 'Auth token', { secret: true })] },
		] },
		{ id: 'decisions', name: 'Decision model', required: false, live: true, provider: 'openrouter', restart: false, saved: false, options: [
			{ id: 'openrouter', label: 'OpenRouter', fields: [field('ANTON_DECISION_MODEL', 'Model', { fallback: '~typesafe/jev-latest' })] },
			{ id: 'off', label: 'Off', fields: [] },
		] },
		{ id: 'web', name: 'Web search', required: false, live: true, provider: 'parallel', restart: false, saved: false, options: [
			{ id: 'parallel', label: 'Parallel', fields: [field('PARALLEL_API_KEY', 'API key', { secret: true, optional: true })] },
			{ id: 'mcp', label: 'Other server', fields: [field('ANTON_WEB_MCP_URL', 'Server URL'), field('PARALLEL_API_KEY', 'API key', { secret: true, optional: true })] },
			{ id: 'off', label: 'Off', fields: [] },
		] },
	];
}

const OK: Record<string, string> = {
	models: '316 models that can call tools.',
	git: 'Acting as Perf. Pushes and pull requests go through its API.',
	sandbox: 'Tasks run in Modal app anton. 0 running now.',
	store: 'Bucket anton at t3.storage.dev.',
	database: 'A file on this server.',
	decisions: 'Skips pull request comments that ask nothing and drives the browser agent.',
	web: 'web_search and web_fetch through search.parallel.ai, on the free tier.',
};

let state = { slots: slots(), checks: [] as Check[], plans: [] as string[] };

function envServer() {
	const next = slots();
	const set = (id: string, provider: string, fromEnv: Record<string, string | null>) => {
		const slot = next.find((s) => s.id === id)!;
		slot.provider = provider;
		for (const f of slot.options.find((o) => o.id === provider)!.fields)
			if (f.env in fromEnv) Object.assign(f, { source: 'environment', hint: f.secret ? fromEnv[f.env] : null, value: f.secret ? null : fromEnv[f.env] });
	};
	set('models', 'openrouter', { OPENROUTER_API_KEY: '9f3a' });
	set('git', 'github', { ANTON_GITHUB_TOKEN: 'a4f2' });
	set('sandbox', 'modal', { MODAL_TOKEN_ID: 'ak-perf', MODAL_TOKEN_SECRET: '71c0' });
	set('store', 's3', { TIGRIS_ENDPOINT: 'https://t3.storage.dev', TIGRIS_BUCKET: 'anton', TIGRIS_ACCESS_KEY_ID: 'tid_perf', TIGRIS_SECRET_ACCESS_KEY: '0b9e' });
	state = {
		slots: next,
		plans: ['ChatGPT plan'],
		checks: [
			{ id: 'git', name: 'Code host', provider: 'github', detail: OK.git, state: 'ok' },
			{ id: 'sandbox', name: 'Sandboxes', provider: 'modal', detail: OK.sandbox, state: 'ok' },
			{ id: 'store', name: 'Object storage', provider: 's3', detail: 't3.storage.dev did not answer within 10.0s. The address lookup took 9.8s, so this server is slow to resolve names; check its DNS.', state: 'failing' },
			{ id: 'models', name: 'Models', provider: 'openrouter', detail: OK.models, state: 'ok' },
			{ id: 'decisions', name: 'Decision model', provider: '~typesafe/jev-latest', detail: OK.decisions, state: 'ok' },
			{ id: 'web', name: 'Web search', provider: 'search.parallel.ai', detail: OK.web, state: 'set' },
			{ id: 'database', name: 'Database', provider: 'sqlite', detail: OK.database, state: 'ok' },
		],
	};
}

function freshServer() {
	state = {
		slots: slots(),
		plans: [],
		checks: [
			{ id: 'git', name: 'Code host', provider: 'github', detail: 'ANTON_GITHUB_TOKEN is not set.', state: 'off' },
			{ id: 'sandbox', name: 'Sandboxes', provider: 'local', detail: 'Tasks run in this server, in folders under the data directory. 0 running now.', state: 'ok' },
			{ id: 'store', name: 'Object storage', provider: 'disk', detail: 'Files under the data directory on this server.', state: 'ok' },
			{ id: 'models', name: 'Models', provider: 'openrouter', detail: 'No OpenRouter key.', state: 'off' },
			{ id: 'decisions', name: 'Decision model', provider: 'off', detail: 'Needs an OpenRouter key.', state: 'off' },
			{ id: 'web', name: 'Web search', provider: 'search.parallel.ai', detail: OK.web, state: 'set' },
			{ id: 'database', name: 'Database', provider: 'sqlite', detail: OK.database, state: 'ok' },
		],
	};
}

envServer();

const read = (req: IncomingMessage) =>
	new Promise<{ provider: string; values: Record<string, string> }>((resolve) => {
		let text = '';
		req.on('data', (chunk) => (text += chunk));
		req.on('end', () => resolve(text ? JSON.parse(text) : { provider: '', values: {} }));
	});

function refuse(res: ServerResponse, message: string) {
	res.statusCode = 400;
	res.setHeader('content-type', 'application/json');
	res.end(JSON.stringify({ error: message }));
}

/** Answers the setup and connections routes; false for any other path. */
export async function mockSetup(req: IncomingMessage, res: ServerResponse, path: string, json: (res: ServerResponse, body: unknown) => void): Promise<boolean> {
	if (path === '/__setup/fresh') return (freshServer(), json(res, { ok: true }), true);
	if (path === '/__setup/env') return (envServer(), json(res, { ok: true }), true);
	if (path === '/api/connections') {
		await new Promise((resolve) => setTimeout(resolve, 400));
		return (json(res, { connections: state.checks }), true);
	}
	if (path === '/api/setup') return (json(res, { slots: state.slots, plans: state.plans, canRunTasks: state.slots[0].provider !== null || state.plans.length > 0 }), true);
	const match = /^\/api\/setup\/([a-z]+)(\/test)?$/.exec(path);
	if (!match) return false;
	const slot = state.slots.find((s) => s.id === match[1]);
	if (!slot) return (refuse(res, 'No such connection'), true);
	if (req.method === 'DELETE') {
		slot.saved = false;
		slot.restart = false;
		return (json(res, { ok: true }), true);
	}
	const input = await read(req);
	const option = slot.options.find((o) => o.id === input.provider);
	if (!option) return (refuse(res, `${slot.name} has no provider "${input.provider}"`), true);
	await new Promise((resolve) => setTimeout(resolve, 700));
	const missing = option.fields.filter((f) => !f.optional && !f.source && !f.fallback && !input.values[f.env]?.trim());
	if (missing.length) return (refuse(res, `${missing.map((f) => f.label).join(' and ')} ${missing.length > 1 ? 'are' : 'is'} needed.`), true);
	if (Object.values(input.values).some((v) => /bad/i.test(v))) return (refuse(res, `${option.label} rejected this key. Check it was copied whole.`), true);
	const detail = slot.id === 'sandbox' && option.id === 'docker' ? 'Docker 27.3 answered. Tasks run as containers on this server.' : (OK[slot.id] ?? 'Answered.');
	if (match[2]) return (json(res, { detail }), true);
	slot.provider = option.id;
	slot.saved = true;
	slot.restart = !slot.live;
	for (const f of option.fields) {
		const value = input.values[f.env]?.trim();
		if (value) Object.assign(f, { source: 'saved', value: f.secret ? null : value, hint: f.secret ? value.slice(-4) : null });
	}
	const check = state.checks.find((c) => c.id === slot.id);
	if (check && slot.live) Object.assign(check, { state: 'ok', detail, provider: option.id });
	return (json(res, { detail, restart: slot.restart }), true);
}

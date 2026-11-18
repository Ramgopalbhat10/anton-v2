import { Hono } from 'hono';
import * as v from 'valibot';
import { config } from '../config.ts';
import { InvalidInputError, NotFoundError } from '../core/errors.ts';
import { beginConnect, connectorsView, disconnectAccount, finishConnect, setAccountClient, setMailboxOptions } from '../services/connectors/connectors.ts';
import { addComposioToolkit, beginComposioConnect, composioAuthSetup, composioToolkit, composioTools, composioView, disconnectComposioAccount, refreshComposioAccount, removeComposioAccount, saveComposioCredentials, searchComposioToolkits, setComposioAccountEnabled, setComposioKey } from '../services/connectors/composio.ts';
import { addMcpServer, mcpServersView, mcpServerTools, removeMcpServer, toggleMcpServer, updateMcpServer } from '../services/connectors/mcp-servers.ts';
import { beginMcpSignIn, finishMcpSignIn, signOutOfMcpServer } from '../services/connectors/mcp-sign-in.ts';
import { gitHubDelivery, signedByGitHub } from '../services/git/pr-watch.ts';
import { body } from './shared.ts';

const app = new Hono();

// Off without ANTON_GITHUB_WEBHOOK_SECRET; a delivery only says which pull requests to read again from GitHub.
app.post('/api/github/webhook', async (c) => {
	const secret = config.github.webhookSecret;
	if (!secret) return c.json({ error: 'Webhooks are off: set ANTON_GITHUB_WEBHOOK_SECRET to the webhook secret.' }, 404);
	const raw = await c.req.text();
	if (!signedByGitHub(secret, raw, c.req.header('x-hub-signature-256'))) return c.json({ error: 'The signature does not match the secret.' }, 401);
	const event = c.req.header('x-github-event') ?? '';
	if (event === 'ping') return c.json({ ok: true });
	// A webhook can be set to send its payload as a form field instead of JSON.
	const form = c.req.header('content-type')?.startsWith('application/x-www-form-urlencoded');
	let delivery: unknown;
	try {
		delivery = JSON.parse(form ? (new URLSearchParams(raw).get('payload') ?? '') : raw);
	} catch {
		throw new InvalidInputError('The payload is not JSON.');
	}
	return c.json({ ok: true, tasks: await gitHubDelivery(event, (delivery ?? {}) as Parameters<typeof gitHubDelivery>[1]) });
});

app.get('/api/connectors', async (c) => c.json({ ...(await connectorsView()), mcpServers: await mcpServersView(), composio: await composioView() }));
app.put('/api/connectors/accounts/:id/client', async (c) => {
	const input = await body(
		c,
		v.object({ clientId: v.pipe(v.string(), v.trim(), v.maxLength(300)), clientSecret: v.optional(v.nullable(v.pipe(v.string(), v.trim(), v.maxLength(300)))) }),
	);
	return c.json(await setAccountClient(c.req.param('id'), input));
});
app.delete('/api/connectors/accounts/:id', async (c) => c.json(await disconnectAccount(c.req.param('id'))));
app.post('/api/connectors/mailboxes/:id/connect', async (c) => {
	const { origin, access } = await body(c, v.object({ origin: v.pipe(v.string(), v.maxLength(300)), access: v.picklist(['read', 'draft']) }));
	return c.json(await beginConnect(c.req.param('id'), origin, access));
});
app.put('/api/connectors/mailboxes/:id', async (c) => {
	const options = await body(c, v.object({ enabled: v.boolean(), draft: v.boolean(), send: v.boolean() }));
	return c.json(await setMailboxOptions(c.req.param('id'), options));
});
app.get('/api/connectors/:account/callback', async (c) => {
	const query = new URL(c.req.url).search;
	const back = new URLSearchParams();
	try {
		const { mailbox } = await finishConnect(c.req.param('account'), query);
		back.set('c', `mail:${mailbox}`);
		back.set('connected', mailbox);
	} catch (error) {
		back.set('add', 'gmail');
		back.set('problem', error instanceof Error ? error.message : String(error));
	}
	return c.redirect(`/settings/connectors/view?${back}`);
});
const MCP_SERVER = v.object({
	url: v.pipe(v.string(), v.trim(), v.url(), v.startsWith('https://', 'MCP servers need an https URL'), v.maxLength(500)),
	auth: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(4000)))),
	tools: v.pipe(v.array(v.pipe(v.string(), v.maxLength(100))), v.maxLength(50)),
	codeMode: v.optional(v.boolean()),
});
const SERVER_NAME = v.pipe(v.string(), v.regex(/^[a-z0-9_-]{1,32}$/, 'Server names use lowercase letters, digits, - and _'));
app.post('/api/mcp-servers', async (c) => {
	const input = await body(c, v.object({ ...MCP_SERVER.entries, name: SERVER_NAME }));
	return c.json({ mcpServers: await addMcpServer(input) });
});
app.put('/api/mcp-servers/:name', async (c) => c.json({ mcpServers: await updateMcpServer(c.req.param('name'), await body(c, MCP_SERVER)) }));
app.patch('/api/mcp-servers/:name', async (c) => {
	const { enabled } = await body(c, v.object({ enabled: v.boolean() }));
	return c.json({ mcpServers: await toggleMcpServer(c.req.param('name'), enabled) });
});
app.delete('/api/mcp-servers/:name', async (c) => c.json({ mcpServers: await removeMcpServer(c.req.param('name')) }));
app.get('/api/mcp-servers/:name/tools', async (c) => c.json({ tools: await mcpServerTools(c.req.param('name')) }));
app.post('/api/mcp-servers/:name/sign-in', async (c) => {
	const { origin, client } = await body(
		c,
		v.object({
			origin: v.pipe(v.string(), v.maxLength(300)),
			client: v.optional(v.nullable(v.object({ clientId: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(500)), clientSecret: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(2000)))) }))),
		}),
	);
	const { url } = await beginMcpSignIn(c.req.param('name'), origin, client);
	return c.json({ url, mcpServers: await mcpServersView() });
});
app.delete('/api/mcp-servers/:name/sign-in', async (c) => {
	await signOutOfMcpServer(c.req.param('name'));
	return c.json({ mcpServers: await mcpServersView() });
});
app.get('/api/mcp-servers/callback', async (c) => {
	const back = new URLSearchParams();
	try {
		const name = await finishMcpSignIn(new URL(c.req.url).searchParams);
		back.set('c', `mcp:${name}`);
		back.set('connected', name);
	} catch (error) {
		// No server is known when the sign-in failed, so Connectors itself shows the problem.
		back.set('problem', error instanceof Error ? error.message : String(error));
		return c.redirect(`/settings/connectors?${back}`);
	}
	return c.redirect(`/settings/connectors/view?${back}`);
});
const COMPOSIO_TOOLKIT = v.pipe(v.string(), v.regex(/^[a-z0-9_-]{1,64}$/, 'Toolkit names use lowercase letters, digits, - and _'));
app.put('/api/composio/key', async (c) => {
	const { key } = await body(c, v.object({ key: v.nullable(v.pipe(v.string(), v.trim(), v.maxLength(300))) }));
	return c.json(await setComposioKey(key));
});
app.post('/api/composio/accounts', async (c) => {
	const { toolkit } = await body(c, v.object({ toolkit: COMPOSIO_TOOLKIT }));
	return c.json(await addComposioToolkit(toolkit));
});
app.get('/api/composio/accounts/:toolkit/tools', async (c) => c.json({ tools: await composioTools(c.req.param('toolkit')) }));
app.get('/api/composio/toolkits', async (c) => c.json({ toolkits: await searchComposioToolkits(c.req.query('search') ?? '') }));
app.get('/api/composio/toolkits/:slug', async (c) => {
	const slug = c.req.param('slug');
	if (!v.safeParse(COMPOSIO_TOOLKIT, slug).success) throw new InvalidInputError('That is not a toolkit name.');
	const toolkit = await composioToolkit(slug);
	if (!toolkit) throw new NotFoundError(`Composio has no toolkit named ${slug}`);
	return c.json(toolkit);
});
app.patch('/api/composio/accounts/:toolkit', async (c) => {
	const { enabled } = await body(c, v.object({ enabled: v.boolean() }));
	return c.json(await setComposioAccountEnabled(c.req.param('toolkit'), enabled));
});
app.post('/api/composio/accounts/:toolkit/connect', async (c) => {
	const { callbackUrl } = await body(c, v.object({ callbackUrl: v.optional(v.pipe(v.string(), v.maxLength(500))) }));
	return c.json(await beginComposioConnect(c.req.param('toolkit'), callbackUrl));
});
app.get('/api/composio/accounts/:toolkit/auth', async (c) => c.json(await composioAuthSetup(c.req.param('toolkit'))));
app.post('/api/composio/accounts/:toolkit/auth', async (c) => {
	const { scheme, credentials, callbackUrl } = await body(
		c,
		v.object({
			scheme: v.pipe(v.string(), v.regex(/^[A-Z0-9_]{1,40}$/, 'That is not a sign-in method')),
			credentials: v.pipe(v.record(v.pipe(v.string(), v.maxLength(100)), v.pipe(v.string(), v.maxLength(8000))), v.check((record) => Object.keys(record).length <= 30, 'Too many fields')),
			callbackUrl: v.optional(v.pipe(v.string(), v.maxLength(500))),
		}),
	);
	return c.json(await saveComposioCredentials(c.req.param('toolkit'), { scheme, credentials }, callbackUrl));
});
app.post('/api/composio/accounts/:toolkit/refresh', async (c) => c.json(await refreshComposioAccount(c.req.param('toolkit'))));
app.post('/api/composio/accounts/:toolkit/disconnect', async (c) => c.json(await disconnectComposioAccount(c.req.param('toolkit'))));
app.delete('/api/composio/accounts/:toolkit', async (c) => c.json(await removeComposioAccount(c.req.param('toolkit'))));

export const connectorRoutes = app;

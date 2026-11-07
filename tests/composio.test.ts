import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const dir = mkdtempSync(path.join(os.tmpdir(), 'anton-composio-'));
process.env.ANTON_DATA_DIR = dir;
process.env.ANTON_COMPOSIO_API_URL = 'https://composio.test/api/v3.1';
process.env.COMPOSIO_API_KEY = 'ck_env';

const { setProviders } = await import('../src/providers/index.ts');
const { composioApps } = await import('../src/providers/composio/index.ts');
const { composioKeySlot } = await import('../src/providers/composio/key.ts');
const composio = await import('../src/services/composio.ts');
const approvals = await import('../src/services/tool-approvals.ts');
const connectorTools = await import('../src/services/connector-tools.ts');
const { onChange } = await import('../src/core/changes.ts');

setProviders({ sandbox: {} as never, store: {} as never, git: {} as never, models: { name: 'openrouter', list: async () => [] }, apps: composioApps({ key: composioKeySlot }) });

const realFetch = globalThis.fetch;
after(() => {
	globalThis.fetch = realFetch;
	composio.resetComposioForTests();
	rmSync(dir, { recursive: true, force: true });
});

const SLUG = 'slack';
const ACCOUNT_ID = 'ca_link_1';

type Seen = { method: string; url: string; body: string; key: string | null };

/** A Composio that keeps one toolkit, one auth config, and accounts whose status the test sets. */
function fakeComposio({ accountStatus = 'INITIATED' }: { accountStatus?: string } = {}) {
	const state = { accountStatus, linked: false, seen: [] as Seen[], tools: [
		{ slug: 'SLACK_FETCH_CONVERSATION_HISTORY', name: 'Fetch Conversation History', description: 'Read messages', input_parameters: { type: 'object', properties: { channel: { type: 'string' } } }, tags: ['read'] },
		{ slug: 'SLACK_SEND_MESSAGE', name: 'Send Message', description: 'Post a message', input_parameters: { type: 'object', properties: { channel: { type: 'string' }, text: { type: 'string' } } }, tags: ['write'] },
	] as Array<Record<string, unknown>>, executed: [] as Array<{ slug: string; body: Record<string, unknown> }> };
	const toolkit = { slug: SLUG, name: 'Slack', no_auth: false, meta: { description: 'Chat and channels', logo: 'https://logos.composio.dev/slack.png', app_url: 'https://slack.com', categories: [{ name: 'Communication' }], tools_count: 2 } };
	const account = () => ({
		id: ACCOUNT_ID,
		status: state.accountStatus,
		toolkit: { slug: SLUG },
		word_id: 'T0123',
		status_reason: state.accountStatus === 'FAILED' ? 'Slack refused the token' : null,
		created_at: '2026-10-17T00:00:00Z',
	});
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const request = new Request(input, init);
		const body = await request.clone().text();
		state.seen.push({ method: request.method, url: request.url, body, key: request.headers.get('x-api-key') });
		const url = new URL(request.url);
		const path = url.pathname;
		if (!url.host.endsWith('composio.test')) throw new Error(`Unexpected fetch ${request.method} ${request.url}`);
		assert.equal(request.headers.get('x-api-key') != null, true, 'every call carries the project key');
		if (request.headers.get('x-api-key') === 'ck_bad') return Response.json({ error: { message: 'Invalid API key' } }, { status: 401 });
		if (path.endsWith('/toolkits')) {
			const search = url.searchParams.get('search');
			return Response.json({ items: search && search !== SLUG ? [] : [toolkit] });
		}
		if (path.endsWith('/auth_configs') && request.method === 'GET') return Response.json({ items: [{ id: 'ac_1', status: 'ENABLED', is_composio_managed: true }] });
		if (path.endsWith('/auth_configs') && request.method === 'POST') return Response.json({ auth_config: { id: 'ac_new' } });
		if (path.endsWith('/connected_accounts/link')) {
			state.linked = true;
			return Response.json({ redirect_url: 'https://connect.composio.dev/link/abc', connected_account_id: ACCOUNT_ID, expires_at: '2026-10-18T00:00:00Z' });
		}
		if (path.endsWith('/connected_accounts') && request.method === 'GET') {
			return Response.json({ items: state.linked && state.accountStatus !== 'NONE' ? [account()] : [] });
		}
		if (path.endsWith(`/connected_accounts/${ACCOUNT_ID}`) && request.method === 'GET') return Response.json(account());
		if (path.endsWith('/tools') && request.method === 'GET') return Response.json({ items: state.tools, next_cursor: null });
		const execute = /\/tools\/execute\/([^/]+)$/.exec(path);
		if (execute && request.method === 'POST') {
			const payload = JSON.parse(body) as Record<string, unknown>;
			state.executed.push({ slug: decodeURIComponent(execute[1]), body: payload });
			return Response.json({ data: { ok: true, echoed: payload.arguments }, error: null, successful: true, log_id: 'log_1' });
		}
		if (path.endsWith(`/connected_accounts/${ACCOUNT_ID}/revoke`)) return Response.json({});
		if (path.endsWith(`/connected_accounts/${ACCOUNT_ID}`) && request.method === 'DELETE') return new Response('', { status: 204 });
		throw new Error(`Unexpected fetch ${request.method} ${request.url}`);
	}) as typeof fetch;
	return state;
}

/** One app row per test: the file's tests share a database. */
async function reset() {
	composio.resetComposioForTests();
	await composio.removeComposioAccount(SLUG).catch(() => undefined);
	composio.resetComposioForTests();
}

test('the project key comes from the environment, and a pasted one replaces it after Composio accepts it', async () => {
	fakeComposio();
	let view = await composio.composioView();
	assert.deepEqual([view.configured, view.keyFromEnv, view.accounts.length], [true, true, 0]);

	await composio.setComposioKey('ck_pasted');
	view = await composio.composioView();
	assert.deepEqual([view.configured, view.keyFromEnv], [true, false]);
	await assert.rejects(composio.setComposioKey('ck_bad'), /refused|answered/);
});

test('an app is added from Composio’s catalog, once', async () => {
	await reset();
	fakeComposio();
	await assert.rejects(composio.addComposioToolkit('not-a-toolkit'), /no toolkit named/);
	await composio.addComposioToolkit(SLUG);
	await assert.rejects(composio.addComposioToolkit(SLUG), /already added/);
	const view = await composio.composioView();
	const account = view.accounts.find((item) => item.toolkit === SLUG)!;
	assert.equal(account.name, 'Slack');
	assert.equal(account.status, 'none');
	assert.ok(!('accountId' in account), 'the connected account id is not part of the view');
});

test('the whole catalog is searched live, and one app is read by its slug', async () => {
	composio.resetComposioForTests();
	fakeComposio();
	const found = await composio.searchComposioToolkits('slack');
	assert.equal(found.length, 1);
	assert.equal(found[0].slug, SLUG);
	assert.deepEqual(await composio.searchComposioToolkits('s'), [], 'under two letters nothing is asked');
	assert.deepEqual(await composio.searchComposioToolkits('zzz'), []);
	assert.equal((await composio.composioToolkit(SLUG))?.name, 'Slack');
	assert.equal(await composio.composioToolkit('zzz'), null);
});

test('connecting makes a Composio-managed auth config, a link, and a pending row; finishing it marks the account active', async () => {
	await reset();
	fakeComposio({ accountStatus: 'ACTIVE' });
	await composio.addComposioToolkit(SLUG);
	const changes: string[] = [];
	const stop = onChange((change) => changes.push(change.kind));
	const { url } = await composio.beginComposioConnect(SLUG);
	stop();
	assert.equal(url, 'https://connect.composio.dev/link/abc');
	assert.ok(changes.includes('connectors'));

	// The pending row asks Composio for the account's status on the next view.
	const view = await composio.refreshComposioAccount(SLUG);
	const account = view.accounts.find((item) => item.toolkit === SLUG)!;
	assert.equal(account.status, 'active');
	assert.equal(account.account, ACCOUNT_ID);
	assert.ok(account.connectedAt);
});

test('a failed connection says why, and reads give tools while writes wait on Run', async () => {
	await reset();
	const fake = fakeComposio({ accountStatus: 'FAILED' });
	await composio.addComposioToolkit(SLUG);
	await composio.beginComposioConnect(SLUG);
	const view = await composio.refreshComposioAccount(SLUG);
	const account = view.accounts.find((item) => item.toolkit === SLUG)!;
	assert.equal(account.status, 'failed');
	assert.equal(account.statusReason, 'Slack refused the token');

	// Reads run at once; writes become an approval the thread can show.
	fake.accountStatus = 'ACTIVE';
	await composio.refreshComposioAccount(SLUG);
	const listed = await connectorTools.connectorToolsText('');
	assert.match(listed, /## Slack: on/);
	assert.match(listed, /### composio__slack__fetch_conversation_history/);
	const read = await connectorTools.callConnectorTool('task-1', 'composio__slack__fetch_conversation_history', { channel: 'C1' });
	assert.match(read.output, /"ok": true/);
	assert.equal(fake.executed.at(-1)?.body.user_id, 'anton', 'Composio scopes the call to Anton’s install');
	assert.equal(fake.executed.at(-1)?.body.connected_account_id, ACCOUNT_ID);

	const write = await connectorTools.callConnectorTool('task-1', 'composio__slack__send_message', { channel: '#general', text: 'hi' });
	assert.match(write.output, /\[approval:tool_[\w-]+\]/);
	const waiting = await approvals.toolApprovals('task-1');
	assert.equal(waiting.length, 1);
	assert.equal(waiting[0].state, 'pending');
	assert.equal(waiting[0].connector, 'composio:slack');
});

test('Run executes the approved call once, and Don’t run sends nothing', async () => {
	await reset();
	const fake = fakeComposio({ accountStatus: 'ACTIVE' });
	await composio.addComposioToolkit(SLUG);
	await composio.beginComposioConnect(SLUG);
	await composio.refreshComposioAccount(SLUG);
	await connectorTools.callConnectorTool('task-2', 'composio__slack__send_message', { channel: '#ops', text: 'deploy?' });
	const [waiting] = await approvals.toolApprovals('task-2');

	await assert.rejects(approvals.decideToolApproval('other-task', waiting.id, true), /No tool call waits/);
	const done = await approvals.decideToolApproval('task-2', waiting.id, true);
	assert.equal(done.state, 'done');
	assert.match(done.result ?? '', /"ok": true/);
	assert.equal(fake.executed.length, 1);
	assert.equal((fake.executed[0].body.arguments as { text: string }).text, 'deploy?');
	await assert.rejects(approvals.decideToolApproval('task-2', waiting.id, true), /already ran/);

	await connectorTools.callConnectorTool('task-2', 'composio__slack__send_message', { channel: '#ops', text: 'again?' });
	const [second] = (await approvals.toolApprovals('task-2')).filter((item) => item.state === 'pending');
	const declined = await approvals.decideToolApproval('task-2', second.id, false);
	assert.equal(declined.state, 'declined');
	assert.equal(fake.executed.length, 1, 'nothing ran for the declined call');
});

test('turning the app off and on gates its tools, and disconnecting forgets the connection', async () => {
	await reset();
	const fake = fakeComposio({ accountStatus: 'ACTIVE' });
	await composio.addComposioToolkit(SLUG);
	await composio.beginComposioConnect(SLUG);
	await composio.refreshComposioAccount(SLUG);

	await composio.setComposioAccountEnabled(SLUG, false);
	assert.match(await connectorTools.connectorToolsText(''), /## Slack: it is off/);
	await assert.rejects(connectorTools.callConnectorTool('task-3', 'composio__slack__fetch_conversation_history', {}), /Slack is off/);
	await composio.setComposioAccountEnabled(SLUG, true);
	assert.match(await connectorTools.connectorToolsText(''), /## Slack: on/);

	await composio.disconnectComposioAccount(SLUG);
	assert.ok(fake.seen.some((request) => request.method === 'POST' && request.url.endsWith(`/connected_accounts/${ACCOUNT_ID}/revoke`)));
	const view = await composio.composioView();
	assert.equal(view.accounts[0].status, 'none');
	assert.equal(view.accounts[0].account, null);
	await assert.rejects(connectorTools.callConnectorTool('task-3', 'composio__slack__fetch_conversation_history', {}), /not connected|Needs|sign in/i);
});

test('writes and the unknown ask first; reads by name go straight through', () => {
	assert.equal(composio.composioToolNeedsApproval('slack', 'SLACK_SEND_MESSAGE'), true);
	assert.equal(composio.composioToolNeedsApproval('github', 'GITHUB_DELETE_FILE'), true);
	assert.equal(composio.composioToolNeedsApproval('googlecalendar', 'GOOGLECALENDAR_EVENTS_LIST'), false, 'a listing named noun-first is still a read');
	assert.equal(composio.composioToolNeedsApproval('slack', 'SLACK_FETCH_CONVERSATION_HISTORY'), false);
	assert.equal(composio.composioToolNeedsApproval('notion', 'NOTION_SEARCH'), false);
	assert.equal(composio.composioToolNeedsApproval('gmail', 'GMAIL_MARK_AS_READ'), true, 'marking read changes state');
	assert.equal(composio.composioToolNeedsApproval('slack', 'SLACK_FROBNICATE'), true, 'an unrecognized action asks');
	assert.equal(composio.composioToolName('slack', 'SLACK_SEND_MESSAGE'), 'composio__slack__send_message');
});

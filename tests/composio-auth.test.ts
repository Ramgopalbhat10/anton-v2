import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';

const dir = mkdtempSync(path.join(os.tmpdir(), 'anton-composio-auth-'));
process.env.ANTON_DATA_DIR = dir;
process.env.ANTON_COMPOSIO_API_URL = 'https://composio.test/api/v3.1';
process.env.COMPOSIO_API_KEY = 'ck_env';

const { setProviders } = await import('../src/providers/index.ts');
const { composioApps } = await import('../src/providers/composio/index.ts');
const { composioKeySlot } = await import('../src/providers/composio/key.ts');
const composio = await import('../src/services/connectors/composio.ts');

setProviders({ sandbox: {} as never, store: {} as never, git: {} as never, models: { name: 'openrouter', list: async () => [] }, apps: composioApps({ key: composioKeySlot }) });

const realFetch = globalThis.fetch;
after(() => {
	globalThis.fetch = realFetch;
	composio.resetComposioForTests();
	rmSync(dir, { recursive: true, force: true });
});

const SLUG = 'mongodb';
const field = (name: string, displayName: string, extra: Record<string, unknown> = {}) => ({ name, displayName, type: 'string', description: `${displayName} of the service account`, required: true, user_visible: true, ...extra });

type Config = { id: string; status: string; is_composio_managed: boolean; created_at: string; toolkit: { slug: string } };

/** A Composio with one toolkit that has no managed app, as MongoDB is. */
function fakeComposio(options: { managedSchemes?: string[]; configFields?: Array<Record<string, unknown>>; configs?: Config[]; managedCreate?: 'ok' | '404' } = {}) {
	const state = { configs: [...(options.configs ?? [])], created: [] as Array<Record<string, unknown>>, linkedWith: [] as string[] };
	const toolkit = { slug: SLUG, name: 'MongoDB', no_auth: false, meta: { description: 'Atlas', logo: '', app_url: null, categories: [{ name: 'databases' }], tools_count: 496 } };
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const request = new Request(input, init);
		const url = new URL(request.url);
		const path = url.pathname;
		if (path.endsWith('/toolkits')) return Response.json({ items: [toolkit] });
		if (path.endsWith(`/toolkits/${SLUG}`)) {
			return Response.json({
				...toolkit,
				composio_managed_auth_schemes: options.managedSchemes ?? [],
				auth_guide_url: 'https://docs.composio.dev/toolkits/mongodb',
				auth_config_details: [
					{
						mode: 'S2S_OAUTH2',
						name: 'Atlas service account',
						fields: {
							auth_config_creation: { required: options.configFields ?? [field('client_id', 'Client ID'), field('client_secret', 'Client secret', { is_secret: true })], optional: [] },
							connected_account_initiation: { required: [], optional: [] },
						},
					},
				],
			});
		}
		if (path.endsWith('/auth_configs') && request.method === 'GET') {
			assert.equal(url.searchParams.get('toolkit_slug'), SLUG);
			return Response.json({ items: state.configs });
		}
		if (path.endsWith('/auth_configs') && request.method === 'POST') {
			const body = JSON.parse(await request.text()) as { auth_config: Record<string, unknown> };
			state.created.push(body.auth_config);
			if (body.auth_config.type === 'use_composio_managed_auth' && options.managedCreate === '404') {
				return Response.json({ error: { message: 'Default auth config not found for toolkit "mongodb". Composio does not have managed credentials for this toolkit.' } }, { status: 404 });
			}
			const id = `ac_${state.created.length}`;
			state.configs.push({ id, status: 'ENABLED', is_composio_managed: body.auth_config.type === 'use_composio_managed_auth', created_at: `2026-11-18T00:00:0${state.created.length}Z`, toolkit: { slug: SLUG } });
			return Response.json({ auth_config: { id } });
		}
		if (path.endsWith('/connected_accounts/link')) {
			state.linkedWith.push((JSON.parse(await request.text()) as { auth_config_id: string }).auth_config_id);
			return Response.json({ redirect_url: 'https://connect.composio.dev/link/m', connected_account_id: 'ca_m', expires_at: '2026-11-19T00:00:00Z' });
		}
		if (path.endsWith('/connected_accounts') && request.method === 'GET') return Response.json({ items: [] });
		if (path.endsWith('/connected_accounts/ca_m') && request.method === 'GET') return Response.json({ id: 'ca_m', status: 'INITIATED', toolkit: { slug: SLUG } });
		if (path.includes('/connected_accounts/ca_m')) return Response.json({});
		throw new Error(`Unexpected fetch ${request.method} ${request.url}`);
	}) as typeof fetch;
	return state;
}

beforeEach(async () => {
	composio.resetComposioForTests();
	fakeComposio();
	await composio.removeComposioAccount(SLUG).catch(() => undefined);
	composio.resetComposioForTests();
});

test('an app without a managed sign-in asks for your credentials instead of failing with Composio’s 404', async () => {
	const fake = fakeComposio();
	await composio.addComposioToolkit(SLUG);
	const setup = await composio.composioAuthSetup(SLUG);
	assert.equal(setup.state, 'credentials');
	assert.deepEqual(setup.methods[0].configFields.map((each) => [each.name, each.label, each.secret]), [
		['client_id', 'Client ID', false],
		['client_secret', 'Client secret', true],
	]);
	await assert.rejects(composio.beginComposioConnect(SLUG), /no shared sign-in for MongoDB.*your own credentials/);
	assert.equal(fake.created.length, 0, 'no managed auth config is asked for');
});

test('your credentials make a custom auth config at Composio, and the sign-in runs on it', async () => {
	const fake = fakeComposio();
	await composio.addComposioToolkit(SLUG);
	await assert.rejects(composio.saveComposioCredentials(SLUG, { scheme: 'S2S_OAUTH2', credentials: { client_id: 'mdb_sa_id' } }), /Fill in Client secret/);
	await assert.rejects(composio.saveComposioCredentials(SLUG, { scheme: 'OAUTH2', credentials: {} }), /does not sign in with OAUTH2/);
	const { url } = await composio.saveComposioCredentials(SLUG, { scheme: 'S2S_OAUTH2', credentials: { client_id: ' mdb_sa_id ', client_secret: 'mdb_sa_secret', stray: 'x' } });
	assert.equal(url, 'https://connect.composio.dev/link/m');
	assert.deepEqual(fake.created, [{ type: 'use_custom_auth', name: 'Anton · MongoDB', authScheme: 'S2S_OAUTH2', credentials: { client_id: 'mdb_sa_id', client_secret: 'mdb_sa_secret' } }]);
	assert.deepEqual(fake.linkedWith, ['ac_1']);
	assert.equal((await composio.composioView()).accounts.find((each) => each.toolkit === SLUG)?.status, 'pending');

	// Connecting again reuses that config rather than asking for credentials.
	assert.equal((await composio.composioAuthSetup(SLUG)).state, 'custom');
	await composio.beginComposioConnect(SLUG);
	assert.deepEqual(fake.linkedWith, ['ac_1', 'ac_1']);
	assert.equal(fake.created.length, 1);
});

test('an auth config made in Composio’s dashboard is used, ahead of a managed one', async () => {
	const fake = fakeComposio({
		managedSchemes: ['S2S_OAUTH2'],
		configs: [
			{ id: 'ac_managed', status: 'ENABLED', is_composio_managed: true, created_at: '2026-11-01T00:00:00Z', toolkit: { slug: SLUG } },
			{ id: 'ac_off', status: 'DISABLED', is_composio_managed: false, created_at: '2026-11-17T00:00:00Z', toolkit: { slug: SLUG } },
			{ id: 'ac_dashboard', status: 'ENABLED', is_composio_managed: false, created_at: '2026-11-10T00:00:00Z', toolkit: { slug: SLUG } },
		],
	});
	await composio.addComposioToolkit(SLUG);
	assert.equal((await composio.composioAuthSetup(SLUG)).state, 'custom');
	await composio.beginComposioConnect(SLUG);
	assert.deepEqual(fake.linkedWith, ['ac_dashboard']);
	assert.equal(fake.created.length, 0);
});

test('a sign-in that takes no setup fields gets a custom config on Connect, also when Composio has no managed app after all', async () => {
	const fake = fakeComposio({ managedSchemes: ['S2S_OAUTH2'], managedCreate: '404', configFields: [] });
	await composio.addComposioToolkit(SLUG);
	await composio.beginComposioConnect(SLUG);
	assert.deepEqual(
		fake.created.map((each) => each.type),
		['use_composio_managed_auth', 'use_custom_auth'],
	);
	assert.deepEqual(fake.created[1], { type: 'use_custom_auth', name: 'Anton · MongoDB', authScheme: 'S2S_OAUTH2', credentials: {} });
	assert.deepEqual(fake.linkedWith, ['ac_2']);
});

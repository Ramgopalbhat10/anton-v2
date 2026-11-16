import { config } from '../config.ts';
import { announce } from '../core/changes.ts';
import { InvalidInputError, NotFoundError } from '../core/errors.ts';
import { checkDecisionModel, checkDocker, checkGitHub, checkLibsql, checkMcpServer, checkModal, checkS3 } from '../providers/checks.ts';
import { refreshLiveProviders } from '../providers/index.ts';
import { openRouterKey } from '../providers/openrouter/key.ts';
import { bootValue, environmentValue, savedValue, writeSavedEnv } from '../saved-env.ts';
import { withTimeout } from './connections.ts';
import { connectKey, disconnect, gateways, loadGatewayKey, plansSignedIn } from './subscriptions.ts';

/*
 * Settings › Connections as Anton's setup: for each slot it depends on (its
 * models, code host, sandboxes, storage, database, decision model and web
 * search) the providers it can use, the values each needs, and where each
 * value comes from now (saved here, the server's environment, or nowhere).
 * Values are checked before they are kept, and a secret is never sent back,
 * only its last four characters.
 *
 * Models keep their keys where Settings › Subscriptions does; every other
 * value is saved in data/anton.env under its environment variable
 * (`saved-env.ts`). Slots marked `live` apply at once; the rest at the next start.
 */

type Field = { env: string; label: string; secret?: boolean; optional?: boolean; fallback?: string };
type Option = { id: string; label: string; fields: Field[]; set?: Record<string, string>; url?: (values: Values) => string | undefined; check: (values: Values) => Promise<string> };
type Values = Record<string, string>;
type Slot = { id: string; name: string; required: boolean; live: boolean; options: Option[]; current: (value: (env: string) => string) => string | null };

const GITHUB_API = 'https://api.github.com';
const PARALLEL = 'https://search.parallel.ai/mcp';
const DECISION_MODEL = '~typesafe/jev-latest';
const ok = (sentence: string) => async () => sentence;

const SLOTS: Slot[] = [
	{
		id: 'git',
		name: 'Code host',
		required: true,
		live: true,
		options: [
			{
				id: 'github',
				label: 'GitHub',
				fields: [
					{ env: 'ANTON_GITHUB_TOKEN', label: 'Personal access token', secret: true },
					{ env: 'ANTON_GITHUB_API_URL', label: 'API address', optional: true, fallback: GITHUB_API },
				],
				url: (values) => values.ANTON_GITHUB_API_URL,
				check: (values) => checkGitHub(values.ANTON_GITHUB_TOKEN, values.ANTON_GITHUB_API_URL),
			},
		],
		current: () => 'github',
	},
	{
		id: 'sandbox',
		name: 'Sandboxes',
		required: true,
		live: false,
		options: [
			{
				id: 'modal',
				label: 'Modal',
				set: { ANTON_SANDBOX: 'modal' },
				fields: [
					{ env: 'MODAL_TOKEN_ID', label: 'Token ID' },
					{ env: 'MODAL_TOKEN_SECRET', label: 'Token secret', secret: true },
					{ env: 'ANTON_MODAL_APP', label: 'App name', optional: true, fallback: 'anton' },
				],
				url: () => 'https://api.modal.com',
				check: (values) => checkModal(values.MODAL_TOKEN_ID, values.MODAL_TOKEN_SECRET, values.ANTON_MODAL_APP),
			},
			{ id: 'docker', label: 'Docker', set: { ANTON_SANDBOX: 'docker' }, fields: [{ env: 'ANTON_DOCKER_NETWORK', label: 'Network', optional: true }], check: () => checkDocker() },
			{ id: 'local', label: 'This server', set: { ANTON_SANDBOX: 'local' }, fields: [], check: ok('Tasks run in folders under the data directory.') },
		],
		current: (value) => value('ANTON_SANDBOX') || (value('MODAL_TOKEN_ID') ? 'modal' : 'local'),
	},
	{
		id: 'store',
		name: 'Object storage',
		required: true,
		live: false,
		options: [
			{
				id: 's3',
				label: 'S3-compatible',
				set: { ANTON_STORE: 's3' },
				fields: [
					{ env: 'TIGRIS_ENDPOINT', label: 'Endpoint', fallback: 'https://t3.storage.dev' },
					{ env: 'TIGRIS_BUCKET', label: 'Bucket' },
					{ env: 'TIGRIS_ACCESS_KEY_ID', label: 'Access key ID' },
					{ env: 'TIGRIS_SECRET_ACCESS_KEY', label: 'Secret access key', secret: true },
					{ env: 'TIGRIS_REGION', label: 'Region', optional: true, fallback: 'auto' },
				],
				url: (values) => values.TIGRIS_ENDPOINT,
				check: (values) =>
					checkS3({ endpoint: values.TIGRIS_ENDPOINT, bucket: values.TIGRIS_BUCKET, accessKeyId: values.TIGRIS_ACCESS_KEY_ID, secretAccessKey: values.TIGRIS_SECRET_ACCESS_KEY, region: values.TIGRIS_REGION }),
			},
			{ id: 'disk', label: 'This server', set: { ANTON_STORE: 'disk' }, fields: [], check: ok('Files under the data directory on this server.') },
		],
		current: (value) => value('ANTON_STORE') || (value('TIGRIS_SECRET_ACCESS_KEY') ? 's3' : 'disk'),
	},
	{
		id: 'database',
		name: 'Database',
		required: false,
		live: false,
		options: [
			{ id: 'sqlite', label: 'SQLite', set: { TURSO_DATABASE_URL: '', TURSO_AUTH_TOKEN: '' }, fields: [], check: ok('A file on this server.') },
			{
				id: 'turso',
				label: 'Turso',
				fields: [
					{ env: 'TURSO_DATABASE_URL', label: 'Database URL' },
					{ env: 'TURSO_AUTH_TOKEN', label: 'Auth token', secret: true },
				],
				url: (values) => values.TURSO_DATABASE_URL.replace(/^libsql:/, 'https:'),
				check: (values) => checkLibsql(values.TURSO_DATABASE_URL, values.TURSO_AUTH_TOKEN),
			},
		],
		current: (value) => (value('TURSO_DATABASE_URL') && !value('TURSO_DATABASE_URL').startsWith('file:') ? 'turso' : 'sqlite'),
	},
	{
		id: 'decisions',
		name: 'Decision model',
		required: false,
		live: true,
		options: [
			{
				id: 'openrouter',
				label: 'OpenRouter',
				fields: [{ env: 'ANTON_DECISION_MODEL', label: 'Model', fallback: DECISION_MODEL }],
				url: () => config.openrouter.apiUrl,
				check: async (values) => {
					if (!openRouterKey()) throw new Error('Needs the OpenRouter key from Models first.');
					return checkDecisionModel(config.openrouter.apiUrl, openRouterKey, values.ANTON_DECISION_MODEL);
				},
			},
			{ id: 'off', label: 'Off', set: { ANTON_DECISION_MODEL: 'off' }, fields: [], check: ok('Off. Every comment wakes the agent and every pull request is reviewed.') },
		],
		current: (value) => (value('ANTON_DECISION_MODEL') === 'off' ? 'off' : 'openrouter'),
	},
	{
		id: 'web',
		name: 'Web search',
		required: false,
		live: true,
		options: [
			{
				id: 'parallel',
				label: 'Parallel',
				set: { ANTON_WEB_MCP_URL: PARALLEL },
				fields: [{ env: 'PARALLEL_API_KEY', label: 'API key', secret: true, optional: true }],
				url: () => PARALLEL,
				check: (values) => checkMcpServer(PARALLEL, values.PARALLEL_API_KEY),
			},
			{
				id: 'mcp',
				label: 'Other server',
				fields: [
					{ env: 'ANTON_WEB_MCP_URL', label: 'Server URL' },
					{ env: 'PARALLEL_API_KEY', label: 'API key', secret: true, optional: true },
				],
				url: (values) => values.ANTON_WEB_MCP_URL,
				check: (values) => checkMcpServer(values.ANTON_WEB_MCP_URL, values.PARALLEL_API_KEY),
			},
			{ id: 'off', label: 'Off', set: { ANTON_WEB_MCP_URL: 'off' }, fields: [], check: ok('Off. The agent has no web_search or web_fetch.') },
		],
		current: (value) => {
			const url = value('ANTON_WEB_MCP_URL') || PARALLEL;
			return url === 'off' ? 'off' : url === PARALLEL ? 'parallel' : 'mcp';
		},
	},
];

/** A field as the page sees it: where its value comes from, and the value itself unless it is a secret, whose last four characters stand in. */
export type FieldView = { env: string; label: string; secret: boolean; optional: boolean; fallback: string | null; source: 'saved' | 'environment' | null; value: string | null; hint: string | null };
export type OptionView = { id: string; label: string; fields: FieldView[] };
/** `provider` is the one the next start uses; `restart` says it or a value differs from what runs now; `saved` that something was saved here, which Remove takes away. */
export type SlotView = { id: string; name: string; required: boolean; live: boolean; provider: string | null; restart: boolean; saved: boolean; options: OptionView[] };
export type SetupView = { slots: SlotView[]; plans: string[]; canRunTasks: boolean };

/** A name's value as the next start reads it: saved here, else the environment's. */
const next = (env: string): string => savedValue(env) ?? environmentValue(env);
const namesOf = (slot: Slot): string[] => [...new Set(slot.options.flatMap((option) => [...Object.keys(option.set ?? {}), ...option.fields.map((field) => field.env)]))];
const hint = (value: string) => (value.length > 8 ? value.slice(-4) : null);

/**
 * Whether the next start runs a slot differently from now: another provider, or another value for one of its
 * fields (defaults included), so an unset variable and the value it defaults to read as the same.
 */
function waitsForRestart(slot: Slot): boolean {
	if (slot.live) return false;
	const now = slot.current(bootValue);
	const then = slot.current(next);
	if (now !== then) return true;
	const option = slot.options.find((candidate) => candidate.id === then);
	return (option?.fields ?? []).some((field) => (next(field.env) || field.fallback || '') !== (bootValue(field.env) || field.fallback || ''));
}

function fieldView(field: Field): FieldView {
	const saved = savedValue(field.env);
	const source = saved ? 'saved' : environmentValue(field.env) ? 'environment' : null;
	const value = next(field.env);
	return {
		env: field.env,
		label: field.label,
		secret: Boolean(field.secret),
		optional: Boolean(field.optional),
		fallback: field.fallback ?? null,
		source,
		value: field.secret || !value ? null : value,
		hint: field.secret && value ? hint(value) : null,
	};
}

/** The Models slot: the gateways billed per token, each keyed where Settings › Subscriptions keeps them. */
function modelsView(): SlotView {
	const list = gateways();
	const keyed = list.find((gateway) => gateway.key.source());
	return {
		id: 'models',
		name: 'Models',
		required: true,
		live: true,
		provider: keyed?.account.id ?? null,
		restart: false,
		saved: list.some((gateway) => gateway.key.source() === 'settings'),
		options: list.map((gateway) => {
			const key = gateway.key.get();
			const source = gateway.key.source();
			return {
				id: gateway.account.id,
				label: gateway.account.name,
				fields: [
					{
						env: gateway.account.id === 'openrouter' ? 'OPENROUTER_API_KEY' : 'AI_GATEWAY_API_KEY',
						label: 'API key',
						secret: true,
						optional: false,
						fallback: null,
						source: source === 'settings' ? 'saved' : source,
						value: null,
						hint: key ? hint(key) : null,
					},
				],
			};
		}),
	};
}

function slotView(slot: Slot): SlotView {
	return {
		id: slot.id,
		name: slot.name,
		required: slot.required,
		live: slot.live,
		provider: slot.current(next),
		restart: waitsForRestart(slot),
		saved: namesOf(slot).some((name) => savedValue(name) !== undefined),
		options: slot.options.map((option) => ({ id: option.id, label: option.label, fields: option.fields.map(fieldView) })),
	};
}

export async function setupView(): Promise<SetupView> {
	await loadGatewayKey();
	const plans = await plansSignedIn();
	const models = modelsView();
	return { slots: [models, ...SLOTS.map(slotView)], plans, canRunTasks: Boolean(models.provider) || plans.length > 0 };
}

function slotOf(id: string): Slot {
	const slot = SLOTS.find((candidate) => candidate.id === id);
	if (!slot) throw new NotFoundError(`No connection named "${id}"`);
	return slot;
}

function optionOf(slot: Slot, id: string): Option {
	const option = slot.options.find((candidate) => candidate.id === id);
	if (!option) throw new InvalidInputError(`${slot.name} has no provider "${id}"`);
	return option;
}

/** The values a check runs with: what was typed, else what the next start would read, else the field's default. */
function candidate(option: Option, typed: Values): Values {
	const values: Values = {};
	const missing: string[] = [];
	for (const field of option.fields) {
		const value = typed[field.env]?.trim() || next(field.env) || field.fallback || '';
		if (!value && !field.optional) missing.push(field.label);
		values[field.env] = value;
	}
	if (missing.length) throw new InvalidInputError(`${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} needed.`);
	return values;
}

/** Why a check failed, as a sentence the page shows. */
const failure = (error: unknown) => new InvalidInputError(error instanceof Error ? error.message : String(error));

/** Checks a provider with these values, keeping none of them; answers what it found, or throws with why it failed. */
export async function testSlot(slotId: string, provider: string, typed: Values): Promise<{ detail: string }> {
	if (slotId === 'models') return { detail: await testGateway(provider, typed) };
	const option = optionOf(slotOf(slotId), provider);
	const values = candidate(option, typed);
	try {
		return { detail: await withTimeout(option.check(values), option.url?.(values)) };
	} catch (error) {
		throw failure(error);
	}
}

async function testGateway(id: string, typed: Values): Promise<string> {
	const gateway = gateways().find((candidate) => candidate.account.id === id);
	if (!gateway) throw new InvalidInputError(`Models has no provider "${id}"`);
	const key = Object.values(typed)[0]?.trim() || gateway.key.get();
	if (!key) throw new InvalidInputError('API key is needed.');
	try {
		await withTimeout(gateway.account.check(key), id === 'vercel' ? config.vercel.apiUrl : config.openrouter.apiUrl);
	} catch (error) {
		throw failure(error);
	}
	return `${gateway.account.name} accepted the key.`;
}

/**
 * Checks, then keeps: the provider's choice and each value typed (a blank one keeps what is there). Answers
 * what the check found and whether it waits for a restart.
 */
export async function saveSlot(slotId: string, provider: string, typed: Values): Promise<{ detail: string; restart: boolean }> {
	if (slotId === 'models') {
		const key = Object.values(typed)[0]?.trim();
		if (!key) throw new InvalidInputError('Paste a key to save it here.');
		await connectKey(provider, key).catch((error: unknown) => {
			throw failure(error);
		});
		announce({ kind: 'setup' });
		return { detail: await testGateway(provider, {}), restart: false };
	}
	const slot = slotOf(slotId);
	const option = optionOf(slot, provider);
	const { detail } = await testSlot(slotId, provider, typed);
	const changes: Record<string, string | null> = { ...(option.set ?? {}) };
	for (const field of option.fields) {
		const value = typed[field.env]?.trim();
		if (value) changes[field.env] = value;
	}
	writeSavedEnv(changes, slot.live);
	if (slot.live) refreshLiveProviders();
	announce({ kind: 'setup' });
	return { detail, restart: waitsForRestart(slot) };
}

/** Forgets what was saved for a slot (a gateway's key, for Models), so the environment's values apply again. */
export async function clearSlot(slotId: string, provider: string): Promise<void> {
	if (slotId === 'models') {
		await disconnect(provider);
		announce({ kind: 'setup' });
		return;
	}
	const slot = slotOf(slotId);
	writeSavedEnv(Object.fromEntries(namesOf(slot).filter((name) => savedValue(name) !== undefined).map((name) => [name, null])), slot.live);
	if (slot.live) refreshLiveProviders();
	announce({ kind: 'setup' });
}

import { announce } from '../core/changes.ts';
import { ConflictError, InvalidInputError, NotFoundError } from '../core/errors.ts';
import type { AppsConnector, AppsToolkit, AppsTool } from '../core/ports.ts';
import { deleteComposioAccount, getComposioAccount, type ComposioAccountRow, listComposioAccounts, markComposioPending, markComposioStatus, resetComposioConnection, saveComposioAccount, setComposioEnabled } from '../db/composio.ts';
import { getSetting, setSetting } from '../db/settings.ts';
import { getProviders } from '../providers/index.ts';
import { composioKeySlot } from '../providers/composio/key.ts';
import { logProblem } from './log.ts';

/**
 * Apps connected through an apps platform (Composio, behind the AppsConnector
 * port): one row per toolkit, its sign-in a hosted connect link the user
 * approves on the provider's own page. The platform holds the tokens and runs
 * the tools; Anton keeps only the connected account's id and status, so they
 * never reach a sandbox, a view or the model. The project API key comes from
 * Settings or COMPOSIO_API_KEY.
 */

/** Whose connections these are inside the platform's project: one per Anton install. */
const USER_ID = 'anton';
/** A pending sign-in's status is read from the platform at most this often. */
const REFRESH_MS = 15_000;
const refreshedAt = new Map<string, number>();

const KEY_SETTING = 'composio.key';

/** The apps platform port, when this install has one (tests may not). */
const apps = (): AppsConnector | null => getProviders().apps ?? null;

/** Whether a project key is about to be used, and from where — what Settings › Connectors shows. */
export function composioKeySource(): 'settings' | 'environment' | null {
	return apps() ? composioKeySlot.source() : null;
}

/** Reads the key pasted in Settings into the slot at startup, so calls have it before any page asks. */
export async function loadComposioKey(): Promise<void> {
	composioKeySlot.set(await getSetting<string | null>(KEY_SETTING, null));
}

async function needApps(): Promise<AppsConnector> {
	const platform = apps();
	if (!platform || !composioKeySlot.get()) throw new ConflictError('Add your Composio API key first: Settings › Connectors, under Composio.');
	return platform;
}

/** Saves the project key pasted in Settings; an empty one removes it. It is checked with the platform before it is kept. */
export async function setComposioKey(key: string | null): Promise<ComposioView> {
	const platform = apps();
	const trimmed = key?.trim() ?? '';
	if (trimmed) {
		if (!platform) throw new ConflictError('This install has no apps platform.');
		try {
			await platform.checkKey(trimmed);
		} catch (error) {
			throw new InvalidInputError(`Composio refused that key: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	const saved = trimmed || null;
	composioKeySlot.set(saved);
	await setSetting(KEY_SETTING, saved);
	announce({ kind: 'connectors' });
	return composioView();
}

const ACTIVE = new Set(['ACTIVE']);
const FAILED = new Set(['FAILED', 'EXPIRED', 'INACTIVE', 'REVOKED']);

function accountState(status: string): ComposioAccountRow['status'] {
	if (ACTIVE.has(status)) return 'active';
	if (FAILED.has(status)) return 'failed';
	return status ? 'pending' : 'none';
}

/** Reads the connected account's live status into the row, at most once per REFRESH_MS per toolkit. */
async function refreshRow(row: ComposioAccountRow, platform: AppsConnector, force = false): Promise<ComposioAccountRow> {
	if (!row.accountId || row.status === 'none') return row;
	const last = refreshedAt.get(row.toolkit) ?? 0;
	if (!force && Date.now() - last < REFRESH_MS) return row;
	refreshedAt.set(row.toolkit, Date.now());
	try {
		const account = await platform.connectedAccount(row.accountId);
		if (!account) {
			await resetComposioConnection(row.toolkit);
			return { ...row, accountId: null, status: 'none', statusReason: null, connectedAt: null };
		}
		const status = accountState(account.status);
		const connectedAt = status === 'active' ? (row.connectedAt ?? new Date().toISOString()) : row.connectedAt;
		await markComposioStatus(row.toolkit, status, account.statusReason, account.id, connectedAt ?? undefined);
		return { ...row, status, statusReason: account.statusReason, connectedAt };
	} catch (error) {
		logProblem('warn', `Could not read the ${row.name} connection's status`, error);
		return row;
	}
}

export type ComposioAccountView = Omit<ComposioAccountRow, 'accountId' | 'updatedAt'> & { account: string | null };
export type ComposioView = { configured: boolean; keyFromEnv: boolean; accounts: ComposioAccountView[] };

const present = (row: ComposioAccountRow): ComposioAccountView => {
	const { accountId: _id, updatedAt: _at, ...rest } = row;
	return { ...rest, account: row.status === 'active' ? (_id ?? null) : null };
};

/** What Settings › Connectors shows: whether a key is set, and each added app with its live status. */
export async function composioView(): Promise<ComposioView> {
	const platform = apps();
	const source = composioKeySource();
	const rows = await listComposioAccounts();
	if (!platform || !source) return { configured: false, keyFromEnv: false, accounts: rows.map(present) };
	const live = await Promise.all(rows.map((row) => (row.status === 'pending' || row.status === 'failed' ? refreshRow(row, platform) : row)));
	return { configured: true, keyFromEnv: source === 'environment', accounts: live.map(present) };
}

/** Forgets cached state (tests). */
export function resetComposioForTests(): void {
	composioKeySlot.set(null);
	refreshedAt.clear();
	toolLists.clear();
}

/** Adds an app from the catalog; its details are read from the platform so the row always matches the toolkit. */
export async function addComposioToolkit(toolkit: string): Promise<ComposioView> {
	const platform = await needApps();
	const slug = toolkit.trim().toLowerCase();
	if (!/^[a-z0-9_-]{1,64}$/.test(slug)) throw new InvalidInputError('That is not a toolkit name.');
	if (await getComposioAccount(slug)) throw new ConflictError(`${slug} is already added`);
	const found = await platform.toolkits({ slug });
	const meta = found[0];
	if (!meta) throw new NotFoundError(`Composio has no toolkit named ${slug}`);
	await saveComposioAccount({
		toolkit: meta.slug,
		name: meta.name,
		description: meta.description,
		category: meta.categories[0] ?? '',
		appUrl: meta.appUrl ?? '',
		logo: meta.logo,
	});
	announce({ kind: 'connectors' });
	return composioView();
}

export async function setComposioAccountEnabled(toolkit: string, enabled: boolean): Promise<ComposioView> {
	if (!(await getComposioAccount(toolkit))) throw new NotFoundError(`No app is named ${toolkit}`);
	await setComposioEnabled(toolkit, enabled);
	announce({ kind: 'connectors' });
	return composioView();
}

/**
 * Starts a sign-in: the Composio-managed auth config for the toolkit (made on
 * first use), stale unfinished accounts cleared, and a Connect Link whose
 * page the user approves on the provider's own site.
 */
export async function beginComposioConnect(toolkit: string, callbackUrl?: string): Promise<{ url: string }> {
	const platform = await needApps();
	const row = await getComposioAccount(toolkit);
	if (!row) throw new NotFoundError(`No app is named ${toolkit}`);
	const authConfigId = await platform.managedAuthConfig(toolkit);
	// Unfinished accounts from earlier attempts would pile up; only a live one is kept.
	const existing = await platform.connectedAccounts({ userId: USER_ID, toolkits: [toolkit] });
	for (const account of existing) {
		if (account.id !== row.accountId && accountState(account.status) !== 'active') await platform.deleteConnectedAccount(account.id);
	}
	const link = await platform.connectLink({ authConfigId, userId: USER_ID, callbackUrl });
	await markComposioPending(toolkit, link.accountId);
	// The account this replaces would otherwise stay live at the platform with no row pointing at it.
	const previous = row.accountId;
	if (previous && previous !== link.accountId) await platform.revokeConnectedAccount(previous).catch((error: unknown) => logProblem('warn', `Could not revoke the old ${row.name} connection`, error));
	announce({ kind: 'connectors' });
	return { url: link.redirectUrl };
}

/** Reads the account's status now, for the page that is waiting on the sign-in. */
export async function refreshComposioAccount(toolkit: string): Promise<ComposioView> {
	const platform = apps();
	const row = await getComposioAccount(toolkit);
	if (!platform || !composioKeySource() || !row) return composioView();
	await refreshRow(row, platform, true);
	return composioView();
}

/** Forgets the connection at the platform and here; the app stays added, ready to connect again. */
export async function disconnectComposioAccount(toolkit: string): Promise<ComposioView> {
	const platform = await needApps();
	const row = await getComposioAccount(toolkit);
	if (!row) throw new NotFoundError(`No app is named ${toolkit}`);
	if (row.accountId) await platform.revokeConnectedAccount(row.accountId);
	await resetComposioConnection(toolkit);
	announce({ kind: 'connectors' });
	return composioView();
}

/** Removes the app altogether: its connection first, then its row. */
export async function removeComposioAccount(toolkit: string): Promise<ComposioView> {
	const row = await getComposioAccount(toolkit);
	if (!row) throw new NotFoundError(`No app is named ${toolkit}`);
	const platform = apps();
	if (platform && composioKeySource() && row.accountId) await platform.revokeConnectedAccount(row.accountId).catch((error: unknown) => logProblem('warn', `Could not revoke the ${row.name} connection`, error));
	await deleteComposioAccount(toolkit);
	announce({ kind: 'connectors' });
	return composioView();
}

/** Apps in Composio's catalog matching a search, for the Connectors page's search box; fewer than two letters finds nothing. */
export async function searchComposioToolkits(search: string, limit = 20): Promise<AppsToolkit[]> {
	const platform = await needApps();
	const query = search.trim();
	if (query.length < 2) return [];
	return platform.toolkits({ search: query, limit });
}

/** One catalog app by its toolkit slug, for the page that adds it; null when Composio has none by that name. */
export async function composioToolkit(toolkit: string): Promise<AppsToolkit | null> {
	const platform = await needApps();
	return (await platform.toolkits({ slug: toolkit }))[0] ?? null;
}

/* ---- what the agent reaches ---- */

export type ComposioConnectorTool = AppsTool & { toolkit: string };

const TOOL_LIST_MS = 10 * 60_000;
const toolLists = new Map<string, { at: number; tools: Promise<ComposioConnectorTool[]> }>();

/** A toolkit's tools as the agent may call them, cached for a while; empty when the app is not connected. */
export async function composioTools(toolkit: string): Promise<ComposioConnectorTool[]> {
	const platform = apps();
	const row = await getComposioAccount(toolkit);
	if (!platform || !composioKeySource() || !row || row.status !== 'active') return [];
	const known = toolLists.get(toolkit);
	if (known && Date.now() - known.at < TOOL_LIST_MS) return known.tools;
	const listing = { at: Date.now(), tools: platform.tools(toolkit).then((tools) => tools.map((tool) => ({ ...tool, toolkit }))) };
	toolLists.set(toolkit, listing);
	listing.tools.catch(() => toolLists.delete(toolkit));
	return listing.tools;
}

/** `composio__<toolkit>__<action>`: the name connector_tools gives and connector_call takes. */
export function composioToolName(toolkit: string, slug: string): string {
	const prefix = `${toolkit.toUpperCase()}_`;
	const action = slug.toUpperCase().startsWith(prefix) ? slug.slice(prefix.length) : slug;
	return `composio__${toolkit}__${action.toLowerCase()}`;
}

/**
 * Whether a tool call waits on the user's Run before it goes. Composio's
 * catalog does not mark read and write apart, so the action's name does:
 * a write-looking word anywhere asks first; otherwise the action is a read
 * when it starts or ends with a read verb (`FETCH_…`, `…_LIST`), and anything
 * unrecognized asks too.
 */
const WRITES = /(^|_)(SEND|POST|CREATE|UPDATE|DELETE|REMOVE|ADD|PUBLISH|WRITE|PATCH|PUT|MERGE|APPROVE|REJECT|CLOSE|ARCHIVE|UNARCHIVE|MOVE|ASSIGN|UNASSIGN|INVITE|SHARE|UNSHARE|UPLOAD|EXECUTE|RUN|TRIGGER|SUBMIT|CANCEL|REVOKE|GRANT|TRANSFER|PAY|CHARGE|REFUND|DEPLOY|RESTART|REBOOT|STOP|START|ENABLE|DISABLE|CONNECT|DISCONNECT|FOLLOW|UNFOLLOW|LIKE|UNLIKE|COMMENT|REACT|NOTIFY|ALERT|BOOK|SCHEDULE|RESERVE|ORDER|PURCHASE|BUY|SUBSCRIBE|UNSUBSCRIBE|MODIFY|EDIT|RENAME|COPY|DUPLICATE|IMPORT|EXPORT|SYNC|GENERATE|COMPOSE|REPLY|FORWARD|DRAFT|ATTACH|DETACH|LINK|UNLINK|MARK|FLAG|PIN|UNPIN|MUTE|UNMUTE|BLOCK|UNBLOCK|VERIFY|CONFIRM|COMPLETE|RESOLVE|REOPEN|ESCALATE|SPLIT|CLONE|FORK|COMMIT|PUSH|TAG|RELEASE|ROLLBACK|MIGRATE|SEED|PURGE|WIPE|TRUNCATE|INSERT|UPSERT|REPLACE|SWAP|ROTATE|REGENERATE|ACTIVATE|DEACTIVATE|REGISTER|DEREGISTER|ENROLL|UNENROLL|AUTHORIZE|DEAUTHORIZE|AUTHENTICATE)(_|$)/;
const READS = new Set(['GET', 'LIST', 'SEARCH', 'FETCH', 'READ', 'FIND', 'RETRIEVE', 'COUNT', 'CHECK', 'LOOKUP', 'QUERY', 'VIEW', 'PREVIEW', 'DESCRIBE', 'SHOW', 'DOWNLOAD', 'HEAD', 'INSPECT']);

export function composioToolNeedsApproval(toolkit: string, slug: string): boolean {
	const prefix = `${toolkit.toUpperCase()}_`;
	const action = (slug.toUpperCase().startsWith(prefix) ? slug.slice(prefix.length) : slug).toUpperCase();
	if (WRITES.test(action)) return true;
	const words = action.split('_');
	return !READS.has(words[0]) && !READS.has(words[words.length - 1]);
}

/** Runs a toolkit's tool on the user's connected account; the result's data as JSON text. */
export async function executeComposioTool(toolkit: string, slug: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
	const platform = await needApps();
	const row = await getComposioAccount(toolkit);
	if (!row || row.status !== 'active' || !row.accountId) throw new ConflictError(`${row?.name ?? toolkit} is not connected. Connect it in Settings › Connectors.`);
	const result = await platform.runTool(slug, { userId: USER_ID, connectedAccountId: row.accountId, args }, signal);
	if (!result.successful) throw new Error(result.error || `${slug} failed (log ${result.logId ?? 'unknown'})`);
	return result.data === undefined || result.data === null ? '(No result.)' : typeof result.data === 'string' ? result.data : JSON.stringify(result.data, null, 2);
}

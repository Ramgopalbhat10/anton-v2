import { announce } from '../core/changes.ts';
import { ConflictError, InvalidInputError, NotFoundError } from '../core/errors.ts';
import type { AccountSignIn, Mailbox, OAuthClient, SubscriptionCredential, SubscriptionLogin } from '../core/ports.ts';
import { config } from '../config.ts';
import { getSetting, setSetting } from '../db/settings.ts';
import { getProviders } from '../providers/index.ts';
import { logProblem } from './log.ts';

/**
 * Accounts the agent's tools reach (Google) and the services on them (Gmail),
 * connected once in Settings › Connectors for every task. The sign-in is kept
 * here, on Anton's server, and renewed here: its tokens never reach a
 * sandbox, a view or the model. Google signs in on your own OAuth client
 * (pasted in Settings, else GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET), since
 * a self-hosted Anton is no verified app of Google's.
 */

/** What Anton keeps of an account. `client` is the one pasted in Settings; null falls back to the environment. */
type StoredAccount = { client: OAuthClient | null; credential: SubscriptionCredential | null; connectedAt: string | null; problem: string | null };
/** What a mailbox may do for the agent. Drafts and sending also need the sign-in to have allowed them. */
export type MailboxOptions = { enabled: boolean; draft: boolean; send: boolean };
/** How much a connect asks Google for. */
export type MailAccess = 'read' | 'draft';

const ACCOUNT_DEFAULTS: StoredAccount = { client: null, credential: null, connectedAt: null, problem: null };
const MAILBOX_DEFAULTS: MailboxOptions = { enabled: true, draft: true, send: true };
/** A token this close to expiring is renewed first, so a call the agent makes with it does not fail halfway. */
const RENEW_EARLY_MS = 2 * 60_000;
const LOGIN_TTL_MS = 10 * 60_000;
/** Where Google sends the browser back, on Anton's own address. */
export const CALLBACK_PATH = (account: string) => `/api/connectors/${account}/callback`;

const accountKey = (id: string) => `account.${id}`;
const mailboxKey = (id: string) => `connector.${id}`;

export const accountSignIns = (): AccountSignIn[] => getProviders().accounts ?? [];
export const mailboxes = (): Mailbox[] => getProviders().mailboxes ?? [];

function signInById(id: string): AccountSignIn {
	const found = accountSignIns().find((account) => account.id === id);
	if (!found) throw new NotFoundError(`No account is named ${id}`);
	return found;
}

export function mailboxById(id: string): Mailbox {
	const found = mailboxes().find((mailbox) => mailbox.id === id);
	if (!found) throw new NotFoundError(`No connector is named ${id}`);
	return found;
}

/** Each account's stored state, read once and written through, so the agent's lookups stay cheap. */
const accounts = new Map<string, StoredAccount>();

async function storedAccount(id: string): Promise<StoredAccount> {
	const cached = accounts.get(id);
	if (cached) return cached;
	const loaded = { ...ACCOUNT_DEFAULTS, ...(await getSetting<Partial<StoredAccount>>(accountKey(id), {})) };
	accounts.set(id, accounts.get(id) ?? loaded);
	return accounts.get(id)!;
}

async function saveAccount(id: string, patch: Partial<StoredAccount>): Promise<StoredAccount> {
	const next = { ...(await storedAccount(id)), ...patch };
	accounts.set(id, next);
	await setSetting(accountKey(id), next);
	announce({ kind: 'connectors' });
	return next;
}

async function mailboxOptions(id: string): Promise<MailboxOptions> {
	return { ...MAILBOX_DEFAULTS, ...(await getSetting<Partial<MailboxOptions>>(mailboxKey(id), {})) };
}

/** The OAuth client to sign in with: the one pasted in Settings, else the environment's; null when neither is set. */
async function clientFor(id: string): Promise<OAuthClient | null> {
	const { client } = await storedAccount(id);
	if (client) return client;
	if (id === 'google' && config.google.clientId && config.google.clientSecret) return { clientId: config.google.clientId, clientSecret: config.google.clientSecret };
	return null;
}

/** Saves the OAuth client pasted in Settings. A secret left out keeps the stored one; an empty client id removes the client. */
export async function setAccountClient(id: string, input: { clientId: string; clientSecret?: string | null }): Promise<ConnectorsView> {
	signInById(id);
	const clientId = input.clientId.trim();
	const current = (await storedAccount(id)).client;
	if (!clientId) {
		await saveAccount(id, { client: null });
		return connectorsView();
	}
	const clientSecret = input.clientSecret?.trim() || (current?.clientId === clientId ? current.clientSecret : '');
	if (!clientSecret) throw new InvalidInputError('Paste the client secret too');
	// A sign-in made on another client cannot be renewed with this one.
	const changed = current && current.clientId !== clientId;
	await saveAccount(id, { client: { clientId, clientSecret }, ...(changed ? { credential: null, connectedAt: null, problem: null } : {}) });
	return connectorsView();
}

type Attempt = { login: SubscriptionLogin; mailbox: string; timer: ReturnType<typeof setTimeout>; finishing?: Promise<void> };
/** One sign-in at a time per account, held only in memory: a restart means connecting again. */
const attempts = new Map<string, Attempt>();

function endAttempt(id: string) {
	const attempt = attempts.get(id);
	if (attempt) clearTimeout(attempt.timer);
	attempts.delete(id);
}

/** Anton's address as the browser reaches it, which is where Google must send it back; only its origin is kept. */
export function appOrigin(origin: string): string {
	if (!URL.canParse(origin)) throw new InvalidInputError('Send the page’s origin, such as https://anton.example.com');
	const url = new URL(origin);
	if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new InvalidInputError('Anton’s address must be http or https');
	return url.origin;
}

/** The address to add to the OAuth client in Google Cloud, for Anton at `origin`. */
export const redirectUriFor = (account: string, origin: string) => `${appOrigin(origin)}${CALLBACK_PATH(account)}`;

/** Starts connecting a mailbox: the address of the vendor's consent page, which comes back to Anton's callback. */
export async function beginConnect(mailboxId: string, origin: string, access: MailAccess): Promise<{ url: string }> {
	const mailbox = mailboxById(mailboxId);
	const signIn = signInById(mailbox.account);
	const client = await clientFor(signIn.id);
	if (!client) throw new ConflictError(`Add your ${signIn.name} OAuth client first`);
	const current = await storedAccount(signIn.id);
	const scopes = [...mailbox.scopes.read, ...(access === 'draft' ? mailbox.scopes.draft : [])];
	endAttempt(signIn.id);
	const login = signIn.startLogin(client, scopes, redirectUriFor(signIn.id, origin), current.credential?.email);
	const timer = setTimeout(() => endAttempt(signIn.id), LOGIN_TTL_MS);
	timer.unref?.();
	attempts.set(signIn.id, { login, mailbox: mailbox.id, timer });
	return { url: login.url };
}

/** Finishes a sign-in with the query Google sent the browser back with; the mailbox it was for is turned on. */
export async function finishConnect(accountId: string, query: string): Promise<{ mailbox: string; email: string | null }> {
	const signIn = signInById(accountId);
	const attempt = attempts.get(accountId);
	if (!attempt) throw new ConflictError('No sign-in is waiting. Connect again from Settings › Connectors.');
	attempt.finishing ??= attempt.login
		.complete(`${attempt.login.redirectUri}?${query.replace(/^\?/, '')}`)
		.then(async (credential) => {
			if (attempts.get(accountId) === attempt) endAttempt(accountId);
			await saveAccount(signIn.id, { credential, connectedAt: new Date().toISOString(), problem: null });
			await setSetting(mailboxKey(attempt.mailbox), { ...(await mailboxOptions(attempt.mailbox)), enabled: true });
		})
		.catch((error: unknown) => {
			attempt.finishing = undefined;
			throw error instanceof Error ? new InvalidInputError(error.message) : error;
		});
	await attempt.finishing;
	return { mailbox: attempt.mailbox, email: (await storedAccount(accountId)).credential?.email ?? null };
}

/** Forgets the sign-in, telling the vendor first so Anton leaves the account's connected apps. */
export async function disconnectAccount(id: string): Promise<ConnectorsView> {
	const signIn = signInById(id);
	const { credential } = await storedAccount(id);
	endAttempt(id);
	if (credential) await signIn.revoke(credential).catch((error: unknown) => logProblem('warn', `Could not revoke the ${signIn.name} sign-in`, error));
	await saveAccount(id, { credential: null, connectedAt: null, problem: null });
	return connectorsView();
}

export async function setMailboxOptions(id: string, options: MailboxOptions): Promise<ConnectorsView> {
	mailboxById(id);
	await setSetting(mailboxKey(id), options);
	announce({ kind: 'connectors' });
	return connectorsView();
}

/** The account's sign-in no longer works: what the agent and Settings say about it. */
export class SignInNeeded extends Error {}

const renewing = new Map<string, Promise<string>>();
const isRejected = (message: string) => /\((400|401)\)|invalid_grant/.test(message);

/** A working access token for the account, renewed when it is about to expire; concurrent calls share one renewal. */
export async function accountToken(id: string): Promise<string> {
	const signIn = signInById(id);
	const { credential, problem } = await storedAccount(id);
	if (!credential) throw new SignInNeeded(`${signIn.name} is not connected. Connect it in Settings › Connectors.`);
	if (credential.expiresAt - RENEW_EARLY_MS > Date.now()) return credential.access;
	if (problem) throw new SignInNeeded(problem);
	let pending = renewing.get(id);
	if (!pending) {
		pending = (async () => {
			const client = await clientFor(id);
			if (!client) throw new SignInNeeded(`The ${signIn.name} OAuth client was removed. Add it again in Settings › Connectors.`);
			try {
				const next = await signIn.refresh(client, credential);
				await saveAccount(id, { credential: next, problem: null });
				return next.access;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (!isRejected(message)) throw new Error(`Could not renew the ${signIn.name} sign-in: ${message}`);
				const note = `${signIn.name} no longer accepts Anton’s sign-in. Connect it again in Settings › Connectors.`;
				await saveAccount(id, { problem: note });
				throw new SignInNeeded(note);
			}
		})().finally(() => renewing.delete(id));
		renewing.set(id, pending);
	}
	return pending;
}

/** What the agent may do in a mailbox now: null when it is off or its account is not connected. */
export type MailboxAccess = { read: true; draft: boolean; send: boolean };

export async function mailboxAccess(id: string): Promise<MailboxAccess | null> {
	const mailbox = mailboxById(id);
	const [options, account] = await Promise.all([mailboxOptions(id), storedAccount(mailbox.account)]);
	if (!options.enabled || !account.credential) return null;
	const granted = (scopes: string[]) => scopes.every((scope) => account.credential!.scopes.includes(scope));
	if (!granted(mailbox.scopes.read)) return null;
	const drafts = granted(mailbox.scopes.draft);
	return { read: true, draft: options.draft && drafts, send: options.send && drafts };
}

export type AccountView = {
	id: string;
	name: string;
	/** The OAuth client's id, never its secret; `fromEnv` when it comes from the environment. */
	client: { clientId: string; fromEnv: boolean } | null;
	email: string | null;
	connectedAt: string | null;
	scopes: string[];
	problem: string | null;
	callbackPath: string;
};

export type MailboxView = {
	id: string;
	name: string;
	account: string;
	options: MailboxOptions;
	/** Whether the sign-in allowed drafts and sending. */
	canDraft: boolean;
	access: MailboxAccess | null;
};

export type ConnectorsView = { accounts: AccountView[]; mailboxes: MailboxView[] };

export async function connectorsView(): Promise<ConnectorsView> {
	const accountViews = await Promise.all(
		accountSignIns().map(async (signIn): Promise<AccountView> => {
			const stored = await storedAccount(signIn.id);
			const client = await clientFor(signIn.id);
			return {
				id: signIn.id,
				name: signIn.name,
				client: client ? { clientId: client.clientId, fromEnv: !stored.client } : null,
				email: stored.credential?.email ?? null,
				connectedAt: stored.credential ? stored.connectedAt : null,
				scopes: stored.credential?.scopes ?? [],
				problem: stored.credential ? stored.problem : null,
				callbackPath: CALLBACK_PATH(signIn.id),
			};
		}),
	);
	const mailboxViews = await Promise.all(
		mailboxes().map(async (mailbox): Promise<MailboxView> => {
			const scopes = accountViews.find((account) => account.id === mailbox.account)?.scopes ?? [];
			return {
				id: mailbox.id,
				name: mailbox.name,
				account: mailbox.account,
				options: await mailboxOptions(mailbox.id),
				canDraft: mailbox.scopes.draft.every((scope) => scopes.includes(scope)),
				access: await mailboxAccess(mailbox.id),
			};
		}),
	);
	return { accounts: accountViews, mailboxes: mailboxViews };
}

/** For tests: forget what is cached in memory. */
export function resetConnectorsForTests(): void {
	accounts.clear();
	renewing.clear();
	for (const id of [...attempts.keys()]) endAttempt(id);
}

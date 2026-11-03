import { createHash, randomUUID } from 'node:crypto';
import { announce } from '../core/changes.ts';
import { BrokerError, ConflictError, InvalidInputError, NotFoundError } from '../core/errors.ts';
import type { Broker, BrokerCredentialField, BrokerFetch, BrokerOrder, BrokerRead, BrokerSession } from '../core/ports.ts';
import { getSetting, setSetting } from '../db/settings.ts';
import {
	getOrderApproval,
	insertOrderApproval,
	listOrderApprovals,
	moveOrderApproval,
	type OrderAction,
	type OrderApproval,
	type OrderApprovalState,
	ordersPlacedSince,
} from '../db/order-approvals.ts';
import { brokerFetch as directFetch, proxyLabel, proxyParts } from '../providers/broker-fetch.ts';
import { getProviders } from '../providers/index.ts';

/*
 * Trading through a broker (Settings › Trading). Every call is made here, on
 * Anton's server, with the sign-in kept in its database: the broker's
 * credentials and token never reach a sandbox, a page or the model. Calls go
 * out through the fixed-IP proxy when one is set, inside an encrypted tunnel
 * the proxy cannot read. The agent reads freely; an order (new, changed or
 * cancelled) only asks: the thread shows it with Place and Don't place, and
 * only that press sends it, within the limits set here, checked again then.
 */

/** What Settings › Trading keeps for a broker. */
type StoredBroker = {
	/** Off leaves its tools out of every task. */
	enabled: boolean;
	/** Off leaves the agent its reads only: it cannot even ask to order. */
	trading: boolean;
	credentials: Record<string, string>;
	/** http(s)://user:password@host:port, with the fixed IP the broker allows orders from; null calls straight out. */
	proxy: string | null;
	/** The most one order may be worth, quantity times price, in the broker's currency. */
	maxOrderValue: number;
	/** New orders a day at most, counted on the broker's clock. */
	maxOrdersPerDay: number;
};

const DEFAULTS: StoredBroker = { enabled: true, trading: true, credentials: {}, proxy: null, maxOrderValue: 10_000, maxOrdersPerDay: 20 };
/** An order not answered this long after it was asked is not placed: prices will have moved. */
export const ORDER_TTL_MS = 30 * 60_000;
/** The broker allows a new sign-in once a minute, and each ends the one before. */
const SIGN_IN_GAP_MS = 60_000;

const settingKey = (id: string) => `broker:${id}`;
const sessionKey = (id: string) => `broker-session:${id}`;

type StoredSession = BrokerSession & { fingerprint: string; mintedAt: string };

export const brokers = (): Broker[] => getProviders().brokers ?? [];
/** How a broker's calls leave the server, through `proxy` when one is set. */
const brokerFetch = (proxy: string | null): BrokerFetch => (getProviders().brokerFetch ?? directFetch)(proxy);

export function brokerById(id: string): Broker {
	const found = brokers().find((broker) => broker.id === id);
	if (!found) throw new NotFoundError(`No broker is named ${id}`);
	return found;
}

async function stored(id: string): Promise<StoredBroker> {
	return { ...DEFAULTS, ...(await getSetting<Partial<StoredBroker>>(settingKey(id), {})) };
}

/** Whether the saved credentials are enough to sign in. */
const signsIn = (broker: Broker, credentials: Record<string, string>) => broker.canSignIn(credentials);

const fingerprintOf = (credentials: Record<string, string>) => createHash('sha256').update(JSON.stringify(Object.entries(credentials).sort())).digest('hex');

export type BrokerView = {
	id: string;
	name: string;
	/** Credentials saved enough to sign in. */
	ready: boolean;
	enabled: boolean;
	trading: boolean;
	/** Each field, and whether it is saved; a value is never sent back. */
	fields: Array<BrokerCredentialField & { set: boolean }>;
	/** The proxy without its password, or null. */
	proxy: string | null;
	maxOrderValue: number;
	maxOrdersPerDay: number;
	timeZone: string;
	hosts: string[];
	/** When the sign-in Anton holds ends, if it holds one. */
	sessionEndsAt: string | null;
};

async function viewOf(broker: Broker): Promise<BrokerView> {
	const settings = await stored(broker.id);
	const session = await getSetting<StoredSession | null>(sessionKey(broker.id), null);
	const live = session && session.fingerprint === fingerprintOf(settings.credentials) && Date.parse(session.expiresAt) > Date.now();
	return {
		id: broker.id,
		name: broker.name,
		ready: signsIn(broker, settings.credentials),
		enabled: settings.enabled,
		trading: settings.trading,
		fields: broker.credentials.map((field) => ({ ...field, set: Boolean(settings.credentials[field.key]) })),
		proxy: settings.proxy ? proxyLabel(settings.proxy) : null,
		maxOrderValue: settings.maxOrderValue,
		maxOrdersPerDay: settings.maxOrdersPerDay,
		timeZone: broker.timeZone,
		hosts: broker.hosts,
		sessionEndsAt: live ? session.expiresAt : null,
	};
}

export async function brokersView(): Promise<BrokerView[]> {
	return Promise.all(brokers().map(viewOf));
}

export async function brokerView(id: string): Promise<BrokerView> {
	return viewOf(brokerById(id));
}

/**
 * A change from Settings › Trading. A credential set to a string replaces it and to null keeps it, and one
 * set to '' removes it; the proxy likewise (undefined keeps it, '' removes it). Changing either drops the
 * sign-in Anton holds, so the next call signs in with the new ones.
 */
export type BrokerSettingsChange = {
	enabled?: boolean;
	trading?: boolean;
	credentials?: Record<string, string | null>;
	proxy?: string;
	maxOrderValue?: number;
	maxOrdersPerDay?: number;
};

export async function saveBrokerSettings(id: string, change: BrokerSettingsChange): Promise<BrokerView> {
	const broker = brokerById(id);
	const current = await stored(id);
	const credentials = { ...current.credentials };
	for (const [key, value] of Object.entries(change.credentials ?? {})) {
		if (!broker.credentials.some((field) => field.key === key)) throw new InvalidInputError(`${broker.name} takes no credential named ${key}`);
		if (value === null) continue;
		if (value.trim()) credentials[key] = value.trim();
		else delete credentials[key];
	}
	let proxy = current.proxy;
	if (change.proxy !== undefined) {
		proxy = change.proxy.trim() || null;
		if (proxy) {
			try {
				proxyParts(proxy);
			} catch (error) {
				throw new InvalidInputError(error instanceof Error ? error.message : String(error));
			}
		}
	}
	const next: StoredBroker = {
		enabled: change.enabled ?? current.enabled,
		trading: change.trading ?? current.trading,
		credentials,
		proxy,
		maxOrderValue: change.maxOrderValue ?? current.maxOrderValue,
		maxOrdersPerDay: change.maxOrdersPerDay ?? current.maxOrdersPerDay,
	};
	await setSetting(settingKey(id), next);
	if (fingerprintOf(credentials) !== fingerprintOf(current.credentials) || proxy !== current.proxy) await setSetting(sessionKey(id), null);
	announce({ kind: 'connectors' });
	return viewOf(broker);
}

/** One sign-in at a time per broker: two at once would each end the other's. */
const signingIn = new Map<string, Promise<BrokerSession>>();

async function freshSession(broker: Broker, settings: StoredBroker, fetch: BrokerFetch, signal?: AbortSignal): Promise<BrokerSession> {
	const running = signingIn.get(broker.id);
	if (running) return running;
	const attempt = (async () => {
		const previous = await getSetting<StoredSession | null>(sessionKey(broker.id), null);
		const since = previous ? Date.now() - Date.parse(previous.mintedAt) : Infinity;
		if (since < SIGN_IN_GAP_MS) throw new BrokerError(`${broker.name} signed in under a minute ago and allows one sign-in a minute; try again in ${Math.ceil((SIGN_IN_GAP_MS - since) / 1000)} seconds`, 'refused');
		const session = await broker.signIn(settings.credentials, fetch, signal);
		await setSetting(sessionKey(broker.id), { ...session, fingerprint: fingerprintOf(settings.credentials), mintedAt: new Date().toISOString() } satisfies StoredSession);
		announce({ kind: 'connectors' });
		return session;
	})();
	signingIn.set(broker.id, attempt);
	try {
		return await attempt;
	} finally {
		signingIn.delete(broker.id);
	}
}

/**
 * Runs `work` with the broker's sign-in and the way out its calls take. A sign-in that ended is renewed
 * once and the work run again: the broker refused the first try for its token, so nothing went.
 */
async function withBroker<T>(id: string, work: (broker: Broker, session: BrokerSession, fetch: BrokerFetch) => Promise<T>, signal?: AbortSignal): Promise<T> {
	const broker = brokerById(id);
	const settings = await stored(id);
	if (!signsIn(broker, settings.credentials)) throw new ConflictError(`${broker.name} has no sign-in yet: add it in Settings › Trading.`);
	const fetch = brokerFetch(settings.proxy);
	const fingerprint = fingerprintOf(settings.credentials);
	const saved = await getSetting<StoredSession | null>(sessionKey(id), null);
	const usable = saved && saved.fingerprint === fingerprint && Date.parse(saved.expiresAt) > Date.now() ? saved : null;
	const session = usable ?? (await freshSession(broker, settings, fetch, signal));
	try {
		return await work(broker, session, fetch);
	} catch (error) {
		if (!(error instanceof BrokerError) || error.reason !== 'session' || !usable) throw error;
		// The token Anton held stopped working (replaced, revoked or expired early): sign in again, once.
		await setSetting(sessionKey(id), { ...saved!, expiresAt: new Date(0).toISOString() });
		const renewed = await freshSession(broker, settings, fetch, signal);
		if (renewed.token === session.token) throw new BrokerError(`${broker.name}'s sign-in stopped working: sign in again in Settings › Trading.`, 'session');
		return work(broker, renewed, fetch);
	}
}

/** Settings › Trading's Check: signs in, reads the profile, and says which address the broker sees calls from. */
export async function checkBroker(id: string): Promise<{ name: string | null; address: string | null; problem: string | null }> {
	const broker = brokerById(id);
	const settings = await stored(id);
	let address: string | null = null;
	try {
		const answer = await brokerFetch(settings.proxy)('https://checkip.amazonaws.com/', { method: 'GET', headers: {} });
		address = answer.status === 200 ? answer.text.trim() || null : null;
	} catch {
		address = null;
	}
	try {
		const profile = (await withBroker(id, (each, session, fetch) => each.read(session, 'profile', fetch))) as Record<string, unknown> | null;
		const name = [profile?.name, profile?.user_name, profile?.client_name, profile?.email].find((value) => typeof value === 'string' && value) as string | undefined;
		return { name: name ?? broker.name, address, problem: null };
	} catch (error) {
		return { name: null, address, problem: error instanceof Error ? error.message : String(error) };
	}
}

const text = (value: unknown) => JSON.stringify(value);

export async function brokerReadText(id: string, what: BrokerRead[], signal?: AbortSignal): Promise<string> {
	return withBroker(
		id,
		async (broker, session, fetch) => {
			const parts: string[] = [];
			for (const each of what) parts.push(`${each}: ${text(await broker.read(session, each, fetch, signal))}`);
			return parts.join('\n\n');
		},
		signal,
	);
}

export async function brokerQuotesText(id: string, codes: string[], signal?: AbortSignal): Promise<string> {
	return withBroker(id, async (broker, session, fetch) => `Quotes: ${text(await broker.quotes(session, codes, fetch, signal))}`, signal);
}

export async function findInstrumentsText(id: string, query: string, source: string, signal?: AbortSignal): Promise<string> {
	return withBroker(
		id,
		async (broker, session, fetch) => {
			const found = await broker.findInstruments(session, query, source, fetch, signal);
			if (!found.length) return `No ${source} instrument matches ${JSON.stringify(query)}. Try fewer words, the exchange symbol, or another list (${broker.instrumentSources.join(', ')}).`;
			const rows = found.map((each) =>
				[
					`security_id ${each.securityId}`,
					each.symbol,
					each.name !== each.symbol ? each.name : '',
					`${each.exchange} ${each.segment}`,
					`quote ${each.quoteCode}`,
					each.lotSize > 1 ? `lot ${each.lotSize}` : '',
					each.tickSize ? `tick ${each.tickSize}` : '',
					each.expiry ? `expiry ${each.expiry}` : '',
					each.strike ? `strike ${each.strike}` : '',
					each.optionType ?? '',
				]
					.filter(Boolean)
					.join(' · '),
			);
			return `${found.length} ${source} instrument${found.length === 1 ? '' : 's'} match ${JSON.stringify(query)}, best first:\n${rows.join('\n')}`;
		},
		signal,
	);
}

/** Midnight today on the broker's clock, as an ISO instant: where the daily cap starts counting. */
export function startOfDay(timeZone: string, now = new Date()): string {
	const day = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
	const local = (zone: string) => Date.parse(new Date(now).toLocaleString('en-US', { timeZone: zone }));
	const offset = local(timeZone) - local('UTC');
	return new Date(Date.parse(`${day}T00:00:00Z`) - offset).toISOString();
}

const money = (value: number) => value.toLocaleString('en-IN', { maximumFractionDigits: 2 });

/** What an action is worth, for the per-order cap: a new order at its limit price, or the latest price for a market order. */
async function valueOf(broker: Broker, session: BrokerSession, fetch: BrokerFetch, action: OrderAction, signal?: AbortSignal): Promise<number | null> {
	if (action.kind === 'cancel') return null;
	if (action.kind === 'modify') return action.change.quantity * action.change.limitPrice;
	const price = action.order.limitPrice ?? (await broker.lastPrice(session, action.order, fetch, signal));
	if (price === null) throw new BrokerError(`${broker.name} gave no price for security ${action.order.securityId}, so the order's value is unknown; give a limit price`, 'refused');
	return action.order.quantity * price;
}

/** The limits an action must keep, now: trading on, under the per-order value, under the day's count. */
async function checkLimits(broker: Broker, settings: StoredBroker, action: OrderAction, value: number | null): Promise<void> {
	if (!settings.enabled) throw new ConflictError(`${broker.name} is off in Settings › Trading.`);
	if (!settings.trading) throw new ConflictError(`Trading is off for ${broker.name} in Settings › Trading: the agent may only read.`);
	if (value !== null && value > settings.maxOrderValue) {
		throw new ConflictError(`That order is worth about ${money(value)}, over the ${money(settings.maxOrderValue)} an order may be worth in Settings › Trading.`);
	}
	if (action.kind === 'place') {
		const placed = await ordersPlacedSince(broker.id, startOfDay(broker.timeZone));
		if (placed >= settings.maxOrdersPerDay) throw new ConflictError(`${placed} orders were placed today, the most Settings › Trading allows a day.`);
	}
}

export type OrderApprovalView = {
	id: string;
	broker: string;
	brokerName: string;
	action: OrderAction;
	value: number | null;
	state: OrderApprovalState;
	createdAt: string;
	expiresAt: string;
	decidedAt: string | null;
	orderId: string | null;
	problem: string | null;
};

function present(approval: OrderApproval): OrderApprovalView {
	const broker = brokers().find((each) => each.id === approval.broker);
	const expired = approval.state === 'pending' && Date.now() - Date.parse(approval.createdAt) > ORDER_TTL_MS;
	return {
		id: approval.id,
		broker: approval.broker,
		brokerName: broker?.name ?? approval.broker,
		action: approval.action,
		value: approval.value,
		state: expired ? 'expired' : approval.state,
		createdAt: approval.createdAt,
		expiresAt: new Date(Date.parse(approval.createdAt) + ORDER_TTL_MS).toISOString(),
		decidedAt: approval.decidedAt,
		orderId: approval.orderId,
		problem: approval.problem,
	};
}

/** The order in a line, as the agent and the push notification put it. */
export function orderLine(action: OrderAction): string {
	const name = action.symbol ?? (action.kind === 'place' ? `security ${action.order.securityId}` : `order ${action.kind === 'modify' ? action.change.orderId : action.cancel.orderId}`);
	if (action.kind === 'place') {
		const { order } = action;
		return `${order.side === 'BUY' ? 'Buy' : 'Sell'} ${order.quantity} ${name} at ${order.orderType === 'MARKET' ? 'market' : money(order.limitPrice ?? 0)}`;
	}
	if (action.kind === 'modify') return `Change ${name} to ${action.change.quantity} at ${money(action.change.limitPrice)}`;
	return `Cancel ${name}`;
}

/** Asks the user to place, change or cancel an order: checked against the limits, kept as it stands, and shown in the thread until they decide. */
export async function requestOrder(sessionId: string, brokerId: string, action: OrderAction, signal?: AbortSignal): Promise<{ order: OrderApprovalView; output: string }> {
	const broker = brokerById(brokerId);
	const settings = await stored(brokerId);
	if (action.kind === 'place') {
		const { order } = action;
		const { exchanges, segments, products } = broker.orderOptions;
		if (!exchanges.includes(order.exchange)) throw new InvalidInputError(`exchange is one of ${exchanges.join(', ')}`);
		if (!segments.includes(order.segment)) throw new InvalidInputError(`segment is one of ${segments.join(', ')}`);
		if (!products.includes(order.product)) throw new InvalidInputError(`product is one of ${products.join(', ')}`);
		if (order.orderType === 'LIMIT' && !(order.limitPrice && order.limitPrice > 0)) throw new InvalidInputError('A LIMIT order needs limit_price');
		if (order.orderType === 'MARKET' && order.limitPrice !== null) throw new InvalidInputError('A MARKET order takes no limit_price');
	}
	const value = await withBroker(brokerId, (each, session, fetch) => valueOf(each, session, fetch, action, signal), signal);
	await checkLimits(broker, settings, action, value);
	const approval = { id: `order_${randomUUID()}`, sessionId, broker: brokerId, action, value, createdAt: new Date().toISOString() };
	await insertOrderApproval(approval);
	announce({ kind: 'task', id: sessionId, what: 'orders' });
	return {
		order: present({ ...approval, state: 'pending', decidedAt: null, orderId: null, problem: null }),
		output:
			`The user now sees "${orderLine(action)}"${value !== null ? ` (worth about ${money(value)})` : ''} with Place and Don't place, and nothing goes to ${broker.name} until they press Place. ` +
			`Stop here and wait for their answer; write nothing after this. [order:${approval.id}]`,
	};
}

export async function orderApprovals(sessionId: string): Promise<OrderApprovalView[]> {
	return (await listOrderApprovals(sessionId)).map(present);
}

/** The user's Place or Don't place. Place sends it only while it is fresh and within the limits as they stand now. */
export async function decideOrder(sessionId: string, approvalId: string, place: boolean): Promise<OrderApprovalView> {
	const approval = await getOrderApproval(approvalId);
	if (!approval || approval.sessionId !== sessionId) throw new NotFoundError('No order waits for your answer here');
	const finish = async () => {
		announce({ kind: 'task', id: sessionId, what: 'orders' });
		return present((await getOrderApproval(approvalId))!);
	};
	if (approval.state !== 'pending') {
		const said: Partial<Record<OrderApprovalState, string>> = {
			sending: 'That order is being sent.',
			done: 'That order was already sent.',
			declined: 'You already chose not to place it.',
			failed: `${approval.problem ?? 'The broker refused it'}.`,
			unknown: 'It was sent but no answer came; look at the order book.',
		};
		throw new ConflictError(said[approval.state] ?? 'That order can no longer be placed.');
	}
	if (!place) {
		if (!(await moveOrderApproval(approvalId, 'pending', 'declined'))) throw new ConflictError('Someone answered this order already.');
		return finish();
	}
	if (Date.now() - Date.parse(approval.createdAt) > ORDER_TTL_MS) {
		await moveOrderApproval(approvalId, 'pending', 'expired');
		await finish();
		throw new ConflictError('That order was asked over 30 minutes ago, so it was not placed; ask the agent again for a fresh one.');
	}
	const broker = brokerById(approval.broker);
	const settings = await stored(approval.broker);
	// A market order is valued again at today's price, so the cap holds as it would be placed.
	const value =
		approval.action.kind === 'place' && approval.action.order.orderType === 'MARKET'
			? await withBroker(approval.broker, (each, session, fetch) => valueOf(each, session, fetch, approval.action))
			: approval.value;
	await checkLimits(broker, settings, approval.action, value);
	// Held while it goes, so a second press, here or in another tab, cannot send it twice.
	if (!(await moveOrderApproval(approvalId, 'pending', 'sending'))) throw new ConflictError('Someone answered this order already.');
	try {
		const action = approval.action;
		const result = await withBroker(approval.broker, (each, session, fetch) =>
			action.kind === 'place' ? each.placeOrder(session, action.order, fetch) : action.kind === 'modify' ? each.modifyOrder(session, action.change, fetch) : each.cancelOrder(session, action.cancel, fetch),
		);
		await moveOrderApproval(approvalId, 'sending', 'done', { orderId: result.orderId });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		// With no answer the order may have gone: it is never sent again from here.
		const unknown = error instanceof BrokerError && error.reason === 'unreachable';
		await moveOrderApproval(approvalId, 'sending', unknown ? 'unknown' : 'failed', { problem: message });
	}
	return finish();
}

/** Every broker set up enough to sign in, for the agent's instructions. */
export async function readyBrokers(): Promise<Array<{ id: string; name: string; enabled: boolean; trading: boolean }>> {
	const out = [];
	for (const broker of brokers()) {
		const settings = await stored(broker.id);
		if (signsIn(broker, settings.credentials)) out.push({ id: broker.id, name: broker.name, enabled: settings.enabled, trading: settings.trading });
	}
	return out;
}

export type { BrokerOrder };

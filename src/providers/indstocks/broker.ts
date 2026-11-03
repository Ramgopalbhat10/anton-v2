import { BrokerError } from '../../core/errors.ts';
import type { Broker, BrokerFetch, BrokerInstrument, BrokerOrder, BrokerOrderResult, BrokerRead, BrokerResponse, BrokerSession } from '../../core/ports.ts';
import { totp, totpRemainingMs } from '../../core/totp.ts';

/*
 * INDstocks (INDmoney's broker), over its REST API (api-docs.indstocks.com).
 * A session is minted with TOTP: the Client ID as x-api-key, the account's
 * MPIN, and a code from the authenticator secret; it lasts 24 hours and only
 * the newest one works, so Anton keeps it and mints again only when it ends.
 * Orders must come from a static IP registered on the Access Tokens page,
 * which is the proxy's; reads work from anywhere.
 */

const DAY_MS = 24 * 3_600_000;
/** A minted token is taken to end a little before its 24 hours, so a call never meets it ending. */
const MARGIN_MS = 10 * 60_000;
const READ_PATHS: Record<BrokerRead, string> = {
	profile: '/user/profile',
	funds: '/funds',
	holdings: '/portfolio/holdings',
	positions: '/portfolio/positions',
	orders: '/order-book',
};
/** What each instrument list's rows are ordered and quoted as. */
const SOURCES: Record<string, { segment: string; quotePrefix: (exchange: string) => string }> = {
	equity: { segment: 'EQUITY', quotePrefix: (exchange) => exchange },
	fno: { segment: 'DERIVATIVE', quotePrefix: () => 'NFO' },
	mcx: { segment: 'COMMODITY', quotePrefix: () => 'MCX' },
	index: { segment: 'INDEX', quotePrefix: (exchange) => exchange },
};
const LIST_MS = 6 * 3_600_000;
const MAX_FOUND = 20;

type Json = Record<string, unknown>;

function parse(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

/** Why a call failed, from whichever of the broker's error shapes came back. */
function failure(response: BrokerResponse, what: string): BrokerError {
	const body = (parse(response.text) ?? {}) as Json;
	const kind = typeof body.error_type === 'string' ? body.error_type : '';
	const detail = [body.debug_info, body.message, body.error].find((value) => typeof value === 'string' && value && value !== 'Bad Request') as string | undefined;
	const message = `${what} failed (${response.status}${kind ? ` ${kind}` : ''})${detail ? `: ${detail}` : ''}`;
	if (kind === 'TokenException' || ((response.status === 401 || response.status === 403) && !kind)) return new BrokerError(message, 'session');
	if (response.status === 429 || response.status >= 500 || response.status === 0) return new BrokerError(message, 'unreachable');
	return new BrokerError(message, 'refused');
}

/** One CSV line's cells, with quoted cells and doubled quotes inside them. */
export function csvCells(line: string): string[] {
	const cells: string[] = [];
	let cell = '';
	let quoted = false;
	for (let index = 0; index < line.length; index += 1) {
		const char = line[index];
		if (quoted) {
			if (char === '"' && line[index + 1] === '"') {
				cell += '"';
				index += 1;
			} else if (char === '"') quoted = false;
			else cell += char;
		} else if (char === '"') quoted = true;
		else if (char === ',') {
			cells.push(cell);
			cell = '';
		} else cell += char;
	}
	cells.push(cell.replace(/\r$/, ''));
	return cells;
}

/** An instrument list's rows as instruments. The index list has three columns, its second the index's name. */
export function instrumentsFromCsv(text: string, source: string): BrokerInstrument[] {
	const [header, ...lines] = text.split('\n').filter((line) => line.trim());
	if (!header) return [];
	const { segment, quotePrefix } = SOURCES[source] ?? SOURCES.equity!;
	if (source === 'index') {
		return lines.map((line) => {
			const [exchange = '', name = '', securityId = ''] = csvCells(line);
			return { securityId, exchange, segment, symbol: name, name, quoteCode: `${quotePrefix(exchange)}_${securityId}`, lotSize: 0, tickSize: 0, expiry: null, strike: null, optionType: null };
		});
	}
	const columns = csvCells(header).map((name) => name.trim().toUpperCase());
	const at = (cells: string[], name: string) => {
		const index = columns.indexOf(name);
		return index < 0 ? '' : (cells[index] ?? '').trim();
	};
	return lines.map((line) => {
		const cells = csvCells(line);
		const exchange = at(cells, 'EXCH');
		const securityId = at(cells, 'SECURITY_ID');
		const strike = Number(at(cells, 'STRIKE_PRICE'));
		return {
			securityId,
			exchange,
			segment,
			symbol: at(cells, 'TRADING_SYMBOL') || at(cells, 'SYMBOL_NAME'),
			name: at(cells, 'CUSTOM_SYMBOL') || at(cells, 'UNDERLYING_SCRIP_NAME') || at(cells, 'SYMBOL_NAME'),
			quoteCode: `${quotePrefix(exchange)}_${securityId}`,
			lotSize: Number(at(cells, 'LOT_UNITS')) || 1,
			tickSize: Number(at(cells, 'TICK_SIZE')) || 0,
			expiry: at(cells, 'EXPIRY_DATE') || null,
			strike: strike > 0 ? strike : null,
			optionType: at(cells, 'OPTION_TYPE') || null,
		};
	});
}

/** The best matches for `query` among `instruments`: an exact symbol first, then symbols it starts, then every word found. */
export function bestMatches(instruments: BrokerInstrument[], query: string, max = MAX_FOUND): BrokerInstrument[] {
	const words = query.toUpperCase().split(/\s+/).filter(Boolean);
	if (!words.length) return [];
	const whole = words.join(' ');
	return instruments
		.map((instrument) => {
			const symbol = instrument.symbol.toUpperCase();
			const text = `${symbol} ${instrument.name.toUpperCase()} ${instrument.expiry ?? ''} ${instrument.strike ?? ''} ${instrument.optionType ?? ''}`;
			if (!words.every((word) => text.includes(word))) return { instrument, score: 0 };
			const score = (symbol === whole ? 100 : 0) + (symbol.startsWith(words[0]!) ? 20 : 0) + (instrument.name.toUpperCase() === whole ? 50 : 0) + 1;
			return { instrument, score };
		})
		.filter((entry) => entry.score > 0)
		.sort((a, b) => b.score - a.score || a.instrument.symbol.length - b.instrument.symbol.length)
		.slice(0, max)
		.map((entry) => entry.instrument);
}

/** The quote code for what an order names: NSE_ and BSE_ cash, NFO_ derivatives, MCX_ commodities. */
export function quoteCodeFor(order: Pick<BrokerOrder, 'exchange' | 'segment' | 'securityId'>): string | null {
	if (order.segment === 'EQUITY' && (order.exchange === 'NSE' || order.exchange === 'BSE')) return `${order.exchange}_${order.securityId}`;
	if (order.segment === 'DERIVATIVE' && order.exchange === 'NSE') return `NFO_${order.securityId}`;
	if (order.segment === 'COMMODITY') return `MCX_${order.securityId}`;
	return null;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function indstocksBroker({ apiUrl = 'https://api.indstocks.com' } = {}): Broker {
	const host = new URL(apiUrl).hostname;
	const lists = new Map<string, { at: number; instruments: Promise<BrokerInstrument[]> }>();

	async function call(session: BrokerSession, fetch: BrokerFetch, method: 'GET' | 'POST', path: string, what: string, body?: Json, signal?: AbortSignal): Promise<BrokerResponse> {
		const response = await fetch(`${apiUrl}${path}`, {
			method,
			headers: { Authorization: session.token, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
			body: body ? JSON.stringify(body) : undefined,
			signal,
		});
		if (response.status < 200 || response.status >= 300) throw failure(response, what);
		return response;
	}

	async function json(session: BrokerSession, fetch: BrokerFetch, method: 'GET' | 'POST', path: string, what: string, body?: Json, signal?: AbortSignal): Promise<unknown> {
		const response = await call(session, fetch, method, path, what, body, signal);
		const data = parse(response.text) as Json | null;
		if (data === null) throw new BrokerError(`${what} answered something that is not JSON`, 'unreachable');
		return 'data' in data ? data.data : data;
	}

	function orderResult(data: unknown, what: string): BrokerOrderResult {
		const result = (data ?? {}) as Json;
		const orderId = typeof result.order_id === 'string' ? result.order_id : '';
		if (!orderId) throw new BrokerError(`${what} answered without an order id; look at the order book before trying again`, 'unreachable');
		return { orderId, status: String(result.order_status ?? '') };
	}

	return {
		id: 'indstocks',
		name: 'INDstocks',
		timeZone: 'Asia/Kolkata',
		hosts: [host],
		credentials: [
			{ key: 'clientId', label: 'Client ID', secret: true, optional: true, help: 'Shown on the Access Tokens page once TOTP is set up; sent as x-api-key when Anton signs in.' },
			{ key: 'mpin', label: 'MPIN', secret: true, optional: true, help: "Your INDstocks account's MPIN." },
			{
				key: 'totpSecret',
				label: 'TOTP secret',
				secret: true,
				optional: true,
				help: 'The setup key shown once while you set up TOTP (letters and digits). Anton makes the six-digit codes from it, so it signs in again by itself each day.',
			},
			{ key: 'accessToken', label: 'Access token', secret: true, optional: true, help: 'Or paste a token from the Access Tokens page instead of the three above. It lasts 24 hours, so you paste a new one each day.' },
		],
		orderOptions: { exchanges: ['NSE', 'BSE', 'MCX'], segments: ['EQUITY', 'DERIVATIVE', 'COMMODITY'], products: ['CNC', 'INTRADAY', 'MARGIN'] },
		instrumentSources: Object.keys(SOURCES),

		canSignIn: ({ clientId, mpin, totpSecret, accessToken }) => Boolean((clientId && mpin && totpSecret) || accessToken),

		async signIn(credentials, fetch, signal) {
			const { clientId, mpin, totpSecret, accessToken } = credentials;
			if (clientId && mpin && totpSecret) {
				// A code about to change may be stale by the time it lands; take the next one.
				if (totpRemainingMs() < 2_000) await wait(totpRemainingMs() + 100);
				const response = await fetch(`${apiUrl}/generate/token`, {
					method: 'POST',
					headers: { 'x-api-key': clientId, 'Content-Type': 'application/json', Accept: 'application/json' },
					body: JSON.stringify({ mpin, totp: totp(totpSecret) }),
					signal,
				});
				if (response.status < 200 || response.status >= 300) {
					const error = failure(response, 'Signing in to INDstocks');
					// The sign-in itself was refused: signing in again would only count toward a lockout.
					throw new BrokerError(error.message, error.reason === 'session' ? 'refused' : error.reason);
				}
				const body = (parse(response.text) ?? {}) as Json;
				const data = (body.data && typeof body.data === 'object' ? body.data : body) as Json;
				const token = [data.token, data.access_token, body.token].find((value) => typeof value === 'string' && value) as string | undefined;
				if (!token) throw new BrokerError('INDstocks signed in but sent no token', 'refused');
				return { token, expiresAt: new Date(Date.now() + DAY_MS - MARGIN_MS).toISOString() };
			}
			if (accessToken) return { token: accessToken, expiresAt: new Date(Date.now() + DAY_MS).toISOString() };
			throw new BrokerError('Add your Client ID, MPIN and TOTP secret (or an access token) in Settings › Trading', 'refused');
		},

		read: (session, what, fetch, signal) => json(session, fetch, 'GET', READ_PATHS[what], `Reading ${what}`, undefined, signal),

		quotes: (session, codes, fetch, signal) => json(session, fetch, 'GET', `/market/quotes/full?scrip-codes=${codes.map(encodeURIComponent).join(',')}`, 'Reading quotes', undefined, signal),

		async lastPrice(session, order, fetch, signal) {
			const code = quoteCodeFor(order);
			if (!code) return null;
			const data = (await json(session, fetch, 'GET', `/market/quotes/ltp?scrip-codes=${encodeURIComponent(code)}`, 'Reading the price', undefined, signal)) as Json;
			const price = Number(((data?.[code] ?? {}) as Json).live_price);
			return Number.isFinite(price) && price > 0 ? price : null;
		},

		async findInstruments(session, query, source, fetch, signal) {
			if (!SOURCES[source]) throw new BrokerError(`The instrument lists are ${Object.keys(SOURCES).join(', ')}`, 'refused');
			const cached = lists.get(source);
			let entry = cached && Date.now() - cached.at < LIST_MS ? cached : undefined;
			if (!entry) {
				const instruments = call(session, fetch, 'GET', `/market/instruments?source=${source}`, 'Reading the instrument list', undefined, signal).then((response) => instrumentsFromCsv(response.text, source));
				entry = { at: Date.now(), instruments };
				lists.set(source, entry);
				instruments.catch(() => lists.delete(source));
			}
			return bestMatches(await entry.instruments, query);
		},

		async placeOrder(session, order, fetch) {
			const body: Json = {
				txn_type: order.side,
				exchange: order.exchange,
				segment: order.segment,
				product: order.product,
				order_type: order.orderType,
				validity: 'DAY',
				security_id: order.securityId,
				qty: order.quantity,
				is_amo: order.afterMarket,
				...(order.orderType === 'LIMIT' && order.limitPrice !== null ? { limit_price: order.limitPrice } : {}),
				...(order.tag ? { remarks: order.tag.slice(0, 100) } : {}),
			};
			return orderResult(await json(session, fetch, 'POST', '/order', 'Placing the order', body), 'Placing the order');
		},

		async modifyOrder(session, change, fetch) {
			const body = { order_id: change.orderId, segment: change.segment, qty: change.quantity, limit_price: change.limitPrice };
			return orderResult(await json(session, fetch, 'POST', '/order/modify', 'Changing the order', body), 'Changing the order');
		},

		async cancelOrder(session, cancel, fetch) {
			return orderResult(await json(session, fetch, 'POST', '/order/cancel', 'Cancelling the order', { order_id: cancel.orderId, segment: cancel.segment }), 'Cancelling the order');
		},
	};
}

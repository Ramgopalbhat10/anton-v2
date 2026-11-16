import { lookup } from 'node:dns/promises';
import { connect } from 'node:net';

// Node looks names up on a small thread pool, so a slow resolver stalls every request, which one service's check cannot tell from that service being down.

const STEP_MS = 5_000;
/** A lookup slower than this is the problem, not the service. */
const SLOW_LOOKUP_MS = 2_000;

const seconds = (ms: number) => (ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`);

function within<T>(work: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([work, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error('timeout')), ms)))]).finally(() => clearTimeout(timer));
}

function connectTo(address: string, port: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const socket = connect({ host: address, port });
		socket.once('connect', () => {
			socket.destroy();
			resolve();
		});
		socket.once('error', (error) => {
			socket.destroy();
			reject(error);
		});
	});
}

async function firstThatConnects(addresses: string[], port: number): Promise<void> {
	let last: unknown = new Error('no address');
	for (const address of addresses) {
		try {
			return await connectTo(address, port);
		} catch (error) {
			last = error;
		}
	}
	throw last;
}

export async function whyNoAnswer(url: string, waitedMs: number): Promise<string> {
	const { hostname, port, protocol } = new URL(url);
	const head = `${hostname} did not answer within ${seconds(waitedMs)}.`;
	let started = Date.now();
	let addresses: string[];
	try {
		addresses = (await within(lookup(hostname, { all: true }), STEP_MS)).map((entry) => entry.address);
	} catch (error) {
		const took = Date.now() - started;
		return error instanceof Error && error.message === 'timeout'
			? `${head} Looking up its address took over ${seconds(took)}, so this server is slow to resolve names; check its DNS.`
			: `${head} Its address could not be looked up (${error instanceof Error ? error.message : String(error)}); check this server's DNS.`;
	}
	const lookedUp = Date.now() - started;
	started = Date.now();
	try {
		// Each address in turn, as a request would: a name can resolve to an IPv6 address first that nothing answers on.
		await within(firstThatConnects(addresses, Number(port) || (protocol === 'http:' ? 80 : 443)), STEP_MS);
	} catch (error) {
		return `${head} The address lookup took ${seconds(lookedUp)}, but connecting ${error instanceof Error && error.message === 'timeout' ? `took over ${seconds(STEP_MS)}` : `failed (${error instanceof Error ? error.message : String(error)})`}, so this server cannot reach it; check its network.`;
	}
	const connected = Date.now() - started;
	if (lookedUp > SLOW_LOOKUP_MS) return `${head} The address lookup took ${seconds(lookedUp)}, so this server is slow to resolve names; check its DNS.`;
	return `${head} The lookup took ${seconds(lookedUp)} and connecting ${seconds(connected)}, so the service itself was slow; it may be busy.`;
}

import { totp, totpRemainingMs } from '../core/totp.ts';
import { EgressError, egressFetch, proxyParts, type EgressResponse, type TlsTrust } from './egress.ts';
import { saveToLibrary } from './files.ts';
import { assertKeepable, hostAllowed, keepFromAnswer, type OpenSecret, openSecrets } from './sealed-secrets.ts';

/*
 * The agent's http_request tool: one HTTP request sent from Anton's server,
 * with sealed secrets filled in here (`sealed-secrets.ts`). The agent writes
 * `{{secret:NAME}}` where a value goes and `{{totp:NAME}}` where the current
 * code of a TOTP secret goes; it never sees either. A secret goes only to the
 * hosts it allows, over https, through its proxy; its value is hidden in what
 * comes back, and a value the answer holds (a token) can be kept as a sealed
 * secret of its own instead of being shown.
 */

const PLACEHOLDER = /\{\{(secret|totp):([A-Za-z0-9_]+)\}\}/g;
/** Characters of the answer's body the agent is shown; the rest is cut. */
const MAX_SHOWN = 100_000;
/** Below this a value is too likely to be ordinary text to hide everywhere, so only where it stands alone is it hidden. */
const MIN_HIDDEN = 4;
/** A TOTP code about to change is waited out, so the server sees one that is still good. */
const TOTP_MARGIN_MS = 3_000;
/**
 * The answer's headers the agent is shown: what it acts on (the type, where a redirect points, how
 * long to wait, rate limits, a download's name). CDN, gateway and security headers only take room.
 */
const SHOWN_HEADERS = /^(content-type|content-disposition|location|retry-after|www-authenticate|(x-)?rate-?limit-.+|x-request-id)$/i;

export type HttpRequestInput = {
	url: string;
	method?: string;
	headers?: Record<string, string>;
	body?: string;
	/** Values of the answer to keep as sealed secrets: `from` is a dotted path in its JSON body, or `header:<name>`. */
	save?: Array<{ name: string; from: string }>;
	/** Writes the answer's body (secrets hidden) to this file in the task's Library instead of showing it: for a large download. */
	toFile?: string;
};

const namesIn = (text: string) => [...text.matchAll(PLACEHOLDER)].map((match) => ({ kind: match[1] as 'secret' | 'totp', name: match[2]! }));

const wait = (ms: number, signal?: AbortSignal) =>
	new Promise<void>((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener('abort', () => (clearTimeout(timer), reject(new EgressError('Stopped'))), { once: true });
	});

/** Every form a value may come back in: as it is, URL-encoded, and escaped in JSON. */
function formsOf(value: string): string[] {
	return [...new Set([value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1)])].filter((form) => form.length >= MIN_HIDDEN);
}

function hider(secrets: Array<{ name: string; value: string }>): (text: string) => string {
	const pairs = secrets.flatMap(({ name, value }) => formsOf(value).map((form) => [form, name] as const)).sort(([a], [b]) => b.length - a.length);
	return (text) => pairs.reduce((out, [form, name]) => out.replaceAll(form, `[${name} hidden]`), text);
}

/** The first of `a|b|c` the answer has, so an answer whose shape is not settled can still be kept. */
function pick(response: EgressResponse, text: string, from: string): string {
	const choices = from.split('|').map((choice) => choice.trim()).filter(Boolean);
	for (const choice of choices.slice(0, -1)) {
		try {
			return pickOne(response, text, choice);
		} catch {
			// The next one, then.
		}
	}
	return pickOne(response, text, choices.at(-1) ?? from);
}

/** A dotted path into JSON (`data.token`, `items.0.id`), or `header:<name>`. */
function pickOne(response: EgressResponse, text: string, from: string): string {
	if (from.startsWith('header:')) {
		const value = response.headers[from.slice(7).trim().toLowerCase()];
		if (!value) throw new EgressError(`The answer has no ${from.slice(7).trim()} header to save`);
		return value;
	}
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch {
		throw new EgressError(`The answer is not JSON, so ${from} cannot be read from it`);
	}
	const value = from.split('.').reduce<unknown>((at, part) => (at && typeof at === 'object' ? (at as Record<string, unknown>)[part] : undefined), data);
	if (typeof value !== 'string' && typeof value !== 'number') throw new EgressError(`The answer has no text at ${from} to save`);
	return String(value);
}

function substitute(text: string, secrets: Map<string, OpenSecret>, codes: Map<string, string>): string {
	return text.replace(PLACEHOLDER, (_, kind: string, name: string) => (kind === 'totp' ? codes.get(name)! : secrets.get(name)!.value));
}

/** Sends the request and returns what the agent may read of the answer. */
export async function httpRequest(taskId: string, input: HttpRequestInput, { signal, trust }: { signal?: AbortSignal; trust?: TlsTrust } = {}): Promise<string> {
	const method = (input.method ?? 'GET').toUpperCase();
	if (!/^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(method)) throw new EgressError(`${method} is not a method this tool sends`);
	const headers = input.headers ?? {};
	// Where the request goes is read before anything is filled in, so no secret can choose the host.
	const origin = /^[a-z]+:\/\/[^/?#]*/i.exec(input.url)?.[0] ?? '';
	if (namesIn(origin).length) throw new EgressError('A secret cannot be part of the host');
	if (!URL.canParse(input.url.replace(PLACEHOLDER, 'x'))) throw new EgressError(`${input.url} is not a URL`);
	const host = new URL(input.url.replace(PLACEHOLDER, 'x')).hostname.toLowerCase();

	const used = [input.url, ...Object.keys(headers), ...Object.values(headers), input.body ?? ''].flatMap(namesIn);
	const secrets = await openSecrets(used.map((entry) => entry.name));
	for (const { name } of used) {
		const secret = secrets.get(name);
		if (!secret) throw new EgressError(`No sealed secret is named ${name}; the user adds them in Settings › Secrets`);
		if (!hostAllowed(host, secret.hosts)) throw new EgressError(`${name} may only be sent to ${secret.hosts.join(', ')}, not ${host}`);
	}
	const proxies = new Set([...secrets.values()].map((secret) => secret.proxy).filter((proxy): proxy is string => proxy !== null));
	if (proxies.size > 1) throw new EgressError('The secrets in this request go through different proxies, so they cannot be sent together');
	const proxy = [...proxies][0] ?? null;
	// A read skips the proxy only when every proxied secret in it says reads may go straight out.
	const proxied = [...secrets.values()].filter((secret) => secret.proxy !== null);
	const readsDirect = proxied.length > 0 && proxied.every((secret) => secret.readsDirect);
	const route = readsDirect && (method === 'GET' || method === 'HEAD') ? null : proxy;
	if (secrets.size && !input.url.toLowerCase().startsWith('https://')) throw new EgressError('A request with a secret in it goes over https only');
	for (const { name } of input.save ?? []) await assertKeepable(name);

	const codes = new Map<string, string>();
	const totpNames = [...new Set(used.filter((entry) => entry.kind === 'totp').map((entry) => entry.name))];
	if (totpNames.length && totpRemainingMs() < TOTP_MARGIN_MS) await wait(totpRemainingMs() + 200, signal);
	for (const name of totpNames) {
		try {
			codes.set(name, totp(secrets.get(name)!.value));
		} catch (error) {
			throw new EgressError(`${name} is not a TOTP secret: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	const url = new URL(substitute(input.url, secrets, codes));
	const response = await egressFetch(
		route ? proxyParts(route) : null,
		{
			url,
			method,
			headers: Object.fromEntries(Object.entries(headers).map(([name, value]) => [substitute(name, secrets, codes), substitute(value, secrets, codes)])),
			body: input.body === undefined ? undefined : substitute(input.body, secrets, codes),
			signal,
		},
		trust,
	);
	const text = response.body.toString('utf8');

	const kept: Array<{ name: string; value: string; from: string }> = [];
	for (const { name, from } of input.save ?? []) {
		const value = pick(response, text, from);
		await keepFromAnswer(taskId, name, value, host, proxy, readsDirect);
		kept.push({ name, value, from });
	}

	const hide = hider([...[...secrets.values()].map(({ name, value }) => ({ name, value })), ...kept, ...[...codes].map(([name, value]) => ({ name: `${name} code`, value }))]);
	const shownHeaders = Object.entries(response.headers)
		.filter(([name]) => SHOWN_HEADERS.test(name))
		.map(([name, value]) => `${name}: ${value}`);
	const notes = kept.map(({ name, from }) => `Kept ${from} as the sealed secret ${name}; use it as {{secret:${name}}}.`);
	let body = text.length > MAX_SHOWN ? `${text.slice(0, MAX_SHOWN)}\n[cut: the answer is ${text.length} characters]` : text;
	if (input.toFile) {
		const saved = await saveToLibrary(taskId, input.toFile, new TextEncoder().encode(hide(text)), response.headers['content-type']);
		body = `[${text.length} characters written to ${saved} in the Library (outputs/${saved} in a workspace), secrets hidden]`;
	}
	return hide([`HTTP ${response.status}`, ...shownHeaders, '', body, ...(notes.length ? ['', ...notes] : [])].join('\n'));
}

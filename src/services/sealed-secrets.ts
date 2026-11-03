import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config.ts';
import { announce } from '../core/changes.ts';
import { ConflictError, InvalidInputError, NotFoundError } from '../core/errors.ts';
import { getSetting, setSetting } from '../db/settings.ts';
import { proxyLabel, proxyParts } from './egress.ts';

/*
 * Sealed secrets: values the agent can use but never read. Unlike Settings ›
 * Secrets' variables, none of them reaches a sandbox, a shell or the model.
 * The agent names one in a request (`{{secret:NAME}}`, or `{{totp:NAME}}` for
 * the current code of a TOTP secret) and Anton fills it in on this server as
 * it sends the request (`http-request.ts`), only to the hosts the secret
 * allows, through the proxy it names, with its value hidden in the answer.
 * A token an API answers with can be kept the same way, so the agent never
 * holds that either.
 *
 * Values are stored encrypted (AES-256-GCM) with ANTON_SECRETS_KEY, or a key
 * Anton makes once in its data folder, so a copy of the database alone does
 * not give them away.
 */

const KEY = 'sealed-secrets';
const NAME = /^[A-Z][A-Z0-9_]{1,63}$/;
const HOST = /^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*$/;
const MAX_SECRETS = 100;
const MAX_VALUE = 16_384;

/** Who set it: you in Settings, or a task that saved it from an answer. */
export type SealedSource = { by: 'you' } | { by: 'task'; taskId: string };

type Stored = { value: string; hosts: string[]; proxy: string | null; source: SealedSource; updatedAt: string };

/** A sealed secret as the page sees it: never its value or the proxy's password. */
export type SealedSecretView = { name: string; hosts: string[]; proxy: string | null; source: SealedSource; updatedAt: string };

/** What the agent is told of one: its name and where it may go. */
export type SealedSecretBrief = { name: string; hosts: string[]; proxied: boolean };

/** A secret as a request uses it, decrypted. */
export type OpenSecret = { name: string; value: string; hosts: string[]; proxy: string | null; source: SealedSource };

let cachedKey: Buffer | undefined;

function key(): Buffer {
	if (cachedKey) return cachedKey;
	const given = process.env.ANTON_SECRETS_KEY;
	if (given) return (cachedKey = createHash('sha256').update(given).digest());
	const file = path.join(config.dataDir, 'sealed-secrets.key');
	try {
		cachedKey = Buffer.from(readFileSync(file, 'utf8').trim(), 'base64');
	} catch {
		mkdirSync(config.dataDir, { recursive: true });
		cachedKey = randomBytes(32);
		writeFileSync(file, cachedKey.toString('base64'), { mode: 0o600, flag: 'wx' });
	}
	return cachedKey;
}

/** For tests, which change the data folder or the key. */
export function forgetSealingKey(): void {
	cachedKey = undefined;
}

function seal(value: string): string {
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', key(), iv);
	const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
	return `v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${data.toString('base64')}`;
}

function unseal(sealed: string): string {
	const [version, iv, tag, data] = sealed.split(':');
	if (version !== 'v1' || !iv || !tag || data === undefined) throw new Error('A sealed secret is not in a form this Anton reads');
	const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
	decipher.setAuthTag(Buffer.from(tag, 'base64'));
	return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}

const stored = () => getSetting<Record<string, Stored>>(KEY, {});

function view(name: string, entry: Stored): SealedSecretView {
	return { name, hosts: entry.hosts, proxy: entry.proxy ? proxyLabel(unseal(entry.proxy)) : null, source: entry.source, updatedAt: entry.updatedAt };
}

export async function sealedSecretsView(): Promise<SealedSecretView[]> {
	return Object.entries(await stored())
		.map(([name, entry]) => view(name, entry))
		.sort((a, b) => a.name.localeCompare(b.name));
}

export async function sealedSecretBriefs(): Promise<SealedSecretBrief[]> {
	return Object.entries(await stored())
		.map(([name, entry]) => ({ name, hosts: entry.hosts, proxied: entry.proxy !== null }))
		.sort((a, b) => a.name.localeCompare(b.name));
}

/** The secrets a request names, decrypted; a name that is not set is left out. */
export async function openSecrets(names: string[]): Promise<Map<string, OpenSecret>> {
	const all = await stored();
	const open = new Map<string, OpenSecret>();
	for (const name of new Set(names)) {
		const entry = all[name];
		if (entry) open.set(name, { name, value: unseal(entry.value), hosts: entry.hosts, proxy: entry.proxy ? unseal(entry.proxy) : null, source: entry.source });
	}
	return open;
}

/** Every value, decrypted, to hide wherever an agent's output is read back. */
export async function sealedValues(): Promise<Record<string, string>> {
	const all = await stored();
	return Object.fromEntries(Object.entries(all).map(([name, entry]) => [name, unseal(entry.value)]));
}

/** Whether `host` is one of `hosts`; `*.example.com` takes its subdomains, not example.com itself. */
export function hostAllowed(host: string, hosts: string[]): boolean {
	const name = host.toLowerCase();
	return hosts.some((allowed) => (allowed.startsWith('*.') ? name.endsWith(allowed.slice(1)) && name.length > allowed.length - 1 : name === allowed));
}

function cleanHosts(hosts: string[]): string[] {
	const clean = [...new Set(hosts.map((host) => host.trim().toLowerCase()).filter(Boolean))];
	if (!clean.length) throw new InvalidInputError('Name at least one host the secret may be sent to, such as api.example.com');
	const bad = clean.find((host) => !HOST.test(host));
	if (bad) throw new InvalidInputError(`${bad} is not a host name, such as api.example.com or *.example.com`);
	return clean;
}

/**
 * What the page sends. `value` and `proxy` left out (or null) keep what is stored; an empty `proxy`
 * removes it. A new secret needs a value.
 */
export type SealedSecretInput = { name: string; value?: string | null; hosts: string[]; proxy?: string | null };

export async function saveSealedSecret(input: SealedSecretInput): Promise<SealedSecretView[]> {
	if (!NAME.test(input.name)) throw new InvalidInputError('A name is capital letters, digits and _, starting with a letter, such as BROKER_API_KEY');
	const all = await stored();
	const current = all[input.name];
	if (!current && !input.value) throw new InvalidInputError('Give the secret a value');
	if (!current && Object.keys(all).length >= MAX_SECRETS) throw new InvalidInputError(`Up to ${MAX_SECRETS} sealed secrets can be kept`);
	if (input.value && input.value.length > MAX_VALUE) throw new InvalidInputError('A sealed secret is up to 16 KB');
	if (input.proxy) {
		try {
			proxyParts(input.proxy);
		} catch (error) {
			throw new InvalidInputError(error instanceof Error ? error.message : String(error));
		}
	}
	const proxy = input.proxy === '' ? null : input.proxy ? seal(input.proxy) : (current?.proxy ?? null);
	all[input.name] = {
		value: input.value ? seal(input.value) : current!.value,
		hosts: cleanHosts(input.hosts),
		proxy,
		source: { by: 'you' },
		updatedAt: new Date().toISOString(),
	};
	await setSetting(KEY, all);
	announce({ kind: 'connectors' });
	return sealedSecretsView();
}

export async function deleteSealedSecret(name: string): Promise<SealedSecretView[]> {
	const all = await stored();
	if (!all[name]) throw new NotFoundError('No sealed secret has that name');
	delete all[name];
	await setSetting(KEY, all);
	announce({ kind: 'connectors' });
	return sealedSecretsView();
}

/** Checked before a request is sent, so one whose answer could not be kept is not sent at all. */
export async function assertKeepable(name: string): Promise<void> {
	if (!NAME.test(name)) throw new InvalidInputError(`${name} is not a secret name: capital letters, digits and _, starting with a letter`);
	if ((await stored())[name]?.source.by === 'you') throw new ConflictError(`${name} was set in Settings, so a task cannot replace it; save under another name`);
}

/**
 * Keeps a value a task's request was answered with (a sign-in's token) as a sealed secret, sent only
 * where that request went and through the same proxy. A task may replace what a task saved, never
 * one you set.
 */
export async function keepFromAnswer(taskId: string, name: string, value: string, host: string, proxy: string | null): Promise<void> {
	await assertKeepable(name);
	const all = await stored();
	const current = all[name];
	if (!current && Object.keys(all).length >= MAX_SECRETS) throw new InvalidInputError(`Up to ${MAX_SECRETS} sealed secrets can be kept`);
	all[name] = { value: seal(value), hosts: [host.toLowerCase()], proxy: proxy ? seal(proxy) : null, source: { by: 'task', taskId }, updatedAt: new Date().toISOString() };
	await setSetting(KEY, all);
	announce({ kind: 'connectors' });
}

// Antigravity subscription quota — the 5-hour and weekly usage bars in Settings.
// agy/acp reports the account tier but no quota over ACP, so, like T3 Code, this
// reads Google's own `retrieveUserQuotaSummary` with the OAuth token the sign-in
// already keeps. Read-only, and the token file is never written: agy owns it and
// may rotate the refresh token, so refreshes live in memory only.

import type { PlanWindow } from '../../core/ports.ts';
import { antigravityRefresh, readCredential } from './oauth.ts';

const DAILY = 'https://daily-cloudcode-pa.googleapis.com';
const PROD = 'https://cloudcode-pa.googleapis.com';
// Consumer accounts are metered on the daily host, business/GCP-terms on prod;
// the file's auth_method picks the order and the first host's reading of a
// bucket wins (T3 hit the wrong-host bug before ordering by sign-in method).
const USER_AGENT = `antigravity/hub/2.24.0 (aidev_client; os_type=${process.platform}; arch=${process.arch}; cl=963137146)`;
const TTL_MS = 60_000;
const REQUEST_MS = 10_000;

const WINDOW_MINS: Record<string, number> = { '5h': 300, weekly: 10_080 };

type Token = { access_token?: string; refresh_token?: string; expiry?: string };
type Quota = { remainingFraction?: number; resetTime?: string };
type Bucket = Quota & { bucketId?: string; window?: string; displayName?: string; description?: string; disabled?: boolean };
type Summary = { groups?: { displayName?: string; buckets?: Bucket[] }[]; buckets?: Bucket[] };
type Models = { models?: Record<string, { modelProvider?: string; quotaInfo?: Quota; weeklyQuotaInfo?: Quota }> };

const usedPercent = (remaining: number) => Math.round((1 - Math.max(0, Math.min(1, remaining))) * 1000) / 10;
const iso = (value: string | undefined): string | null => {
	if (!value) return null;
	const at = Date.parse(value);
	return Number.isNaN(at) ? null : new Date(at).toISOString();
};

function familyOf(bucketId: string | undefined, group: string | undefined): string {
	if (bucketId?.startsWith('gemini-argon-')) return group || 'Gemini Argon';
	if (bucketId?.startsWith('gemini-carbon-')) return group || 'Gemini Carbon';
	if (bucketId?.startsWith('gemini-')) return 'Gemini';
	if (bucketId?.startsWith('3p-')) return 'Claude & GPT (shared)';
	return group || bucketId || 'Quota';
}

/** Untouched buckets report a rolling full-window reset — showing it would claim a reset that is not coming. */
function summaryReset(bucket: Bucket, requestedAt: number): string | null {
	const mins = WINDOW_MINS[bucket.window ?? ''];
	const untouched =
		bucket.remainingFraction === 1 &&
		!bucket.description &&
		mins !== undefined &&
		Math.abs(Date.parse(bucket.resetTime ?? '') - requestedAt - mins * 60_000) <= 60_000;
	return untouched ? null : iso(bucket.resetTime);
}

/** retrieveUserQuotaSummary buckets → windows, keyed by bucketId for the endpoint merge. */
export function summaryWindows(summary: unknown, requestedAt: number): Map<string, PlanWindow> {
	const s = summary as Summary;
	const groups = s.groups?.some((g) => g.buckets?.length) ? s.groups : [{ displayName: undefined, buckets: s.buckets }];
	const out = new Map<string, PlanWindow>();
	for (const group of groups ?? []) {
		for (const bucket of group.buckets ?? []) {
			if (bucket.disabled || typeof bucket.remainingFraction !== 'number' || !bucket.bucketId) continue;
			const remaining = bucket.remainingFraction;
			const used = usedPercent(remaining);
			const period = bucket.window === 'weekly' ? 'Weekly' : bucket.window === '5h' ? '5-hour' : bucket.displayName?.trim() || 'Quota';
			out.set(bucket.bucketId, {
				label: `${familyOf(bucket.bucketId, group.displayName?.trim())} · ${period}`,
				usedPercent: used,
				resetsAt: summaryReset(bucket, requestedAt),
				limited: used >= 100,
			});
		}
	}
	return out;
}

/** Older accounts expose per-model quotas without window lengths; no reset cadence is invented. */
export function modelWindows(models: unknown): Map<string, PlanWindow> {
	const m = models as Models;
	const out = new Map<string, PlanWindow>();
	for (const [modelId, model] of Object.entries(m.models ?? {})) {
		const family =
			model.modelProvider === 'MODEL_PROVIDER_GOOGLE' || modelId.startsWith('gemini-')
				? 'Gemini'
				: model.modelProvider === 'MODEL_PROVIDER_ANTHROPIC' || modelId.startsWith('claude-')
					? 'Claude'
					: model.modelProvider === 'MODEL_PROVIDER_OPENAI' || modelId.startsWith('gpt-')
						? 'GPT'
						: null;
		if (!family) continue;
		for (const [suffix, quota] of [
			['quota', model.quotaInfo],
			['weekly', model.weeklyQuotaInfo],
		] as const) {
			if (typeof quota?.remainingFraction !== 'number') continue;
			const used = usedPercent(quota.remainingFraction);
			const id = `${family.toLowerCase()}-${suffix}`;
			const previous = out.get(id);
			if (previous && previous.usedPercent >= used) continue;
			out.set(id, {
				label: `${family} · ${suffix === 'weekly' ? 'Weekly' : 'Reported quota'}`,
				usedPercent: used,
				resetsAt: iso(quota.resetTime),
				limited: used >= 100,
			});
		}
	}
	return out;
}

async function post(endpoint: string, operation: string, accessToken: string): Promise<unknown | null> {
	try {
		const res = await fetch(`${endpoint}/v1internal:${operation}`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': USER_AGENT },
			body: '{}',
			redirect: 'manual',
			signal: AbortSignal.timeout(REQUEST_MS),
		});
		if (!res.ok) return null;
		return (await res.json()) as unknown;
	} catch {
		return null;
	}
}

// One refresh per grant at a time; the file's own expiry decides first so a
// fresh file never costs a token call.
let refreshed: { refreshToken: string; accessToken: string; expiresAt: number } | null = null;

async function accessTokenFor(token: Token): Promise<string | null> {
	const now = Date.now();
	if (refreshed && refreshed.refreshToken === token.refresh_token && refreshed.expiresAt > now + 60_000) return refreshed.accessToken;
	if (token.access_token && Date.parse(token.expiry ?? '') > now + 60_000) return token.access_token;
	if (!token.refresh_token) return token.access_token ?? null;
	try {
		const next = await antigravityRefresh(token.refresh_token);
		refreshed = { refreshToken: token.refresh_token, accessToken: next.accessToken, expiresAt: now + next.expiresIn * 1000 };
		return next.accessToken;
	} catch {
		return null;
	}
}

async function readWindows(file: string): Promise<PlanWindow[] | null> {
	const credential = await readCredential(file);
	if (!credential) return null;
	const parsed = JSON.parse(credential) as { token?: Token; auth_method?: string };
	const token = parsed.token;
	if (!token?.access_token) return null;
	const accessToken = await accessTokenFor(token);
	if (!accessToken) return null;
	const endpoints = parsed.auth_method === 'consumer' ? [DAILY, PROD] : [PROD, DAILY];
	const requestedAt = Date.now();
	const windows = new Map<string, PlanWindow>();
	const merge = (source: Map<string, PlanWindow>) => {
		for (const [id, window] of source) if (!windows.has(id)) windows.set(id, window);
	};
	// The summary carries windowed buckets; models carry the older per-model quotas.
	// Both hosts answer concurrently; endpoint order decides which reading wins.
	const summaries = await Promise.all(endpoints.map((endpoint) => post(endpoint, 'retrieveUserQuotaSummary', accessToken)));
	for (const summary of summaries) if (summary) merge(summaryWindows(summary, requestedAt));
	if (!windows.size) {
		const models = await Promise.all(endpoints.map((endpoint) => post(endpoint, 'fetchAvailableModels', accessToken)));
		for (const model of models) if (model) merge(modelWindows(model));
	}
	return windows.size ? [...windows.values()] : null;
}

let cache: { at: number; value: PlanWindow[] | null } | null = null;
let lastGood: PlanWindow[] | null = null;
let inflight: Promise<PlanWindow[] | null> | null = null;

/**
 * The plan's usage windows, or null when unsigned/unsupported. Cached for a
 * minute like the other plans' windows; a failed read serves the last good
 * answer so one flaky probe does not blank the bars.
 */
export async function antigravityWindows(file: string): Promise<PlanWindow[] | null> {
	if (cache && Date.now() - cache.at < TTL_MS) return cache.value ?? lastGood;
	inflight ??= readWindows(file).catch(() => null);
	const value = await inflight.finally(() => {
		inflight = null;
	});
	cache = { at: Date.now(), value };
	if (value?.length) lastGood = value;
	return value ?? lastGood;
}

import { config } from '../../config.ts';

/**
 * Composio's REST API (v3.1): the apps connector's catalog, managed auth and
 * tool execution. Every call carries the project API key in `x-api-key`;
 * connected accounts' tokens stay inside Composio and never reach Anton.
 */

export type ComposioToolkit = {
	slug: string;
	name: string;
	description: string;
	logo: string;
	appUrl: string | null;
	categories: string[];
	toolsCount: number;
	noAuth: boolean;
};

export type ComposioTool = {
	slug: string;
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	tags: string[];
};

export type ComposioAccount = {
	id: string;
	toolkit: string;
	/** word_id or alias, for showing which account is connected. */
	label: string | null;
	status: string;
	statusReason: string | null;
	createdAt: string;
};

export type ComposioLink = { redirectUrl: string; accountId: string; expiresAt: string };

export type ComposioPage<T> = { items: T[]; nextCursor: string | null };

class ComposioError extends Error {
	readonly status: number;
	constructor(message: string, status: number) {
		super(message);
		this.name = 'ComposioError';
		this.status = status;
	}
}

async function call<T>(apiKey: string, method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
	const response = await fetch(`${config.composio.apiUrl}${path}`, {
		method,
		headers: { 'x-api-key': apiKey, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
		body: body === undefined ? undefined : JSON.stringify(body),
		signal: signal ?? AbortSignal.timeout(30_000),
	});
	const text = await response.text();
	let data: unknown = null;
	try {
		data = text ? JSON.parse(text) : null;
	} catch {}
	if (!response.ok) {
		const message = (data as { error?: { message?: string } } | null)?.error?.message ?? text.slice(0, 300);
		throw new ComposioError(`Composio answered ${response.status}: ${message}`, response.status);
	}
	return data as T;
}

const query = (params: Record<string, string | number | undefined>) => {
	const search = new URLSearchParams();
	for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== '') search.set(key, String(value));
	const text = search.toString();
	return text ? `?${text}` : '';
};

const rawToolkit = (item: Record<string, unknown>) => {
	const meta = (item.meta ?? {}) as Record<string, unknown>;
	const categories = (meta.categories ?? []) as Array<{ name?: string }>;
	return {
		slug: String(item.slug ?? ''),
		name: String(item.name ?? item.slug ?? ''),
		description: String(meta.description ?? ''),
		logo: String(meta.logo ?? ''),
		appUrl: meta.app_url == null ? null : String(meta.app_url),
		categories: categories.map((category) => String(category.name ?? '')).filter(Boolean),
		toolsCount: Number(meta.tools_count ?? 0),
		noAuth: item.no_auth === true,
	} satisfies ComposioToolkit;
};

const rawTool = (item: Record<string, unknown>) => ({
	slug: String(item.slug ?? ''),
	name: String(item.name ?? item.slug ?? ''),
	description: String(item.description ?? ''),
	inputSchema: (item.input_parameters ?? {}) as Record<string, unknown>,
	tags: Array.isArray(item.tags) ? (item.tags as unknown[]).map(String) : [],
}) satisfies ComposioTool;

const rawAccount = (item: Record<string, unknown>) => {
	const toolkit = (item.toolkit ?? {}) as Record<string, unknown>;
	const state = (item.state ?? {}) as Record<string, unknown>;
	return {
		id: String(item.id ?? ''),
		toolkit: String(toolkit.slug ?? ''),
		label: (item.word_id ?? item.alias ?? null) as string | null,
		status: String(item.status ?? state.status ?? ''),
		statusReason: (item.status_reason ?? null) as string | null,
		createdAt: String(item.created_at ?? ''),
	} satisfies ComposioAccount;
};

/** Toolkits matching a search, best first; `slug` narrows to one. */
export async function listToolkits(apiKey: string, options: { search?: string; slug?: string; limit?: number } = {}): Promise<ComposioToolkit[]> {
	const page = await call<{ items: Array<Record<string, unknown>> }>(
		apiKey,
		'GET',
		`/toolkits${query({ search: options.slug ?? options.search, limit: options.limit ?? 50 })}`,
	);
	return (page.items ?? []).map(rawToolkit).filter((toolkit) => !options.slug || toolkit.slug === options.slug);
}

/** A toolkit's tools, every page up to `max`; deprecated ones left out. */
export async function listToolkitTools(apiKey: string, toolkit: string, max = 3): Promise<ComposioTool[]> {
	const tools: ComposioTool[] = [];
	let cursor: string | undefined;
	for (let page = 0; page < max; page++) {
		const result = await call<{ items: Array<Record<string, unknown>>; next_cursor?: string | null }>(
			apiKey,
			'GET',
			`/tools${query({ toolkit_slug: toolkit, limit: 1000, cursor })}`,
		);
		for (const item of result.items ?? []) {
			if (item.is_deprecated === true) continue;
			tools.push(rawTool(item));
		}
		cursor = result.next_cursor ?? undefined;
		if (!cursor) break;
	}
	return tools;
}

/** The project's Composio-managed auth config for a toolkit, made on first use. */
export async function managedAuthConfig(apiKey: string, toolkit: string): Promise<string> {
	const found = await call<{ items: Array<Record<string, unknown>> }>(apiKey, 'GET', `/auth_configs${query({ toolkit_slug: toolkit, is_composio_managed: 'true', limit: 50 })}`);
	const enabled = (found.items ?? []).find((item) => item.status === 'ENABLED' && item.is_composio_managed === true);
	if (enabled) return String(enabled.id);
	const created = await call<{ auth_config: { id: string } }>(apiKey, 'POST', '/auth_configs', {
		toolkit: { slug: toolkit },
		auth_config: { type: 'use_composio_managed_auth' },
	});
	return created.auth_config.id;
}

/** A hosted sign-in page for the user to authorize the toolkit; the account it makes is `accountId`. */
export async function createLink(apiKey: string, input: { authConfigId: string; userId: string; callbackUrl?: string }): Promise<ComposioLink> {
	const link = await call<{ redirect_url: string; connected_account_id: string; expires_at: string }>(apiKey, 'POST', '/connected_accounts/link', {
		auth_config_id: input.authConfigId,
		user_id: input.userId,
		...(input.callbackUrl ? { callback_url: input.callbackUrl } : {}),
	});
	return { redirectUrl: link.redirect_url, accountId: link.connected_account_id, expiresAt: link.expires_at };
}

export async function getConnectedAccount(apiKey: string, id: string): Promise<ComposioAccount | null> {
	try {
		return rawAccount((await call<Record<string, unknown>>(apiKey, 'GET', `/connected_accounts/${encodeURIComponent(id)}`)) ?? {});
	} catch (error) {
		if (error instanceof ComposioError && error.status === 404) return null;
		throw error;
	}
}

/** The user's connected accounts for the given toolkits (empty toolkits means all). */
export async function listConnectedAccounts(apiKey: string, input: { userId: string; toolkits?: string[]; statuses?: string[] }): Promise<ComposioAccount[]> {
	const page = await call<{ items: Array<Record<string, unknown>> }>(
		apiKey,
		'GET',
		`/connected_accounts${query({
			user_ids: input.userId,
			toolkit_slugs: input.toolkits?.length ? input.toolkits.join(',') : undefined,
			statuses: input.statuses?.length ? input.statuses.join(',') : undefined,
			limit: 100,
		})}`,
	);
	return (page.items ?? []).map(rawAccount);
}

/** Forgets an unfinished connection, so connecting again does not leave strays. */
export async function deleteConnectedAccount(apiKey: string, id: string): Promise<void> {
	await call(apiKey, 'DELETE', `/connected_accounts/${encodeURIComponent(id)}`).catch(() => undefined);
}

/** Revokes the grant at the provider, then removes the account. */
export async function revokeConnectedAccount(apiKey: string, id: string): Promise<void> {
	await call(apiKey, 'POST', `/connected_accounts/${encodeURIComponent(id)}/revoke`).catch(() => undefined);
	await deleteConnectedAccount(apiKey, id);
}

export type ComposioExecution = { data: unknown; error: string | null; successful: boolean; logId: string | null };

/** Runs one tool on the user's connected account; Composio holds and refreshes its credentials. */
export async function executeTool(
	apiKey: string,
	toolSlug: string,
	input: { userId: string; connectedAccountId?: string | null; args: Record<string, unknown> },
	signal?: AbortSignal,
): Promise<ComposioExecution> {
	const result = await call<Record<string, unknown>>(apiKey, 'POST', `/tools/execute/${encodeURIComponent(toolSlug)}`, {
		user_id: input.userId,
		...(input.connectedAccountId ? { connected_account_id: input.connectedAccountId } : {}),
		arguments: input.args,
	}, signal);
	return {
		data: result.data,
		error: (result.error ?? null) as string | null,
		successful: result.successful === true,
		logId: (result.log_id ?? null) as string | null,
	};
}

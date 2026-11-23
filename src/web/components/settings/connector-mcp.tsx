import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { ExternalLink, Plus, X } from '@/lib/icons';
import { useId, useState } from 'react';
import { MCP, useServerMark } from '@/components/marks/brand-marks';
import { Btn, IconBtn, Spinner, Switch } from '@/components/kit/signal';
import { api } from '@/lib/api';
import type { ConnectorsView, McpServer, McpServerInput } from '@/lib/api/connectors';
import { type CatalogEntry, catalogEntryFor } from '@/lib/connector-catalog';
import { connectorItems, connectorKey } from '@/lib/connectors';
import { cn } from '@/lib/utils';
import { FIELD, Note, SettingRow } from './parts';
import { ConsoleLink, CopyField, DetailFrame, DocsLink, ErrorLine, type Fact, hostOf, OnSwitch, type Opened, Prose, Returned, Section, since, ToolChips, useConnectorMutation, useConnectors } from './connector-parts';

/** A custom header row; a stored one keeps its value unless a new one is typed. */
type HeaderRow = { name: string; value: string; stored: boolean };

/** A server row being added or edited; `token` and header values are only what was typed, since stored secrets are never sent back. */
type Draft = { name: string; url: string; token: string; clearToken: boolean; headers: HeaderRow[]; tools: string; codeMode: boolean };

const FIELD_LABEL = 'text-small font-medium text-(--text-2)';
const FIELD_HINT = 'text-micro text-(--text-3)';

const toDraft = (server?: McpServer): Draft => ({
	name: server?.name ?? '',
	url: server?.url ?? '',
	token: '',
	clearToken: false,
	headers: (server?.headerNames ?? []).map((name) => ({ name, value: '', stored: true })),
	tools: server?.tools.join(', ') ?? '',
	codeMode: server ? server.codeMode !== false : true,
});

function toHeaders(rows: HeaderRow[]): Record<string, string | null> {
	const entries: Array<[string, string | null]> = [];
	const seen = new Set<string>();
	for (const row of rows) {
		const name = row.name.trim();
		const value = row.value.trim();
		if (!name && !value) continue;
		if (!name) throw new Error('Enter a header name for every custom header.');
		if (!row.stored && !value) throw new Error(`Enter a value for header ${name}.`);
		const lower = name.toLowerCase();
		if (seen.has(lower)) throw new Error('Each header needs its own name.');
		seen.add(lower);
		entries.push([name, row.stored && !value ? null : value]);
	}
	return Object.fromEntries(entries);
}

function toInput(draft: Draft, editing: McpServer | null): McpServerInput {
	const headers = toHeaders(draft.headers);
	const token = draft.token.trim();
	return {
		name: draft.name.trim(),
		url: draft.url.trim(),
		// Null keeps a stored token when editing; an empty one says there is none.
		auth: token ? token : draft.clearToken ? '' : editing ? null : '',
		...(editing || Object.keys(headers).length ? { headers } : {}),
		tools: draft.tools.split(/[\s,]+/).filter(Boolean),
		...(draft.codeMode ? {} : { codeMode: false }),
	};
}

function ServerForm({ editing, onDone, onSaved }: { editing: McpServer | null; onDone: () => void; onSaved?: (name: string) => void }) {
	const id = useId();
	const [draft, setDraft] = useState(() => toDraft(editing ?? undefined));
	const update = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));
	const updateHeader = (index: number, patch: Partial<HeaderRow>) =>
		setDraft((current) => ({ ...current, headers: current.headers.map((row, at) => (at === index ? { ...row, ...patch } : row)) }));
	const removeHeader = (index: number) =>
		setDraft((current) => ({ ...current, headers: current.headers.filter((_, at) => at !== index) }));
	const save = useConnectorMutation(async () => (editing ? api.updateMcpServer(toInput(draft, editing)) : api.addMcpServer(toInput(draft, null))));
	return (
		<form
			className="flex flex-col gap-4 rounded-control border border-(--line) p-4"
			onSubmit={(event) => {
				event.preventDefault();
				save.mutate(undefined, { onSuccess: () => (onSaved ? onSaved(draft.name.trim()) : onDone()) });
			}}
		>
			<div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
				<div className="flex min-w-0 flex-col gap-1">
					<label htmlFor={`${id}-name`} className={FIELD_LABEL}>
						Server name
					</label>
					<input
						id={`${id}-name`}
						type="text"
						value={draft.name}
						readOnly={Boolean(editing)}
						onChange={(event) => update({ name: event.target.value })}
						placeholder="e.g. AWS"
						spellCheck={false}
						aria-describedby={`${id}-name-hint`}
						className={cn(FIELD, 'font-mono read-only:text-(--text-2)')}
					/>
					<span id={`${id}-name-hint`} className={FIELD_HINT}>
						{editing ? 'Server name cannot be changed after adding.' : 'Letters, digits, spaces, - and _'}
					</span>
				</div>
				<div className="flex min-w-0 flex-col gap-1">
					<label htmlFor={`${id}-url`} className={FIELD_LABEL}>
						Server URL
					</label>
					<input
						id={`${id}-url`}
						type="url"
						value={draft.url}
						onChange={(event) => update({ url: event.target.value })}
						placeholder="https://mcp.example.com/mcp"
						spellCheck={false}
						aria-describedby={`${id}-url-hint`}
						className={cn(FIELD, 'font-mono')}
					/>
					<span id={`${id}-url-hint`} className={FIELD_HINT}>
						Remote MCP endpoint over https.
					</span>
				</div>
			</div>

			<div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
				<div className="flex min-w-0 flex-col gap-1">
					<div className="flex items-baseline gap-1.5">
						<label htmlFor={`${id}-token`} className={FIELD_LABEL}>
							Bearer token
						</label>
						<span className={FIELD_HINT}>Optional</span>
					</div>
					<div className="flex min-w-0 items-center gap-1.5">
						<input
							id={`${id}-token`}
							type="password"
							autoComplete="off"
							value={draft.token}
							onChange={(event) => update({ token: event.target.value, clearToken: false })}
							placeholder={
								editing?.hasAuth && !draft.clearToken
									? 'Token saved. Type to replace'
									: draft.clearToken
										? 'Token will be removed on save'
										: 'Paste bearer token'
							}
							aria-describedby={`${id}-token-hint`}
							className={cn(FIELD, 'min-w-0 flex-1 font-mono')}
						/>
						{editing?.hasAuth && !draft.clearToken && !draft.token ? (
							<Btn type="button" size="sm" variant="ghost" aria-label="Remove saved token" onClick={() => update({ clearToken: true })}>
								Remove
							</Btn>
						) : null}
					</div>
					<span id={`${id}-token-hint`} className={FIELD_HINT}>
						Sent as Authorization: Bearer. Leave blank for OAuth or custom headers.
					</span>
				</div>
				<div className="flex min-w-0 flex-col gap-1">
					<div className="flex items-baseline gap-1.5">
						<label htmlFor={`${id}-tools`} className={FIELD_LABEL}>
							Tools
						</label>
						<span className={FIELD_HINT}>Optional</span>
					</div>
					<input
						id={`${id}-tools`}
						type="text"
						value={draft.tools}
						onChange={(event) => update({ tools: event.target.value })}
						placeholder="search, fetch"
						spellCheck={false}
						aria-describedby={`${id}-tools-hint`}
						className={cn(FIELD, 'font-mono')}
					/>
					<span id={`${id}-tools-hint`} className={FIELD_HINT}>
						Comma-separated tool names to allow, or leave blank for all.
					</span>
				</div>
			</div>

			<fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
				<legend className={cn(FIELD_LABEL, 'inline-flex items-baseline gap-1.5 p-0')}>
					<span>Custom headers</span>
					<span className={cn(FIELD_HINT, 'font-normal')}>Optional</span>
				</legend>
				<span className={FIELD_HINT}>Extra HTTP headers sent on every request; values are never shown again.</span>
				{draft.headers.length ? (
					<div className="flex flex-col gap-2">
						<div className="hidden grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto] items-center gap-2 text-micro text-(--text-3) sm:grid">
							<span>Header name</span>
							<span>Header value</span>
							<span className="w-7" aria-hidden />
						</div>
						{draft.headers.map((row, index) => (
							<div key={index} className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto]">
								<div className="col-span-2 flex min-w-0 flex-col gap-1 sm:col-span-1">
									<label htmlFor={`${id}-header-name-${index}`} className="text-micro text-(--text-3) sm:sr-only">
										Header name
									</label>
									<input
										id={`${id}-header-name-${index}`}
										type="text"
										value={row.name}
										readOnly={row.stored}
										onChange={(event) => updateHeader(index, { name: event.target.value })}
										placeholder="X-API-Key"
										spellCheck={false}
										className={cn(FIELD, 'font-mono read-only:text-(--text-2)')}
									/>
								</div>
								<div className="flex min-w-0 flex-col gap-1">
									<label htmlFor={`${id}-header-value-${index}`} className="text-micro text-(--text-3) sm:sr-only">
										{row.name.trim() ? `Value for ${row.name.trim()}` : 'Header value'}
									</label>
									<input
										id={`${id}-header-value-${index}`}
										type="password"
										autoComplete="new-password"
										value={row.value}
										onChange={(event) => updateHeader(index, { value: event.target.value })}
										placeholder={row.stored ? 'Saved. Type to replace' : 'Header value'}
										className={cn(FIELD, 'font-mono')}
									/>
								</div>
								<IconBtn
									icon={X}
									size="sm"
									label={row.name.trim() ? `Remove header ${row.name.trim()}` : 'Remove header'}
									onClick={() => removeHeader(index)}
								/>
							</div>
						))}
					</div>
				) : null}
				<Btn type="button" size="sm" variant="ghost" icon={Plus} className="self-start" onClick={() => update({ headers: [...draft.headers, { name: '', value: '', stored: false }] })}>
					Add header
				</Btn>
			</fieldset>

			<div className="flex flex-col gap-2 border-t border-(--line) pt-3">
				<ErrorLine error={save.error} />
				<div className="flex flex-wrap items-center gap-3">
					<Switch checked={draft.codeMode} onChange={(codeMode) => update({ codeMode })} label={<span className="text-small text-(--text-2)">Scripts can call it</span>} />
					{editing && editing.signIn.state !== 'none' ? <SignOut name={editing.name} /> : null}
					<span className="flex-1" />
					<Btn type="button" size="sm" variant="ghost" onClick={onDone}>
						Cancel
					</Btn>
					<Btn type="submit" size="sm" variant="primary" disabled={save.isPending || !draft.name.trim() || !draft.url.trim()}>
						{save.isPending ? 'Saving…' : editing ? 'Save server' : 'Add server'}
					</Btn>
				</div>
			</div>
		</form>
	);
}

function ServerTools({ name }: { name: string }) {
	const tools = useQuery({ queryKey: ['mcp-tools', name], queryFn: () => api.mcpServerTools(name), retry: false, staleTime: 30_000 });
	if (tools.isPending) return <Spinner size={12} />;
	if (tools.isError) return <span className="text-small text-(--bad)">{tools.error.message}</span>;
	if (!tools.data.tools.length) return <span className="text-small text-(--text-3)">It answered with no tools.</span>;
	return <ToolChips tools={tools.data.tools.map((tool) => ({ name: tool.name, about: tool.description ?? '' }))} />;
}

function SignOut({ name }: { name: string }) {
	const signOut = useConnectorMutation(() => api.signOutMcpServer(name));
	return (
		<Btn size="sm" variant="ghost" disabled={signOut.isPending} onClick={() => signOut.mutate(undefined)}>
			{signOut.isPending ? 'Signing out…' : 'Sign out'}
		</Btn>
	);
}

function useSignIn(server: McpServer) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (client?: { clientId: string; clientSecret: string | null }) => api.signInMcpServer(server.name, client),
		onSuccess: ({ url, mcpServers }) => {
			if (url) window.location.assign(url);
			else queryClient.setQueryData<ConnectorsView>(['connectors'], (current) => (current ? { ...current, mcpServers } : current));
		},
	});
}

/** For a server that lets no app register itself: an OAuth app you made in the service's settings, with Anton's redirect URI. */
function OwnClient({ server, signIn }: { server: McpServer; signIn: ReturnType<typeof useSignIn> }) {
	const [clientId, setClientId] = useState(server.signIn.clientId ?? '');
	const [secret, setSecret] = useState('');
	// GitHub's MCP server signs in with GitHub, where the app is an OAuth app whose callback URL is this redirect URI.
	const github = /(^|\.)githubcopilot\.com$/.test(hostOf(server.url));
	return (
		<form
			className="flex flex-col gap-2 rounded-control border border-(--line) px-3 py-2.5"
			onSubmit={(event) => {
				event.preventDefault();
				signIn.mutate({ clientId: clientId.trim(), clientSecret: secret || null });
			}}
		>
			{github ? (
				<Note info="The sign-in asks for the scopes GitHub's MCP server lists; a token works with the scopes you give it.">
					In GitHub, <ConsoleLink href="https://github.com/settings/applications/new">register a new OAuth app</ConsoleLink> with this redirect URI as its authorization callback URL, then
					paste its client id and a client secret you generate on its page. Or skip the app and paste a{' '}
					<ConsoleLink href="https://github.com/settings/personal-access-tokens/new">personal access token</ConsoleLink> with Edit address and token.
				</Note>
			) : (
				<Note info="In the service's developer settings, create an OAuth app with this redirect URI, then paste its client id, and its secret if it has one.">
					Create an OAuth app with this redirect URI.
				</Note>
			)}
			<CopyField value={`${window.location.origin}/api/mcp-servers/callback`} label="Redirect URI" />
			<div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
				<input value={clientId} onChange={(event) => setClientId(event.target.value)} placeholder="Client id" aria-label="OAuth client id" className={cn(FIELD, 'font-mono')} />
				<input
					type="password"
					autoComplete="off"
					value={secret}
					onChange={(event) => setSecret(event.target.value)}
					placeholder={server.signIn.pastedClient ? 'Secret kept. Type to replace' : 'Client secret (if it has one)'}
					aria-label="OAuth client secret"
					className={cn(FIELD, 'font-mono')}
				/>
			</div>
			<Btn type="submit" size="sm" variant="primary" icon={ExternalLink} className="self-end" disabled={signIn.isPending || !clientId.trim()}>
				{signIn.isPending ? 'Opening…' : 'Sign in with this app'}
			</Btn>
		</form>
	);
}

export function ServerDetail({ server, search }: { server: McpServer; search: Opened }) {
	const navigate = useNavigate();
	const [editing, setEditing] = useState(false);
	const [confirming, setConfirming] = useState(false);
	const remove = useConnectorMutation(() => api.removeMcpServer(server.name));
	const codeMode = useConnectorMutation((on: boolean) =>
		api.updateMcpServer({ name: server.name, url: server.url, auth: null, tools: server.tools, ...(on ? {} : { codeMode: false }) }),
	);
	const signIn = useSignIn(server);
	const mark = useServerMark(server.url);
	const entry = catalogEntryFor(server.url);
	const item = connectorItems(useConnectors().data).find((each) => each.kind === 'mcp' && each.server.name === server.name) ?? null;
	const headerNames = server.headerNames ?? [];
	const hasAuthHeader = headerNames.some((name) => name.toLowerCase() === 'authorization');
	const signedIn = !hasAuthHeader && server.signIn.state === 'signed-in';
	const needsSignIn = !hasAuthHeader && server.signIn.state === 'needed';
	const offerSignIn = !signedIn && !server.hasAuth && !hasAuthHeader;
	const noRegistration = /register themselves/.test(signIn.error?.message ?? '');
	const facts: Fact[] = [
		{ label: 'Made by', value: entry?.by ?? hostOf(server.url) },
		...(entry ? [{ label: 'Category', value: entry.category }] : []),
		{
			label: 'Sign-in',
			value: hasAuthHeader
				? 'Custom Authorization header'
				: signedIn
					? `Signed in${server.signIn.since ? ` since ${since(server.signIn.since)}` : ''}`
					: server.hasAuth
						? 'Bearer token'
						: needsSignIn
							? 'Needs signing in again'
							: 'None yet',
		},
		{ label: 'Connector URL', value: <span className="text-small break-all">{server.url}</span> },
		...(headerNames.length ? [{ label: 'Custom headers', value: headerNames.join(', ') }] : []),
		{ label: 'Tools allowed', value: server.tools.length ? server.tools.join(', ') : 'All' },
		{ label: 'Added', value: since(server.addedAt) },
		...(entry?.docs ? [{ label: 'More info', value: <DocsLink href={entry.docs} /> }] : []),
	];
	return (
		<DetailFrame
			mark={mark}
			title={entry && entry.id === server.name ? entry.name : server.name}
			mono={!entry}
			tagline={entry?.tagline ?? 'A remote MCP server'}
			facts={facts}
			actions={
				<>
					{offerSignIn ? (
						<Btn size="sm" variant={needsSignIn ? 'primary' : 'secondary'} icon={ExternalLink} disabled={signIn.isPending} onClick={() => signIn.mutate(undefined)}>
							{signIn.isPending ? 'Opening…' : needsSignIn ? 'Sign in again' : 'Sign in'}
						</Btn>
					) : null}
					{item ? <OnSwitch item={item} label={<span className="text-body text-(--text-2)">On for tasks</span>} /> : null}
				</>
			}
		>
			<Returned search={search} />
			<Prose>{entry?.description ?? `A remote MCP server at ${hostOf(server.url)}. Its tools are listed below as the agent finds them.`}</Prose>
			{needsSignIn ? <span className="text-small text-(--bad)">{server.signIn.problem}</span> : null}
			<ErrorLine error={signIn.error} />
			{offerSignIn && (server.signIn.pastedClient || noRegistration) ? <OwnClient server={server} signIn={signIn} /> : null}
			<Section title="Tools">
				<ServerTools name={server.name} />
			</Section>
			<Section
				title="Settings"
				aside={
					editing ? null : (
						<Btn size="sm" variant="ghost" onClick={() => setEditing(true)}>
							Edit address and token
						</Btn>
					)
				}
			>
				{editing ? <ServerForm editing={server} onDone={() => setEditing(false)} /> : null}
				<div className="in-card flex flex-col px-3.5 py-1">
					<SettingRow
						title="Scripts can call it"
						help="The agent's run_script programs can chain its tools, so many calls cost one step."
						info="Off, the agent still calls its tools one at a time through its connector tools."
					>
						<Switch checked={server.codeMode !== false} disabled={codeMode.isPending} onChange={(on) => codeMode.mutate(on)} label={<span className="sr-only">Scripts can call it</span>} />
					</SettingRow>
					{signedIn ? (
						<SettingRow title="Sign-in" help="Anton keeps and renews it; it never reaches a sandbox or the model.">
							<SignOut name={server.name} />
						</SettingRow>
					) : null}
				</div>
				<ErrorLine error={codeMode.error} />
			</Section>
			<Section title="Remove">
				<div className="flex flex-wrap items-center gap-3">
					<span className="min-w-0 flex-1 text-small text-(--text-3)">Removes the server, its sign-in, token and custom headers from Anton.</span>
					<ErrorLine error={remove.error} />
					<Btn
						size="sm"
						variant="danger"
						disabled={remove.isPending}
						onBlur={() => setConfirming(false)}
						onClick={() =>
							confirming
								? remove.mutate(undefined, { onSuccess: () => void navigate({ to: '/settings/$section', params: { section: 'connectors' } }) })
								: setConfirming(true)
						}
					>
						{remove.isPending ? 'Removing…' : confirming ? 'Click again to remove' : 'Remove'}
					</Btn>
				</div>
			</Section>
		</DetailFrame>
	);
}

export function OfferedServer({ entry }: { entry: CatalogEntry }) {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const mark = useServerMark(entry.url ?? '');
	const add = useMutation({
		mutationFn: async () => {
			const { mcpServers } = await api.addMcpServer({ name: entry.id, url: entry.url!, tools: [] });
			queryClient.setQueryData<ConnectorsView>(['connectors'], (current) => (current ? { ...current, mcpServers } : current));
			return api.signInMcpServer(entry.id).catch(() => ({ url: null, mcpServers }));
		},
		onSuccess: ({ url, mcpServers }) => {
			queryClient.setQueryData<ConnectorsView>(['connectors'], (current) => (current ? { ...current, mcpServers } : current));
			if (url) window.location.assign(url);
			else void navigate({ to: '/settings/connectors/view', search: { c: connectorKey.mcp(entry.id) }, replace: true });
		},
	});
	return (
		<DetailFrame
			mark={mark}
			title={entry.name}
			tagline={entry.tagline}
			facts={[
				{ label: 'Made by', value: entry.by },
				{ label: 'Category', value: entry.category },
				{ label: 'Sign-in', value: 'OAuth, in a new page' },
				{ label: 'Connector URL', value: <span className="text-small break-all">{entry.url}</span> },
				...(entry.docs ? [{ label: 'More info', value: <DocsLink href={entry.docs} /> }] : []),
			]}
			actions={
				<Btn variant="primary" icon={Plus} disabled={add.isPending} onClick={() => add.mutate()}>
					{add.isPending ? 'Adding…' : 'Add and sign in'}
				</Btn>
			}
		>
			<Prose>{entry.description}</Prose>
			<ErrorLine error={add.error} />
			<Note info="Anton keeps and renews the sign-in on its server. The agent finds the server's tools only when a task needs them.">
				Once added, turn it on or off for tasks here or from the + menu in any composer.
			</Note>
		</DetailFrame>
	);
}

export function CustomServer() {
	const navigate = useNavigate();
	const open = (name: string) => void navigate({ to: '/settings/connectors/view', search: { c: connectorKey.mcp(name) }, replace: true });
	return (
		<DetailFrame
			mark={MCP}
			title="Custom MCP server"
			tagline="Any remote MCP server, by its https address"
			facts={[
				{ label: 'Sign-in', value: 'OAuth after adding, a bearer token, or custom headers' },
				{ label: 'More info', value: <DocsLink href="https://modelcontextprotocol.io/docs/learn/server-concepts" /> },
			]}
		>
			<Prose>
				Give it a name and its https address. A server that uses OAuth, as most hosted ones do, signs in from its page after you add it; otherwise add a bearer token or custom headers.
				List tool names to allow only those.
			</Prose>
			<ServerForm editing={null} onDone={() => void navigate({ to: '/settings/$section', params: { section: 'connectors' } })} onSaved={open} />
		</DetailFrame>
	);
}

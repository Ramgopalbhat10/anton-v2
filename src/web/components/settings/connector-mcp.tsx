import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { ExternalLink, Plus } from '@/lib/icons';
import { useState } from 'react';
import { MCP, useServerMark } from '@/components/marks/brand-marks';
import { Btn, Spinner, Switch } from '@/components/kit/signal';
import { api } from '@/lib/api';
import type { ConnectorsView, McpServer, McpServerInput } from '@/lib/api/connectors';
import { type CatalogEntry, catalogEntryFor } from '@/lib/connector-catalog';
import { connectorItems, connectorKey } from '@/lib/connectors';
import { cn } from '@/lib/utils';
import { FIELD, Note, SettingRow } from './parts';
import { ConsoleLink, CopyField, DetailFrame, DocsLink, ErrorLine, type Fact, hostOf, OnSwitch, type Opened, Prose, Returned, Section, since, ToolChips, useConnectorMutation, useConnectors } from './connector-parts';

/** A server row being added or edited; `token` is only what was typed, since a stored token is never sent back. */
type Draft = { name: string; url: string; token: string; tools: string; codeMode: boolean };

const toDraft = (server?: McpServer): Draft => ({
	name: server?.name ?? '',
	url: server?.url ?? '',
	token: '',
	tools: server?.tools.join(', ') ?? '',
	codeMode: server ? server.codeMode !== false : true,
});

function toInput(draft: Draft, editing: McpServer | null): McpServerInput {
	return {
		name: draft.name.trim(),
		url: draft.url.trim(),
		// Null keeps a stored token when editing; an empty one says there is none.
		auth: draft.token ? draft.token : editing ? null : '',
		tools: draft.tools.split(/[\s,]+/).filter(Boolean),
		...(draft.codeMode ? {} : { codeMode: false }),
	};
}

function ServerForm({ editing, onDone, onSaved }: { editing: McpServer | null; onDone: () => void; onSaved?: (name: string) => void }) {
	const [draft, setDraft] = useState(() => toDraft(editing ?? undefined));
	const update = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));
	const save = useConnectorMutation(async () => (editing ? api.updateMcpServer(toInput(draft, editing)) : api.addMcpServer(toInput(draft, null))));
	return (
		<form
			className="flex flex-col gap-2 rounded-control border border-(--line) p-3"
			onSubmit={(event) => {
				event.preventDefault();
				save.mutate(undefined, { onSuccess: () => (onSaved ? onSaved(draft.name.trim()) : onDone()) });
			}}
		>
			<div className="grid grid-cols-1 gap-1.5 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
				<input value={draft.name} readOnly={Boolean(editing)} onChange={(event) => update({ name: event.target.value })} placeholder="name" aria-label="Server name" className={cn(FIELD, 'font-mono read-only:text-(--text-2)')} />
				<input value={draft.url} onChange={(event) => update({ url: event.target.value })} placeholder="https://mcp.example.com/mcp" aria-label="Server URL" className={cn(FIELD, 'font-mono')} />
				<input
					type="password"
					autoComplete="off"
					value={draft.token}
					onChange={(event) => update({ token: event.target.value })}
					placeholder={editing?.hasAuth ? 'Token saved. Type to replace' : 'Token, if it takes one'}
					aria-label="Token"
					className={cn(FIELD, 'font-mono')}
				/>
				<input value={draft.tools} onChange={(event) => update({ tools: event.target.value })} placeholder="All tools, or a list: search, fetch" aria-label="Tools" className={cn(FIELD, 'font-mono')} />
			</div>
			<div className="flex flex-wrap items-center gap-3">
				<Switch checked={draft.codeMode} onChange={(codeMode) => update({ codeMode })} label={<span className="text-small text-(--text-2)">Scripts can call it</span>} />
				{editing && editing.signIn.state !== 'none' ? <SignOut name={editing.name} /> : null}
				<span className="flex-1" />
				<ErrorLine error={save.error} />
				<Btn size="sm" variant="ghost" onClick={onDone}>
					Cancel
				</Btn>
				<Btn type="submit" size="sm" variant="primary" disabled={save.isPending || !draft.name.trim() || !draft.url.trim()}>
					{save.isPending ? 'Saving…' : editing ? 'Save server' : 'Add server'}
				</Btn>
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
	const codeMode = useConnectorMutation((on: boolean) => api.updateMcpServer(toInput({ ...toDraft(server), codeMode: on }, server)));
	const signIn = useSignIn(server);
	const mark = useServerMark(server.url);
	const entry = catalogEntryFor(server.url);
	const item = connectorItems(useConnectors().data).find((each) => each.kind === 'mcp' && each.server.name === server.name) ?? null;
	const signedIn = server.signIn.state === 'signed-in';
	const needsSignIn = server.signIn.state === 'needed';
	const offerSignIn = !signedIn && !server.hasAuth;
	const noRegistration = /register themselves/.test(signIn.error?.message ?? '');
	const facts: Fact[] = [
		{ label: 'Made by', value: entry?.by ?? hostOf(server.url) },
		...(entry ? [{ label: 'Category', value: entry.category }] : []),
		{ label: 'Sign-in', value: signedIn ? `Signed in${server.signIn.since ? ` since ${since(server.signIn.since)}` : ''}` : server.hasAuth ? 'Token' : needsSignIn ? 'Needs signing in again' : 'None yet' },
		{ label: 'Connector URL', value: <span className="text-small break-all">{server.url}</span> },
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
					<span className="min-w-0 flex-1 text-small text-(--text-3)">Removes the server, its sign-in and its token from Anton.</span>
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
				{ label: 'Sign-in', value: 'OAuth after adding, or a token you paste' },
				{ label: 'More info', value: <DocsLink href="https://modelcontextprotocol.io/docs/learn/server-concepts" /> },
			]}
		>
			<Prose>
				Give it a short name and its address. A server that uses OAuth, as most hosted ones do, signs in from its page after you add it; a pasted token is sent as a bearer header instead.
				List tool names to allow only those.
			</Prose>
			<ServerForm editing={null} onDone={() => void navigate({ to: '/settings/$section', params: { section: 'connectors' } })} onSaved={open} />
		</DetailFrame>
	);
}

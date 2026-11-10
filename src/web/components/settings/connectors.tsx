import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useCanGoBack, useNavigate, useRouter, useSearch } from '@tanstack/react-router';
import { ArrowLeft, Check, Copy, ExternalLink, Plus, X } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { GMAIL, GOOGLE, type Mark, MarkTile, MCP, useComposioMark, useServerMark } from '@/components/brand-marks';
import { Status } from '@/components/instrument';
import { Btn, EmptyState, Icon, IconBtn, SearchField, Spinner, Switch } from '@/components/signal';
import { api, type ComposioAccount, type ComposioToolkitHit, type ConnectorAccount, type ConnectorMailbox, type ConnectorsView, type McpServer, type McpServerInput } from '@/lib/api';
import { type CatalogEntry, catalogEntryFor, composioEntryFor, COMPOSIO_CATALOG, GMAIL_ENTRY, GMAIL_TOOLS, MCP_CATALOG } from '@/lib/connector-catalog';
import { type ConnectorItem, connectorItems, connectorKey, type ConnectorState, setConnectorOn } from '@/lib/connectors';
import { cn } from '@/lib/utils';
import { FIELD, Note, PageHeading, SettingRow } from './parts';

function useConnectors() {
	return useQuery({ queryKey: ['connectors'], queryFn: api.connectors });
}

/** A change to connectors, answered with the new state, which goes straight into the page. */
function useConnectorMutation<T>(run: (input: T) => Promise<Partial<ConnectorsView>>) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: run,
		onSuccess: (next) => queryClient.setQueryData<ConnectorsView>(['connectors'], (current) => (current ? { ...current, ...next } : current)),
	});
}

function ErrorLine({ error }: { error: Error | null }) {
	return error ? <span className="text-small text-(--danger-text)">{error.message}</span> : null;
}

/** A value to paste somewhere else, with a button that copies it. */
function CopyField({ value, label }: { value: string; label: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<div className="flex min-w-0 items-center gap-1.5">
			<input readOnly value={value} aria-label={label} className={cn(FIELD, 'flex-1 font-mono text-small text-(--text-secondary)')} onFocus={(event) => event.target.select()} />
			<IconBtn
				icon={copied ? Check : Copy}
				size="sm"
				label={`Copy ${label.toLowerCase()}`}
				onClick={() => {
					void navigator.clipboard?.writeText(value).then(() => {
						setCopied(true);
						setTimeout(() => setCopied(false), 1500);
					});
				}}
			/>
		</div>
	);
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
	return (
		<li className="flex gap-3">
			<span className="in-num mt-px inline-flex size-5 shrink-0 items-center justify-center rounded-control border border-(--border-default) text-micro text-(--text-tertiary)">{n}</span>
			<div className="flex min-w-0 flex-1 flex-col gap-1.5">
				<div className="text-body font-medium text-(--text-primary)">{title}</div>
				<div className="flex flex-col gap-1.5 text-small leading-[18px] text-pretty text-(--text-tertiary)">{children}</div>
			</div>
		</li>
	);
}

const ConsoleLink = ({ href, children }: { href: string; children: ReactNode }) => (
	<a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-(--accent-text) hover:underline">
		{children}
		<Icon icon={ExternalLink} size={11} />
	</a>
);

/** The one-time Google Cloud setup: Anton signs in on an OAuth client you own, since it is no verified app of Google's. */
function GoogleClient({ account, open }: { account: ConnectorAccount; open: boolean }) {
	const [clientId, setClientId] = useState(account.client && !account.client.fromEnv ? account.client.clientId : '');
	const [secret, setSecret] = useState('');
	const save = useConnectorMutation(() => api.setConnectorClient(account.id, { clientId, clientSecret: secret || null }));
	const redirect = `${window.location.origin}${account.callbackPath}`;
	const steps = (
		<ol className="m-0 flex list-none flex-col gap-3.5 p-0">
			<Step n={1} title="Turn on the Gmail API">
				<span>
					In a Google Cloud project of yours, <ConsoleLink href="https://console.cloud.google.com/apis/library/gmail.googleapis.com">enable the Gmail API</ConsoleLink>.
				</span>
			</Step>
			<Step n={2} title="Set up the consent screen, then publish it">
				<span>
					In <ConsoleLink href="https://console.cloud.google.com/auth/overview">Google Auth Platform</ConsoleLink>, choose External, add yourself as a test user, then under
					Audience press <b>Publish app</b>. In Testing, Google ends every sign-in after 7 days. Published but unverified, Google shows an “app isn’t verified” page once; choose
					Advanced, then Go to the app. With a Google Workspace account, choose Internal instead and skip this.
				</span>
			</Step>
			<Step n={3} title="Create an OAuth client">
				<span>
					Under <ConsoleLink href="https://console.cloud.google.com/auth/clients">Clients</ConsoleLink>, create a Web application client with this authorized redirect URI, then paste
					its client id and secret here.
				</span>
				<CopyField value={redirect} label="Redirect URI" />
			</Step>
		</ol>
	);
	return (
		<form
			className="flex flex-col gap-3"
			onSubmit={(event) => {
				event.preventDefault();
				save.mutate(undefined);
			}}
		>
			{open ? steps : null}
			<div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
				<input value={clientId} onChange={(event) => setClientId(event.target.value)} placeholder="Client id, …apps.googleusercontent.com" aria-label="Client id" className={cn(FIELD, 'font-mono')} />
				<input
					type="password"
					autoComplete="off"
					value={secret}
					onChange={(event) => setSecret(event.target.value)}
					placeholder={account.client && !account.client.fromEnv ? 'Secret saved. Type to replace' : 'Client secret'}
					aria-label="Client secret"
					className={cn(FIELD, 'font-mono')}
				/>
			</div>
			<div className="flex flex-wrap items-center justify-end gap-3">
				<ErrorLine error={save.error} />
				{save.isSuccess && !save.isPending ? <span className="text-small text-(--success-text)">Saved.</span> : null}
				<Btn type="submit" size="sm" variant={open ? 'primary' : 'secondary'} disabled={save.isPending || (!clientId.trim() && !account.client)}>
					{save.isPending ? 'Saving…' : 'Save client'}
				</Btn>
			</div>
		</form>
	);
}

/** Sends the browser to Google's consent page; Google sends it back to Settings › Connectors. */
function ConnectButton({ mailbox, access, label, variant = 'primary' }: { mailbox: ConnectorMailbox; access: 'read' | 'draft'; label: string; variant?: 'primary' | 'secondary' }) {
	const connect = useMutation({
		mutationFn: () => api.connectMailbox(mailbox.id, access),
		onSuccess: ({ url }) => window.location.assign(url),
	});
	return (
		<>
			<ErrorLine error={connect.error} />
			<Btn size="sm" variant={variant} icon={ExternalLink} disabled={connect.isPending} onClick={() => connect.mutate()}>
				{connect.isPending ? 'Opening Google…' : label}
			</Btn>
		</>
	);
}

function Disconnect({ account }: { account: ConnectorAccount }) {
	const [confirming, setConfirming] = useState(false);
	const remove = useConnectorMutation(() => api.disconnectAccount(account.id));
	return (
		<>
			<ErrorLine error={remove.error} />
			<Btn size="sm" variant="danger" disabled={remove.isPending} onBlur={() => setConfirming(false)} onClick={() => (confirming ? remove.mutate(undefined) : setConfirming(true))}>
				{remove.isPending ? 'Disconnecting…' : confirming ? 'Click again to disconnect' : 'Disconnect'}
			</Btn>
		</>
	);
}

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
			className="flex flex-col gap-2 rounded-control border border-(--border-subtle) p-3"
			onSubmit={(event) => {
				event.preventDefault();
				save.mutate(undefined, { onSuccess: () => (onSaved ? onSaved(draft.name.trim()) : onDone()) });
			}}
		>
			<div className="grid grid-cols-1 gap-1.5 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
				<input value={draft.name} readOnly={Boolean(editing)} onChange={(event) => update({ name: event.target.value })} placeholder="name" aria-label="Server name" className={cn(FIELD, 'font-mono read-only:text-(--text-secondary)')} />
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
				<Switch checked={draft.codeMode} onChange={(codeMode) => update({ codeMode })} label={<span className="text-small text-(--text-secondary)">Scripts can call it</span>} />
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

/** The server's tools as the agent would find them, read now: a check that its address and sign-in work. */
function ServerTools({ name }: { name: string }) {
	const tools = useQuery({ queryKey: ['mcp-tools', name], queryFn: () => api.mcpServerTools(name), retry: false, staleTime: 30_000 });
	if (tools.isPending) return <Spinner size={12} />;
	if (tools.isError) return <span className="text-small text-(--danger-text)">{tools.error.message}</span>;
	if (!tools.data.tools.length) return <span className="text-small text-(--text-tertiary)">It answered with no tools.</span>;
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

/** Sends the browser to the server's sign-in; the server sends it back to Settings › Connectors. */
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
			className="flex flex-col gap-2 rounded-control border border-(--border-subtle) px-3 py-2.5"
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

/** Each tool as a chip, its description on hover, as Claude's connector pages list them. */
function ToolChips({ tools }: { tools: Array<{ name: string; about: string }> }) {
	return (
		<ul className="m-0 grid list-none grid-cols-1 gap-1.5 p-0 sm:grid-cols-2">
			{tools.map((tool) => (
				<li key={tool.name} className="min-w-0" title={tool.about || undefined}>
					<span className="inline-flex max-w-full items-center rounded-control border border-(--border-subtle) bg-(--well-bg) px-2 py-1 text-small text-(--text-secondary)">
						<span className="truncate">{tool.name}</span>
					</span>
				</li>
			))}
		</ul>
	);
}

function StateBadge({ state }: { state: ConnectorState }) {
	if (state === 'needs-sign-in') return <Status tone="danger">Needs sign-in</Status>;
	return state === 'on' ? <Status tone="success">On</Status> : <Status tone="neutral">Off</Status>;
}

/** The switch that turns a connector on or off for every task, the same one the composer's + menu shows. */
function OnSwitch({ item, label }: { item: ConnectorItem; label?: ReactNode }) {
	const queryClient = useQueryClient();
	const [problem, setProblem] = useState<string | null>(null);
	return (
		<>
			{problem ? <span className="text-small text-(--danger-text)">{problem}</span> : null}
			<Switch
				checked={item.state !== 'off'}
				onChange={(on) => {
					setProblem(null);
					setConnectorOn(queryClient, item, on).catch((error: unknown) => setProblem(error instanceof Error ? error.message : String(error)));
				}}
				label={label ?? <span className="sr-only">Use {item.name} in tasks</span>}
			/>
		</>
	);
}

function useItemMark(item: ConnectorItem | null): Mark {
	const composio = item?.kind === 'composio' ? item.account : undefined;
	const composioUrl = composio ? composio.appUrl || composioEntryFor(composio.toolkit)?.url || '' : '';
	const url = item?.kind === 'mcp' ? item.server.url : composio ? composioUrl : '';
	const mark = useComposioMark(composio?.logo || undefined, url, composio?.name ?? '');
	return item?.kind === 'mailbox' ? GMAIL : mark;
}

type Opened = { c?: string; add?: string; connected?: string; problem?: string };

/** A connector on the catalog: its mark, name and what it does, opening its page; its switch, or a +, in the corner. */
function Tile({ open, mark, title, mono, by, tagline, corner }: { open: Opened; mark: Mark; title: string; mono?: boolean; by: string; tagline: string; corner: ReactNode }) {
	return (
		<div className="in-card group relative flex-row items-start gap-3 p-3.5 transition-colors duration-(--duration-micro) hover:border-(--border-default)">
			<MarkTile mark={mark} size={40} className="rounded-control" />
			<div className="flex min-w-0 flex-1 flex-col gap-0.5">
				<Link
					to="/settings/connectors/view"
					search={open}
					className={cn(
						'truncate text-body-lg font-medium text-(--text-primary) outline-none after:absolute after:inset-0 after:rounded-control focus-visible:after:shadow-(--focus-ring)',
						mono && 'text-body',
					)}
				>
					{title}
				</Link>
				<p className="m-0 line-clamp-2 text-small leading-[17px] text-pretty text-(--text-tertiary)">{tagline}</p>
				<span className="text-micro text-(--text-disabled)">by {by}</span>
			</div>
			<div className="relative z-10 flex shrink-0 items-center">{corner}</div>
		</div>
	);
}

/** A tile's + corner: the connector is not added yet. */
const AddCorner = () => (
	<span aria-hidden className="inline-flex size-7 items-center justify-center text-(--icon-tertiary) group-hover:text-(--text-primary)">
		<Icon icon={Plus} size={16} />
	</span>
);

const hostOf = (url: string) => (URL.canParse(url) ? new URL(url).hostname : url);

function ConnectedTile({ item }: { item: ConnectorItem }) {
	const mark = useItemMark(item);
	const entry = item.kind === 'mailbox' ? GMAIL_ENTRY : item.kind === 'composio' ? composioEntryFor(item.account.toolkit) : catalogEntryFor(item.server.url);
	const name = item.kind === 'composio' ? item.account.name : item.name;
	return (
		<Tile
			open={{ c: item.key }}
			mark={mark}
			title={entry && (item.kind !== 'mcp' || entry.id === item.name) ? entry.name : name}
			mono={item.kind === 'mcp' && entry?.id !== item.name}
			by={entry?.by ?? (item.kind === 'mcp' ? hostOf(item.server.url) : 'Composio')}
			tagline={item.kind === 'mailbox' ? (item.account.email ?? entry?.tagline ?? '') : item.kind === 'composio' ? (item.account.description || entry?.tagline || '') : (entry?.tagline ?? item.server.url)}
			corner={item.state === 'needs-sign-in' ? <StateBadge state={item.state} /> : <OnSwitch item={item} />}
		/>
	);
}

function OfferedTile({ entry }: { entry: CatalogEntry }) {
	const mark = useServerMark(entry.url ?? '');
	return <Tile open={{ add: entry.id }} mark={entry.url ? mark : GMAIL} title={entry.name} by={entry.by} tagline={entry.tagline} corner={<AddCorner />} />;
}

/** A Composio app not added yet: same tile, opening its own page. */
function OfferedComposioTile({ entry }: { entry: CatalogEntry }) {
	const mark = useComposioMark(entry.logo, entry.url ?? '', entry.name);
	return <Tile open={{ add: `composio:${entry.id}` }} mark={mark} title={entry.name} by={entry.by} tagline={entry.tagline} corner={<AddCorner />} />;
}

/** A Composio catalog hit in the shape the offered tiles and add page take. */
const entryForToolkit = (hit: ComposioToolkitHit): CatalogEntry => ({
	id: hit.slug,
	name: hit.name,
	by: 'Composio',
	tagline: hit.description.length > 100 ? `${hit.description.slice(0, 97).trimEnd()}…` : hit.description,
	description: hit.description,
	category: hit.categories[0] ?? 'Apps',
	url: hit.appUrl ?? undefined,
	logo: hit.logo || undefined,
});

const matches = (words: string, ...texts: string[]) => !words || texts.some((text) => text.toLowerCase().includes(words));

/** Settings › Connectors: the connectors you have, each with its switch, then the ones to add. Each opens a page of its own. */
export function ConnectorsPage() {
	const connectors = useConnectors();
	const navigate = useNavigate();
	const returned = useSearch({ strict: false }) as Opened;
	const [query, setQuery] = useState('');
	const words = query.trim().toLowerCase();
	// The same box searches Composio's whole catalog, a beat behind the keystrokes.
	const [live, setLive] = useState('');
	useEffect(() => {
		const timer = setTimeout(() => setLive(query.trim()), 300);
		return () => clearTimeout(timer);
	}, [query]);
	const composioConfigured = Boolean(connectors.data?.composio.configured);
	const found = useQuery({
		queryKey: ['composio-toolkits', live],
		queryFn: () => api.composioToolkits(live),
		enabled: composioConfigured && live.length >= 2,
		staleTime: 60_000,
		placeholderData: keepPreviousData,
	});
	const items = connectorItems(connectors.data);
	const added = new Set(connectors.data?.mcpServers.map((server) => (URL.canParse(server.url) ? new URL(server.url).origin : server.url)));
	const composioAdded = new Set(connectors.data?.composio.accounts.map((account) => account.toolkit));
	const offeredStatic = [
		...(connectors.data?.mailboxes.some((mailbox) => !items.some((item) => item.kind === 'mailbox' && item.mailbox.id === mailbox.id)) ? [GMAIL_ENTRY] : []),
		...MCP_CATALOG.filter((entry) => entry.url && !added.has(new URL(entry.url).origin)),
		...COMPOSIO_CATALOG.filter((entry) => !composioAdded.has(entry.id)),
	].filter((entry) => matches(words, entry.name, entry.tagline, entry.category));
	// Composio's own matches join the offered list; an app already offered, under any connector, stays single.
	const offered = [
		...offeredStatic,
		...(found.data?.toolkits ?? [])
			.filter((hit) => !composioAdded.has(hit.slug) && !offeredStatic.some((entry) => entry.id === hit.slug))
			.map(entryForToolkit),
	];
	const yours = items.filter((item) => matches(words, item.name, item.kind === 'mcp' ? item.server.url : item.kind === 'composio' ? item.account.toolkit : 'gmail email'));
	return (
		<>
			<PageHeading
				title="Connectors"
				info="Sign-ins and tokens stay on Anton's server and never reach a sandbox or the model. A connector that is on is offered to every task, but its tools load only when a task looks them up, so the agent's prompt and its cache stay the same whichever are on."
				actions={
					<div className="flex items-center gap-2">
						<SearchField value={query} onChange={setQuery} placeholder="Search connectors" className="w-[200px]" />
						<Btn size="sm" icon={Plus} onClick={() => void navigate({ to: '/settings/connectors/view', search: { add: 'custom' } })}>
							Add custom
						</Btn>
					</div>
				}
			>
				Connect your tools once here, then turn each on or off from the + menu in any composer. Tools load only when a task uses them.
			</PageHeading>
			<Returned search={returned} />
			{connectors.isError ? <p className="m-0 text-small text-(--danger-text)">{connectors.error.message}</p> : null}
			{!connectors.data && !connectors.isError ? <Spinner size={12} /> : null}
			{connectors.data && yours.length ? (
				<section className="flex flex-col gap-2.5" aria-label="Your connectors">
					<SectionTitle count={yours.length}>Yours</SectionTitle>
					<div className="grid grid-cols-1 gap-2.5 md:grid-cols-2">
						{yours.map((item) => (
							<ConnectedTile key={item.key} item={item} />
						))}
					</div>
				</section>
			) : null}
			{connectors.data ? (
				<section className="flex flex-col gap-2.5" aria-label="Add a connector">
					<SectionTitle count={offered.length + 1}>{yours.length ? 'Add more' : 'Add a connector'}</SectionTitle>
					<div className="grid grid-cols-1 gap-2.5 md:grid-cols-2">
						{offered.map((entry) =>
							entry === GMAIL_ENTRY || MCP_CATALOG.includes(entry) ? (
								<OfferedTile key={entry.id} entry={entry} />
							) : (
								<OfferedComposioTile key={entry.id} entry={entry} />
							),
						)}
						<Tile open={{ add: 'custom' }} mark={MCP} title="Custom MCP server" by="you" tagline="Any remote MCP server by its https address, with OAuth sign-in or a token." corner={<AddCorner />} />
					</div>
				</section>
			) : null}
		</>
	);
}

function SectionTitle({ count, children }: { count: number; children: ReactNode }) {
	return (
		<h2 className="m-0 flex items-center gap-2 text-body-lg font-semibold">
			{children}
			<span className="in-num rounded-control bg-(--alpha-white-6) px-1.5 text-micro font-normal text-(--text-tertiary)">{count}</span>
		</h2>
	);
}

/** What a sign-in that came back to Anton said: connected, or what went wrong, until dismissed. */
function Returned({ search }: { search: Opened }) {
	const navigate = useNavigate();
	if (!search.connected && !search.problem) return null;
	const dismiss = () =>
		search.c || search.add
			? void navigate({ to: '/settings/connectors/view', search: { c: search.c, add: search.add }, replace: true })
			: void navigate({ to: '/settings/$section', params: { section: 'connectors' }, search: {}, replace: true });
	return (
		<div
			role="status"
			className={cn(
				'flex items-center gap-3 rounded-control border px-3.5 py-2.5 text-body',
				search.problem ? 'border-(--danger-border) text-(--danger-text)' : 'border-(--success-border) text-(--success-text)',
			)}
		>
			<span className="min-w-0 flex-1">{search.problem ? `Not connected: ${search.problem}` : 'Connected. Turn it on or off for tasks here or from the + menu in any composer.'}</span>
			<IconBtn icon={X} size="sm" label="Dismiss" onClick={dismiss} />
		</div>
	);
}

type Fact = { label: string; value: ReactNode };

/** A connector's page: its mark, name and main action on top, what it does and its settings beside the facts about it. */
function DetailFrame({ mark, title, mono, tagline, actions, facts, children }: { mark: Mark; title: string; mono?: boolean; tagline: string; actions?: ReactNode; facts: Fact[]; children: ReactNode }) {
	return (
		<div className="flex flex-col gap-5">
			<div className="flex flex-wrap items-center gap-4 border-b border-(--border-subtle) pb-5">
				<MarkTile mark={mark} size={64} label={mark.title} className="rounded-control" />
				<div className="flex min-w-0 flex-1 basis-[240px] flex-col gap-1">
					<h1 className={cn('m-0 truncate text-h1 leading-[32px] font-semibold tracking-[-0.022em]', mono && 'text-h1')}>{title}</h1>
					<p className="m-0 text-body leading-[19px] text-pretty text-(--text-tertiary)">{tagline}</p>
				</div>
				{actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
			</div>
			<div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_220px]">
				<div className="flex min-w-0 flex-col gap-6">{children}</div>
				<dl className="m-0 flex flex-col gap-4 lg:border-l lg:border-(--border-subtle) lg:pl-6">
					{facts.map((fact) => (
						<div key={fact.label} className="flex min-w-0 flex-col gap-1">
							<dt className="in-caption text-(--text-disabled)">{fact.label}</dt>
							<dd className="m-0 min-w-0 text-body leading-[18px] break-words text-(--text-secondary)">{fact.value}</dd>
						</div>
					))}
				</dl>
			</div>
		</div>
	);
}

function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
	return (
		<section className="flex flex-col gap-2.5">
			<div className="flex items-center gap-2">
				<h2 className="m-0 flex-1 text-h3 font-semibold">{title}</h2>
				{aside}
			</div>
			{children}
		</section>
	);
}

const Prose = ({ children }: { children: ReactNode }) => <p className="m-0 max-w-[68ch] text-body leading-[21px] text-pretty text-(--text-secondary)">{children}</p>;

const DocsLink = ({ href }: { href: string }) => <ConsoleLink href={href}>Documentation</ConsoleLink>;

const since = (at: string | null) => (at ? new Date(at).toLocaleDateString(undefined, { month: 'long', year: 'numeric', day: 'numeric' }) : '—');

function MailboxDetail({ mailbox, account, search }: { mailbox: ConnectorMailbox; account: ConnectorAccount; search: Opened }) {
	const [access, setAccess] = useState<'read' | 'draft'>('draft');
	const [showClient, setShowClient] = useState(false);
	const options = useConnectorMutation((next: ConnectorMailbox['options']) => api.setMailboxOptions(mailbox.id, next));
	const items = connectorItems(useConnectors().data);
	const item = items.find((entry) => entry.kind === 'mailbox' && entry.mailbox.id === mailbox.id) ?? null;
	const connected = Boolean(account.connectedAt);
	const set = (patch: Partial<ConnectorMailbox['options']>) => options.mutate({ ...mailbox.options, ...patch });
	const allowed = (needs: 'read' | 'draft' | 'send') => needs === 'read' || (needs === 'draft' ? mailbox.access?.draft : mailbox.access?.send) || (!mailbox.access && mailbox.canDraft);
	const facts: Fact[] = [
		{ label: 'Made by', value: GMAIL_ENTRY.by },
		{ label: 'Category', value: GMAIL_ENTRY.category },
		{ label: 'Sign-in', value: connected ? (account.problem ? 'Needs signing in again' : 'Signed in') : 'Required, on your own Google OAuth client' },
		...(connected ? [{ label: 'Account', value: <span className="inline-flex items-center gap-1.5 text-small"><Icon icon={GOOGLE.icon} size={12} />{account.email ?? 'Google account'}</span> }] : []),
		...(connected ? [{ label: 'Connected', value: since(account.connectedAt) }] : []),
		...(account.client ? [{ label: 'OAuth client', value: <span className="text-small">{account.client.clientId.slice(0, 18)}…{account.client.fromEnv ? ' (environment)' : ''}</span> }] : []),
		{ label: 'More info', value: <DocsLink href={GMAIL_ENTRY.docs!} /> },
	];
	return (
		<DetailFrame
			mark={GMAIL}
			title={GMAIL_ENTRY.name}
			tagline={GMAIL_ENTRY.tagline}
			facts={facts}
			actions={
				connected && item ? (
					<>
						{item.state === 'needs-sign-in' ? <StateBadge state={item.state} /> : null}
						<OnSwitch item={item} label={<span className="text-body text-(--text-secondary)">On for tasks</span>} />
					</>
				) : undefined
			}
		>
			<Returned search={search} />
			<Prose>{GMAIL_ENTRY.description}</Prose>
			{!account.client ? (
				<Section title="Set up once">
					<Note info="It takes about five minutes in Google Cloud.">{account.name} needs an OAuth client of your own.</Note>
					<GoogleClient account={account} open />
				</Section>
			) : !connected ? (
				<Section title="Connect">
					<div className="flex flex-col gap-1.5" role="radiogroup" aria-label="What the agent may do">
						{(
							[
								['draft', 'Read, draft and send', 'Search and read mail, write drafts, and send after you press Send.'],
								['read', 'Read only', 'Search and read mail. Nothing is written.'],
							] as const
						).map(([value, title, detail]) => (
							<button
								key={value}
								type="button"
								role="radio"
								aria-checked={access === value}
								onClick={() => setAccess(value)}
								className={cn(
									'flex items-center gap-2.5 rounded-control border px-2.5 py-2 text-left outline-none focus-visible:shadow-(--focus-ring)',
									access === value ? 'border-(--accent-border) bg-(--accent-bg-subtle)' : 'border-(--border-subtle) hover:border-(--border-strong)',
								)}
							>
								<span className={cn('inline-flex size-3.5 shrink-0 rounded-full border', access === value ? 'border-(--accent-base) bg-(--accent-base)' : 'border-(--border-strong)')} />
								<span className="flex min-w-0 flex-col">
									<span className="text-body text-(--text-primary)">{title}</span>
									<span className="text-small text-(--text-tertiary)">{detail}</span>
								</span>
							</button>
						))}
					</div>
					<div className="flex flex-wrap items-center justify-end gap-3">
						<button type="button" className="mr-auto text-small text-(--text-tertiary) hover:text-(--text-secondary)" onClick={() => setShowClient((open) => !open)}>
							{showClient ? 'Hide the OAuth client' : 'Change the OAuth client'}
						</button>
						<ConnectButton mailbox={mailbox} access={access} label={`Connect ${mailbox.name}`} />
					</div>
					{showClient ? <GoogleClient account={account} open /> : null}
				</Section>
			) : (
				<>
					{account.problem ? (
						<div className="flex flex-wrap items-center gap-3 rounded-control border border-(--danger-border) px-3 py-2">
							<span className="min-w-0 flex-1 text-small text-(--danger-text)">{account.problem}</span>
							<ConnectButton mailbox={mailbox} access={mailbox.canDraft ? 'draft' : 'read'} label="Connect again" />
						</div>
					) : null}
					<Section title="What it may do">
						<div className="in-card flex flex-col px-3.5 py-1">
							<SettingRow
								title="Write drafts"
								help={mailbox.canDraft ? 'In your Drafts folder, where you can edit them.' : 'This sign-in only allowed reading.'}
								info={mailbox.canDraft ? undefined : 'Connect again with drafts and sending allowed.'}
							>
								{mailbox.canDraft ? null : <ConnectButton mailbox={mailbox} access="draft" label="Allow" variant="secondary" />}
								<Switch
									checked={mailbox.canDraft && mailbox.options.draft}
									disabled={!mailbox.canDraft || options.isPending}
									onChange={(draft) => set({ draft })}
									label={<span className="sr-only">Write drafts</span>}
								/>
							</SettingRow>
							<SettingRow
								title="Send, when you press Send"
								help="Nothing goes until you press Send."
								info="The agent asks; the thread shows you the email as it will go, with Send and Don't send. A draft changed after you were shown it is not sent."
							>
								<Switch
									checked={mailbox.canDraft && mailbox.options.send}
									disabled={!mailbox.canDraft || options.isPending}
									onChange={(send) => set({ send })}
									label={<span className="sr-only">Send after you press Send</span>}
								/>
							</SettingRow>
						</div>
						<ErrorLine error={options.error} />
					</Section>
				</>
			)}
			<Section title="Tools">
				<ToolChips tools={GMAIL_TOOLS.filter((tool) => allowed(tool.needs)).map((tool) => ({ name: tool.name, about: tool.about }))} />
			</Section>
			{connected ? (
				<Section title="Disconnect">
					<div className="flex flex-wrap items-center gap-3">
						<span className="min-w-0 flex-1 text-small text-(--text-tertiary)">Signs out of {account.email ?? 'the account'} and removes Anton from its connected apps.</span>
						<Disconnect account={account} />
					</div>
				</Section>
			) : null}
		</DetailFrame>
	);
}

function ServerDetail({ server, search }: { server: McpServer; search: Opened }) {
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
					{item ? <OnSwitch item={item} label={<span className="text-body text-(--text-secondary)">On for tasks</span>} /> : null}
				</>
			}
		>
			<Returned search={search} />
			<Prose>{entry?.description ?? `A remote MCP server at ${hostOf(server.url)}. Its tools are listed below as the agent finds them.`}</Prose>
			{needsSignIn ? <span className="text-small text-(--danger-text)">{server.signIn.problem}</span> : null}
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
					<span className="min-w-0 flex-1 text-small text-(--text-tertiary)">Removes the server, its sign-in and its token from Anton.</span>
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

/** A server from the catalog not added yet: what it does, and one button that adds it and opens its sign-in. */
function OfferedServer({ entry }: { entry: CatalogEntry }) {
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

function CustomServer() {
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

/** The Composio project key, pasted once; it runs the apps' sign-ins and tools, and never leaves Anton's server. */
function ComposioKeyForm({ configured, keyFromEnv }: { configured: boolean; keyFromEnv: boolean }) {
	const [key, setKey] = useState('');
	const save = useConnectorMutation(async () => ({ composio: await api.setComposioKey(key.trim() || null) }));
	const remove = useConnectorMutation(async () => ({ composio: await api.setComposioKey(null) }));
	return (
		<form
			className="flex flex-col gap-2"
			onSubmit={(event) => {
				event.preventDefault();
				save.mutate(undefined);
			}}
		>
			<div className="flex flex-wrap items-center gap-1.5">
				<input
					type="password"
					autoComplete="off"
					value={key}
					onChange={(event) => setKey(event.target.value)}
					placeholder={configured ? 'Key saved. Type to replace' : 'Composio API key'}
					aria-label="Composio API key"
					className={cn(FIELD, 'min-w-[220px] flex-1 font-mono')}
				/>
				<Btn type="submit" size="sm" variant="primary" disabled={save.isPending || (!key.trim() && !configured)}>
					{save.isPending ? 'Checking…' : 'Save key'}
				</Btn>
				{configured && !keyFromEnv ? (
					<Btn size="sm" variant="ghost" disabled={remove.isPending} onClick={() => remove.mutate(undefined)}>
						{remove.isPending ? 'Removing…' : 'Remove key'}
					</Btn>
				) : null}
			</div>
			<ErrorLine error={save.error ?? remove.error} />
			{keyFromEnv ? <span className="text-small text-(--text-tertiary)">Set by COMPOSIO_API_KEY on this server.</span> : null}
		</form>
	);
}

/** An app's tools as the agent finds them, read now through Composio. */
function ComposioTools({ toolkit }: { toolkit: string }) {
	const tools = useQuery({ queryKey: ['composio-tools', toolkit], queryFn: () => api.composioTools(toolkit), retry: false, staleTime: 60_000 });
	if (tools.isPending) return <Spinner size={12} />;
	if (tools.isError) return <span className="text-small text-(--danger-text)">{tools.error.message}</span>;
	if (!tools.data.tools.length) return <span className="text-small text-(--text-tertiary)">Composio lists no tools for it.</span>;
	return <ToolChips tools={tools.data.tools.map((tool) => ({ name: tool.name, about: tool.description }))} />;
}

const composioStatus = (account: ComposioAccount) =>
	account.status === 'active' ? 'Connected' : account.status === 'pending' ? 'Waiting for you to finish signing in' : account.status === 'failed' ? 'The connection failed' : 'Not connected yet';

/** An app connected through Composio: its sign-in on Composio's page, its tools run by Composio. */
function ComposioDetail({ account, search }: { account: ComposioAccount; search: Opened }) {
	const navigate = useNavigate();
	const entry = composioEntryFor(account.toolkit);
	const mark = useComposioMark(account.logo || entry?.logo, account.appUrl || entry?.url || '', account.name);
	const items = connectorItems(useConnectors().data);
	const item = items.find((each) => each.kind === 'composio' && each.account.toolkit === account.toolkit) ?? null;
	const connect = useMutation({
		mutationFn: () => api.connectComposio(account.toolkit),
		onSuccess: ({ url }) => window.location.assign(url),
	});
	const check = useConnectorMutation(async () => ({ composio: await api.refreshComposio(account.toolkit) }));
	const [confirming, setConfirming] = useState(false);
	const disconnect = useConnectorMutation(async () => ({ composio: await api.disconnectComposio(account.toolkit) }));
	const remove = useConnectorMutation(async () => ({ composio: await api.removeComposio(account.toolkit) }));
	const active = account.status === 'active';
	const pending = account.status === 'pending';
	const facts: Fact[] = [
		{ label: 'Made by', value: entry?.by ?? 'Composio' },
		{ label: 'Category', value: entry?.category ?? account.category },
		{ label: 'Runs through', value: 'Composio' },
		{ label: 'Sign-in', value: composioStatus(account) },
		...(active && account.connectedAt ? [{ label: 'Connected', value: since(account.connectedAt) }] : []),
		{ label: 'Added', value: since(account.addedAt) },
		...(entry?.docs ? [{ label: 'More info', value: <DocsLink href={entry.docs} /> }] : []),
	];
	return (
		<DetailFrame
			mark={mark}
			title={account.name}
			tagline={entry?.tagline ?? account.description}
			facts={facts}
			actions={
				<>
					{!active ? (
						<Btn size="sm" variant="primary" icon={ExternalLink} disabled={connect.isPending} onClick={() => connect.mutate()}>
							{connect.isPending ? 'Opening…' : pending ? 'Open sign-in again' : `Connect ${account.name}`}
						</Btn>
					) : null}
					{pending ? (
						<Btn size="sm" variant="secondary" disabled={check.isPending} onClick={() => check.mutate(undefined)}>
							{check.isPending ? 'Checking…' : 'Check again'}
						</Btn>
					) : null}
					{item ? <OnSwitch item={item} label={<span className="text-body text-(--text-secondary)">On for tasks</span>} /> : null}
				</>
			}
		>
			<Returned search={search} />
			<Prose>{entry?.description ?? account.description}</Prose>
			{account.status === 'failed' ? (
				<div className="flex flex-wrap items-center gap-3 rounded-control border border-(--danger-border) px-3 py-2">
					<span className="min-w-0 flex-1 text-small text-(--danger-text)">{account.statusReason ?? 'The connection failed.'}</span>
				</div>
			) : null}
			{pending ? (
				<Note info="Finish signing in on the page that opened; this updates when you come back, or press Check again.">
					Composio is holding the sign-in until you approve it on {account.name}’s own page.
				</Note>
			) : null}
			<ErrorLine error={connect.error} />
			{active ? (
				<>
					<Section title="Tools">
						<ComposioTools toolkit={account.toolkit} />
					</Section>
					<Section title="What it may do">
						<div className="in-card flex flex-col px-3.5 py-3">
							<Prose>
								The agent reads and searches freely. A call that would change something — post, create, update, delete — waits for your <b>Run</b> in the
								thread first, shown with its arguments.
							</Prose>
						</div>
					</Section>
					<Section title="Disconnect">
						<div className="flex flex-wrap items-center gap-3">
							<span className="min-w-0 flex-1 text-small text-(--text-tertiary)">Revokes the sign-in at {account.name} and at Composio; the app stays here to connect again.</span>
							<ErrorLine error={disconnect.error} />
							<Btn
								size="sm"
								variant="danger"
								disabled={disconnect.isPending}
								onBlur={() => setConfirming(false)}
								onClick={() => (confirming ? disconnect.mutate(undefined) : setConfirming(true))}
							>
								{disconnect.isPending ? 'Disconnecting…' : confirming ? 'Click again to disconnect' : 'Disconnect'}
							</Btn>
						</div>
					</Section>
				</>
			) : null}
			<Section title="Remove">
				<div className="flex flex-wrap items-center gap-3">
					<span className="min-w-0 flex-1 text-small text-(--text-tertiary)">Removes the app, its sign-in and its connection from Anton.</span>
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

/** A Composio app not added yet: what it does, the project key if none is set, and one button that adds it and opens its sign-in. */
function OfferedComposio({ entry }: { entry: CatalogEntry }) {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const view = useConnectors().data?.composio;
	const configured = Boolean(view?.configured);
	const mark = useComposioMark(entry.logo, entry.url ?? '', entry.name);
	const add = useMutation({
		mutationFn: async () => {
			await api.addComposioAccount(entry.id);
			return api.connectComposio(entry.id);
		},
		onSuccess: async ({ url }) => {
			if (url) window.location.assign(url);
			else {
				await queryClient.invalidateQueries({ queryKey: ['connectors'] });
				void navigate({ to: '/settings/connectors/view', search: { c: connectorKey.composio(entry.id) }, replace: true });
			}
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
				{ label: 'Runs through', value: 'Composio' },
				{ label: 'Sign-in', value: 'Composio Connect, in a new page' },
				...(entry.docs ? [{ label: 'More info', value: <DocsLink href={entry.docs} /> }] : []),
			]}
			actions={
				configured ? (
					<Btn variant="primary" icon={Plus} disabled={add.isPending} onClick={() => add.mutate()}>
						{add.isPending ? 'Opening…' : 'Add and connect'}
					</Btn>
				) : undefined
			}
		>
			<Prose>{entry.description}</Prose>
			<Note info="Composio hosts the sign-in on the app's own page and keeps its tokens; Anton keeps only the connection's state. Calls that change something wait for your Run in the thread.">
				Once added, turn it on or off for tasks here or from the + menu in any composer.
			</Note>
			{!configured ? (
				<Section title="Set up once">
					<Note info="Apps connected through Composio need its project API key, from your Composio dashboard.">
						<ConsoleLink href="https://docs.composio.dev/docs/quickstart">Get a Composio API key</ConsoleLink>, then paste it here.
					</Note>
					<ComposioKeyForm configured={configured} keyFromEnv={Boolean(view?.keyFromEnv)} />
				</Section>
			) : (
				<ErrorLine error={add.error} />
			)}
		</DetailFrame>
	);
}

/** The add page of a Composio app outside the offered list, its details read live from Composio's catalog. */
function OfferedComposioLookup({ slug }: { slug: string }) {
	const toolkit = useQuery({ queryKey: ['composio-toolkit', slug], queryFn: () => api.composioToolkit(slug), staleTime: 60_000 });
	if (toolkit.isPending) return <Spinner size={12} />;
	if (toolkit.isError) return <p className="m-0 text-small text-(--danger-text)">{toolkit.error.message}</p>;
	return <OfferedComposio entry={entryForToolkit(toolkit.data)} />;
}

/** One connector's page: yours to manage, or one from the catalog to add. */
export function ConnectorDetailPage() {
	const search = useSearch({ from: '/settings/connectors/view' });
	const router = useRouter();
	const canGoBack = useCanGoBack();
	const navigate = useNavigate();
	const connectors = useConnectors();
	const back = () => (canGoBack ? router.history.back() : void navigate({ to: '/settings/$section', params: { section: 'connectors' } }));
	const data = connectors.data;
	let page: ReactNode = null;
	if (data && search.c?.startsWith('mail:')) {
		const mailbox = data.mailboxes.find((item) => connectorKey.mailbox(item.id) === search.c);
		const account = mailbox && data.accounts.find((item) => item.id === mailbox.account);
		if (mailbox && account) page = <MailboxDetail mailbox={mailbox} account={account} search={search} />;
	} else if (data && search.c?.startsWith('mcp:')) {
		const server = data.mcpServers.find((item) => connectorKey.mcp(item.name) === search.c);
		if (server) page = <ServerDetail key={server.name} server={server} search={search} />;
	} else if (data && search.c?.startsWith('composio:')) {
		const account = data.composio.accounts.find((item) => connectorKey.composio(item.toolkit) === search.c);
		if (account) page = <ComposioDetail key={account.toolkit} account={account} search={search} />;
	} else if (data && search.add === 'custom') {
		page = <CustomServer />;
	} else if (data && search.add === GMAIL_ENTRY.id) {
		const mailbox = data.mailboxes.find((item) => item.id === 'gmail');
		const account = mailbox && data.accounts.find((item) => item.id === mailbox.account);
		if (mailbox && account) page = <MailboxDetail mailbox={mailbox} account={account} search={search} />;
	} else if (data && search.add?.startsWith('composio:')) {
		const entry = COMPOSIO_CATALOG.find((item) => `composio:${item.id}` === search.add);
		if (entry) page = <OfferedComposio entry={entry} />;
		else page = <OfferedComposioLookup slug={search.add.slice('composio:'.length)} />;
	} else if (data && search.add) {
		const entry = MCP_CATALOG.find((item) => item.id === search.add);
		if (entry) page = <OfferedServer entry={entry} />;
	}
	return (
		<>
			<button
				type="button"
				onClick={back}
				className="inline-flex items-center gap-1.5 self-start text-small text-(--text-tertiary) outline-none hover:text-(--text-primary) focus-visible:shadow-(--focus-ring)"
			>
				<Icon icon={ArrowLeft} size={12} />
				Connectors
			</button>
			{page ??
				(connectors.isPending ? (
					<Spinner size={12} />
				) : connectors.isError ? (
					<p className="m-0 text-small text-(--danger-text)">{connectors.error.message}</p>
				) : (
					<EmptyState title="No such connector" body="It may have been removed. Every connector is on the Connectors page.">
						<Link to="/settings/$section" params={{ section: 'connectors' }}>
							<Btn size="sm">Back to Connectors</Btn>
						</Link>
					</EmptyState>
				))}
		</>
	);
}

/** The name the breadcrumbs give the connector a page shows. */
export function ConnectorCrumb() {
	const search = useSearch({ strict: false }) as Opened;
	const data = useConnectors().data;
	const addSlug = search.add?.startsWith('composio:') ? search.add.slice('composio:'.length) : null;
	const catalogHit = addSlug ? composioEntryFor(addSlug) : undefined;
	const found = useQuery({
		queryKey: ['composio-toolkit', addSlug],
		queryFn: () => api.composioToolkit(addSlug!),
		enabled: Boolean(addSlug) && !catalogHit,
		staleTime: Infinity,
	});
	if (search.c?.startsWith('mail:') || search.add === 'gmail') return <>Gmail</>;
	if (search.c?.startsWith('composio:')) {
		const toolkit = search.c.slice('composio:'.length);
		return <>{data?.composio.accounts.find((item) => item.toolkit === toolkit)?.name ?? composioEntryFor(toolkit)?.name ?? 'App'}</>;
	}
	if (search.add?.startsWith('composio:')) return <>{catalogHit?.name ?? found.data?.name ?? 'App'}</>;
	if (search.add === 'custom') return <>Custom MCP server</>;
	if (search.add) return <>{MCP_CATALOG.find((entry) => entry.id === search.add)?.name ?? search.add}</>;
	const server = data?.mcpServers.find((item) => connectorKey.mcp(item.name) === search.c);
	const entry = server && catalogEntryFor(server.url);
	return <>{entry && entry.id === server?.name ? entry.name : (server?.name ?? 'Connector')}</>;
}

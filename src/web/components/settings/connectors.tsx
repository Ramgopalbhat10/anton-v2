import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { Check, Copy, ExternalLink, Plus, X } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { GMAIL, GOOGLE, MarkTile, MCP, useServerMark } from '@/components/brand-marks';
import { Status } from '@/components/instrument';
import { Btn, Icon, IconBtn, Spinner, Switch } from '@/components/signal';
import { api, type ConnectorAccount, type ConnectorMailbox, type ConnectorsView, type McpServer, type McpServerInput } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Block, FIELD, PageHeading, SettingRow, SubBlock } from './parts';

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
	return error ? <span className="text-[12px] text-(--danger-text)">{error.message}</span> : null;
}

/** A value to paste somewhere else, with a button that copies it. */
function CopyField({ value, label }: { value: string; label: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<div className="flex min-w-0 items-center gap-1.5">
			<input readOnly value={value} aria-label={label} className={cn(FIELD, 'flex-1 font-mono text-[12px] text-(--text-secondary)')} onFocus={(event) => event.target.select()} />
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
			<span className="in-num mt-px inline-flex size-5 shrink-0 items-center justify-center rounded-[6px] border border-(--border-default) text-[10.5px] text-(--text-tertiary)">{n}</span>
			<div className="flex min-w-0 flex-1 flex-col gap-1.5">
				<div className="text-[12.5px] font-medium text-(--text-primary)">{title}</div>
				<div className="flex flex-col gap-1.5 text-[12px] leading-[18px] text-pretty text-(--text-tertiary)">{children}</div>
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
				{save.isSuccess && !save.isPending ? <span className="text-[12px] text-(--success-text)">Saved.</span> : null}
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

function MailboxBlock({ mailbox, account }: { mailbox: ConnectorMailbox; account: ConnectorAccount }) {
	const [access, setAccess] = useState<'read' | 'draft'>('draft');
	const [showClient, setShowClient] = useState(false);
	const options = useConnectorMutation((next: ConnectorMailbox['options']) => api.setMailboxOptions(mailbox.id, next));
	const connected = Boolean(account.connectedAt);
	const set = (patch: Partial<ConnectorMailbox['options']>) => options.mutate({ ...mailbox.options, ...patch });
	const state = account.problem ? (
		<Status tone="danger">Needs sign-in</Status>
	) : connected ? (
		mailbox.access ? (
			<Status tone="success">Connected</Status>
		) : (
			<Status tone="neutral">Off</Status>
		)
	) : (
		<Status tone="neutral">Not connected</Status>
	);
	return (
		<Block
			title={mailbox.name}
			mark={<MarkTile mark={GMAIL} />}
			aside={state}
			help={
				connected
					? `Every task's agent can search and read ${account.email ?? 'this account'}'s mail, write drafts, and ask to send one; an email goes only when you press Send in the thread.`
					: `Let every task's agent search and read your mail, write drafts, and ask to send them. The sign-in stays on Anton's server and never reaches a sandbox, and nothing is sent until you press Send in the thread.`
			}
			footer={connected ? <Disconnect account={account} /> : undefined}
		>
			{!account.client ? (
				<SubBlock label="Set up once" help={`${account.name} needs an OAuth client of your own before it can sign in. It takes about five minutes in Google Cloud.`}>
					<GoogleClient account={account} open />
				</SubBlock>
			) : !connected ? (
				<div className="flex flex-col gap-3">
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
									'flex items-center gap-2.5 rounded-[9px] border px-2.5 py-2 text-left outline-none focus-visible:shadow-(--focus-ring)',
									access === value ? 'border-(--accent-border) bg-(--accent-bg-subtle)' : 'border-(--border-subtle) hover:border-(--border-strong)',
								)}
							>
								<span className={cn('inline-flex size-3.5 shrink-0 rounded-full border', access === value ? 'border-(--accent-base) bg-(--accent-base)' : 'border-(--border-strong)')} />
								<span className="flex min-w-0 flex-col">
									<span className="text-[12.5px] text-(--text-primary)">{title}</span>
									<span className="text-[11.5px] text-(--text-tertiary)">{detail}</span>
								</span>
							</button>
						))}
					</div>
					<div className="flex flex-wrap items-center justify-end gap-3">
						<button type="button" className="mr-auto text-[12px] text-(--text-tertiary) hover:text-(--text-secondary)" onClick={() => setShowClient((open) => !open)}>
							{showClient ? 'Hide the OAuth client' : `OAuth client ${account.client.clientId.slice(0, 12)}…${account.client.fromEnv ? ' (from the environment)' : ''}`}
						</button>
						<ConnectButton mailbox={mailbox} access={access} label={`Connect ${mailbox.name}`} />
					</div>
					{showClient ? <GoogleClient account={account} open /> : null}
				</div>
			) : (
				<div className="flex flex-col">
					{account.problem ? (
						<div className="mb-2 flex flex-wrap items-center gap-3 rounded-[10px] border border-(--danger-border) px-3 py-2">
							<span className="min-w-0 flex-1 text-[12px] text-(--danger-text)">{account.problem}</span>
							<ConnectButton mailbox={mailbox} access={mailbox.canDraft ? 'draft' : 'read'} label="Connect again" />
						</div>
					) : null}
					<SettingRow title="Signed in" help={account.connectedAt ? `Since ${new Date(account.connectedAt).toLocaleDateString()}` : undefined}>
						<span className="inline-flex items-center gap-1.5 font-mono text-[12px] text-(--text-secondary)">
							<Icon icon={GOOGLE.icon} size={13} />
							{account.email ?? 'Google account'}
						</span>
					</SettingRow>
					<SettingRow title={`Use ${mailbox.name} in tasks`} help="Off leaves the sign-in in place, but no task's agent gets the tools.">
						<Switch checked={mailbox.options.enabled} disabled={options.isPending} onChange={(enabled) => set({ enabled })} label={<span className="sr-only">Use {mailbox.name}</span>} />
					</SettingRow>
					<SettingRow
						title="Write drafts"
						help={mailbox.canDraft ? 'Drafts land in your Drafts folder, where you can edit them too.' : 'This sign-in only allowed reading. Connect again with drafts and sending allowed.'}
					>
						{mailbox.canDraft ? null : <ConnectButton mailbox={mailbox} access="draft" label="Allow" variant="secondary" />}
						<Switch
							checked={mailbox.canDraft && mailbox.options.draft}
							disabled={!mailbox.canDraft || !mailbox.options.enabled || options.isPending}
							onChange={(draft) => set({ draft })}
							label={<span className="sr-only">Write drafts</span>}
						/>
					</SettingRow>
					<SettingRow title="Send, when you press Send" help="The agent asks; the thread shows you the email as it will go, with Send and Don't send. A draft changed after you were shown it is not sent.">
						<Switch
							checked={mailbox.canDraft && mailbox.options.send}
							disabled={!mailbox.canDraft || !mailbox.options.enabled || options.isPending}
							onChange={(send) => set({ send })}
							label={<span className="sr-only">Send after you press Send</span>}
						/>
					</SettingRow>
					<ErrorLine error={options.error} />
				</div>
			)}
		</Block>
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

/** Remote MCP servers that sign in with OAuth, to add with a click; Sign in on the row does the rest. */
const POPULAR = [
	{ name: 'linear', url: 'https://mcp.linear.app/mcp' },
	{ name: 'notion', url: 'https://mcp.notion.com/mcp' },
	{ name: 'atlassian', url: 'https://mcp.atlassian.com/v1/mcp' },
	{ name: 'sentry', url: 'https://mcp.sentry.dev/mcp' },
	{ name: 'stripe', url: 'https://mcp.stripe.com' },
	{ name: 'vercel', url: 'https://mcp.vercel.com' },
	{ name: 'supabase', url: 'https://mcp.supabase.com/mcp' },
];

function PopularServer({ name, url, onPick }: { name: string; url: string; onPick: () => void }) {
	const mark = useServerMark(url);
	return (
		<button
			type="button"
			onClick={onPick}
			className="inline-flex h-7 items-center gap-1.5 rounded-full border border-(--border-subtle) pr-2.5 pl-1 text-[12px] text-(--text-secondary) outline-none hover:border-(--border-strong) focus-visible:shadow-(--focus-ring)"
		>
			<MarkTile mark={mark} size={20} className="rounded-full" />
			{mark === MCP ? name : mark.title}
		</button>
	);
}

function ServerForm({ editing, onDone }: { editing: McpServer | null; onDone: () => void }) {
	const [draft, setDraft] = useState(() => toDraft(editing ?? undefined));
	const update = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));
	const save = useConnectorMutation(async () => (editing ? api.updateMcpServer(toInput(draft, editing)) : api.addMcpServer(toInput(draft, null))));
	return (
		<form
			className="flex flex-col gap-2 rounded-[12px] border border-(--border-subtle) p-3"
			onSubmit={(event) => {
				event.preventDefault();
				save.mutate(undefined, { onSuccess: onDone });
			}}
		>
			{editing ? null : (
				<div className="flex flex-wrap items-center gap-1.5" aria-label="Popular servers">
					{POPULAR.map((server) => (
						<PopularServer key={server.name} {...server} onPick={() => update({ name: server.name, url: server.url })} />
					))}
				</div>
			)}
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
				<Switch checked={draft.codeMode} onChange={(codeMode) => update({ codeMode })} label={<span className="text-[12px] text-(--text-secondary)">Through code mode</span>} />
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

/** Lists the server's tools now, as the agent would get them: a check that its address and token work. */
function ServerTools({ name }: { name: string }) {
	const tools = useQuery({ queryKey: ['mcp-tools', name], queryFn: () => api.mcpServerTools(name), retry: false, staleTime: 0 });
	if (tools.isPending) return <Spinner size={12} />;
	if (tools.isError) return <span className="text-[12px] text-(--danger-text)">{tools.error.message}</span>;
	if (!tools.data.tools.length) return <span className="text-[12px] text-(--text-tertiary)">It answered with no tools.</span>;
	return (
		<ul className="m-0 flex list-none flex-col gap-0.5 p-0">
			{tools.data.tools.map((tool) => (
				<li key={tool.name} className="flex min-w-0 gap-2 text-[12px] leading-[18px]">
					<span className="shrink-0 font-mono text-(--text-secondary)">{tool.name}</span>
					<span className="min-w-0 truncate text-(--text-tertiary)">{tool.description}</span>
				</li>
			))}
		</ul>
	);
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
	return (
		<form
			className="flex flex-col gap-2 rounded-[10px] border border-(--border-subtle) px-3 py-2.5"
			onSubmit={(event) => {
				event.preventDefault();
				signIn.mutate({ clientId: clientId.trim(), clientSecret: secret || null });
			}}
		>
			<p className="m-0 text-[12px] leading-[18px] text-(--text-tertiary)">
				In the service's developer settings, create an OAuth app with this redirect URI, then paste its client id, and its secret if it has one.
			</p>
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

function ServerRow({ server, onEdit }: { server: McpServer; onEdit: () => void }) {
	const [checking, setChecking] = useState(false);
	const [confirming, setConfirming] = useState(false);
	const toggle = useConnectorMutation((enabled: boolean) => api.setMcpServerEnabled(server.name, enabled));
	const remove = useConnectorMutation(() => api.removeMcpServer(server.name));
	const signIn = useSignIn(server);
	const mark = useServerMark(server.url);
	const signedIn = server.signIn.state === 'signed-in';
	const needsSignIn = server.signIn.state === 'needed';
	// A server with a pasted token needs no sign-in; one without may, and saying so is cheap.
	const offerSignIn = !signedIn && !server.hasAuth;
	const noRegistration = /register themselves/.test(signIn.error?.message ?? '');
	const facts = [
		signedIn ? 'signed in' : server.hasAuth ? 'token' : null,
		server.tools.length ? `${server.tools.length} tools allowed` : 'all tools',
		server.codeMode === false ? 'direct' : 'through code mode',
	].filter(Boolean);
	return (
		<div className="flex flex-col gap-2 border-t border-(--border-subtle) py-2.5 first:border-t-0 first:pt-1">
			<div className="flex min-w-0 items-center gap-3">
				<MarkTile mark={mark} size={32} label={mark.title} className={server.enabled ? undefined : 'opacity-50 grayscale'} />
				<div className="flex min-w-0 flex-1 flex-col gap-0.5">
					<div className={cn('font-mono text-[13px]', server.enabled ? 'text-(--text-primary)' : 'text-(--text-disabled)')}>{server.name}</div>
					<div className="truncate font-mono text-[11.5px] text-(--text-tertiary)">{server.url}</div>
					<div className="text-[11px] text-(--text-disabled)">{facts.join(' · ')}</div>
				</div>
				{offerSignIn ? (
					<Btn size="sm" variant={needsSignIn ? 'primary' : 'secondary'} icon={ExternalLink} disabled={signIn.isPending} onClick={() => signIn.mutate(undefined)}>
						{signIn.isPending ? 'Opening…' : needsSignIn ? 'Sign in again' : 'Sign in'}
					</Btn>
				) : null}
				<Btn size="sm" variant="ghost" onClick={() => setChecking((open) => !open)}>
					{checking ? 'Hide tools' : 'Tools'}
				</Btn>
				<Btn size="sm" variant="ghost" onClick={onEdit}>
					Edit
				</Btn>
				<IconBtn
					icon={X}
					size="sm"
					label={confirming ? `Click again to remove ${server.name}` : `Remove ${server.name}`}
					className={confirming ? 'text-(--danger-text)' : undefined}
					onBlur={() => setConfirming(false)}
					onClick={() => (confirming ? remove.mutate(undefined) : setConfirming(true))}
				/>
				<Switch checked={server.enabled} disabled={toggle.isPending} onChange={(enabled) => toggle.mutate(enabled)} label={<span className="sr-only">Use {server.name}</span>} />
			</div>
			{needsSignIn ? <span className="text-[12px] text-(--danger-text)">{server.signIn.problem}</span> : null}
			{checking ? (
				<div className="rounded-[10px] border border-(--border-subtle) bg-(--well-bg) px-3 py-2">
					<ServerTools name={server.name} />
				</div>
			) : null}
			<ErrorLine error={toggle.error ?? remove.error ?? signIn.error} />
			{offerSignIn && (server.signIn.pastedClient || noRegistration) ? <OwnClient server={server} signIn={signIn} /> : null}
		</div>
	);
}

function McpServers({ servers }: { servers: McpServer[] }) {
	const [editing, setEditing] = useState<string | null>(null);
	const [adding, setAdding] = useState(false);
	return (
		<Block
			title="MCP servers"
			mark={<MarkTile mark={MCP} />}
			aside={servers.length ? <Status tone={servers.some((server) => server.enabled) ? 'accent' : 'neutral'}>{servers.filter((server) => server.enabled).length} on</Status> : undefined}
			help="Remote MCP servers every task's agent can call, a repository's and a chat's alike, over HTTPS. Sign in connects one that uses OAuth, as Linear and Notion do; Anton keeps and renews the sign-in. A pasted token is sent as a bearer header instead. Neither is shown again. List tool names to allow only those. With code mode on, the agent calls a server's tools from its scripts, a line per tool rather than a full tool each; turn Through code mode off to give the agent a server's tools directly."
		>
			{servers.length ? (
				<div className="flex flex-col">
					{servers.map((server) =>
						editing === server.name ? (
							<ServerForm key={server.name} editing={server} onDone={() => setEditing(null)} />
						) : (
							<ServerRow key={server.name} server={server} onEdit={() => setEditing(server.name)} />
						),
					)}
				</div>
			) : null}
			{adding ? (
				<ServerForm editing={null} onDone={() => setAdding(false)} />
			) : (
				<Btn size="sm" variant="ghost" icon={Plus} className="self-start" onClick={() => setAdding(true)}>
					Add a server
				</Btn>
			)}
		</Block>
	);
}

/** What Google's return said: connected, or what went wrong, until dismissed. */
function Returned() {
	const search = useSearch({ strict: false }) as { connected?: string; problem?: string };
	const navigate = useNavigate();
	if (!search.connected && !search.problem) return null;
	const dismiss = () => void navigate({ to: '/settings/$section', params: { section: 'connectors' }, search: {}, replace: true });
	return (
		<div
			role="status"
			className={cn(
				'flex items-center gap-3 rounded-[12px] border px-3.5 py-2.5 text-[12.5px]',
				search.problem ? 'border-(--danger-border) text-(--danger-text)' : 'border-(--success-border) text-(--success-text)',
			)}
		>
			<span className="min-w-0 flex-1">{search.problem ? `Not connected: ${search.problem}` : 'Connected. New messages in any task can use it.'}</span>
			<IconBtn icon={X} size="sm" label="Dismiss" onClick={dismiss} />
		</div>
	);
}

export function ConnectorsPage() {
	const connectors = useConnectors();
	return (
		<>
			<PageHeading title="Connectors">
				Services every task's agent can use, added once like skills: your email, and MCP servers. Each can be turned off without removing it. Sign-ins and tokens stay on
				Anton's server and never reach a sandbox.
			</PageHeading>
			<Returned />
			{connectors.data ? (
				<>
					{connectors.data.mailboxes.map((mailbox) => {
						const account = connectors.data.accounts.find((item) => item.id === mailbox.account);
						return account ? <MailboxBlock key={mailbox.id} mailbox={mailbox} account={account} /> : null;
					})}
					<McpServers servers={connectors.data.mcpServers} />
				</>
			) : connectors.isError ? (
				<p className="m-0 text-[12px] text-(--danger-text)">{connectors.error.message}</p>
			) : (
				<Spinner size={12} />
			)}
		</>
	);
}

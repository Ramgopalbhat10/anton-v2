import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link, useCanGoBack, useNavigate, useRouter, useSearch } from '@tanstack/react-router';
import { ArrowLeft, Plus } from '@/lib/icons';
import { type ReactNode, useEffect, useState } from 'react';
import { GMAIL, type Mark, MarkTile, MCP, useComposioMark, useServerMark } from '@/components/marks/brand-marks';
import { Btn, EmptyState, Icon, SearchField, Spinner } from '@/components/kit/signal';
import { api } from '@/lib/api';
import { type CatalogEntry, catalogEntryFor, composioEntryFor, COMPOSIO_CATALOG, GMAIL_ENTRY, MCP_CATALOG } from '@/lib/connector-catalog';
import { type ConnectorItem, connectorItems, connectorKey } from '@/lib/connectors';
import { cn } from '@/lib/utils';
import { PageHeading } from './parts';
import { hostOf, OnSwitch, type Opened, Returned, StateBadge, useConnectors } from './connector-parts';
import { MailboxDetail } from './connector-mailbox';
import { CustomServer, OfferedServer, ServerDetail } from './connector-mcp';
import { ComposioDetail, entryForToolkit, OfferedComposio, OfferedComposioLookup } from './connector-composio';

function useItemMark(item: ConnectorItem | null): Mark {
	const composio = item?.kind === 'composio' ? item.account : undefined;
	const composioUrl = composio ? composio.appUrl || composioEntryFor(composio.toolkit)?.url || '' : '';
	const url = item?.kind === 'mcp' ? item.server.url : composio ? composioUrl : '';
	const mark = useComposioMark(composio?.logo || undefined, url, composio?.name ?? '');
	return item?.kind === 'mailbox' ? GMAIL : mark;
}

function Tile({ open, mark, title, mono, by, tagline, corner }: { open: Opened; mark: Mark; title: string; mono?: boolean; by: string; tagline: string; corner: ReactNode }) {
	return (
		<div className="in-card group relative flex-row items-start gap-3 p-3.5 transition-colors duration-(--t-fast) hover:border-(--line-strong)">
			<MarkTile mark={mark} size={40} className="rounded-control" />
			<div className="flex min-w-0 flex-1 flex-col gap-0.5">
				<Link
					to="/settings/connectors/view"
					search={open}
					className={cn(
						'truncate text-body-lg font-medium text-(--text) outline-none after:absolute after:inset-0 after:rounded-control focus-visible:after:shadow-(--focus)',
						mono && 'text-body',
					)}
				>
					{title}
				</Link>
				<p className="m-0 line-clamp-2 text-small leading-[17px] text-pretty text-(--text-3)">{tagline}</p>
				<span className="text-micro text-(--text-4)">by {by}</span>
			</div>
			<div className="relative z-10 flex shrink-0 items-center">{corner}</div>
		</div>
	);
}

const AddCorner = () => (
	<span aria-hidden className="inline-flex size-7 items-center justify-center text-(--text-3) group-hover:text-(--text)">
		<Icon icon={Plus} size={16} />
	</span>
);

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

function OfferedComposioTile({ entry }: { entry: CatalogEntry }) {
	const mark = useComposioMark(entry.logo, entry.url ?? '', entry.name);
	return <Tile open={{ add: `composio:${entry.id}` }} mark={mark} title={entry.name} by={entry.by} tagline={entry.tagline} corner={<AddCorner />} />;
}

const matches = (words: string, ...texts: string[]) => !words || texts.some((text) => text.toLowerCase().includes(words));

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
			{connectors.isError ? <p className="m-0 text-small text-(--bad)">{connectors.error.message}</p> : null}
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
			<span className="in-num rounded-control bg-(--bg-active) px-1.5 text-micro font-normal text-(--text-3)">{count}</span>
		</h2>
	);
}

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
				className="inline-flex items-center gap-1.5 self-start text-small text-(--text-3) outline-none hover:text-(--text) focus-visible:shadow-(--focus)"
			>
				<Icon icon={ArrowLeft} size={12} />
				Connectors
			</button>
			{page ??
				(connectors.isPending ? (
					<Spinner size={12} />
				) : connectors.isError ? (
					<p className="m-0 text-small text-(--bad)">{connectors.error.message}</p>
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

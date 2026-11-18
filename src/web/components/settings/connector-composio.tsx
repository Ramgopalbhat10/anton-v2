import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { ExternalLink, Plus } from '@/lib/icons';
import { useState } from 'react';
import { useComposioMark } from '@/components/marks/brand-marks';
import { Btn, Spinner } from '@/components/kit/signal';
import { api } from '@/lib/api';
import type { ComposioAccount, ComposioAuthMethod, ComposioAuthSetup, ComposioToolkitHit } from '@/lib/api/connectors';
import { type CatalogEntry, composioEntryFor } from '@/lib/connector-catalog';
import { connectorItems, connectorKey } from '@/lib/connectors';
import { cn } from '@/lib/utils';
import { FIELD, Note } from './parts';
import { ConsoleLink, DetailFrame, DocsLink, ErrorLine, type Fact, OnSwitch, type Opened, Prose, Returned, Section, since, ToolChips, useConnectorMutation, useConnectors } from './connector-parts';

export const entryForToolkit = (hit: ComposioToolkitHit): CatalogEntry => ({
	id: hit.slug,
	name: hit.name,
	by: 'Composio',
	tagline: hit.description.length > 100 ? `${hit.description.slice(0, 97).trimEnd()}…` : hit.description,
	description: hit.description,
	category: hit.categories[0] ?? 'Apps',
	url: hit.appUrl ?? undefined,
	logo: hit.logo || undefined,
});

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
			{keyFromEnv ? <span className="text-small text-(--text-3)">Set by COMPOSIO_API_KEY on this server.</span> : null}
		</form>
	);
}

function ComposioTools({ toolkit }: { toolkit: string }) {
	const tools = useQuery({ queryKey: ['composio-tools', toolkit], queryFn: () => api.composioTools(toolkit), retry: false, staleTime: 60_000 });
	if (tools.isPending) return <Spinner size={12} />;
	if (tools.isError) return <span className="text-small text-(--bad)">{tools.error.message}</span>;
	if (!tools.data.tools.length) return <span className="text-small text-(--text-3)">Composio lists no tools for it.</span>;
	return <ToolChips tools={tools.data.tools.map((tool) => ({ name: tool.name, about: tool.description }))} />;
}

/** For apps Composio has no shared sign-in for: the fields Composio asks for its auth config, sent on to Composio and not kept by Anton. */
function ComposioCredentials({ account, setup, onCancel }: { account: ComposioAccount; setup: ComposioAuthSetup; onCancel?: () => void }) {
	const [scheme, setScheme] = useState(setup.methods[0]?.scheme ?? '');
	const [values, setValues] = useState<Record<string, string>>({});
	const method: ComposioAuthMethod | undefined = setup.methods.find((each) => each.scheme === scheme) ?? setup.methods[0];
	const save = useMutation({
		mutationFn: () => api.saveComposioCredentials(account.toolkit, method?.scheme ?? '', values),
		onSuccess: ({ url }) => window.location.assign(url),
	});
	if (!method) return null;
	const missing = method.configFields.some((field) => field.required && !values[field.name]?.trim());
	return (
		<form
			className="flex flex-col gap-2.5 rounded-control border border-(--line) p-3"
			onSubmit={(event) => {
				event.preventDefault();
				save.mutate();
			}}
		>
			{setup.methods.length > 1 ? (
				<div className="flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label="Sign-in method">
					{setup.methods.map((each) => (
						<Btn key={each.scheme} size="sm" variant={each.scheme === method.scheme ? 'primary' : 'ghost'} role="radio" aria-checked={each.scheme === method.scheme} onClick={() => setScheme(each.scheme)}>
							{each.name}
						</Btn>
					))}
				</div>
			) : null}
			{method.configFields.map((field) => (
				<label key={field.name} className="flex flex-col gap-1">
					<span className="text-small text-(--text-2)">
						{field.label}
						{field.required ? null : <span className="text-(--text-3)"> (optional)</span>}
					</span>
					<input
						type={field.secret ? 'password' : 'text'}
						autoComplete="off"
						value={values[field.name] ?? ''}
						onChange={(event) => setValues((current) => ({ ...current, [field.name]: event.target.value }))}
						placeholder={field.default ?? undefined}
						aria-label={field.label}
						className={cn(FIELD, 'font-mono')}
					/>
					{field.description ? <span className="text-small text-(--text-3)">{field.description}</span> : null}
				</label>
			))}
			<div className="flex flex-wrap items-center gap-3">
				{method.hintUrl || setup.guideUrl ? <ConsoleLink href={method.hintUrl ?? setup.guideUrl ?? ''}>Where to find these</ConsoleLink> : null}
				<span className="flex-1" />
				<ErrorLine error={save.error} />
				{onCancel ? (
					<Btn size="sm" variant="ghost" onClick={onCancel}>
						Cancel
					</Btn>
				) : null}
				<Btn type="submit" size="sm" variant="primary" icon={ExternalLink} disabled={save.isPending || missing}>
					{save.isPending ? 'Opening…' : `Save and connect ${account.name}`}
				</Btn>
			</div>
		</form>
	);
}

const composioStatus = (account: ComposioAccount) =>
	account.status === 'active' ? 'Connected' : account.status === 'pending' ? 'Waiting for you to finish signing in' : account.status === 'failed' ? 'The connection failed' : 'Not connected yet';

export function ComposioDetail({ account, search }: { account: ComposioAccount; search: Opened }) {
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
	const setup = useQuery({ queryKey: ['composio-auth', account.toolkit], queryFn: () => api.composioAuth(account.toolkit), enabled: !active, retry: false, staleTime: 60_000 });
	const needsCredentials = setup.data?.state === 'credentials';
	const [replacing, setReplacing] = useState(false);
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
					{!active && !needsCredentials ? (
						<Btn size="sm" variant="primary" icon={ExternalLink} disabled={connect.isPending || setup.isPending} onClick={() => connect.mutate()}>
							{connect.isPending ? 'Opening…' : pending ? 'Open sign-in again' : `Connect ${account.name}`}
						</Btn>
					) : null}
					{pending ? (
						<Btn size="sm" variant="secondary" disabled={check.isPending} onClick={() => check.mutate(undefined)}>
							{check.isPending ? 'Checking…' : 'Check again'}
						</Btn>
					) : null}
					{item ? <OnSwitch item={item} label={<span className="text-body text-(--text-2)">On for tasks</span>} /> : null}
				</>
			}
		>
			<Returned search={search} />
			<Prose>{entry?.description ?? account.description}</Prose>
			{account.status === 'failed' ? (
				<div className="flex flex-wrap items-center gap-3 rounded-control border border-(--bad-line) px-3 py-2">
					<span className="min-w-0 flex-1 text-small text-(--bad)">{account.statusReason ?? 'The connection failed.'}</span>
				</div>
			) : null}
			{pending ? (
				<Note info="Finish signing in on the page that opened; this updates when you come back, or press Check again.">
					Composio is holding the sign-in until you approve it on {account.name}’s own page.
				</Note>
			) : null}
			<ErrorLine error={connect.error} />
			{!active && setup.data && setup.data.methods.length > 0 && setup.data.state !== 'managed' ? (
				<Section title="Your credentials">
					{needsCredentials || replacing ? (
						<>
							<Note info="Anton passes these to Composio, which keeps them in an auth config for this app; Anton does not store them.">
								{needsCredentials
									? `Composio has no shared sign-in for ${account.name}, so it runs on your own. You can also make an auth config for “${account.toolkit}” in Composio’s dashboard instead; Anton uses it when you connect.`
									: `This makes a new auth config at Composio with these credentials and connects with it.`}
							</Note>
							<ComposioCredentials account={account} setup={setup.data} onCancel={needsCredentials ? undefined : () => setReplacing(false)} />
						</>
					) : (
						<div className="flex flex-wrap items-center gap-3">
							<span className="min-w-0 flex-1 text-small text-(--text-3)">
								{setup.data.state === 'custom' ? 'Connects with the auth config you made at Composio.' : 'Composio asks for the account’s details on its sign-in page.'}
							</span>
							<Btn size="sm" variant="ghost" onClick={() => setReplacing(true)}>
								Use other credentials
							</Btn>
						</div>
					)}
				</Section>
			) : null}
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
							<span className="min-w-0 flex-1 text-small text-(--text-3)">Revokes the sign-in at {account.name} and at Composio; the app stays here to connect again.</span>
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
					<span className="min-w-0 flex-1 text-small text-(--text-3)">Removes the app, its sign-in and its connection from Anton.</span>
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

export function OfferedComposio({ entry }: { entry: CatalogEntry }) {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const view = useConnectors().data?.composio;
	const configured = Boolean(view?.configured);
	const mark = useComposioMark(entry.logo, entry.url ?? '', entry.name);
	const add = useMutation({
		mutationFn: async () => {
			await api.addComposioAccount(entry.id);
			// An app with no shared sign-in opens on its page, which asks for your credentials first.
			if ((await api.composioAuth(entry.id)).state === 'credentials') return { url: '' };
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

export function OfferedComposioLookup({ slug }: { slug: string }) {
	const toolkit = useQuery({ queryKey: ['composio-toolkit', slug], queryFn: () => api.composioToolkit(slug), staleTime: 60_000 });
	if (toolkit.isPending) return <Spinner size={12} />;
	if (toolkit.isError) return <p className="m-0 text-small text-(--bad)">{toolkit.error.message}</p>;
	return <OfferedComposio entry={entryForToolkit(toolkit.data)} />;
}

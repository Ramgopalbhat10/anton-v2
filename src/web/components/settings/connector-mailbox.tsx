import { useMutation } from '@tanstack/react-query';
import { ExternalLink } from '@/lib/icons';
import { useState } from 'react';
import { GMAIL, GOOGLE } from '@/components/marks/brand-marks';
import { Btn, Icon, Switch } from '@/components/kit/signal';
import { api } from '@/lib/api';
import type { ConnectorAccount, ConnectorMailbox } from '@/lib/api/connectors';
import { GMAIL_ENTRY, GMAIL_TOOLS } from '@/lib/connector-catalog';
import { connectorItems } from '@/lib/connectors';
import { cn } from '@/lib/utils';
import { FIELD, Note, SettingRow } from './parts';
import { ConsoleLink, CopyField, DetailFrame, DocsLink, ErrorLine, type Fact, OnSwitch, type Opened, Prose, Returned, Section, since, StateBadge, Step, ToolChips, useConnectorMutation, useConnectors } from './connector-parts';

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
				{save.isSuccess && !save.isPending ? <span className="text-small text-(--ok)">Saved.</span> : null}
				<Btn type="submit" size="sm" variant={open ? 'primary' : 'secondary'} disabled={save.isPending || (!clientId.trim() && !account.client)}>
					{save.isPending ? 'Saving…' : 'Save client'}
				</Btn>
			</div>
		</form>
	);
}

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

export function MailboxDetail({ mailbox, account, search }: { mailbox: ConnectorMailbox; account: ConnectorAccount; search: Opened }) {
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
						<OnSwitch item={item} label={<span className="text-body text-(--text-2)">On for tasks</span>} />
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
									'flex items-center gap-2.5 rounded-control border px-2.5 py-2 text-left outline-none focus-visible:shadow-(--focus)',
									access === value ? 'border-(--accent-line) bg-(--accent-soft)' : 'border-(--line) hover:border-(--line-strong)',
								)}
							>
								<span className={cn('inline-flex size-3.5 shrink-0 rounded-full border', access === value ? 'border-(--accent) bg-(--accent)' : 'border-(--line-strong)')} />
								<span className="flex min-w-0 flex-col">
									<span className="text-body text-(--text)">{title}</span>
									<span className="text-small text-(--text-3)">{detail}</span>
								</span>
							</button>
						))}
					</div>
					<div className="flex flex-wrap items-center justify-end gap-3">
						<button type="button" className="mr-auto text-small text-(--text-3) hover:text-(--text-2)" onClick={() => setShowClient((open) => !open)}>
							{showClient ? 'Hide the OAuth client' : 'Change the OAuth client'}
						</button>
						<ConnectButton mailbox={mailbox} access={access} label={`Connect ${mailbox.name}`} />
					</div>
					{showClient ? <GoogleClient account={account} open /> : null}
				</Section>
			) : (
				<>
					{account.problem ? (
						<div className="flex flex-wrap items-center gap-3 rounded-control border border-(--bad-line) px-3 py-2">
							<span className="min-w-0 flex-1 text-small text-(--bad)">{account.problem}</span>
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
						<span className="min-w-0 flex-1 text-small text-(--text-3)">Signs out of {account.email ?? 'the account'} and removes Anton from its connected apps.</span>
						<Disconnect account={account} />
					</div>
				</Section>
			) : null}
		</DetailFrame>
	);
}

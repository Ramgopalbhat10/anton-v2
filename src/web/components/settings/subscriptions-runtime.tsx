import { useMutation } from '@tanstack/react-query';
import { ExternalLink, RotateCw } from '@/lib/icons';
import { useState } from 'react';
import { PlanLinkArt } from '@/components/marks/illustrations';
import { Caption, Card, CardFooter, CardSection, SpecGrid, Status, Well } from '@/components/kit/instrument';
import { Btn, Icon, InfoTip } from '@/components/kit/signal';
import { api } from '@/lib/api';
import type { Subscription } from '@/lib/api/plans';
import { age, tokens } from '@/lib/format';
import { logoFor } from '@/lib/provider-logos';
import { FIELD, Note, SaveState } from './parts';
import { Lead, Models, Named, PlanSettings, STATUS, useSaved, useSignIn, Windows } from './subscriptions-parts';

function RuntimePending({ subscription, finish }: { subscription: Subscription; finish: ReturnType<typeof useRuntimeFinish> }) {
	const saved = useSaved();
	const [code, setCode] = useState('');
	const name = subscription.name;
	const login = subscription.login!;
	const cancel = useMutation({ mutationFn: () => api.cancelSubscriptionLogin(subscription.id), onSuccess: saved });
	return (
		<>
			<CardSection label="Finish signing in" hint="Paste the code">
				<ol className="m-0 flex list-decimal flex-col gap-1.5 pl-5 text-small leading-[18px] text-(--text-2)">
					<li>
						Approve {name} in the {name} tab.{' '}
						<a href={login.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-(--accent-text) hover:underline">
							Open it again
							<Icon icon={ExternalLink} size={11} />
						</a>
					</li>
					<li>{name} then shows a code. Copy it and paste it here.</li>
				</ol>
				<form
					className="flex flex-wrap items-center gap-2"
					onSubmit={(event) => {
						event.preventDefault();
						finish.mutate(code);
					}}
				>
					<input
						value={code}
						onChange={(event) => setCode(event.target.value)}
						placeholder={`Code from ${name}`}
						aria-label={`Code from ${name}`}
						autoComplete="off"
						spellCheck={false}
						className={`${FIELD} min-w-[240px] flex-1 font-mono text-small`}
					/>
					<Btn type="submit" size="sm" variant="primary" disabled={!code.trim() || finish.isPending}>
						{finish.isPending ? 'Connecting…' : 'Connect'}
					</Btn>
				</form>
				<SaveState pending={finish.isPending} success={false} error={finish.error ?? cancel.error} />
			</CardSection>
			<CardFooter caption={`Started ${age(login.startedAt)} ago · expires after 10 min`}>
				<Btn size="sm" variant="ghost" disabled={cancel.isPending || finish.isPending} onClick={() => cancel.mutate()}>
					Cancel
				</Btn>
			</CardFooter>
		</>
	);
}

type OAuthClient = NonNullable<Subscription['oauthClient']>;

/** The OAuth client the sign-in uses, kept in Anton's database and shown filled in once saved. */
function OAuthClientForm({ subscription, client }: { subscription: Subscription; client: OAuthClient }) {
	const saved = useSaved();
	const [clientId, setClientId] = useState(client.clientId);
	const [clientSecret, setClientSecret] = useState(client.clientSecret);
	const save = useMutation({
		mutationFn: (next: { clientId: string; clientSecret: string }) => api.setSubscriptionClient(subscription.id, next),
		onSuccess: (result) => {
			saved(result);
			if (!result.oauthClient) return;
			setClientId(result.oauthClient.clientId);
			setClientSecret(result.oauthClient.clientSecret);
		},
	});
	const name = subscription.name;
	const stored = Boolean(client.clientId);
	const changed = clientId.trim() !== client.clientId || clientSecret.trim() !== client.clientSecret;
	return (
		<CardSection label="OAuth client" hint={stored ? 'Saved' : 'Required'}>
			<Note info={`Use the public client ${name}'s own sign-in uses. A sign-in made on a different client may need signing in again.`}>
				{stored ? `The Google OAuth client Anton signs in to ${name} with. Edit it and save to change it.` : `Paste ${name}'s OAuth client id and secret once, before signing in. They're saved in Anton's database.`}
			</Note>
			<form
				className="flex flex-col gap-2"
				onSubmit={(event) => {
					event.preventDefault();
					save.mutate({ clientId, clientSecret });
				}}
			>
				<label className="flex flex-col gap-1">
					<span className="text-small text-(--text-3)">Client ID</span>
					<input
						value={clientId}
						onChange={(event) => setClientId(event.target.value)}
						placeholder="Client id, …apps.googleusercontent.com"
						aria-label={`${name} client id`}
						autoComplete="off"
						spellCheck={false}
						className={`${FIELD} font-mono text-small`}
					/>
				</label>
				<label className="flex flex-col gap-1">
					<span className="text-small text-(--text-3)">Client secret</span>
					<input
						value={clientSecret}
						onChange={(event) => setClientSecret(event.target.value)}
						placeholder="Client secret"
						aria-label={`${name} client secret`}
						autoComplete="off"
						spellCheck={false}
						className={`${FIELD} font-mono text-small`}
					/>
				</label>
				<div className="flex flex-wrap items-center gap-2">
					<Btn type="submit" size="sm" variant="secondary" disabled={!changed || !clientId.trim() || !clientSecret.trim() || save.isPending}>
						{save.isPending ? 'Saving…' : 'Save client'}
					</Btn>
					{stored ? (
						<Btn type="button" size="sm" variant="ghost" disabled={save.isPending} onClick={() => save.mutate({ clientId: '', clientSecret: '' })}>
							Remove
						</Btn>
					) : null}
					<SaveState pending={save.isPending} success={save.isSuccess && !changed} error={save.error} />
				</div>
			</form>
		</CardSection>
	);
}

/** Held by the card, so a refused code's message stays after the sign-in ends. */
function useRuntimeFinish(subscription: Subscription) {
	const saved = useSaved();
	return useMutation({ mutationFn: (code: string) => api.finishSubscriptionLogin(subscription.id, code), onSuccess: saved });
}

/** A vendor's own agent program Anton drives as a model: it runs jailed on this server (or in its sandbox), signs in through its own flow, and Anton never sees its token. */
export function RuntimePlan({ subscription }: { subscription: Subscription }) {
	const saved = useSaved();
	const name = subscription.name;
	const signIn = useSignIn(subscription);
	const finish = useRuntimeFinish(subscription);
	const [confirming, setConfirming] = useState(false);
	const refresh = useMutation({ mutationFn: () => api.refreshSubscriptionModels(subscription.id), onSuccess: saved });
	const disconnect = useMutation({ mutationFn: () => api.disconnectSubscription(subscription.id), onSuccess: saved });
	const connected = subscription.state === 'connected';
	const pending = !connected && Boolean(subscription.login);
	const status = pending ? { tone: 'accent' as const, label: 'Signing in' } : STATUS[subscription.state];
	const { enabled, countAtApiPrices } = subscription.options;
	return (
		<Card
			title={`${name} plan`}
			sub={subscription.email ?? (pending ? 'waiting for approval' : `through ${name}`)}
			label={`${name} plan`}
			status={
				<Status tone={status.tone} pulse={connected || pending}>
					{connected ? 'Connected' : subscription.state === 'expired' && !pending ? 'Needs attention' : status.label}
				</Status>
			}
		>
			<CardSection ruled={false} className="pt-0">
				<Well grid className="flex items-center justify-center px-4 py-6">
					<PlanLinkArt linked={connected} plan={name} logo={logoFor({ id: `${subscription.gateway}/` })} className="w-full max-w-[440px]" />
				</Well>
			</CardSection>
			{connected ? (
				<Lead
					title={`${subscription.models.length} ${subscription.models.length === 1 ? 'model' : 'models'} on your plan`}
					info={
						<>
							{name} runs on this server with only Anton's tools. <Named gateway={subscription.gateway} />
						</>
					}
				>
					Billed to your {name} plan's usage, not per token.
				</Lead>
			) : pending ? (
				<Lead title={`Waiting for ${name}`}>Approve {name} in the {name} tab, then paste the code it shows.</Lead>
			) : subscription.state === 'expired' ? (
				<Lead title={`${name} cannot connect`}>
					<span className="text-(--bad)">{subscription.problem}</span>
				</Lead>
			) : (
				<Lead
					title={`Run tasks on your ${name} plan`}
					info={`${name} only runs inside its own agent, so Anton runs that agent on this server with its built-in tools off: ${name} does the thinking, and Anton runs every tool. It signs in through its own flow and keeps the sign-in to itself.`}
				>
					Through {name} on this server.
				</Lead>
			)}
			{connected ? (
				<>
					<SpecGrid
						items={[
							{ label: 'Account', value: subscription.email ?? 'Signed in', title: subscription.email ?? undefined },
							{ label: 'Plan', value: subscription.plan ?? '—' },
							{ label: name, value: subscription.version ?? '—' },
							{ label: 'Models', value: enabled ? `${subscription.models.length} in the picker` : 'Switched off', tone: enabled ? undefined : 'warning' },
							{ label: 'This month', value: `${tokens(subscription.monthTokens)} tokens`, tone: 'accent' },
							{ label: 'Counted as', value: countAtApiPrices ? 'API prices' : '$0 per call' },
						]}
					/>
					{subscription.extraUsageAt ? (
						<CardSection label="Extra usage">
							<p className="m-0 max-w-[72ch] text-small leading-[18px] text-pretty text-(--warn)">
								Your plan's limit ran out {age(subscription.extraUsageAt)} ago and calls now bill extra usage, which costs money. Turn it off at{' '}
								{subscription.gateway === 'claude-code' ? (
									<a href="https://claude.ai/settings/usage" target="_blank" rel="noreferrer" className="text-(--accent-text) hover:underline">
										claude.ai/settings/usage
									</a>
								) : (
									'your plan’s usage settings'
								)}{' '}
								to have tasks stop at the limit instead.
							</p>
						</CardSection>
					) : null}
					{subscription.windows?.length ? <Windows windows={subscription.windows} /> : null}
					<Models subscription={subscription} />
					<PlanSettings
						subscription={subscription}
						pricedAs={subscription.gateway === 'claude-code' ? 'the Anthropic API' : null}
						error={refresh.error ?? disconnect.error}
					/>
				</>
			) : pending ? (
				<RuntimePending subscription={subscription} finish={finish} />
			) : (
				<CardSection label={`Sign in with ${name}`} hint="Once">
					<Note info={`${name} runs the sign-in on this server and keeps the token to itself. Anton only passes it the code ${name} shows.`}>
						Opens {name} in a new tab. Approve there, then paste the code it shows.
					</Note>
					<div>
						<Btn
							size="sm"
							variant="primary"
							icon={ExternalLink}
							disabled={signIn.isPending}
							onClick={() => {
								finish.reset();
								signIn.mutate(window.open('', '_blank'));
							}}
						>
							{signIn.isPending ? 'Opening…' : `Sign in with ${name}`}
						</Btn>
					</div>
					<SaveState pending={signIn.isPending || refresh.isPending} success={false} error={finish.error ?? signIn.error ?? refresh.error} />
				</CardSection>
			)}
			{subscription.oauthClient && !pending ? (
				<OAuthClientForm subscription={subscription} client={subscription.oauthClient} />
			) : null}
			{pending ? null : (
				<CardFooter
					caption={
						<Caption className="inline-flex items-center gap-1.5">
							For your own use only
							<InfoTip>{name} lets you sign in to its own agent with your own plan, for your own use — not to share the sign-in.</InfoTip>
						</Caption>
					}
				>
					<Btn size="sm" variant="ghost" icon={RotateCw} disabled={refresh.isPending} onClick={() => refresh.mutate()}>
						{refresh.isPending ? 'Checking…' : 'Check again'}
					</Btn>
					{connected ? (
						<Btn
							size="sm"
							variant={confirming ? 'danger' : 'dangerGhost'}
							disabled={disconnect.isPending}
							onClick={() => (confirming ? disconnect.mutate() : setConfirming(true))}
							onBlur={() => setConfirming(false)}
						>
							{disconnect.isPending ? 'Signing out…' : confirming ? 'Click again to sign out' : 'Sign out'}
						</Btn>
					) : null}
				</CardFooter>
			)}
		</Card>
	);
}

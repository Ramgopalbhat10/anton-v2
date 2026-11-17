import { useMutation, useQuery } from '@tanstack/react-query';
import { Check, Copy, ExternalLink, RotateCw } from '@/lib/icons';
import { useState } from 'react';
import { PlanLinkArt } from '@/components/marks/illustrations';
import { Card, CardFooter, CardSection, SpecGrid, Status, StatusDot, Tab, Tabs, Well } from '@/components/kit/instrument';
import { AREA } from '@/components/settings/repo-settings';
import { Btn, Icon, InlineCode, Spinner } from '@/components/kit/signal';
import { api } from '@/lib/api';
import type { Subscription } from '@/lib/api/plans';
import { age, tokens, until } from '@/lib/format';
import { logoFor } from '@/lib/provider-logos';
import { cn } from '@/lib/utils';
import { FIELD, Note, PageHeading, SaveState } from './parts';
import { day, Lead, Models, Named, PlanSettings, STATUS, useSaved, useSignIn } from './subscriptions-parts';
import { ClaudePlan } from './subscriptions-claude';
import { KeyPlan } from './subscriptions-key';
import { GatewayPlan } from './subscriptions-gateway';

function Pending({ subscription }: { subscription: Subscription }) {
	const saved = useSaved();
	const [address, setAddress] = useState('');
	const login = subscription.login!;
	const finish = useMutation({ mutationFn: () => api.finishSubscriptionLogin(subscription.id, address), onSuccess: saved });
	const cancel = useMutation({ mutationFn: () => api.cancelSubscriptionLogin(subscription.id), onSuccess: saved });
	return (
		<>
			<CardSection label="Finish signing in" hint={login.listening ? 'Listening on this computer' : 'Paste the address'}>
				<ol className="m-0 flex list-decimal flex-col gap-1.5 pl-5 text-small leading-[18px] text-(--text-2)">
					<li>
						Approve Anton in the {subscription.name} tab.{' '}
						<a href={login.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-(--accent-text) hover:underline">
							Open it again
							<Icon icon={ExternalLink} size={11} />
						</a>
					</li>
					<li>
						{subscription.name} then sends that tab to <InlineCode>{login.redirectUri}</InlineCode>.{' '}
						{login.listening
							? 'When Anton runs on this computer it catches that and finishes on its own. Otherwise the page will not load: copy its whole address and paste it here.'
							: 'That page will not load: copy its whole address from the address bar and paste it here.'}
					</li>
				</ol>
				<form
					className="flex flex-wrap items-center gap-2"
					onSubmit={(event) => {
						event.preventDefault();
						finish.mutate();
					}}
				>
					<input
						value={address}
						onChange={(event) => setAddress(event.target.value)}
						placeholder={`${login.redirectUri}?code=…`}
						aria-label="Address ChatGPT sent you back to"
						className={`${FIELD} min-w-[240px] flex-1 font-mono text-small`}
					/>
					<Btn type="submit" size="sm" variant="primary" disabled={!address.trim() || finish.isPending}>
						{finish.isPending ? 'Connecting…' : 'Connect'}
					</Btn>
				</form>
				<SaveState pending={finish.isPending} success={false} error={finish.error ?? cancel.error} />
			</CardSection>
			<CardFooter caption={`Started ${age(login.startedAt)} ago · expires after 10 min`}>
				<Btn size="sm" variant="ghost" disabled={cancel.isPending} onClick={() => cancel.mutate()}>
					Cancel
				</Btn>
			</CardFooter>
		</>
	);
}

function Connect({ subscription }: { subscription: Subscription }) {
	const saved = useSaved();
	const signIn = useSignIn(subscription);
	const [credential, setCredential] = useState('');
	const importing = useMutation({
		mutationFn: () => api.importSubscriptionLogin(subscription.id, credential),
		onSuccess: (result) => {
			setCredential('');
			saved(result);
		},
	});
	return (
		<>
			<CardSection label={subscription.state === 'expired' ? 'Sign in again' : `Option 1 · Sign in with ${subscription.name}`} hint="Recommended">
				<Note
					info={`${subscription.name} only sends you back to an address on your own computer, so when Anton is hosted elsewhere you paste that address here.`}
				>
					Approve Anton for your Plus or Pro plan in a new tab.
				</Note>
				<div className="flex flex-wrap items-center gap-3">
					<Btn size="sm" variant="primary" disabled={signIn.isPending} onClick={() => signIn.mutate(window.open('', '_blank'))}>
						{signIn.isPending ? 'Opening…' : `Sign in with ${subscription.name}`}
					</Btn>
					<SaveState pending={signIn.isPending} success={false} error={signIn.error} />
				</div>
			</CardSection>
			<CardSection label="Option 2 · Bring a sign-in from your computer">
				<Note info="Anton renews it at once and keeps it renewed from then on, so the copy on that computer stops working; delete it there.">
					Run this on a computer with a browser, approve it in {subscription.name}, then paste the <InlineCode>auth.json</InlineCode> it writes.
				</Note>
				<Command text="npx @earendil-works/pi-ai@latest login openai" label="Command that signs in to ChatGPT on your computer" />
				<form
					className="flex flex-col gap-2"
					onSubmit={(event) => {
						event.preventDefault();
						importing.mutate();
					}}
				>
					<textarea
						value={credential}
						onChange={(event) => setCredential(event.target.value)}
						rows={3}
						spellCheck={false}
						placeholder={'{ "openai": { "type": "oauth", "refresh": "…", "clientId": "oaiapp_…" } }'}
						aria-label="Sign-in to import"
						className={`${AREA} font-mono text-small leading-[18px]`}
					/>
					<div className="flex flex-wrap items-center justify-end gap-3">
						<SaveState pending={importing.isPending} success={false} error={importing.error} />
						<Btn type="submit" size="sm" disabled={!credential.trim() || importing.isPending}>
							{importing.isPending ? 'Importing…' : 'Import sign-in'}
						</Btn>
					</div>
				</form>
			</CardSection>
			<CardFooter caption="Plus or Pro · through Sign in with ChatGPT" />
		</>
	);
}

function Connected({ subscription }: { subscription: Subscription }) {
	const saved = useSaved();
	const [confirming, setConfirming] = useState(false);
	const refresh = useMutation({ mutationFn: () => api.refreshSubscriptionModels(subscription.id), onSuccess: saved });
	const disconnect = useMutation({ mutationFn: () => api.disconnectSubscription(subscription.id), onSuccess: saved });
	const { enabled, countAtApiPrices } = subscription.options;
	return (
		<>
			<SpecGrid
				items={[
					{ label: 'Account', value: subscription.email ?? 'Signed in', title: subscription.email ?? undefined },
					{ label: 'Connected', value: subscription.connectedAt ? day(subscription.connectedAt) : '—' },
					{ label: 'Token renews', value: subscription.expiresAt ? until(subscription.expiresAt) : '—', tone: 'success' },
					{ label: 'Models', value: enabled ? `${subscription.models.length} in the picker` : 'Switched off', tone: enabled ? undefined : 'warning' },
					{ label: 'This month', value: `${tokens(subscription.monthTokens)} tokens`, tone: 'accent' },
					{ label: 'Counted as', value: countAtApiPrices ? 'API prices' : '$0 per call' },
				]}
			/>
			<Models subscription={subscription} />
			<PlanSettings subscription={subscription} error={refresh.error ?? disconnect.error} />
			<CardFooter caption={subscription.modelsAt ? `Models checked ${age(subscription.modelsAt)} ago` : 'Models not checked yet'}>
				<Btn size="sm" variant="ghost" icon={RotateCw} disabled={refresh.isPending} onClick={() => refresh.mutate()}>
					{refresh.isPending ? 'Checking…' : 'Check again'}
				</Btn>
				<Btn
					size="sm"
					variant={confirming ? 'danger' : 'dangerGhost'}
					disabled={disconnect.isPending}
					onClick={() => (confirming ? disconnect.mutate() : setConfirming(true))}
					onBlur={() => setConfirming(false)}
				>
					{confirming ? 'Click again to disconnect' : 'Disconnect'}
				</Btn>
			</CardFooter>
		</>
	);
}

function Plan({ subscription }: { subscription: Subscription }) {
	const status = subscription.login ? { tone: 'accent' as const, label: 'Signing in' } : STATUS[subscription.state];
	const connected = subscription.state === 'connected';
	return (
		<Card
			title={`${subscription.name} plan`}
			sub={subscription.email ?? (subscription.login ? 'waiting for approval' : 'Plus or Pro')}
			label={`${subscription.name} plan`}
			status={
				<Status tone={status.tone} pulse={connected || Boolean(subscription.login)}>
					{status.label}
				</Status>
			}
		>
			<CardSection ruled={false} className="pt-0">
				<Well grid className="flex items-center justify-center px-4 py-6">
					<PlanLinkArt linked={connected} plan={subscription.name} logo={logoFor({ id: `${subscription.gateway}/` })} className="w-full max-w-[440px]" />
				</Well>
			</CardSection>
			{connected ? (
				<Lead
					title={`${subscription.models.length} ${subscription.models.length === 1 ? 'model' : 'models'} on your plan`}
					info={
						<>
							<Named gateway={subscription.gateway} /> Anton renews the sign-in on its own a few minutes before each token lapses.
						</>
					}
				>
					Billed to your {subscription.name} plan's usage, not per token.
				</Lead>
			) : subscription.login ? (
				<Lead title={`Waiting for ${subscription.name}`}>Approve Anton in the {subscription.name} tab, then finish here.</Lead>
			) : subscription.state === 'expired' ? (
				<Lead title="The sign-in stopped working">
					<span className="text-(--bad)">{subscription.problem}</span>
				</Lead>
			) : (
				<Lead
					title={`Run tasks on your ${subscription.name} plan`}
					info="Their models join the model picker, and their calls count toward the plan's limits instead of costing money per token."
				>
					Plus and Pro plans, through Sign in with ChatGPT.
				</Lead>
			)}
			{connected ? <Connected subscription={subscription} /> : subscription.login ? <Pending subscription={subscription} /> : <Connect subscription={subscription} />}
		</Card>
	);
}

function Command({ text, label }: { text: string; label: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<div className="flex items-start gap-2">
			<pre aria-label={label} className="m-0 min-w-0 flex-1 rounded-control bg-(--bg-raised) px-3 py-2 font-mono text-small leading-[18px] break-all whitespace-pre-wrap text-(--text)">
				{text}
			</pre>
			<Btn
				size="sm"
				variant="ghost"
				icon={copied ? Check : Copy}
				onClick={() => void navigator.clipboard?.writeText(text).then(() => setCopied(true))}
				onBlur={() => setCopied(false)}
			>
				{copied ? 'Copied' : 'Copy'}
			</Btn>
		</div>
	);
}

function PlanTab({ subscription, on, onSelect }: { subscription: Subscription; on: boolean; onSelect: () => void }) {
	const logo = logoFor({ id: `${subscription.gateway}/` });
	const connected = subscription.state === 'connected';
	return (
		<Tab on={on} onSelect={onSelect} id={`plan-tab-${subscription.id}`} controls={`plan-panel-${subscription.id}`}>
			{logo ? (
				// LobeHub's one-colour logos take the text colour, sized by the font size.
				<span aria-hidden className={cn('flex text-h3', on ? 'text-(--text)' : 'text-(--text-2)')} dangerouslySetInnerHTML={{ __html: logo }} />
			) : null}
			{subscription.name}
			<StatusDot title={connected ? 'Connected' : STATUS[subscription.state].label} tone={connected ? 'success' : subscription.state === 'expired' ? 'danger' : 'off'} />
		</Tab>
	);
}

export function SubscriptionsPage() {
	const view = useQuery({ queryKey: ['subscriptions'], queryFn: api.subscriptions });
	const [picked, setPicked] = useState<string | null>(null);
	const plans = view.data?.subscriptions ?? [];
	const current = plans.find((plan) => plan.id === picked) ?? plans[0];
	return (
		<>
			<PageHeading
				title="Subscriptions"
				info="A connected plan gets its own tab in the model picker, its models are marked PLAN, and their calls count against the plan's own limits. The OpenRouter and Vercel AI Gateway tabs take your key for the models they bill per token."
			>
				Run tasks on a plan you already pay for.
			</PageHeading>
			{view.isPending ? (
				<Spinner size={12} />
			) : view.isError ? (
				<p className="m-0 text-small text-(--bad)">{view.error.message}</p>
			) : current ? (
				<div className="flex flex-col gap-5">
					<Tabs label="Plans">
						{plans.map((plan) => (
							<PlanTab key={plan.id} subscription={plan} on={plan.id === current.id} onSelect={() => setPicked(plan.id)} />
						))}
					</Tabs>
					<div role="tabpanel" id={`plan-panel-${current.id}`} aria-labelledby={`plan-tab-${current.id}`}>
						{current.kind === 'runtime' ? (
								<ClaudePlan key={current.id} subscription={current} />
							) : current.kind === 'key' ? (
								<KeyPlan key={current.id} subscription={current} />
							) : current.kind === 'gateway' ? (
								<GatewayPlan key={current.id} subscription={current} />
							) : (
								<Plan key={current.id} subscription={current} />
							)}
					</div>
				</div>
			) : null}
		</>
	);
}

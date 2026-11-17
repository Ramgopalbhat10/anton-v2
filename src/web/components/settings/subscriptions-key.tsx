import { useMutation } from '@tanstack/react-query';
import { ExternalLink, RotateCw } from '@/lib/icons';
import { useState } from 'react';
import { PlanLinkArt } from '@/components/marks/illustrations';
import { Caption, Card, CardFooter, CardSection, SpecGrid, Status, Well } from '@/components/kit/instrument';
import { Btn, Icon } from '@/components/kit/signal';
import { api } from '@/lib/api';
import type { Subscription } from '@/lib/api/plans';
import { age, tokens } from '@/lib/format';
import { logoFor } from '@/lib/provider-logos';
import { FIELD, Note, SaveState } from './parts';
import { day, Lead, Models, Named, PlanSettings, STATUS, useSaved, Windows } from './subscriptions-parts';

const KEY_PLANS: Record<string, { tagline: string; lead: string; about: string; howTo: string; placeholder: string; pricedAs: string | null; terms?: string; billing?: string }> = {
	devin: {
		tagline: 'experimental · oh-my-pi worker',
		lead: 'SWE-2 Flash and SWE-2, with Anton’s tools.',
		about: 'This prototype runs oh-my-pi in a Bun worker on this server. Devin supplies the model; Anton keeps control of tools and the task sandbox. SWE-2 Flash is preferred; choose SWE-2 if Flash is unavailable.',
		howTo: 'Create a Devin personal access token (PAT) and paste it here. The server needs npm run setup:devin first.',
		placeholder: 'cog_…',
		pricedAs: null,
		billing: 'Your Devin plan limits and on-demand billing apply. Local token counts are not an invoice.',
		terms: 'Experimental: uses an internal Devin/Windsurf API, not an officially supported inference endpoint. Your Devin limits and billing apply; check your subscription terms.',
	},
	'opencode-go': {
		tagline: 'open coding models',
		lead: 'A monthly plan of open coding models, with a key from OpenCode.',
		about:
			'OpenCode Go is a monthly plan of open coding models (GLM, Kimi, DeepSeek, Qwen, MiniMax and more) that OpenCode offers for its own agent and others. Anton calls them from this server with a key from your OpenCode workspace.',
		howTo: 'Subscribe to Go in the OpenCode Console, make an API key in the same workspace, and paste it here.',
		placeholder: 'sk-…',
		pricedAs: "pay-as-you-go use at the model's list price",
	},
	cursor: {
		tagline: 'through the Cursor SDK',
		lead: "Your plan's usage, through Cursor's SDK on this server.",
		about:
			"Cursor plans run through Cursor's own agent, so Anton runs it on this server through Cursor's official SDK with its built-in tools off: the model does the thinking, and Anton runs every tool. Calls use your plan's usage.",
		howTo: "Make a user API key in Cursor's dashboard and paste it here.",
		placeholder: 'key_…',
		// Cursor publishes no per-token prices for agent calls, so there is nothing to count them at.
		pricedAs: null,
		terms: "Calls go through Cursor's SDK under Cursor's terms, billed to the plan the key belongs to.",
	},
};

export function KeyForm({ subscription, howTo, placeholder }: { subscription: Subscription; howTo: string; placeholder: string }) {
	const saved = useSaved();
	const [key, setKey] = useState('');
	const connect = useMutation({
		mutationFn: () => api.connectSubscriptionKey(subscription.id, key),
		onSuccess: (result) => {
			setKey('');
			saved(result);
		},
	});
	return (
		<CardSection label={subscription.state === 'expired' ? 'Paste a new key' : 'Paste your key'}>
			<Note info="The key stays on this server and never reaches a task's sandbox.">
				{howTo}{' '}
				{subscription.keyPage ? (
					<a href={subscription.keyPage} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-(--accent-text) hover:underline">
						Open the key page
						<Icon icon={ExternalLink} size={11} />
					</a>
				) : null}
			</Note>
			<form
				className="flex flex-wrap items-center gap-2"
				onSubmit={(event) => {
					event.preventDefault();
					connect.mutate();
				}}
			>
				<input
					type="password"
					autoComplete="off"
					value={key}
					onChange={(event) => setKey(event.target.value)}
					placeholder={placeholder}
					aria-label={`${subscription.name} key`}
					className={`${FIELD} min-w-[240px] flex-1 font-mono text-small`}
				/>
				<Btn type="submit" size="sm" variant="primary" disabled={!key.trim() || connect.isPending}>
					{connect.isPending ? 'Checking…' : 'Connect'}
				</Btn>
			</form>
			<SaveState pending={connect.isPending} success={false} error={connect.error} />
		</CardSection>
	);
}

export function KeyPlan({ subscription }: { subscription: Subscription }) {
	const saved = useSaved();
	const [confirming, setConfirming] = useState(false);
	const refresh = useMutation({ mutationFn: () => api.refreshSubscriptionModels(subscription.id), onSuccess: saved });
	const disconnect = useMutation({ mutationFn: () => api.disconnectSubscription(subscription.id), onSuccess: saved });
	const connected = subscription.state === 'connected';
	const status = STATUS[subscription.state];
	const copy = KEY_PLANS[subscription.id] ?? {
		tagline: 'with your key',
		lead: `Anton calls ${subscription.name} from this server with your key.`,
		about: `Anton calls ${subscription.name} from this server with a key from your account.`,
		howTo: `Make a key on ${subscription.name}'s dashboard and paste it here.`,
		placeholder: 'Key',
		pricedAs: null,
	};
	const { enabled, countAtApiPrices } = subscription.options;
	return (
		<Card
			title={`${subscription.name} plan`}
			sub={subscription.email ?? copy.tagline}
			label={`${subscription.name} plan`}
			status={
				<Status tone={status.tone} pulse={connected}>
					{subscription.state === 'expired' ? 'Needs a new key' : status.label}
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
					info={<Named gateway={subscription.gateway} />}
				>
					{copy.billing ?? <>Billed to your {subscription.name} plan, not per token.</>}
				</Lead>
			) : subscription.state === 'expired' ? (
				<Lead title={`${subscription.name} stopped taking the key`}>
					<span className="text-(--bad)">{subscription.problem}</span>
				</Lead>
			) : (
				<Lead title={`Run tasks on your ${subscription.name} plan`} info={copy.about}>
					{copy.lead}
				</Lead>
			)}
			{connected ? (
				<>
					<SpecGrid
						items={[
							{ label: 'Account', value: subscription.email ?? 'Key accepted', title: subscription.email ?? undefined },
							{ label: 'Key', value: subscription.keyHint ? `…${subscription.keyHint}` : '—' },
							{ label: 'Connected', value: subscription.connectedAt ? day(subscription.connectedAt) : '—' },
							{ label: 'Models', value: enabled ? `${subscription.models.length} in the picker` : 'Switched off', tone: enabled ? undefined : 'warning' },
							{ label: 'This month', value: `${tokens(subscription.monthTokens)} tokens`, tone: 'accent' },
							{ label: 'Counted as', value: subscription.id === 'devin' ? 'Not priced locally' : copy.pricedAs && countAtApiPrices ? 'API prices' : '$0 per call' },
						]}
					/>
					{subscription.windows?.length ? <Windows windows={subscription.windows} /> : null}
					<Models subscription={subscription} />
					<PlanSettings subscription={subscription} error={refresh.error ?? disconnect.error} pricedAs={copy.pricedAs} />
				</>
			) : (
				<KeyForm subscription={subscription} howTo={copy.howTo} placeholder={copy.placeholder} />
			)}
			<CardFooter
				caption={
					copy.terms ? (
						<Caption>{copy.terms}</Caption>
					) : subscription.modelsAt ? (
						`Models checked ${age(subscription.modelsAt)} ago`
					) : undefined
				}
			>
				{connected ? (
					<>
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
					</>
				) : null}
			</CardFooter>
		</Card>
	);
}

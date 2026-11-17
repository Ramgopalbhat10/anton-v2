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

function ClaudePending({ subscription, finish }: { subscription: Subscription; finish: ReturnType<typeof useClaudeFinish> }) {
	const saved = useSaved();
	const [code, setCode] = useState('');
	const login = subscription.login!;
	const cancel = useMutation({ mutationFn: () => api.cancelSubscriptionLogin(subscription.id), onSuccess: saved });
	return (
		<>
			<CardSection label="Finish signing in" hint="Paste the code">
				<ol className="m-0 flex list-decimal flex-col gap-1.5 pl-5 text-small leading-[18px] text-(--text-2)">
					<li>
						Approve Claude Code in the Claude tab.{' '}
						<a href={login.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-(--accent-text) hover:underline">
							Open it again
							<Icon icon={ExternalLink} size={11} />
						</a>
					</li>
					<li>Claude then shows a code. Copy it and paste it here.</li>
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
						placeholder="Code from Claude"
						aria-label="Code from Claude"
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

/** Held by the card, so a refused code's message stays after the sign-in ends. */
function useClaudeFinish(subscription: Subscription) {
	const saved = useSaved();
	return useMutation({ mutationFn: (code: string) => api.finishSubscriptionLogin(subscription.id, code), onSuccess: saved });
}

/** Claude Code signs in through its own flow: Anton starts it, opens Claude to approve, and passes back the code Claude shows. Anton never holds the token. */
export function ClaudePlan({ subscription }: { subscription: Subscription }) {
	const saved = useSaved();
	const signIn = useSignIn(subscription);
	const finish = useClaudeFinish(subscription);
	const [confirming, setConfirming] = useState(false);
	const refresh = useMutation({ mutationFn: () => api.refreshSubscriptionModels(subscription.id), onSuccess: saved });
	const disconnect = useMutation({ mutationFn: () => api.disconnectSubscription(subscription.id), onSuccess: saved });
	const connected = subscription.state === 'connected';
	const pending = !connected && Boolean(subscription.login);
	const status = pending ? { tone: 'accent' as const, label: 'Signing in' } : STATUS[subscription.state];
	const { enabled, countAtApiPrices } = subscription.options;
	return (
		<Card
			title={`${subscription.name} plan`}
			sub={subscription.email ?? (pending ? 'waiting for approval' : 'through Claude Code')}
			label={`${subscription.name} plan`}
			status={
				<Status tone={status.tone} pulse={connected || pending}>
					{connected ? 'Connected' : subscription.state === 'expired' && !pending ? 'Needs attention' : status.label}
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
							Claude Code runs on this server with only Anton's tools. <Named gateway={subscription.gateway} />
						</>
					}
				>
					Billed to your {subscription.name} plan's usage, not per token.
				</Lead>
			) : pending ? (
				<Lead title="Waiting for Claude">Approve Claude Code in the Claude tab, then paste the code it shows.</Lead>
			) : subscription.state === 'expired' ? (
				<Lead title="Claude Code cannot use your plan">
					<span className="text-(--bad)">{subscription.problem}</span>
				</Lead>
			) : (
				<Lead
					title={`Run tasks on your ${subscription.name} plan`}
					info="Pro and Max plans work only inside Anthropic's own Claude Code, so Anton runs it on this server with its built-in tools off: Claude does the thinking, and Anton runs every tool. Claude Code signs in through its own flow and keeps the sign-in to itself."
				>
					Pro and Max plans, through Claude Code on this server.
				</Lead>
			)}
			{connected ? (
				<>
					<SpecGrid
						items={[
							{ label: 'Account', value: subscription.email ?? 'Signed in', title: subscription.email ?? undefined },
							{ label: 'Plan', value: subscription.plan ?? '—' },
							{ label: 'Claude Code', value: subscription.version ?? '—' },
							{ label: 'Models', value: enabled ? `${subscription.models.length} in the picker` : 'Switched off', tone: enabled ? undefined : 'warning' },
							{ label: 'This month', value: `${tokens(subscription.monthTokens)} tokens`, tone: 'accent' },
							{ label: 'Counted as', value: countAtApiPrices ? 'API prices' : '$0 per call' },
						]}
					/>
					{subscription.extraUsageAt ? (
						<CardSection label="Extra usage">
							<p className="m-0 max-w-[72ch] text-small leading-[18px] text-pretty text-(--warn)">
								Your plan's limit ran out {age(subscription.extraUsageAt)} ago and calls now bill extra usage, which costs money. Turn it off at{' '}
								<a href="https://claude.ai/settings/usage" target="_blank" rel="noreferrer" className="text-(--accent-text) hover:underline">
									claude.ai/settings/usage
								</a>{' '}
								to have tasks stop at the limit instead.
							</p>
						</CardSection>
					) : null}
					{subscription.windows?.length ? <Windows windows={subscription.windows} /> : null}
					<Models subscription={subscription} />
					<PlanSettings subscription={subscription} error={refresh.error ?? disconnect.error} />
				</>
			) : pending ? (
				<ClaudePending subscription={subscription} finish={finish} />
			) : (
				<CardSection label="Sign in with Claude" hint="Once">
					<Note info="Claude Code runs the sign-in on this server and keeps the token to itself. Anton only passes it the code Claude shows.">
						Opens Claude in a new tab. Approve there, then paste the code it shows.
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
							{signIn.isPending ? 'Opening Claude…' : 'Sign in with Claude'}
						</Btn>
					</div>
					<SaveState pending={signIn.isPending || refresh.isPending} success={false} error={finish.error ?? signIn.error ?? refresh.error} />
				</CardSection>
			)}
			{pending ? null : (
				<CardFooter
					caption={
						<Caption className="inline-flex items-center gap-1.5">
							For your own use only
							<InfoTip>Anthropic lets you sign in to its unmodified Claude Code with your own plan, not share it with others.</InfoTip>
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

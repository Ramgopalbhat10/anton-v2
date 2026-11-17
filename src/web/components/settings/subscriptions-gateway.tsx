import { unrouted } from '../../../core/model-route';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, KeyRound, RotateCw } from '@/lib/icons';
import { useState } from 'react';
import { PlanLinkArt } from '@/components/marks/illustrations';
import { Card, CardFooter, CardSection, SpecGrid, Status, Well } from '@/components/kit/instrument';
import { EffortRange } from '@/components/composer/model-picker';
import { useModels } from '@/lib/models';
import { Btn, EmptyLine, Icon, InlineCode, SearchField } from '@/components/kit/signal';
import { api } from '@/lib/api';
import type { Subscription } from '@/lib/api/plans';
import { age, dollars, tokens } from '@/lib/format';
import { logoFor } from '@/lib/provider-logos';
import { useGeneralSettings } from './general';
import { Note, SaveState } from './parts';
import { day, Lead, Named, PlanSettings, STATUS, useSaved, Windows } from './subscriptions-parts';
import { KeyForm } from './subscriptions-key';

export const GATEWAY_PAGE_SIZE = 20;

function GatewayModels({ subscription }: { subscription: Subscription }) {
	const queryClient = useQueryClient();
	const settings = useGeneralSettings();
	const models = useModels();
	const [query, setQuery] = useState('');
	const [page, setPage] = useState(0);
	const makeDefault = useMutation({
		mutationFn: (model: string) => api.saveGeneralSettings({ ...settings.data!, model, reasoning: null }),
		onSuccess: (saved) => {
			queryClient.setQueryData(['general-settings'], saved);
			void queryClient.invalidateQueries({ queryKey: ['models'] });
		},
	});
	const current = unrouted(settings.data?.model ?? models.data?.default ?? '');
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	// Used ones first, by tokens; the rest keep the gateway's order, newest first.
	const ranked = subscription.models
		.map((model, index) => ({ model, index }))
		.filter(({ model }) => words.every((word) => `${model.vendor ?? ''} ${model.name} ${model.id}`.toLowerCase().includes(word)))
		.sort((a, b) => b.model.tokens - a.model.tokens || a.index - b.index)
		.map(({ model }) => model);
	const pages = Math.max(1, Math.ceil(ranked.length / GATEWAY_PAGE_SIZE));
	const at = Math.min(page, pages - 1);
	const shown = ranked.slice(at * GATEWAY_PAGE_SIZE, (at + 1) * GATEWAY_PAGE_SIZE);
	if (!subscription.models.length) {
		return (
			<CardSection label="Models">
				<p className="m-0 text-small text-(--text-3)">{subscription.name} has not listed any models for this key yet. Check again in a minute.</p>
			</CardSection>
		);
	}
	return (
		<CardSection label={`Models · ${subscription.models.length}`} hint="Effort · context · $ per 1M in / out · tokens this month">
			<SearchField
				value={query}
				onChange={(next) => {
					setQuery(next);
					setPage(0);
				}}
				placeholder="Search models"
				label={`Search ${subscription.name} models`}
				className="w-full max-w-[320px]"
			/>
			{shown.length ? (
				<ul aria-label={`${subscription.name} models`} className="m-0 -mx-2 flex list-none flex-col p-0">
					{shown.map((model) => (
						<li
							key={model.id}
							className="grid min-h-12 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 rounded-card px-2 py-1.5 hover:bg-(--bg-hover) sm:grid-cols-[minmax(0,1.1fr)_auto_2.5rem_6.5rem_2.5rem_auto]"
						>
							<div className="flex min-w-0 flex-col">
								<span className="truncate text-body text-(--text)">
									{model.vendor ? <span className="text-(--text-3)">{model.vendor}: </span> : null}
									{model.name}
								</span>
								<span className="truncate text-micro text-(--text-4)">{model.id.slice(model.id.indexOf('/') + 1)}</span>
							</div>
							<EffortRange levels={model.reasoning} preferred={model.defaultReasoning} className="hidden sm:inline-flex" />
							<span className="in-num hidden text-right text-micro text-(--text-3) sm:inline">{tokens(model.contextLength)}</span>
							<span className="in-num hidden text-right text-micro text-(--text-3) sm:inline" title="US dollars per million tokens in and out">
								{model.price ? `${dollars(model.price.input)} / ${dollars(model.price.output)}` : '—'}
							</span>
							<span className="in-num hidden text-right text-micro text-(--text-2) sm:inline">{tokens(model.tokens)}</span>
							<div className="flex w-[124px] justify-end">
								{model.id === current ? (
									<Status tone="accent">Default</Status>
								) : (
									<Btn
										size="xs"
										variant="ghost"
										disabled={!settings.data || makeDefault.isPending}
										onClick={() => makeDefault.mutate(model.id)}
										title="New tasks and automations start on this model"
									>
										Use for new tasks
									</Btn>
								)}
							</div>
						</li>
					))}
				</ul>
			) : (
				<EmptyLine className="p-0">No models match “{query}”.</EmptyLine>
			)}
			{ranked.length > GATEWAY_PAGE_SIZE ? (
				<nav aria-label="Model pages" className="flex items-center justify-between gap-3">
					<span className="in-num text-micro text-(--text-3)">
						{at * GATEWAY_PAGE_SIZE + 1}–{at * GATEWAY_PAGE_SIZE + shown.length} of {ranked.length}
					</span>
					<span className="flex items-center gap-2">
						<Btn size="xs" variant="ghost" icon={ChevronLeft} disabled={at === 0} onClick={() => setPage(at - 1)}>
							Previous
						</Btn>
						<span className="in-num text-micro text-(--text-2)">
							Page {at + 1} of {pages}
						</span>
						<Btn size="xs" variant="ghost" disabled={at >= pages - 1} onClick={() => setPage(at + 1)}>
							Next
							<Icon icon={ChevronRight} size={12} />
						</Btn>
					</span>
				</nav>
			) : null}
			<SaveState pending={makeDefault.isPending} success={false} error={makeDefault.error} />
		</CardSection>
	);
}

const GATEWAY_COPY: Record<string, { howTo: string; placeholder: string; billed: string; pitch: string; uses: string; pricedAs: string }> = {
	openrouter: {
		howTo: "Make a key on OpenRouter's keys page and paste it here.",
		placeholder: 'sk-or-v1-…',
		billed: 'Billed per token to your OpenRouter account.',
		pitch: 'Hundreds of models from every major lab through one key, billed per token.',
		uses: "Anton lists the models your key may use, and the agents, the decision model and the computer's eyes call them with it.",
		pricedAs: "OpenRouter's price",
	},
	vercel: {
		howTo: 'Make a key under AI Gateway › API Keys in your Vercel dashboard and paste it here.',
		placeholder: 'AI Gateway API key',
		billed: 'Billed per token to your Vercel AI Gateway credits.',
		pitch: "Models from every major lab through one key, paid from your team's AI Gateway credits.",
		uses: "Anton lists the gateway's models in the picker and the agents call them with your key; the decision model, titles and the computer's eyes stay on OpenRouter.",
		pricedAs: "Vercel's price",
	},
};

export function GatewayPlan({ subscription }: { subscription: Subscription }) {
	const copy = GATEWAY_COPY[subscription.gateway] ?? GATEWAY_COPY.openrouter;
	const saved = useSaved();
	const [confirming, setConfirming] = useState(false);
	const [replacing, setReplacing] = useState(false);
	const refresh = useMutation({ mutationFn: () => api.refreshSubscriptionModels(subscription.id), onSuccess: saved });
	const disconnect = useMutation({ mutationFn: () => api.disconnectSubscription(subscription.id), onSuccess: saved });
	const connected = subscription.state === 'connected';
	const pasted = subscription.keySource === 'settings';
	const fromServer = subscription.keySource === 'environment';
	const envVar = subscription.envVar ?? 'OPENROUTER_API_KEY';
	const { enabled } = subscription.options;
	return (
		<Card
			title={subscription.name}
			sub="models billed per token"
			label={subscription.name}
			status={
				<Status tone={STATUS[subscription.state].tone} pulse={connected}>
					{STATUS[subscription.state].label}
				</Status>
			}
		>
			<CardSection ruled={false} className="pt-0">
				<Well grid className="flex items-center justify-center px-4 py-6">
					<PlanLinkArt linked={connected} plan={subscription.name} logo={logoFor({ id: `${subscription.gateway}/` })} noun="account" className="w-full max-w-[440px]" />
				</Well>
			</CardSection>
			{connected ? (
				<Lead
					title={`${subscription.models.length} ${subscription.models.length === 1 ? 'model' : 'models'} for your key`}
					info={
						<>
							<Named gateway={subscription.gateway} /> Their calls count toward the spending caps at {copy.pricedAs}.
						</>
					}
				>
					{copy.billed}
				</Lead>
			) : (
				<Lead
					title={`Connect ${subscription.name}`}
					info={copy.uses}
				>
					{copy.pitch}
				</Lead>
			)}
			{connected ? (
				<>
					<SpecGrid
						items={[
							{
								label: 'Key',
								value: `${subscription.keyHint ? `…${subscription.keyHint}` : '—'}${fromServer ? ` · ${envVar}` : ''}`,
								title: fromServer ? `From ${envVar} on the server` : 'Pasted in Settings',
							},
							{ label: 'Connected', value: pasted && subscription.connectedAt ? day(subscription.connectedAt) : fromServer ? 'From the server' : '—' },
							{ label: 'Models', value: enabled ? `${subscription.models.length} in the picker` : 'Switched off', tone: enabled ? undefined : 'warning' },
							{ label: 'This month', value: `${tokens(subscription.monthTokens)} tokens`, tone: 'accent' },
							{ label: 'Counted as', value: subscription.gateway === 'vercel' ? 'Vercel prices' : 'OpenRouter prices' },
						]}
					/>
					{subscription.windows?.length ? <Windows windows={subscription.windows} label="Limits and credits" /> : null}
					{fromServer && !replacing ? (
						<CardSection label="Key">
							<Note info="A key pasted here takes its place, and the server's key comes back if you disconnect it.">
								Using <InlineCode>{envVar}</InlineCode> from the server's environment.
							</Note>
							<div>
								<Btn size="sm" variant="ghost" icon={KeyRound} onClick={() => setReplacing(true)}>
									Paste a key instead
								</Btn>
							</div>
						</CardSection>
					) : null}
					{fromServer && replacing ? (
						<KeyForm subscription={subscription} howTo={copy.howTo} placeholder={copy.placeholder} />
					) : null}
					<GatewayModels subscription={subscription} />
					<PlanSettings subscription={subscription} error={refresh.error ?? disconnect.error} pricedAs={null} />
				</>
			) : (
				<KeyForm subscription={subscription} howTo={copy.howTo} placeholder={copy.placeholder} />
			)}
			<CardFooter caption={subscription.modelsAt ? `Models checked ${age(subscription.modelsAt)} ago` : undefined}>
				{connected ? (
					<>
						<Btn size="sm" variant="ghost" icon={RotateCw} disabled={refresh.isPending} onClick={() => refresh.mutate()}>
							{refresh.isPending ? 'Checking…' : 'Check again'}
						</Btn>
						{pasted ? (
							<Btn
								size="sm"
								variant={confirming ? 'danger' : 'dangerGhost'}
								disabled={disconnect.isPending}
								onClick={() => (confirming ? disconnect.mutate() : setConfirming(true))}
								onBlur={() => setConfirming(false)}
							>
								{confirming ? 'Click again to disconnect' : 'Disconnect'}
							</Btn>
						) : null}
					</>
				) : null}
			</CardFooter>
		</Card>
	);
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, ExternalLink, MessageSquareCode, RotateCw } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { PlanLinkArt } from '@/components/illustrations';
import { Caption, Card, CardFooter, CardSection, SpecGrid, Status, Well } from '@/components/instrument';
import { EffortRange, useModels } from '@/components/model-picker';
import { AREA } from '@/components/repo-settings';
import { Btn, Icon, InlineCode, Spinner, Switch } from '@/components/signal';
import { api, type Subscription, type SubscriptionOptions } from '@/lib/api';
import { age, tokens } from '@/lib/format';
import { useGeneralSettings } from './general';
import { FIELD, PageHeading, SaveState, SettingRow } from './parts';

const STATUS: Record<Subscription['state'], { tone: 'success' | 'danger' | 'neutral'; label: string }> = {
	connected: { tone: 'success', label: 'Connected' },
	expired: { tone: 'danger', label: 'Sign in again' },
	'signed-out': { tone: 'neutral', label: 'Not connected' },
};

/** "in 52m", "in 3h": how long until a time that is still ahead. */
function until(iso: string, now = Date.now()): string {
	const minutes = Math.max(0, Math.round((new Date(iso).getTime() - now) / 60_000));
	return minutes < 60 ? `in ${minutes}m` : `in ${Math.round(minutes / 60)}h`;
}

const day = (iso: string) => new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short' });

/** Writes what a call returned into the list, and refetches the models it changes. */
function useSaved() {
	const queryClient = useQueryClient();
	return (saved: Subscription) => {
		queryClient.setQueryData<{ subscriptions: Subscription[] }>(['subscriptions'], (current) =>
			current ? { subscriptions: current.subscriptions.map((item) => (item.id === saved.id ? saved : item)) } : current,
		);
		void queryClient.invalidateQueries({ queryKey: ['models'] });
		void queryClient.invalidateQueries({ queryKey: ['connections'] });
	};
}

/**
 * Opens the vendor's sign-in in a new tab. The caller opens the tab during the
 * click, before the server answers, so popup blockers let it through.
 */
function useSignIn(subscription: Subscription) {
	const saved = useSaved();
	return useMutation({
		mutationFn: async (tab: Window | null) => {
			try {
				const started = await api.beginSubscriptionLogin(subscription.id);
				if (tab && started.login) {
					tab.opener = null;
					tab.location.href = started.login.url;
				}
				return started;
			} catch (error) {
				tab?.close();
				throw error;
			}
		},
		onSuccess: saved,
	});
}

/** The card's lead under its drawing: a headline and what it means. */
function Lead({ title, children }: { title: string; children: ReactNode }) {
	return (
		<div className="flex flex-col gap-1 px-4 pt-1 pb-3.5">
			<h3 className="m-0 text-[15px] leading-[22px] font-medium tracking-[-0.01em]">{title}</h3>
			<p className="m-0 max-w-[72ch] text-[12px] leading-[18px] text-pretty text-(--text-tertiary)">{children}</p>
		</div>
	);
}

/** Waiting for ChatGPT to send the browser back: caught by Anton on this computer, or pasted from the address bar. */
function Pending({ subscription }: { subscription: Subscription }) {
	const saved = useSaved();
	const [address, setAddress] = useState('');
	const login = subscription.login!;
	const finish = useMutation({ mutationFn: () => api.finishSubscriptionLogin(subscription.id, address), onSuccess: saved });
	const cancel = useMutation({ mutationFn: () => api.cancelSubscriptionLogin(subscription.id), onSuccess: saved });
	return (
		<>
			<CardSection label="Finish signing in" hint={login.listening ? 'Listening on this computer' : 'Paste the address'}>
				<ol className="m-0 flex list-decimal flex-col gap-1.5 pl-5 text-[12px] leading-[18px] text-(--text-secondary)">
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
						className={`${FIELD} min-w-[240px] flex-1 font-mono text-[12px]`}
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

/** The two ways in: sign in from this browser, or bring a sign-in made on another computer. */
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
				<p className="m-0 max-w-[72ch] text-[12px] leading-[18px] text-pretty text-(--text-tertiary)">
					Opens {subscription.name} in a new tab, where you approve Anton for your Plus or Pro plan. {subscription.name} only sends you back to an
					address on your own computer, so when Anton is hosted elsewhere you paste that address here.
				</p>
				<div className="flex flex-wrap items-center gap-3">
					<Btn size="sm" variant="primary" disabled={signIn.isPending} onClick={() => signIn.mutate(window.open('', '_blank'))}>
						{signIn.isPending ? 'Opening…' : `Sign in with ${subscription.name}`}
					</Btn>
					<SaveState pending={signIn.isPending} success={false} error={signIn.error} />
				</div>
			</CardSection>
			<CardSection label="Option 2 · Bring a sign-in from your computer">
				<p className="m-0 max-w-[72ch] text-[12px] leading-[18px] text-pretty text-(--text-tertiary)">
					On a computer with a browser, run <InlineCode>npx @earendil-works/pi-ai@latest login openai</InlineCode>, approve it in {subscription.name},
					and paste the <InlineCode>auth.json</InlineCode> it writes in that folder. Anton renews it at once and keeps it renewed from then on, so the
					copy on that computer stops working; delete it there.
				</p>
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
						className={`${AREA} font-mono text-[12px] leading-[18px]`}
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

/**
 * The plan's models as a ranked list, the way a usage card shows them: name
 * and id, the efforts it takes, its context, a bar for this month's tokens,
 * and a way to make it the default for new tasks.
 */
function Models({ subscription }: { subscription: Subscription }) {
	const queryClient = useQueryClient();
	const settings = useGeneralSettings();
	const models = useModels();
	const makeDefault = useMutation({
		mutationFn: (model: string) => api.saveGeneralSettings({ ...settings.data!, model, reasoning: null }),
		onSuccess: (saved) => {
			queryClient.setQueryData(['general-settings'], saved);
			void queryClient.invalidateQueries({ queryKey: ['models'] });
		},
	});
	const current = settings.data?.model ?? models.data?.default;
	const most = Math.max(1, ...subscription.models.map((model) => model.tokens));
	if (!subscription.models.length) {
		return (
			<CardSection label="By model">
				<p className="m-0 text-[12px] text-(--text-tertiary)">{subscription.name} has not listed any models for this account yet. Check again in a minute.</p>
			</CardSection>
		);
	}
	return (
		<CardSection label={`By model · ${subscription.models.length}`} hint="Effort · context · tokens this month">
			<ul aria-label={`${subscription.name} models`} className="m-0 -mx-2 flex list-none flex-col p-0">
				{subscription.models.map((model) => (
					<li
						key={model.id}
						className="grid min-h-12 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 rounded-lg px-2 py-1.5 hover:bg-(--bg-hover) sm:grid-cols-[minmax(0,1.1fr)_auto_2.5rem_minmax(0,1fr)_auto]"
					>
						<div className="flex min-w-0 flex-col">
							<span className="truncate text-[12.5px] text-(--text-primary)">{model.name}</span>
							<span className="truncate font-mono text-[10.5px] text-(--text-disabled)">{model.id.slice(model.id.indexOf('/') + 1)}</span>
						</div>
						<EffortRange levels={model.reasoning} preferred={model.defaultReasoning} className="hidden sm:inline-flex" />
						<span className="in-num hidden text-right text-[11px] text-(--text-tertiary) sm:inline">{tokens(model.contextLength)}</span>
						<div className="hidden min-w-0 items-center gap-2 sm:flex">
							<div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-(--segment-off)">
								<div className="h-full rounded-full bg-(--accent-base)" style={{ width: `${model.tokens ? Math.max(3, (model.tokens / most) * 100) : 0}%` }} />
							</div>
							<span className="in-num w-10 shrink-0 text-right text-[11px] text-(--text-secondary)">{tokens(model.tokens)}</span>
						</div>
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
			<SaveState pending={makeDefault.isPending} success={false} error={makeDefault.error} />
		</CardSection>
	);
}

/** A signed-in plan: its account and token, its models, and how its calls are counted. */
function Connected({ subscription }: { subscription: Subscription }) {
	const saved = useSaved();
	const [confirming, setConfirming] = useState(false);
	const options = useMutation({
		mutationFn: (patch: Partial<SubscriptionOptions>) => api.setSubscriptionOptions(subscription.id, { ...subscription.options, ...patch }),
		onSuccess: saved,
	});
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
			<CardSection label="Settings">
				<div className="flex flex-col">
					<SettingRow
						title={`Use ${subscription.name} models`}
						help="Off hides them from the model picker. Tasks already set to one of them stop until you pick another model."
					>
						<Switch
							checked={enabled}
							disabled={options.isPending}
							onChange={(next) => options.mutate({ enabled: next })}
							label={<span className="sr-only">Use {subscription.name} models</span>}
						/>
					</SettingRow>
					<SettingRow
						title="Count toward the spending caps"
						help="Records each call at what the OpenAI API would charge for it, so the daily and per-task caps also stop a runaway task on your plan. Off, calls are recorded at $0 and only the plan's own limits apply."
					>
						<Switch
							checked={countAtApiPrices}
							disabled={options.isPending}
							onChange={(next) => options.mutate({ countAtApiPrices: next })}
							label={<span className="sr-only">Count toward the spending caps</span>}
						/>
					</SettingRow>
				</div>
				<SaveState pending={options.isPending} success={false} error={options.error ?? refresh.error ?? disconnect.error} />
			</CardSection>
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
			icon={MessageSquareCode}
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
					<PlanLinkArt linked={connected} plan={subscription.name} className="w-full max-w-[440px]" />
				</Well>
			</CardSection>
			{connected ? (
				<Lead title={`${subscription.models.length} models on your plan`}>
					Tasks on these models bill your {subscription.name} plan's usage instead of paying per token. Their names start with{' '}
					<InlineCode>{subscription.gateway}/</InlineCode>, and Anton renews the sign-in on its own a few minutes before each token lapses.
				</Lead>
			) : subscription.login ? (
				<Lead title={`Waiting for ${subscription.name}`}>Approve Anton in the {subscription.name} tab, then finish here.</Lead>
			) : subscription.state === 'expired' ? (
				<Lead title="The sign-in stopped working">
					<span className="text-(--danger-text)">{subscription.problem}</span>
				</Lead>
			) : (
				<Lead title={`Run tasks on your ${subscription.name} plan`}>
					Plus and Pro plans work through OpenAI's Sign in with ChatGPT. Their models join the model picker, and their calls count toward the plan's
					limits instead of costing money per token.
				</Lead>
			)}
			{connected ? <Connected subscription={subscription} /> : subscription.login ? <Pending subscription={subscription} /> : <Connect subscription={subscription} />}
		</Card>
	);
}

/** Claude plans need Claude Code itself; docs/claude-code-subscription.md has the design. */
function ClaudePlanned() {
	return (
		<Card icon={Bot} title="Claude plan" sub="through Claude Code" label="Claude plan" status={<Status>Planned</Status>}>
			<Lead title="Needs Claude Code itself">
				Anthropic allows Claude Pro and Max plans only inside its own Claude Code program, so Anton cannot sign in to Claude the way it does to
				ChatGPT. The design for running Claude Code on your plan is in <InlineCode>docs/claude-code-subscription.md</InlineCode>. Until then, Claude
				models work per token through OpenRouter.
			</Lead>
			<CardFooter caption={<Caption>Design written · not built</Caption>} />
		</Card>
	);
}

export function SubscriptionsPage() {
	const view = useQuery({ queryKey: ['subscriptions'], queryFn: api.subscriptions });
	return (
		<>
			<PageHeading title="Subscriptions">
				Run tasks on a plan you already pay for instead of paying per token. A connected plan gets its own tab in the model picker, its models are
				marked PLAN, and their calls count against the plan's own limits.
			</PageHeading>
			{view.isPending ? (
				<Spinner size={12} />
			) : view.isError ? (
				<p className="m-0 text-[12px] text-(--danger-text)">{view.error.message}</p>
			) : (
				<div className="flex flex-col gap-6">
					{view.data.subscriptions.map((subscription) => (
						<Plan key={subscription.id} subscription={subscription} />
					))}
					<ClaudePlanned />
				</div>
			)}
		</>
	);
}

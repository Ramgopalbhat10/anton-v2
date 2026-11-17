import { unrouted } from '../../../core/model-route';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronLeft, ChevronRight, Copy, ExternalLink, KeyRound, RotateCw } from '@/lib/icons';
import { type ReactNode, useState } from 'react';
import { PlanLinkArt } from '@/components/marks/illustrations';
import { Caption, Card, CardFooter, CardSection, SegmentMeter, SpecGrid, Status, StatusDot, Tab, Tabs, usedTone, Well } from '@/components/kit/instrument';
import { EffortRange } from '@/components/composer/model-picker';
import { useModels } from '@/lib/models';
import { AREA } from '@/components/settings/repo-settings';
import { Btn, EmptyLine, Icon, InfoTip, InlineCode, SearchField, Spinner, Switch } from '@/components/kit/signal';
import { api, type PlanWindow, type Subscription, type SubscriptionOptions } from '@/lib/api';
import { age, dollars, tokens, until } from '@/lib/format';
import { logoFor } from '@/lib/provider-logos';
import { cn } from '@/lib/utils';
import { useGeneralSettings } from './general';
import { FIELD, Note, PageHeading, SaveState, SettingRow } from './parts';

const STATUS: Record<Subscription['state'], { tone: 'success' | 'danger' | 'neutral'; label: string }> = {
	connected: { tone: 'success', label: 'Connected' },
	expired: { tone: 'danger', label: 'Sign in again' },
	'signed-out': { tone: 'neutral', label: 'Not connected' },
};

const day = (iso: string) => new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short' });

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

/** The caller opens the tab during the click, before the server answers, so popup blockers let it through. */
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

function Lead({ title, info, children }: { title: string; info?: ReactNode; children: ReactNode }) {
	return (
		<div className="flex flex-col gap-1 px-4 pt-1 pb-3.5">
			<h3 className="m-0 flex items-center gap-1.5 text-h3 leading-[22px] font-medium tracking-[-0.01em]">
				{title}
				{info ? <InfoTip label={`About ${title}`}>{info}</InfoTip> : null}
			</h3>
			<p className="m-0 max-w-[72ch] text-small leading-[18px] text-pretty text-(--text-3)">{children}</p>
		</div>
	);
}

const Named = ({ gateway }: { gateway: string }) => (
	<>
		Their names start with <InlineCode>{gateway}/</InlineCode>.
	</>
);

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
	const current = unrouted(settings.data?.model ?? models.data?.default ?? '');
	const most = Math.max(1, ...subscription.models.map((model) => model.tokens));
	if (!subscription.models.length) {
		return (
			<CardSection label="By model">
				<p className="m-0 text-small text-(--text-3)">{subscription.name} has not listed any models for this account yet. Check again in a minute.</p>
			</CardSection>
		);
	}
	return (
		<CardSection label={`By model · ${subscription.models.length}`} hint="Effort · context · tokens this month">
			<ul aria-label={`${subscription.name} models`} className="m-0 -mx-2 flex list-none flex-col p-0">
				{subscription.models.map((model) => (
					<li
						key={model.id}
						className="grid min-h-12 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 rounded-card px-2 py-1.5 hover:bg-(--bg-hover) sm:grid-cols-[minmax(0,1.1fr)_auto_2.5rem_minmax(0,1fr)_auto]"
					>
						<div className="flex min-w-0 flex-col">
							<span className="flex min-w-0 items-center gap-1.5">
								<span className="truncate text-body text-(--text)">{model.name}</span>
								{model.options?.map((option) => (
									<span key={option} className="shrink-0 rounded-control bg-(--bg-active) px-1 py-px text-nano text-(--text-3)">
										{option}
									</span>
								))}
							</span>
							<span className="truncate text-micro text-(--text-4)">{model.id.slice(model.id.indexOf('/') + 1)}</span>
						</div>
						<EffortRange levels={model.reasoning} preferred={model.defaultReasoning} className="hidden sm:inline-flex" />
						<span className="in-num hidden text-right text-micro text-(--text-3) sm:inline">{tokens(model.contextLength)}</span>
						<div className="hidden min-w-0 items-center gap-2 sm:flex">
							<div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-(--bg-active)">
								<div className="h-full rounded-full bg-(--accent)" style={{ width: `${model.tokens ? Math.max(3, (model.tokens / most) * 100) : 0}%` }} />
							</div>
							<span className="in-num w-10 shrink-0 text-right text-micro text-(--text-2)">{tokens(model.tokens)}</span>
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

/** `pricedAs` names whose prices a call is counted at; null when the plan has none to count at. */
function PlanSettings({ subscription, error, pricedAs }: { subscription: Subscription; error?: Error | null; pricedAs?: string | null }) {
	const saved = useSaved();
	const options = useMutation({
		mutationFn: (patch: Partial<SubscriptionOptions>) => api.setSubscriptionOptions(subscription.id, { ...subscription.options, ...patch }),
		onSuccess: saved,
	});
	const { enabled, countAtApiPrices } = subscription.options;
	const vendorApi = pricedAs === undefined ? (subscription.kind === 'runtime' ? 'the Anthropic API' : 'the OpenAI API') : pricedAs;
	return (
		<CardSection label="Settings">
			<div className="flex flex-col">
				<SettingRow
					title={`Use ${subscription.name} models`}
					help="Off hides them from the model picker."
					info="Tasks already set to one of them stop until you pick another model."
				>
					<Switch
						checked={enabled}
						disabled={options.isPending}
						onChange={(next) => options.mutate({ enabled: next })}
						label={<span className="sr-only">Use {subscription.name} models</span>}
					/>
				</SettingRow>
				{vendorApi ? (
					<SettingRow
						title="Count toward the spending caps"
						help={`Each call counts at ${vendorApi} prices.`}
						info="So the daily and per-task caps also stop a runaway task on your plan. Off, calls are recorded at $0 and only the plan's own limits apply."
					>
						<Switch
							checked={countAtApiPrices}
							disabled={options.isPending}
							onChange={(next) => options.mutate({ countAtApiPrices: next })}
							label={<span className="sr-only">Count toward the spending caps</span>}
						/>
					</SettingRow>
				) : null}
			</div>
			<SaveState pending={options.isPending} success={false} error={options.error ?? error ?? null} />
		</CardSection>
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
function ClaudePlan({ subscription }: { subscription: Subscription }) {
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

const KEY_PLANS: Record<string, { tagline: string; lead: string; about: string; howTo: string; placeholder: string; pricedAs: string | null; terms?: string }> = {
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

function Windows({ windows, label = 'Plan limits' }: { windows: PlanWindow[]; label?: string }) {
	return (
		<CardSection label={label} hint="As the vendor reports them">
			<ul aria-label={label} className="m-0 grid list-none gap-x-6 gap-y-3.5 p-0 sm:grid-cols-2">
				{windows.map((window) => {
					const tone = window.limited || window.usedPercent >= 90 ? 'danger' : usedTone(window.usedPercent / 100);
					return (
						<li key={window.label} className="flex min-w-0 flex-col gap-1.5">
							<div className="flex min-w-0 items-baseline gap-2 text-small">
								<span className="min-w-0 flex-1 truncate text-(--text-2)" title={window.label}>
									{window.label}
								</span>
								{window.resetsAt ? <Caption className="shrink-0 tracking-normal normal-case">resets {until(window.resetsAt)}</Caption> : null}
								{window.limited ? (
									<span className="in-num shrink-0 text-small text-(--bad)">Limit reached</span>
								) : (
									<span className="in-num shrink-0">
										<span className={cn('text-body', tone === 'accent' ? 'text-(--text)' : tone === 'warning' ? 'text-(--warn)' : 'text-(--bad)')}>
											{Math.round(window.usedPercent)}%
										</span>
										<span className="text-micro text-(--text-3)"> used</span>
									</span>
								)}
							</div>
							<SegmentMeter value={window.limited ? 1 : window.usedPercent / 100} segments={30} height={8} tone={tone} label={`${window.label}: ${Math.round(window.usedPercent)}% used`} />
						</li>
					);
				})}
			</ul>
		</CardSection>
	);
}

function KeyForm({ subscription, howTo, placeholder }: { subscription: Subscription; howTo: string; placeholder: string }) {
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

function KeyPlan({ subscription }: { subscription: Subscription }) {
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
					Billed to your {subscription.name} plan, not per token.
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
							{ label: 'Counted as', value: copy.pricedAs && countAtApiPrices ? 'API prices' : '$0 per call' },
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

function GatewayPlan({ subscription }: { subscription: Subscription }) {
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

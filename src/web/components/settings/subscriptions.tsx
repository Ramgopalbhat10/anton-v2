import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Check, Copy, ExternalLink, KeyRound, MessageSquareCode, RotateCw } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { PlanLinkArt } from '@/components/illustrations';
import { Caption, Card, CardFooter, CardSection, SpecGrid, Status, Well } from '@/components/instrument';
import { EffortRange, useModels } from '@/components/model-picker';
import { AREA } from '@/components/repo-settings';
import { Btn, Icon, InlineCode, Spinner, Switch } from '@/components/signal';
import { api, type PlanWindow, type Subscription, type SubscriptionOptions } from '@/lib/api';
import { age, tokens } from '@/lib/format';
import { logoFor } from '@/lib/provider-logos';
import { cn } from '@/lib/utils';
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

/**
 * Whether the plan's models are offered, and whether their calls count toward the spending caps.
 * `pricedAs` names whose prices a call is counted at; null when the plan has none to count at.
 */
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
					help="Off hides them from the model picker. Tasks already set to one of them stop until you pick another model."
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
						help={`Records each call at what ${vendorApi} would charge for it, so the daily and per-task caps also stop a runaway task on your plan. Off, calls are recorded at $0 and only the plan's own limits apply.`}
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

/** A signed-in plan: its account and token, its models, and how its calls are counted. */
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
				<Lead title={`${subscription.models.length} ${subscription.models.length === 1 ? 'model' : 'models'} on your plan`}>
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

/** A command to run on the server, with a button that copies it. */
function Command({ text, label }: { text: string; label: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<div className="flex items-start gap-2">
			<pre aria-label={label} className="m-0 min-w-0 flex-1 rounded-md bg-(--well-bg) px-3 py-2 font-mono text-[11.5px] leading-[18px] break-all whitespace-pre-wrap text-(--text-primary)">
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

/**
 * A Claude plan, run by Claude Code on Anton's server. Claude Code signs in
 * through its own flow, so the card shows the command to run once there, and
 * what Claude Code then says about the account; Anton never holds the token.
 */
function ClaudePlan({ subscription }: { subscription: Subscription }) {
	const saved = useSaved();
	const refresh = useMutation({ mutationFn: () => api.refreshSubscriptionModels(subscription.id), onSuccess: saved });
	const connected = subscription.state === 'connected';
	const status = STATUS[subscription.state];
	const { enabled, countAtApiPrices } = subscription.options;
	const signOut = subscription.signIn?.replace(/ login$/, ' logout');
	return (
		<Card
			icon={Bot}
			title={`${subscription.name} plan`}
			sub={subscription.email ?? 'through Claude Code'}
			label={`${subscription.name} plan`}
			status={
				<Status tone={status.tone} pulse={connected}>
					{connected ? 'Connected' : subscription.state === 'expired' ? 'Needs attention' : status.label}
				</Status>
			}
		>
			<CardSection ruled={false} className="pt-0">
				<Well grid className="flex items-center justify-center px-4 py-6">
					<PlanLinkArt linked={connected} plan={subscription.name} className="w-full max-w-[440px]" />
				</Well>
			</CardSection>
			{connected ? (
				<Lead title={`${subscription.models.length} ${subscription.models.length === 1 ? 'model' : 'models'} on your plan`}>
					Tasks on these models run through Claude Code on this server, which uses only Anton's tools and bills your {subscription.name} plan's usage
					instead of paying per token. Their names start with <InlineCode>{subscription.gateway}/</InlineCode>.
				</Lead>
			) : subscription.state === 'expired' ? (
				<Lead title="Claude Code cannot use your plan">
					<span className="text-(--danger-text)">{subscription.problem}</span>
				</Lead>
			) : (
				<Lead title={`Run tasks on your ${subscription.name} plan`}>
					Pro and Max plans work only inside Anthropic's own Claude Code, so Anton runs it on this server with its built-in tools off: Claude does the
					thinking, and Anton runs every tool. Claude Code signs in through its own flow and keeps the sign-in to itself.
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
							<p className="m-0 max-w-[72ch] text-[12px] leading-[18px] text-pretty text-(--warning-text)">
								Claude Code said {age(subscription.extraUsageAt)} ago that your plan's limit ran out and calls now bill extra usage, which costs money.
								Turn extra usage off at{' '}
								<a href="https://claude.ai/settings/usage" target="_blank" rel="noreferrer" className="text-(--accent-text) hover:underline">
									claude.ai/settings/usage
								</a>{' '}
								to have tasks stop at the limit instead.
							</p>
						</CardSection>
					) : null}
					<Models subscription={subscription} />
					<PlanSettings subscription={subscription} error={refresh.error} />
					{signOut ? (
						<CardSection label="Sign out on the server">
							<Command text={signOut} label="Command that signs Claude Code out" />
						</CardSection>
					) : null}
				</>
			) : (
				<CardSection label="Sign in on the server" hint="Once">
					<p className="m-0 max-w-[72ch] text-[12px] leading-[18px] text-pretty text-(--text-tertiary)">
						Run this in a shell on the computer Anton runs on, such as over ssh. Claude Code shows a link: open it, approve, and paste the code it gives
						you back into the shell. Then check again here.
					</p>
					{subscription.signIn ? <Command text={subscription.signIn} label="Command that signs Claude Code in" /> : null}
					<SaveState pending={refresh.isPending} success={false} error={refresh.error} />
				</CardSection>
			)}
			<CardFooter
				caption={
					<Caption>For your own use only: Anthropic lets you sign in to its unmodified Claude Code with your own plan, not share it with others.</Caption>
				}
			>
				<Btn size="sm" variant={connected ? 'ghost' : 'primary'} icon={RotateCw} disabled={refresh.isPending} onClick={() => refresh.mutate()}>
					{refresh.isPending ? 'Checking…' : 'Check again'}
				</Btn>
			</CardFooter>
		</Card>
	);
}

/** What a key plan's card says, by plan; a plan not listed here gets plain wording. */
const KEY_PLANS: Record<string, { tagline: string; about: string; howTo: string; placeholder: string; pricedAs: string | null; terms?: string }> = {
	'opencode-go': {
		tagline: 'open coding models',
		about:
			'OpenCode Go is a monthly plan of open coding models (GLM, Kimi, DeepSeek, Qwen, MiniMax and more) that OpenCode offers for its own agent and others. Anton calls them from this server with a key from your OpenCode workspace.',
		howTo: 'Subscribe to Go in the OpenCode Console, make an API key in the same workspace, and paste it here.',
		placeholder: 'sk-…',
		pricedAs: "pay-as-you-go use at the model's list price",
	},
	cursor: {
		tagline: 'through the Cursor SDK',
		about:
			"Cursor plans run through Cursor's own agent, so Anton runs it on this server through Cursor's official SDK with its built-in tools off: the model does the thinking, and Anton runs every tool. Calls use your plan's usage.",
		howTo: "Make a user API key in Cursor's dashboard and paste it here.",
		placeholder: 'key_…',
		// Cursor publishes no per-token prices for agent calls, so there is nothing to count them at.
		pricedAs: null,
		terms: "Calls go through Cursor's SDK under Cursor's terms, billed to the plan the key belongs to.",
	},
};

/** The plan's own limits, as the vendor reports them: how much of each window is used and when it resets. */
function Windows({ windows }: { windows: PlanWindow[] }) {
	return (
		<CardSection label="Plan limits" hint="As the vendor reports them">
			<ul aria-label="Plan limits" className="m-0 flex list-none flex-col gap-2 p-0">
				{windows.map((window) => (
					<li key={window.label} className="grid grid-cols-[4.5rem_minmax(0,1fr)_auto] items-center gap-3 text-[12px]">
						<span className="text-(--text-secondary)">{window.label}</span>
						<div className="h-1.5 min-w-0 overflow-hidden rounded-full bg-(--segment-off)">
							<div
								className={cn('h-full rounded-full', window.limited || window.usedPercent >= 90 ? 'bg-(--danger-base)' : 'bg-(--accent-base)')}
								style={{ width: `${window.usedPercent}%` }}
							/>
						</div>
						<span className="in-num text-right text-[11px] text-(--text-tertiary)">
							{window.limited ? 'Limit reached' : `${Math.round(window.usedPercent)}% used`}
							{window.resetsAt ? ` · resets ${until(window.resetsAt)}` : ''}
						</span>
					</li>
				))}
			</ul>
		</CardSection>
	);
}

/** The form that takes a key: pasted, checked with the vendor on the server, and kept there. */
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
			<p className="m-0 max-w-[72ch] text-[12px] leading-[18px] text-pretty text-(--text-tertiary)">
				{howTo}{' '}
				{subscription.keyPage ? (
					<a href={subscription.keyPage} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-(--accent-text) hover:underline">
						Open the key page
						<Icon icon={ExternalLink} size={11} />
					</a>
				) : null}{' '}
				The key stays on this server and never reaches a task's sandbox.
			</p>
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
					className={`${FIELD} min-w-[240px] flex-1 font-mono text-[12px]`}
				/>
				<Btn type="submit" size="sm" variant="primary" disabled={!key.trim() || connect.isPending}>
					{connect.isPending ? 'Checking…' : 'Connect'}
				</Btn>
			</form>
			<SaveState pending={connect.isPending} success={false} error={connect.error} />
		</CardSection>
	);
}

/** A plan used with a key from the vendor's dashboard: OpenCode Go, Cursor. */
function KeyPlan({ subscription }: { subscription: Subscription }) {
	const saved = useSaved();
	const [confirming, setConfirming] = useState(false);
	const refresh = useMutation({ mutationFn: () => api.refreshSubscriptionModels(subscription.id), onSuccess: saved });
	const disconnect = useMutation({ mutationFn: () => api.disconnectSubscription(subscription.id), onSuccess: saved });
	const connected = subscription.state === 'connected';
	const status = STATUS[subscription.state];
	const copy = KEY_PLANS[subscription.id] ?? {
		tagline: 'with your key',
		about: `Anton calls ${subscription.name} from this server with a key from your account.`,
		howTo: `Make a key on ${subscription.name}'s dashboard and paste it here.`,
		placeholder: 'Key',
		pricedAs: null,
	};
	const { enabled, countAtApiPrices } = subscription.options;
	return (
		<Card
			icon={KeyRound}
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
					<PlanLinkArt linked={connected} plan={subscription.name} className="w-full max-w-[440px]" />
				</Well>
			</CardSection>
			{connected ? (
				<Lead title={`${subscription.models.length} ${subscription.models.length === 1 ? 'model' : 'models'} on your plan`}>
					Tasks on these models use your {subscription.name} plan instead of paying per token. Their names start with{' '}
					<InlineCode>{subscription.gateway}/</InlineCode>.
				</Lead>
			) : subscription.state === 'expired' ? (
				<Lead title={`${subscription.name} stopped taking the key`}>
					<span className="text-(--danger-text)">{subscription.problem}</span>
				</Lead>
			) : (
				<Lead title={`Run tasks on your ${subscription.name} plan`}>{copy.about}</Lead>
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

/** The tab for one plan: its vendor's logo, its name and whether it is connected. */
function PlanTab({ subscription, on, onSelect }: { subscription: Subscription; on: boolean; onSelect: () => void }) {
	const logo = logoFor({ id: `${subscription.gateway}/` });
	const connected = subscription.state === 'connected';
	return (
		<button
			type="button"
			role="tab"
			id={`plan-tab-${subscription.id}`}
			aria-selected={on}
			aria-controls={`plan-panel-${subscription.id}`}
			onClick={onSelect}
			className={cn(
				'-mb-px inline-flex h-10 items-center gap-2 border-b-2 px-1 text-[13px] outline-none focus-visible:shadow-(--focus-ring)',
				on ? 'border-(--accent-base) text-(--text-primary)' : 'border-transparent text-(--text-tertiary) hover:text-(--text-secondary)',
			)}
		>
			{logo ? (
				// LobeHub's one-colour logos take the text colour, sized by the font size.
				<span aria-hidden className={cn('flex text-[15px]', on ? 'text-(--text-primary)' : 'text-(--text-secondary)')} dangerouslySetInnerHTML={{ __html: logo }} />
			) : null}
			{subscription.name}
			<span
				title={connected ? 'Connected' : STATUS[subscription.state].label}
				className={cn('size-1.5 rounded-full', connected ? 'bg-(--success-base)' : subscription.state === 'expired' ? 'bg-(--danger-base)' : 'bg-(--border-strong)')}
			/>
		</button>
	);
}

export function SubscriptionsPage() {
	const view = useQuery({ queryKey: ['subscriptions'], queryFn: api.subscriptions });
	const [picked, setPicked] = useState<string | null>(null);
	const plans = view.data?.subscriptions ?? [];
	const current = plans.find((plan) => plan.id === picked) ?? plans[0];
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
			) : current ? (
				<div className="flex flex-col gap-5">
					<div role="tablist" aria-label="Plans" className="flex gap-6 border-b border-(--border-subtle)">
						{plans.map((plan) => (
							<PlanTab key={plan.id} subscription={plan} on={plan.id === current.id} onSelect={() => setPicked(plan.id)} />
						))}
					</div>
					<div role="tabpanel" id={`plan-panel-${current.id}`} aria-labelledby={`plan-tab-${current.id}`}>
						{current.kind === 'runtime' ? (
								<ClaudePlan key={current.id} subscription={current} />
							) : current.kind === 'key' ? (
								<KeyPlan key={current.id} subscription={current} />
							) : (
								<Plan key={current.id} subscription={current} />
							)}
					</div>
				</div>
			) : null}
		</>
	);
}

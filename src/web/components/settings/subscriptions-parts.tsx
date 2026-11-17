import { unrouted } from '../../../core/model-route';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type ReactNode } from 'react';
import { Caption, CardSection, SegmentMeter, Status, usedTone } from '@/components/kit/instrument';
import { EffortRange } from '@/components/composer/model-picker';
import { useModels } from '@/lib/models';
import { Btn, InfoTip, InlineCode, Switch } from '@/components/kit/signal';
import { api } from '@/lib/api';
import type { PlanWindow, Subscription, SubscriptionOptions } from '@/lib/api/plans';
import { tokens, until } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useGeneralSettings } from './general';
import { SaveState, SettingRow } from './parts';

export const STATUS: Record<Subscription['state'], { tone: 'success' | 'danger' | 'neutral'; label: string }> = {
	connected: { tone: 'success', label: 'Connected' },
	expired: { tone: 'danger', label: 'Sign in again' },
	'signed-out': { tone: 'neutral', label: 'Not connected' },
};

export const day = (iso: string) => new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short' });

export function useSaved() {
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
export function useSignIn(subscription: Subscription) {
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

export function Lead({ title, info, children }: { title: string; info?: ReactNode; children: ReactNode }) {
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

export const Named = ({ gateway }: { gateway: string }) => (
	<>
		Their names start with <InlineCode>{gateway}/</InlineCode>.
	</>
);

export function Models({ subscription }: { subscription: Subscription }) {
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
export function PlanSettings({ subscription, error, pricedAs }: { subscription: Subscription; error?: Error | null; pricedAs?: string | null }) {
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

export function Windows({ windows, label = 'Plan limits' }: { windows: PlanWindow[]; label?: string }) {
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

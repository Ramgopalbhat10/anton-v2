import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, ArrowUpRight, CalendarDays, Coins, CreditCard, Folder, Gauge } from 'lucide-react';
import { useMemo, useState } from 'react';
import { DATA_COLORS, dayKey, lastDays, shortDay, StackedDaysChart, type StackRow } from '@/components/charts';
import { Card, CardFooter, CardSection, Figure, Segmented, SegmentedItem, ShareRow, SplitBar, StatRow, Status, TickGauge, usedTone } from '@/components/instrument';
import { useModels } from '@/components/model-picker';
import { Btn, Icon, Spinner } from '@/components/signal';
import { api, type Budget, type Limits, type PlanUsage, type SpendRow, type UsageView } from '@/lib/api';
import { age, dollars, tokens } from '@/lib/format';
import { FIELD, PageHeading, SaveState } from './parts';

const toInput = (value: number | null) => (value === null ? '' : String(value));
const fromInput = (value: string) => (value.trim() === '' ? null : Math.max(0, Number(value)));

/** The series the daily chart stacks: the biggest models, then everything else as one. */
const CHART_SERIES = 4;

function Caps({ limits }: { limits: Limits }) {
	const queryClient = useQueryClient();
	const [daily, setDaily] = useState(toInput(limits.dailyUsd));
	const [task, setTask] = useState(toInput(limits.taskUsd));
	const save = useMutation({
		mutationFn: () => api.setLimits({ dailyUsd: fromInput(daily), taskUsd: fromInput(task) }),
		onSuccess: (budget) => {
			queryClient.setQueryData(['budget'], budget);
			void queryClient.invalidateQueries({ queryKey: ['budget'] });
		},
	});
	const invalid = [daily, task].some((value) => value.trim() !== '' && !(Number(value) >= 0));
	return (
		<form
			onSubmit={(event) => {
				event.preventDefault();
				if (!invalid) save.mutate();
			}}
		>
			<Card
				icon={Gauge}
				title="Spending caps"
				sub="what stops the agent"
				as="div"
				footer={
					<CardFooter
						caption={
							invalid ? (
								<span className="text-[12px] text-(--danger-text)">Use a dollar amount, or leave it empty for no cap.</span>
							) : save.isSuccess || save.isError ? (
								<SaveState pending={save.isPending} success={save.isSuccess} error={save.error} />
							) : (
								'Empty means no cap'
							)
						}
					>
						<Btn type="submit" size="sm" variant="primary" disabled={save.isPending || invalid}>
							{save.isPending ? 'Saving…' : 'Save caps'}
						</Btn>
					</CardFooter>
				}
			>
				<CardSection ruled={false} className="pt-0">
					<p className="m-0 max-w-[72ch] text-[12px] leading-[18px] text-pretty text-(--text-tertiary)">
						Once a cap is reached, Anton stops the reply that crossed it and takes no new messages until the next day or until you raise it.
						Automations start nothing while today's cap is reached.
					</p>
					<div className="grid gap-3 sm:grid-cols-2">
						<label className="flex flex-col gap-1.5">
							<span className="in-caption">Per day, all tasks</span>
							<span className="relative flex items-center">
								<span className="in-num pointer-events-none absolute left-2.5 text-[13px] text-(--text-disabled)">$</span>
								<input inputMode="decimal" value={daily} onChange={(event) => setDaily(event.target.value)} placeholder="No cap" className={`${FIELD} in-num w-full pl-6`} />
							</span>
						</label>
						<label className="flex flex-col gap-1.5">
							<span className="in-caption">Per task</span>
							<span className="relative flex items-center">
								<span className="in-num pointer-events-none absolute left-2.5 text-[13px] text-(--text-disabled)">$</span>
								<input inputMode="decimal" value={task} onChange={(event) => setTask(event.target.value)} placeholder="No cap" className={`${FIELD} in-num w-full pl-6`} />
							</span>
						</label>
					</div>
				</CardSection>
			</Card>
		</form>
	);
}

/** Today against the daily cap, warning from 80 percent: what is left, and how this month adds up. */
function Allowance({ usage, budget }: { usage: UsageView; budget: Budget }) {
	const cap = budget.limits.dailyUsd;
	const used = cap ? usage.today / cap : 0;
	const month = new Date(usage.since).toLocaleDateString([], { month: 'long' });
	const dayOfMonth = new Date().getDate();
	const activeDays = new Set(usage.daily.filter((row) => row.cost > 0 && row.day >= dayKey(new Date(usage.since))).map((row) => row.day)).size;
	return (
		<Card
			icon={Activity}
			title="Today"
			sub={new Date().toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })}
			status={
				cap === null ? (
					<Status>No daily cap</Status>
				) : used >= 1 ? (
					<Status tone="danger">Cap reached</Status>
				) : (
					<Status tone={usedTone(used)}>{Math.round(used * 100)}% used</Status>
				)
			}
			footer={<CardFooter caption={cap === null ? 'No daily cap is set' : used >= 1 ? 'New messages wait until tomorrow or a higher cap' : 'Resets at midnight, server time'} />}
		>
			<CardSection ruled={false} className="pt-1">
				<div className="flex flex-wrap items-end justify-between gap-3">
					<div className="flex flex-col gap-1">
						<span className="in-caption">{cap === null ? 'Spent' : 'Remaining'}</span>
						<Figure size="xl" value={cap === null ? dollars(usage.today) : dollars(Math.max(0, cap - usage.today))} tone={used >= 1 ? 'danger' : undefined} />
					</div>
					{cap !== null ? (
						<div className="in-num flex gap-4 text-[11px] text-(--text-tertiary)">
							<span>
								SPENT <span className="text-(--text-primary)">{dollars(usage.today)}</span>
							</span>
							<span>
								CAP <span className="text-(--text-primary)">${cap}</span>
							</span>
						</div>
					) : null}
				</div>
				{cap !== null ? (
					<TickGauge
						label="Today's spend against the daily cap"
						value={usage.today}
						max={cap}
						tone={usedTone(used)}
						ticks={64}
						markers={[
							{ at: usage.today, label: 'spent', tone: usedTone(used) },
							{ at: cap * 0.8, label: '80%', tone: 'warning' },
						]}
						scale={['$0', `$${(cap / 2).toFixed(cap < 10 ? 1 : 0)}`, `$${cap}`]}
					/>
				) : null}
			</CardSection>
			<StatRow
				stats={[
					{ label: `since ${month} 1`, value: dollars(usage.month) },
					{ label: 'per active day', value: activeDays ? dollars(usage.month / activeDays) : '$0', title: `${activeDays} of ${dayOfMonth} days had spend` },
					{ label: 'cap per task', value: budget.limits.taskUsd === null ? 'None' : `$${budget.limits.taskUsd}` },
				]}
			/>
		</Card>
	);
}

type Metric = 'tokens' | 'spend';

/** Rows for the daily chart: the biggest series by the metric, then everything else as one. */
function stacked(entries: Array<{ day: string; name: string; value: number }>): { rows: StackRow[]; series: string[] } {
	const totals = new Map<string, number>();
	for (const entry of entries) totals.set(entry.name, (totals.get(entry.name) ?? 0) + entry.value);
	const ranked = [...totals.entries()]
		.filter(([, value]) => value > 0)
		.sort((a, b) => b[1] - a[1])
		.map(([name]) => name);
	const top = ranked.slice(0, CHART_SERIES);
	const named = ranked.length > CHART_SERIES ? [...top, 'Other models'] : top;
	const merged = new Map<string, StackRow>();
	for (const entry of entries) {
		if (entry.value <= 0) continue;
		const series = top.includes(entry.name) ? entry.name : 'Other models';
		const key = `${entry.day} ${series}`;
		const row = merged.get(key) ?? { day: entry.day, series, value: 0 };
		row.value += entry.value;
		merged.set(key, row);
	}
	return { rows: [...merged.values()], series: named };
}

/** Tokens or spend per day for 30 days, stacked by model; spend against the daily cap. Plan models count in tokens, since they cost nothing per token. */
function Daily({ usage, cap, modelName }: { usage: UsageView; cap: number | null; modelName: (id: string | null) => string }) {
	const [metric, setMetric] = useState<Metric>('tokens');
	const days = useMemo(() => lastDays(30), []);
	const { rows, series } = useMemo(
		() => stacked(usage.daily.map((row) => ({ day: row.day, name: modelName(row.model), value: metric === 'tokens' ? row.tokens : row.cost }))),
		[usage.daily, modelName, metric],
	);
	const format = metric === 'tokens' ? tokens : dollars;
	const total = rows.reduce((sum, row) => sum + row.value, 0);
	const busiest = [...days].sort((a, b) => sum(rows, b) - sum(rows, a))[0];
	return (
		<Card
			icon={CalendarDays}
			title="By day"
			sub="last 30 days · by model"
			status={
				<Segmented label="Show" role="radiogroup">
					{(['tokens', 'spend'] as const).map((entry) => (
						<SegmentedItem key={entry} role="radio" size="sm" on={metric === entry} onClick={() => setMetric(entry)}>
							{entry === 'tokens' ? 'Tokens' : 'Spend'}
						</SegmentedItem>
					))}
				</Segmented>
			}
			footer={
				<CardFooter
					caption={
						total > 0 ? (
							<span className="in-caption">
								{format(total)} in 30 days · busiest {shortDay(busiest)} · {format(sum(rows, busiest))}
							</span>
						) : metric === 'spend' ? (
							'Nothing spent in 30 days'
						) : (
							'No model calls in 30 days'
						)
					}
				/>
			}
		>
			<CardSection ruled={false} className="pt-1">
				{series.length ? (
					<div className="flex flex-wrap gap-x-4 gap-y-1">
						{series.map((name, index) => (
							<span key={name} className="inline-flex items-center gap-1.5 text-[11px] text-(--text-tertiary)">
								<span className="size-2 rounded-[2px]" style={{ background: DATA_COLORS[index] }} />
								{name}
							</span>
						))}
					</div>
				) : null}
				<StackedDaysChart
					rows={rows}
					days={days}
					series={series.length ? series : ['Usage']}
					format={format}
					label={`${metric === 'tokens' ? 'Tokens' : 'Spend'} per day over the last 30 days, by model`}
					limit={metric === 'spend' && cap ? { value: cap, label: 'cap' } : null}
					height={184}
				/>
			</CardSection>
		</Card>
	);
}

/**
 * A plan you pay for: how much Anton used it, by day and model, and what the
 * same calls would have cost per token. The vendor does not share how much
 * of the plan is left, so the card links to where it does.
 */
function Plan({ plan, modelName }: { plan: PlanUsage; modelName: (id: string | null) => string }) {
	const days = useMemo(() => lastDays(30), []);
	const { rows, series } = useMemo(() => stacked(plan.daily.map((row) => ({ day: row.day, name: modelName(row.model), value: row.tokens }))), [plan.daily, modelName]);
	const limitRecent = plan.limitHitAt !== null && Date.now() - new Date(plan.limitHitAt).getTime() < 24 * 3600_000;
	return (
		<Card
			icon={CreditCard}
			title={`${plan.name} plan`}
			sub="as Anton used it"
			status={
				limitRecent ? (
					<Status tone="danger">Limit reached {age(plan.limitHitAt!)} ago</Status>
				) : plan.connected ? (
					<Status tone="success" pulse>
						Connected
					</Status>
				) : (
					<Status>Not connected</Status>
				)
			}
			footer={
				<CardFooter
					caption={
						<span className="block py-0.5 text-[12px] leading-[18px] text-pretty text-(--text-disabled)">
							{plan.name} does not tell apps how much of the plan is left; its limits are only in {plan.name}.
						</span>
					}
				>
					{plan.usagePage ? (
						<a className="sg-btn sg-btn--secondary sg-btn--sm" href={plan.usagePage} target="_blank" rel="noreferrer">
							Limits in {plan.name}
							<Icon icon={ArrowUpRight} size={13} />
						</a>
					) : null}
				</CardFooter>
			}
		>
			<CardSection ruled={false} className="pt-1">
				<div className="flex flex-wrap items-end justify-between gap-3">
					<div className="flex flex-col gap-1">
						<span className="in-caption">This month</span>
						<Figure size="xl" value={tokens(plan.tokens.month)} unit="tokens" />
					</div>
					<div className="flex flex-col items-end gap-1 text-right" title="What the same calls would have cost at the vendor's API prices, input counted at the input price">
						<span className="in-caption">At API prices</span>
						<span className="in-figure text-[18px] leading-6 text-(--success-text)">{plan.apiValue === null ? 'unknown' : `≈ ${dollars(plan.apiValue)}`}</span>
					</div>
				</div>
			</CardSection>
			<StatRow
				stats={[
					{ label: 'today', value: tokens(plan.tokens.today) },
					{ label: 'last 7 days', value: tokens(plan.tokens.week) },
					{ label: 'calls this month', value: plan.calls.toLocaleString() },
				]}
			/>
			<CardSection label="Tokens by day" hint="last 30 days">
				<StackedDaysChart
					rows={rows}
					days={days}
					series={series.length ? series : ['Tokens']}
					format={tokens}
					label={`Tokens on the ${plan.name} plan per day over the last 30 days, by model`}
					height={140}
				/>
			</CardSection>
		</Card>
	);
}

const sum = (rows: StackRow[], day: string) => rows.filter((row) => row.day === day).reduce((total, row) => total + row.value, 0);

/** Where this month's spend went: a split bar of the leaders, then every row ranked. */
function Breakdown({
	title,
	sub,
	icon,
	rows,
	label,
	empty,
	note,
	planOf,
}: {
	title: string;
	sub: string;
	icon: typeof Coins;
	rows: SpendRow[];
	label: (key: string | null) => string;
	empty: string;
	note?: string;
	/** Whether a row is a model on a plan, shown as PLAN rather than $0. */
	planOf?: (key: string | null) => boolean;
}) {
	const total = rows.reduce((sum, row) => sum + row.cost, 0);
	const totalTokens = rows.reduce((sum, row) => sum + row.tokens, 0);
	// Ranked by tokens, so models on a plan, which cost nothing per token, still show what they did.
	const ranked = [...rows].sort((a, b) => b.tokens - a.tokens || b.cost - a.cost);
	const top = ranked[0]?.tokens || 1;
	return (
		<Card
			icon={icon}
			title={title}
			sub={sub}
			status={totalTokens > 0 ? <Status>{`${tokens(totalTokens)} tokens · ${dollars(total)}`}</Status> : undefined}
			footer={
				note ? (
					<CardFooter caption={<span className="block py-0.5 text-[12px] leading-[18px] text-pretty text-(--text-disabled)">{note}</span>} />
				) : undefined
			}
		>
			{rows.length === 0 ? (
				<CardSection ruled={false} className="pt-1">
					<p className="m-0 text-[12px] text-(--text-tertiary)">{empty}</p>
				</CardSection>
			) : (
				<>
					<CardSection ruled={false} className="pt-1">
						<SplitBar
							label={`${title}, share of this month's tokens`}
							parts={ranked.slice(0, DATA_COLORS.length).map((row, index) => ({ key: row.key ?? '', label: label(row.key), value: row.tokens, color: DATA_COLORS[index] }))}
							format={(_, share) => `${Math.round(share * 100)}%`}
						/>
					</CardSection>
					<CardSection className="gap-0 py-1.5">
						{ranked.map((row, index) => (
							<ShareRow
								key={row.key ?? ''}
								label={label(row.key)}
								sub={`${tokens(row.tokens)} tokens · ${totalTokens ? Math.round((row.tokens / totalTokens) * 100) : 0}%`}
								share={row.tokens / top}
								color={DATA_COLORS[index] ?? DATA_COLORS[DATA_COLORS.length - 1]}
								value={row.cost > 0 || !planOf?.(row.key) ? dollars(row.cost) : <span className="font-mono text-[10px] tracking-[0.06em] text-(--accent-text)">PLAN</span>}
							/>
						))}
					</CardSection>
				</>
			)}
		</Card>
	);
}

/** What Anton has spent on models, where it went, and the caps that stop it. */
export function UsagePage() {
	const budget = useQuery({ queryKey: ['budget'], queryFn: () => api.budget() });
	const usage = useQuery({ queryKey: ['usage'], queryFn: api.usage });
	const models = useModels();
	const catalog = models.data?.models;
	const modelName = useMemo(
		() => (id: string | null) =>
			id === null
				? 'Not recorded'
				: (catalog?.find((model) => model.id === id)?.name ?? (/typesafe\/jev/.test(id) ? 'Jev (decision model)' : id.replace(/^openrouter\//, ''))),
		[catalog],
	);
	return (
		<>
			<PageHeading title="Usage and limits">
				Model spend from OpenRouter's listed prices, including its cache prices, so the real bill may differ slightly; models on a plan you
				connected cost nothing per token and count in tokens. Sandbox and storage costs are billed by Modal and Tigris and are not counted here.
			</PageHeading>
			{usage.data && budget.data ? (
				<>
					<Allowance usage={usage.data} budget={budget.data} />
					{(usage.data.plans ?? [])
						.filter((plan) => plan.connected || plan.tokens.month > 0)
						.map((plan) => (
							<Plan key={plan.id} plan={plan} modelName={modelName} />
						))}
					<Daily usage={usage.data} cap={budget.data.limits.dailyUsd} modelName={modelName} />
				</>
			) : (
				<Spinner size={12} />
			)}
			{budget.data ? <Caps limits={budget.data.limits} /> : null}
			{usage.data ? (
				<>
					<Breakdown
						title="By model"
						sub="this month"
						icon={Coins}
						rows={usage.data.byModel}
						label={modelName}
						empty="Nothing spent this month."
						note="Each response counts against the model that gave it, so helper agents on their own model and the decision model show up on their own."
						planOf={(key) => Boolean(catalog?.find((model) => model.id === key)?.subscription)}
					/>
					<Breakdown title="By repository" sub="this month" icon={Folder} rows={usage.data.byRepo} label={(key) => key ?? 'Removed repository'} empty="Nothing spent this month." />
				</>
			) : null}
		</>
	);
}

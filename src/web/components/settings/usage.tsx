import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, CalendarDays, Coins, Folder, Gauge } from 'lucide-react';
import { useMemo, useState } from 'react';
import { DATA_COLORS, dayKey, lastDays, shortDay, StackedDaysChart, type StackRow } from '@/components/charts';
import { Card, CardFooter, CardSection, Figure, ShareRow, SplitBar, StatRow, Status, TickGauge, usedTone } from '@/components/instrument';
import { useModels } from '@/components/model-picker';
import { Btn, Spinner } from '@/components/signal';
import { api, type Budget, type Limits, type SpendRow, type UsageView } from '@/lib/api';
import { dollars, tokens } from '@/lib/format';
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

/** Spend per day for 30 days, stacked by model, against the daily cap. */
function Daily({ usage, cap, modelName }: { usage: UsageView; cap: number | null; modelName: (id: string | null) => string }) {
	const days = useMemo(() => lastDays(30), []);
	const { rows, series } = useMemo(() => {
		const totals = new Map<string, number>();
		for (const row of usage.daily) totals.set(modelName(row.model), (totals.get(modelName(row.model)) ?? 0) + row.cost);
		const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name);
		const top = ranked.slice(0, CHART_SERIES);
		const named = ranked.length > CHART_SERIES ? [...top, 'Other models'] : top;
		const merged = new Map<string, StackRow>();
		for (const row of usage.daily) {
			const name = modelName(row.model);
			const series = top.includes(name) ? name : 'Other models';
			const key = `${row.day} ${series}`;
			const entry = merged.get(key) ?? { day: row.day, series, value: 0 };
			entry.value += row.cost;
			merged.set(key, entry);
		}
		return { rows: [...merged.values()], series: named };
	}, [usage.daily, modelName]);
	const total = rows.reduce((sum, row) => sum + row.value, 0);
	const busiest = [...days].sort((a, b) => sum(rows, b) - sum(rows, a))[0];
	return (
		<Card
			icon={CalendarDays}
			title="Spend by day"
			sub="last 30 days · by model"
			status={<Status>{dollars(total)} total</Status>}
			footer={
				<CardFooter
					caption={
						total > 0 ? (
							<span className="in-caption">
								Busiest {shortDay(busiest)} · {dollars(sum(rows, busiest))}
							</span>
						) : (
							'Nothing spent in 30 days'
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
					series={series.length ? series : ['Spend']}
					format={dollars}
					label="Spend per day over the last 30 days, by model"
					limit={cap ? { value: cap, label: 'Daily cap' } : null}
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
}: {
	title: string;
	sub: string;
	icon: typeof Coins;
	rows: SpendRow[];
	label: (key: string | null) => string;
	empty: string;
	note?: string;
}) {
	const total = rows.reduce((sum, row) => sum + row.cost, 0);
	const top = rows[0]?.cost || 1;
	return (
		<Card
			icon={icon}
			title={title}
			sub={sub}
			status={total > 0 ? <Status>{dollars(total)}</Status> : undefined}
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
							label={`${title}, share of this month's spend`}
							parts={rows.slice(0, DATA_COLORS.length).map((row, index) => ({ key: row.key ?? '', label: label(row.key), value: row.cost, color: DATA_COLORS[index] }))}
							format={(_, share) => `${Math.round(share * 100)}%`}
						/>
					</CardSection>
					<CardSection className="gap-0 py-1.5">
						{rows.map((row, index) => (
							<ShareRow
								key={row.key ?? ''}
								label={label(row.key)}
								sub={`${tokens(row.tokens)} tokens`}
								share={row.cost / top}
								color={DATA_COLORS[index] ?? DATA_COLORS[DATA_COLORS.length - 1]}
								value={
									<>
										{dollars(row.cost)} <span className="text-(--text-disabled)">· {total ? Math.round((row.cost / total) * 100) : 0}%</span>
									</>
								}
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
				Model spend from OpenRouter's listed prices, including its cache prices, so the real bill may differ slightly. Sandbox and storage costs are
				billed by Modal and Tigris and are not counted here.
			</PageHeading>
			{usage.data && budget.data ? (
				<>
					<Allowance usage={usage.data} budget={budget.data} />
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
					/>
					<Breakdown title="By repository" sub="this month" icon={Folder} rows={usage.data.byRepo} label={(key) => key ?? 'Removed repository'} empty="Nothing spent this month." />
				</>
			) : null}
		</>
	);
}

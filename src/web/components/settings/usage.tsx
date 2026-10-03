import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useModels } from '@/components/model-picker';
import { Btn, ProgressBar, Spinner } from '@/components/signal';
import { api, type Limits, type SpendRow, type UsageView } from '@/lib/api';
import { dollars, tokens } from '@/lib/format';
import { Block, FIELD, PageHeading, SaveState } from './parts';

const toInput = (value: number | null) => (value === null ? '' : String(value));
const fromInput = (value: string) => (value.trim() === '' ? null : Math.max(0, Number(value)));

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
			className="flex flex-col gap-3"
			onSubmit={(event) => {
				event.preventDefault();
				if (!invalid) save.mutate();
			}}
		>
			<div className="flex flex-wrap gap-4">
				<label className="flex flex-col gap-1 text-[12px] text-(--text-secondary)">
					Per day, all tasks
					<input inputMode="decimal" value={daily} onChange={(event) => setDaily(event.target.value)} placeholder="No cap" className={`${FIELD} w-[120px]`} />
				</label>
				<label className="flex flex-col gap-1 text-[12px] text-(--text-secondary)">
					Per task
					<input inputMode="decimal" value={task} onChange={(event) => setTask(event.target.value)} placeholder="No cap" className={`${FIELD} w-[120px]`} />
				</label>
			</div>
			<div className="flex items-center gap-3">
				<Btn type="submit" size="sm" variant="primary" disabled={save.isPending || invalid}>
					{save.isPending ? 'Saving…' : 'Save caps'}
				</Btn>
				{invalid ? <span className="text-[12px] text-(--danger-text)">Use a dollar amount, or leave it empty for no cap.</span> : null}
				<SaveState pending={save.isPending} success={save.isSuccess} error={save.error} />
			</div>
		</form>
	);
}

/** Today against the daily cap, warning from 80 percent. */
function Meters({ usage, limits }: { usage: UsageView; limits: Limits }) {
	const cap = limits.dailyUsd;
	const pct = cap ? (usage.today / cap) * 100 : 0;
	const month = new Date(usage.since).toLocaleDateString([], { month: 'long' });
	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-col gap-1.5">
				<div className="flex items-center gap-2">
					<div className="min-w-0 flex-1 text-[13px]">Today</div>
					<div className="text-[12px] text-(--text-tertiary) tabular-nums">
						{dollars(usage.today)}
						{cap !== null ? ` of $${cap}` : ''}
					</div>
				</div>
				{cap !== null ? <ProgressBar label="Today's spend against the daily cap" value={pct} tone={pct >= 100 ? 'danger' : pct >= 80 ? 'warning' : 'accent'} /> : null}
				<div className="text-[12px] text-pretty text-(--text-disabled)">
					{cap === null ? 'No daily cap is set.' : pct >= 100 ? 'The cap is reached: new messages wait until tomorrow or a higher cap.' : 'Resets at midnight, server time.'}
				</div>
			</div>
			<div className="flex items-center gap-2">
				<div className="min-w-0 flex-1 text-[13px]">Since {month} 1</div>
				<div className="text-[12px] text-(--text-tertiary) tabular-nums">{dollars(usage.month)}</div>
			</div>
		</div>
	);
}

function SpendRows({ rows, label, empty }: { rows: SpendRow[]; label: (key: string | null) => string; empty: string }) {
	if (rows.length === 0) return <p className="m-0 text-[12px] text-(--text-tertiary)">{empty}</p>;
	return (
		<div className="flex flex-col gap-0.5">
			{rows.map((row) => (
				<div key={row.key ?? ''} className="flex min-h-9 items-center gap-3 rounded-lg bg-(--bg-surface) px-3">
					<div className="min-w-0 flex-1 truncate text-[12px]">{label(row.key)}</div>
					<div className="text-[12px] whitespace-nowrap text-(--text-disabled)">{tokens(row.tokens)} tokens</div>
					<div className="w-[64px] text-right text-[12px] whitespace-nowrap tabular-nums">{dollars(row.cost)}</div>
				</div>
			))}
		</div>
	);
}

/** What Anton has spent on models, where it went, and the caps that stop it. */
export function UsagePage() {
	const budget = useQuery({ queryKey: ['budget'], queryFn: () => api.budget() });
	const usage = useQuery({ queryKey: ['usage'], queryFn: api.usage });
	const models = useModels();
	const modelName = (id: string | null) =>
		id === null ? 'Not recorded' : (models.data?.models.find((model) => model.id === id)?.name ?? id.replace(/^openrouter\//, ''));
	return (
		<>
			<PageHeading title="Usage and limits">
				Model spend from OpenRouter's listed prices, including its cache prices, so the real bill may differ slightly. Sandbox and storage costs are
				billed by Modal and Tigris and are not counted here.
			</PageHeading>
			{usage.data && budget.data ? <Meters usage={usage.data} limits={budget.data.limits} /> : <Spinner size={12} />}
			<Block
				title="Spending caps"
				help="Once a cap is reached, Anton stops the reply that crossed it and takes no new messages until the next day or until you raise it. Automations start nothing while today's cap is reached."
			>
				{budget.data ? <Caps limits={budget.data.limits} /> : <Spinner size={12} />}
			</Block>
			{usage.data ? (
				<>
					<Block title="This month by repository">
						<SpendRows rows={usage.data.byRepo} label={(key) => key ?? 'Removed repository'} empty="Nothing spent this month." />
					</Block>
					<Block title="This month by model" help="Each response counts against the model its task was set to.">
						<SpendRows rows={usage.data.byModel} label={modelName} empty="Nothing spent this month." />
					</Block>
				</>
			) : null}
		</>
	);
}

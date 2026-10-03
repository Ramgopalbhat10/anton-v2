import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Btn, Spinner } from '@/components/signal';
import { api, type Limits } from '@/lib/api';
import { dollars } from '@/lib/format';
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

/** What Anton has spent on models and the caps that stop it. */
export function UsagePage() {
	const budget = useQuery({ queryKey: ['budget'], queryFn: () => api.budget() });
	return (
		<>
			<PageHeading title="Usage and limits">
				Model spend from OpenRouter's listed prices, including its cache prices, so the real bill may differ slightly.
				{budget.data ? ` Spent today: ${dollars(budget.data.today)}.` : ''}
			</PageHeading>
			<Block
				title="Spending caps"
				help="Once a cap is reached, Anton stops the reply that crossed it and takes no new messages until the next day or until you raise it. Automations start nothing while today's cap is reached."
			>
				{budget.data ? <Caps limits={budget.data.limits} /> : <Spinner size={12} />}
			</Block>
		</>
	);
}

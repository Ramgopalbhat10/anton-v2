import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { HardDrive, Plus, Trash2 } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { MenuButton } from '@/components/nav';
import { Btn, Icon, IconBtn, SectionLabel, Spinner } from '@/components/signal';
import { api, type Command, type Limits } from '@/lib/api';
import { age, dollars } from '@/lib/format';

const FIELD =
	'h-8 w-[120px] rounded-lg bg-(--bg-surface) px-2.5 text-[13px] text-(--text-primary) outline-none placeholder:text-(--text-disabled) focus-visible:shadow-(--focus-ring)';

function Section({ title, help, children }: { title: string; help: ReactNode; children: ReactNode }) {
	return (
		<section className="flex flex-col gap-2">
			<SectionLabel>{title}</SectionLabel>
			<p className="m-0 text-[12px] leading-[18px] text-pretty text-(--text-tertiary)">{help}</p>
			{children}
		</section>
	);
}

const toInput = (value: number | null) => (value === null ? '' : String(value));
const fromInput = (value: string) => (value.trim() === '' ? null : Math.max(0, Number(value)));

function size(bytes: number): string {
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
	if (bytes < 1024 ** 3) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
	return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

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
					<input inputMode="decimal" value={daily} onChange={(event) => setDaily(event.target.value)} placeholder="No cap" className={FIELD} />
				</label>
				<label className="flex flex-col gap-1 text-[12px] text-(--text-secondary)">
					Per task
					<input inputMode="decimal" value={task} onChange={(event) => setTask(event.target.value)} placeholder="No cap" className={FIELD} />
				</label>
			</div>
			<div className="flex items-center gap-3">
				<Btn type="submit" size="sm" variant="primary" disabled={save.isPending || invalid}>
					{save.isPending ? 'Saving…' : 'Save caps'}
				</Btn>
				{invalid ? <span className="text-[12px] text-(--danger-text)">Use a dollar amount, or leave it empty for no cap.</span> : null}
				{save.isSuccess && !save.isPending ? <span className="text-[12px] text-(--success-text)">Saved.</span> : null}
				{save.isError ? <span className="text-[12px] text-(--danger-text)">{save.error.message}</span> : null}
			</div>
		</form>
	);
}

function Storage() {
	const queryClient = useQueryClient();
	const storage = useQuery({ queryKey: ['storage'], queryFn: api.storage });
	const clean = useMutation({ mutationFn: api.cleanUpStorage, onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['storage'] }) });
	if (storage.isPending) return <Spinner size={12} />;
	if (storage.isError) return <p className="m-0 text-[12px] text-(--danger-text)">{storage.error.message}</p>;
	const { objects, bytes, lastCleanup } = storage.data;
	return (
		<div className="flex flex-col gap-3">
			<div className="flex items-center gap-2 text-[13px] text-(--text-secondary)">
				<Icon icon={HardDrive} className="text-(--icon-tertiary)" />
				{size(bytes)} in {objects.toLocaleString()} objects
			</div>
			<div className="flex flex-wrap items-center gap-3">
				<Btn size="sm" icon={Trash2} disabled={clean.isPending} onClick={() => clean.mutate()}>
					{clean.isPending ? 'Cleaning up…' : 'Clean up now'}
				</Btn>
				<span className="text-[12px] text-(--text-tertiary)">
					{clean.data
						? `Removed ${clean.data.removed} objects, ${size(clean.data.freedBytes)}.`
						: lastCleanup
							? `Last run ${age(lastCleanup.at)} ago: removed ${lastCleanup.removed} objects, ${size(lastCleanup.freedBytes)}.`
							: 'Not run yet.'}
				</span>
				{clean.isError ? <span className="text-[12px] text-(--danger-text)">{clean.error.message}</span> : null}
			</div>
		</div>
	);
}

function Commands({ saved }: { saved: Command[] }) {
	const queryClient = useQueryClient();
	const [rows, setRows] = useState(saved);
	const save = useMutation({
		mutationFn: () => api.saveCommands(rows.filter((row) => row.name.trim() || row.prompt.trim())),
		onSuccess: (result) => {
			setRows(result.commands);
			queryClient.setQueryData(['commands'], result);
		},
	});
	const change = (index: number, patch: Partial<Command>) => setRows((current) => current.map((row, at) => (at === index ? { ...row, ...patch } : row)));
	return (
		<form
			className="flex flex-col gap-2"
			onSubmit={(event) => {
				event.preventDefault();
				save.mutate();
			}}
		>
			{rows.map((row, index) => (
				<div key={index} className="flex items-start gap-2">
					<input
						value={row.name}
						onChange={(event) => change(index, { name: event.target.value })}
						placeholder="review"
						aria-label="Command name"
						className={`${FIELD} shrink-0 font-mono`}
					/>
					<textarea
						value={row.prompt}
						onChange={(event) => change(index, { prompt: event.target.value })}
						rows={2}
						placeholder="Review the changes on this branch for bugs and missing tests."
						aria-label="Prompt"
						className="min-w-0 flex-1 resize-y rounded-lg bg-(--bg-surface) px-2.5 py-1.5 text-[13px] leading-[19px] text-(--text-primary) outline-none placeholder:text-(--text-disabled) focus-visible:shadow-(--focus-ring)"
					/>
					<IconBtn icon={Trash2} size="sm" label="Remove command" onClick={() => setRows((current) => current.filter((_, at) => at !== index))} />
				</div>
			))}
			<div className="flex items-center gap-3">
				<Btn size="sm" variant="ghost" icon={Plus} onClick={() => setRows((current) => [...current, { name: '', prompt: '' }])}>
					Add a command
				</Btn>
				<Btn type="submit" size="sm" variant="primary" disabled={save.isPending}>
					{save.isPending ? 'Saving…' : 'Save commands'}
				</Btn>
				{save.isSuccess && !save.isPending ? <span className="text-[12px] text-(--success-text)">Saved.</span> : null}
				{save.isError ? <span className="text-[12px] text-(--danger-text)">{save.error.message}</span> : null}
			</div>
		</form>
	);
}

/** App-wide settings: what Anton may spend, saved prompts, and what it keeps in storage. */
export function SettingsPage() {
	const budget = useQuery({ queryKey: ['budget'], queryFn: () => api.budget() });
	const commands = useQuery({ queryKey: ['commands'], queryFn: api.commands });
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<header className="flex h-11 shrink-0 items-center gap-1 border-b border-(--border-subtle) pr-4 pl-2 text-[13px] font-medium text-(--text-secondary) md:pl-4">
				<MenuButton />
				Settings
			</header>
			<div className="min-h-0 flex-1 overflow-y-auto px-4 pt-8 pb-12 md:px-6">
				<div className="mx-auto flex max-w-[660px] flex-col gap-8">
					<Section
						title="Spending caps"
						help={
							<>
								Once a cap is reached, Anton stops the reply that crossed it and takes no new messages until the next day or until you
								raise it. Costs come from OpenRouter's listed prices, so cached tokens may make the real bill a little lower.
								{budget.data ? ` Spent today: ${dollars(budget.data.today)}.` : ''}
							</>
						}
					>
						{budget.data ? <Caps limits={budget.data.limits} /> : <Spinner size={12} />}
					</Section>
					<Section
						title="Commands"
						help={
							<>
								Prompts you reuse. Type <code>/</code> and the name at the start of a message to fill it in. Type <code>@</code> in a task's
								message to point the agent at a file.
							</>
						}
					>
						{commands.data ? <Commands saved={commands.data.commands} /> : <Spinner size={12} />}
					</Section>
					<Section
						title="Storage"
						help="Checkpoints, diffs and Library files are kept in object storage. Cleanup runs once a day and removes deleted tasks, history beyond the newest 50 entries per task, and file contents nothing uses any more."
					>
						<Storage />
					</Section>
				</div>
			</div>
		</div>
	);
}

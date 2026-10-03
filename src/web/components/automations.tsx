import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleDot, Clock, Play, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { ModelPicker, useModels } from '@/components/model-picker';
import { Btn, Icon, IconBtn, Spinner, Switch } from '@/components/signal';
import { api, type Automation, type AutomationInput, type ModelChoice } from '@/lib/api';
import { age } from '@/lib/format';
import { cn } from '@/lib/utils';

const FIELD =
	'h-8 min-w-0 rounded-lg bg-(--bg-surface) px-2.5 text-[13px] text-(--text-primary) outline-none placeholder:text-(--text-disabled) focus-visible:shadow-(--focus-ring)';

const queryKey = (projectId: string) => ['automations', projectId];

function useRefresh(projectId: string) {
	const queryClient = useQueryClient();
	return () => {
		void queryClient.invalidateQueries({ queryKey: queryKey(projectId) });
		void queryClient.invalidateQueries({ queryKey: ['sessions'] });
	};
}

function summary(automation: Automation): string {
	return automation.kind === 'issues' ? `Open issues labeled “${automation.label}”` : `Every ${automation.everyHours} hours`;
}

function lastRun(automation: Automation): string {
	const picked = automation.kind === 'issues' ? ` · ${automation.seen.length} ${automation.seen.length === 1 ? 'issue' : 'issues'} picked up` : '';
	const ran = automation.lastRunAt && age(automation.lastRunAt);
	return `${ran ? `Last run ${ran === 'now' ? 'just now' : `${ran} ago`}` : 'Not run yet'}${picked}`;
}

function AutomationRow({ automation }: { automation: Automation }) {
	const refresh = useRefresh(automation.projectId);
	const toggle = useMutation({ mutationFn: (enabled: boolean) => api.setAutomationEnabled(automation.id, enabled), onSettled: refresh });
	const run = useMutation({ mutationFn: () => api.runAutomation(automation.id), onSettled: refresh });
	const remove = useMutation({ mutationFn: () => api.deleteAutomation(automation.id), onSettled: refresh });
	const error = automation.lastError ?? (run.error ?? toggle.error ?? remove.error)?.message;
	return (
		<div className="flex flex-col gap-1.5 rounded-lg bg-(--bg-surface) px-3 py-2.5">
			<div className="flex items-center gap-2">
				<Icon icon={automation.kind === 'issues' ? CircleDot : Clock} size={14} className="text-(--icon-tertiary)" />
				<span className={cn('min-w-0 flex-1 truncate text-[13px]', automation.enabled ? 'text-(--text-primary)' : 'text-(--text-tertiary)')}>
					{summary(automation)}
				</span>
				<Switch checked={automation.enabled} disabled={toggle.isPending} onChange={(enabled) => toggle.mutate(enabled)} label={<span className="sr-only">Enabled</span>} />
				<Btn size="xs" variant="ghost" icon={Play} disabled={run.isPending} onClick={() => run.mutate()}>
					{run.isPending ? 'Running…' : 'Run now'}
				</Btn>
				<IconBtn icon={Trash2} size="sm" label="Delete automation" disabled={remove.isPending} onClick={() => remove.mutate()} />
			</div>
			{automation.prompt ? <p className="m-0 line-clamp-2 text-[12px] leading-[18px] text-(--text-secondary)">{automation.prompt}</p> : null}
			<div className="text-[11px] text-(--text-disabled)">
				{lastRun(automation)}
				{automation.model ? ` · ${automation.model.replace(/^openrouter\//, '')}` : ''}
				{automation.planFirst ? ' · plans first' : ''}
			</div>
			{error ? <div className="text-[12px] text-(--danger-text)">{error}</div> : null}
		</div>
	);
}

function KindChoice({ value, onChange }: { value: Automation['kind']; onChange: (kind: Automation['kind']) => void }) {
	const option = (kind: Automation['kind'], label: string) => (
		<Btn size="sm" variant={value === kind ? 'secondary' : 'ghost'} aria-pressed={value === kind} onClick={() => onChange(kind)}>
			{label}
		</Btn>
	);
	return (
		<div className="flex gap-1">
			{option('issues', 'From labeled issues')}
			{option('schedule', 'On a schedule')}
		</div>
	);
}

function AddAutomation({ projectId, onDone }: { projectId: string; onDone: () => void }) {
	const refresh = useRefresh(projectId);
	const models = useModels();
	const [kind, setKind] = useState<Automation['kind']>('issues');
	const [label, setLabel] = useState('anton');
	const [hours, setHours] = useState('24');
	const [prompt, setPrompt] = useState('');
	const [choice, setChoice] = useState<ModelChoice | null>(null);
	const [planFirst, setPlanFirst] = useState(false);
	const model = choice ?? { model: models.data?.default ?? '', reasoning: null };
	const input: AutomationInput = {
		kind,
		label: kind === 'issues' ? label.trim() : null,
		everyHours: kind === 'schedule' ? Number(hours) : null,
		prompt,
		model: choice?.model ?? null,
		reasoning: choice?.reasoning ?? null,
		planFirst,
	};
	const ready = kind === 'issues' ? Boolean(input.label) : Number.isInteger(input.everyHours) && (input.everyHours ?? 0) >= 1 && prompt.trim() !== '';
	const add = useMutation({
		mutationFn: () => api.addAutomation(projectId, input),
		onSuccess: () => {
			refresh();
			onDone();
		},
	});
	return (
		<form
			className="flex flex-col gap-2.5 rounded-lg border border-(--border-subtle) p-3"
			onSubmit={(event) => {
				event.preventDefault();
				if (ready) add.mutate();
			}}
		>
			<KindChoice value={kind} onChange={setKind} />
			{kind === 'issues' ? (
				<label className="flex items-center gap-2 text-[12px] text-(--text-secondary)">
					Label
					<input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="anton" className={`${FIELD} w-[180px]`} />
				</label>
			) : (
				<label className="flex items-center gap-2 text-[12px] text-(--text-secondary)">
					Every
					<input inputMode="numeric" value={hours} onChange={(event) => setHours(event.target.value)} className={`${FIELD} w-[64px]`} />
					hours
				</label>
			)}
			<textarea
				value={prompt}
				onChange={(event) => setPrompt(event.target.value)}
				rows={3}
				placeholder={kind === 'issues' ? 'Extra instructions for every issue (optional)' : 'What the agent should do each time'}
				className="w-full resize-y rounded-lg bg-(--bg-surface) px-2.5 py-2 text-[13px] leading-[19px] text-(--text-primary) outline-none placeholder:text-(--text-disabled) focus-visible:shadow-(--focus-ring)"
			/>
			<Switch
				checked={planFirst}
				onChange={setPlanFirst}
				label={<span className="text-[12px] text-(--text-secondary)">Plan first, and wait for my approval before changing code</span>}
			/>
			<div className="flex flex-wrap items-center gap-2">
				<ModelPicker value={model} side="bottom" onChange={(change) => setChoice({ ...model, reasoning: null, ...change })} />
				<span className="flex-1" />
				<Btn size="sm" variant="ghost" onClick={onDone}>
					Cancel
				</Btn>
				<Btn type="submit" size="sm" variant="primary" disabled={!ready || add.isPending}>
					{add.isPending ? 'Adding…' : 'Add automation'}
				</Btn>
			</div>
			{add.isError ? <div className="text-[12px] text-(--danger-text)">{add.error.message}</div> : null}
		</form>
	);
}

/** Tasks this repo starts on its own. Each change saves at once, apart from the settings form. */
export function Automations({ projectId }: { projectId: string }) {
	const [adding, setAdding] = useState(false);
	const list = useQuery({ queryKey: queryKey(projectId), queryFn: () => api.automations(projectId), refetchInterval: 60_000 });
	if (list.isPending) return <Spinner size={12} />;
	if (list.isError) return <p className="m-0 text-[12px] text-(--danger-text)">{list.error.message}</p>;
	return (
		<div className="flex flex-col gap-2">
			{list.data.automations.map((automation) => (
				<AutomationRow key={automation.id} automation={automation} />
			))}
			{adding ? (
				<AddAutomation projectId={projectId} onDone={() => setAdding(false)} />
			) : (
				<Btn size="sm" variant="ghost" icon={Plus} className="self-start" onClick={() => setAdding(true)}>
					Add an automation
				</Btn>
			)}
		</div>
	);
}

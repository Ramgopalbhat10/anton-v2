import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleDot, Clock, Pencil, Play, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { ModelPicker, useModels } from '@/components/model-picker';
import { nextRunText, ScheduleEditor, whenItRuns } from '@/components/schedule-editor';
import { Btn, Icon, IconBtn, Spinner, Switch } from '@/components/signal';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { api, type Automation, type AutomationInput, type ModelChoice, SAFETY_NET_MS } from '@/lib/api';
import { age } from '@/lib/format';
import { cn } from '@/lib/utils';
import { defaultSchedule, type Schedule, scheduleProblem } from '../../core/schedule';

const queryKey = (projectId: string) => ['automations', projectId];

function useRefresh(projectId: string) {
	const queryClient = useQueryClient();
	return () => {
		void queryClient.invalidateQueries({ queryKey: queryKey(projectId) });
		void queryClient.invalidateQueries({ queryKey: ['sessions'] });
	};
}

function summary(automation: Automation): string {
	return automation.kind === 'issues' ? `Open issues labeled “${automation.label}”` : whenItRuns(automation);
}

function lastRun(automation: Automation): string {
	const picked = automation.kind === 'issues' ? ` · ${automation.seen.length} ${automation.seen.length === 1 ? 'issue' : 'issues'} picked up` : '';
	const ran = automation.lastRunAt && age(automation.lastRunAt);
	const next = automation.enabled && automation.schedule ? ` · ${nextRunText(automation)}` : '';
	return `${ran ? `Last run ${ran === 'now' ? 'just now' : `${ran} ago`}` : 'Not run yet'}${picked}${next}`;
}

function AutomationRow({ automation }: { automation: Automation }) {
	const refresh = useRefresh(automation.projectId);
	const toggle = useMutation({ mutationFn: (enabled: boolean) => api.setAutomationEnabled(automation.id, enabled), onSettled: refresh });
	const run = useMutation({ mutationFn: () => api.runAutomation(automation.id), onSettled: refresh });
	const remove = useMutation({ mutationFn: () => api.deleteAutomation(automation.id), onSettled: refresh });
	const [editing, setEditing] = useState(false);
	const error = automation.lastError ?? (run.error ?? toggle.error ?? remove.error)?.message;
	if (editing) return <AutomationForm projectId={automation.projectId} automation={automation} onDone={() => setEditing(false)} />;
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
				<IconBtn icon={Pencil} size="sm" label="Edit automation" onClick={() => setEditing(true)} />
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
	return (
		<ToggleGroup type="single" size="sm" aria-label="Starts" value={value} onValueChange={(next) => next && onChange(next as Automation['kind'])}>
			<ToggleGroupItem value="issues" className="text-[12px]">
				From labeled issues
			</ToggleGroupItem>
			<ToggleGroupItem value="schedule" className="text-[12px]">
				On a schedule
			</ToggleGroupItem>
		</ToggleGroup>
	);
}

/** An automation's settings: a new one, or with `automation` the one being changed. */
function AutomationForm({ projectId, automation, onDone }: { projectId: string; automation?: Automation; onDone: () => void }) {
	const refresh = useRefresh(projectId);
	const models = useModels();
	const [kind, setKind] = useState<Automation['kind']>(automation?.kind ?? 'issues');
	const [label, setLabel] = useState(automation?.label ?? 'anton');
	const [schedule, setSchedule] = useState<Schedule>(automation?.schedule ?? defaultSchedule());
	const [prompt, setPrompt] = useState(automation?.prompt ?? '');
	const [choice, setChoice] = useState<ModelChoice | null>(automation?.model ? { model: automation.model, reasoning: automation.reasoning } : null);
	const [planFirst, setPlanFirst] = useState(automation?.planFirst ?? false);
	const model = choice ?? { model: models.data?.default ?? '', reasoning: null };
	const input: AutomationInput = {
		kind,
		label: kind === 'issues' ? label.trim() : null,
		schedule: kind === 'schedule' ? schedule : null,
		prompt,
		model: choice?.model ?? null,
		reasoning: choice?.reasoning ?? null,
		planFirst,
	};
	const ready = kind === 'issues' ? Boolean(input.label) : !scheduleProblem(schedule) && prompt.trim() !== '';
	const add = useMutation({
		mutationFn: () => (automation ? api.editAutomation(automation.id, input) : api.addAutomation(projectId, input)),
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
					<Input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="anton" className="w-[180px] text-[13px] md:text-[13px]" />
				</label>
			) : (
				<ScheduleEditor value={schedule} onChange={setSchedule} />
			)}
			<Textarea
				aria-label="Instructions"
				value={prompt}
				onChange={(event) => setPrompt(event.target.value)}
				rows={3}
				placeholder={kind === 'issues' ? 'Extra instructions for every issue (optional)' : 'What the agent should do each time'}
				className="resize-y text-[13px] leading-[19px] md:text-[13px]"
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
					{automation ? (add.isPending ? 'Saving…' : 'Save automation') : add.isPending ? 'Adding…' : 'Add automation'}
				</Btn>
			</div>
			{add.isError ? <div className="text-[12px] text-(--danger-text)">{add.error.message}</div> : null}
		</form>
	);
}

/** Tasks this repo starts on its own. Each change saves at once, apart from the settings form. */
export function Automations({ projectId }: { projectId: string }) {
	const [adding, setAdding] = useState(false);
	const list = useQuery({ queryKey: queryKey(projectId), queryFn: () => api.automations(projectId), refetchInterval: SAFETY_NET_MS });
	if (list.isPending) return <Spinner size={12} />;
	if (list.isError) return <p className="m-0 text-[12px] text-(--danger-text)">{list.error.message}</p>;
	return (
		<div className="flex flex-col gap-2">
			{list.data.automations.map((automation) => (
				<AutomationRow key={automation.id} automation={automation} />
			))}
			{adding ? (
				<AutomationForm projectId={projectId} onDone={() => setAdding(false)} />
			) : (
				<Btn size="sm" variant="ghost" icon={Plus} className="self-start" onClick={() => setAdding(true)}>
					Add an automation
				</Btn>
			)}
		</div>
	);
}

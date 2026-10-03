import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Clock, Cpu, Globe, Timer } from 'lucide-react';
import { useState } from 'react';
import { Btn, Spinner } from '@/components/signal';
import { api, type SandboxSettings, type SandboxView } from '@/lib/api';
import { Block, PageHeading, SaveState, Select } from './parts';

const MACHINES = [
	{ cpu: 1, memoryMiB: 2048 },
	{ cpu: 2, memoryMiB: 4096 },
	{ cpu: 4, memoryMiB: 8192 },
	{ cpu: 8, memoryMiB: 16384 },
].map((machine) => ({ value: `${machine.cpu}x${machine.memoryMiB}`, label: `${machine.cpu} vCPU · ${machine.memoryMiB / 1024} GB`, ...machine }));

const REGIONS: Array<{ value: SandboxSettings['region']; label: string }> = [
	{ value: null, label: 'Any region' },
	{ value: 'us', label: 'United States' },
	{ value: 'eu', label: 'Europe' },
	{ value: 'ap', label: 'Asia–Pacific' },
];

const IDLE = [5, 15, 30, 60].map((minutes) => ({ value: minutes, label: `${minutes} minutes` }));
const LIFETIME = [1, 4, 12, 24].map((hours) => ({ value: hours, label: hours === 1 ? '1 hour' : `${hours} hours` }));

const parseDomains = (text: string) => [...new Set(text.split(/[\s,]+/).map((line) => line.trim().toLowerCase()).filter(Boolean))];

/** Saves only this page's fields over what the server has, so the Images page's are kept. */
function Form({ view }: { view: SandboxView }) {
	const queryClient = useQueryClient();
	const [draft, setDraft] = useState(view.settings);
	const [domains, setDomains] = useState(view.settings.allowedDomains.join('\n'));
	const change = (patch: Partial<SandboxSettings>) => setDraft((current) => ({ ...current, ...patch }));
	const save = useMutation({
		mutationFn: async () => {
			const latest = (await api.sandboxSettings()).settings;
			const { cpu, memoryMiB, region, idleMinutes, lifetimeHours } = draft;
			return api.saveSandboxSettings({ ...latest, cpu, memoryMiB, region, idleMinutes, lifetimeHours, allowedDomains: parseDomains(domains) });
		},
		onSuccess: (saved) => queryClient.setQueryData(['sandbox-settings'], saved),
	});
	return (
		<form
			className="flex flex-col gap-6"
			onSubmit={(event) => {
				event.preventDefault();
				save.mutate();
			}}
		>
			<div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-4">
				<Select
					label="Machine size"
					icon={Cpu}
					value={`${draft.cpu}x${draft.memoryMiB}`}
					options={MACHINES}
					fallback={`${draft.cpu} vCPU · ${draft.memoryMiB / 1024} GB`}
					onChange={(value) => {
						const machine = MACHINES.find((option) => option.value === value);
						if (machine) change({ cpu: machine.cpu, memoryMiB: machine.memoryMiB });
					}}
					help="Reserved for each sandbox. Bigger machines install and test faster and cost more."
				/>
				<Select
					label="Region"
					icon={Globe}
					value={draft.region}
					options={REGIONS}
					onChange={(region) => change({ region })}
					help="Pinning a region costs about 15 percent more on Modal."
				/>
				<Select
					label="Idle shutdown"
					icon={Clock}
					value={draft.idleMinutes}
					options={IDLE}
					fallback={`${draft.idleMinutes} minutes`}
					onChange={(idleMinutes) => change({ idleMinutes })}
					help="A sandbox with nothing running stops after this long. Its files are kept."
				/>
				<Select
					label="Maximum lifetime"
					icon={Timer}
					value={draft.lifetimeHours}
					options={LIFETIME}
					fallback={`${draft.lifetimeHours} hours`}
					onChange={(lifetimeHours) => change({ lifetimeHours })}
					help="Stopped this long after it starts, even while working. The branch and files are kept."
				/>
			</div>
			<Block
				title="Allowed domains"
				help="One per line, *.example.com for subdomains. When set, sandboxes can reach only these and GitHub, which setup needs. Leave it empty to allow everything. Web search runs on Anton's side and is not affected."
			>
				<textarea
					value={domains}
					onChange={(event) => setDomains(event.target.value)}
					rows={5}
					spellCheck={false}
					placeholder={'registry.npmjs.org\npypi.org\nfiles.pythonhosted.org'}
					aria-label="Allowed domains"
					className="w-full resize-y rounded-lg bg-(--bg-surface) px-2.5 py-2 font-mono text-[12px] leading-[18px] text-(--text-primary) outline-none placeholder:text-(--text-disabled) focus-visible:shadow-(--focus-ring)"
				/>
			</Block>
			<div className="flex items-center gap-3">
				<Btn type="submit" variant="primary" disabled={save.isPending}>
					{save.isPending ? 'Saving…' : 'Save changes'}
				</Btn>
				<SaveState pending={save.isPending} success={save.isSuccess} error={save.error} saved="Saved. Sandboxes that start from now on use these." />
			</div>
		</form>
	);
}

export function SandboxesPage() {
	const view = useQuery({ queryKey: ['sandbox-settings'], queryFn: api.sandboxSettings });
	return (
		<>
			<PageHeading title="Sandboxes">
				Each task that edits or runs code gets its own sandbox. These apply when one starts; a running sandbox keeps what it started with until it
				stops.
				{view.data && view.data.provider !== 'modal' ? ' Sandboxes run on this server right now, which ignores these settings.' : ''}
			</PageHeading>
			{view.data ? <Form view={view.data} /> : <Spinner size={12} />}
		</>
	);
}

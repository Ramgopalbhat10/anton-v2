import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Layers, Package, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { Status } from '@/components/instrument';
import { Btn, Spinner } from '@/components/signal';
import { api, type Project, type SandboxView } from '@/lib/api';
import { age } from '@/lib/format';
import { useProjects } from '@/lib/projects';
import { Block, FIELD, List, PageHeading, RowIcon, SaveState, Select, SubBlock } from './parts';

const MAX_AGE = [1, 3, 7, 14, 30].map((days) => ({ value: days, label: days === 1 ? '1 day' : `${days} days` }));

function Defaults({ view }: { view: SandboxView }) {
	const queryClient = useQueryClient();
	const [baseImage, setBaseImage] = useState(view.settings.baseImage ?? '');
	const [warmImageDays, setWarmImageDays] = useState(view.settings.warmImageDays);
	const save = useMutation({
		mutationFn: async () => {
			const latest = (await api.sandboxSettings()).settings;
			return api.saveSandboxSettings({ ...latest, baseImage: baseImage.trim() || null, warmImageDays });
		},
		onSuccess: (saved) => {
			queryClient.setQueryData(['sandbox-settings'], saved);
			void queryClient.invalidateQueries({ queryKey: ['projects'] });
		},
	});
	return (
		<form
			onSubmit={(event) => {
				event.preventDefault();
				save.mutate();
			}}
		>
			<Block
				title="Default base image"
				icon={Layers}
				help="A container image from a registry."
				info="Anton adds git, ripgrep, Python and a browser for screenshots on top. A repository can set its own. Changing it rebuilds the prepared images of repositories that use the default."
				footer={
					<>
						<SaveState pending={save.isPending} success={save.isSuccess} error={save.error} />
						<Btn type="submit" size="sm" variant="primary" disabled={save.isPending}>
							{save.isPending ? 'Saving…' : 'Save changes'}
						</Btn>
					</>
				}
			>
				<input value={baseImage} onChange={(event) => setBaseImage(event.target.value)} placeholder={view.defaultBaseImage} aria-label="Default base image" className={`${FIELD} max-w-[420px] font-mono`} />
				<SubBlock>
					<div className="max-w-[260px] pb-1">
						<Select
							label="Rebuild prepared images after"
							icon={RefreshCw}
							value={warmImageDays}
							options={MAX_AGE}
							fallback={`${warmImageDays} days`}
							onChange={setWarmImageDays}
							info="An older one is rebuilt in the background, so new dependencies are picked up. A changed lockfile rebuilds it sooner."
						/>
					</div>
				</SubBlock>
			</Block>
		</form>
	);
}

function Prepared({ project, view }: { project: Project; view: SandboxView }) {
	const queryClient = useQueryClient();
	const rebuild = useMutation({
		mutationFn: () => api.rebuildPreparedImage(project.id),
		onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['projects'] }),
	});
	const base = project.baseImage ?? view.settings.baseImage ?? view.defaultBaseImage;
	return (
		<div className="flex min-h-12 items-center gap-3 rounded-lg px-2.5 py-1.5">
			<RowIcon icon={Package} />
			<div className="flex min-w-0 flex-1 flex-col gap-0.5">
				<Link to="/settings/repos/$projectId" params={{ projectId: project.id }} className="truncate text-[13px] font-medium outline-none hover:underline">
					{project.repoFullName}
				</Link>
				<div className="truncate text-[12px] text-(--text-tertiary)">
					{project.warmedAt ? `Built ${age(project.warmedAt)} ago from ${base}` : `None yet. One is built in the background from ${base}.`}
				</div>
			</div>
			<Btn size="sm" disabled={rebuild.isPending} onClick={() => rebuild.mutate()}>
				{rebuild.isPending ? 'Starting…' : project.warmedAt ? 'Rebuild' : 'Build'}
			</Btn>
		</div>
	);
}

/** The image sandboxes start from, and each repository's prepared image on top of it. */
export function ImagesPage() {
	const view = useQuery({ queryKey: ['sandbox-settings'], queryFn: api.sandboxSettings });
	const projects = useProjects();
	return (
		<>
			<PageHeading
				title="Images"
				info="A prepared image is the repo cloned, dependencies installed and the setup script run. It is built in a sandbox of its own when the repo is added, so no task waits for it. Without one, setup runs from the base image."
			>
				New tasks start from their repository's prepared image.
			</PageHeading>
			{view.data ? <Defaults view={view.data} /> : <Spinner size={12} />}
			{view.data && projects.data ? (
				<Block
					title="Prepared images"
					icon={Package}
					aside={<Status>{`${projects.data.projects.filter((project) => project.warmedAt).length} of ${projects.data.projects.length} built`}</Status>}
					info="Rebuild drops one and builds a fresh one from scratch in the background. Tasks set up from the base image until it is ready."
				>
					<List>
						{projects.data.projects.map((project) => (
							<Prepared key={project.id} project={project} view={view.data} />
						))}
					</List>
				</Block>
			) : null}
		</>
	);
}

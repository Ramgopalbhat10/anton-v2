import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { ArrowUpRight, CheckSquare, ChevronLeft, Download, ExternalLink, FolderUp, MoreVertical, Sparkles, Trash2, Upload } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { CopyButton } from '@/components/code-block';
import { frameUrl } from '@/components/html-frame';
import { LibraryArt } from '@/components/illustrations';
import { Segmented, SegmentedItem } from '@/components/instrument';
import { kindOf } from '@/components/library-tab';
import { MenuButton } from '@/components/nav';
import { DeletedArtifact, OutputPreview, OutputThumb } from '@/components/output-viewer';
import { PageFrame } from '@/components/page-frame';
import { Btn, EmptyState, Icon, IconBtn, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, SearchField, Spinner } from '@/components/signal';
import { ADDED_FILES, api, type Artifact, outputUrl, SAFETY_NET_MS } from '@/lib/api';
import { CATEGORIES, type Category, categoryInfo, categoryOf, extensionOf, isMarkdown, isText, nameOf, zipFolder } from '@/lib/artifacts';
import { useDeletedOutput } from '@/lib/deleted-outputs';
import { age } from '@/lib/format';
import { cn } from '@/lib/utils';

/*
 * Everything the agent made, in every task: apps (the pages it drew, which
 * keep their state wherever they are open) and files, as cards with what each
 * looks like. A card opens the artifact here, full size, with its source.
 */

export type ArtifactsSearch = { type?: Category; q?: string };

const artifactKey = (artifact: Pick<Artifact, 'sessionId' | 'path'>) => JSON.stringify([artifact.sessionId, artifact.path]);

const when = (artifact: Artifact) => age(new Date(artifact.mtimeMs).toISOString());

/** Where the task an artifact came from is: a project's thread opens inside its project. A file you added is from none. */
function TaskLink({ artifact, className, children }: { artifact: Artifact; className?: string; children: ReactNode }) {
	if (artifact.added) return <span className={className}>{children}</span>;
	return artifact.task.spaceId ? (
		<Link to="/projects/$spaceId/threads/$threadId" params={{ spaceId: artifact.task.spaceId, threadId: artifact.sessionId }} className={className}>
			{children}
		</Link>
	) : (
		<Link to="/agents/$sessionId" params={{ sessionId: artifact.sessionId }} search={{ app: 'code' }} className={className}>
			{children}
		</Link>
	);
}

function download(artifact: Artifact) {
	const link = document.createElement('a');
	link.href = outputUrl(artifact.sessionId, artifact.path);
	link.download = nameOf(artifact.path);
	link.click();
}

/**
 * Deletes an artifact from its task's Library. It leaves this page at once;
 * a reply that showed it says it was deleted (src/web/lib/deleted-outputs.ts).
 */
function useDeleteArtifact(artifact: Artifact, onDeleted?: () => void) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: () => api.deleteOutput(artifact.sessionId, artifact.path),
		onSuccess: () => {
			queryClient.setQueryData<{ artifacts: Artifact[] }>(['artifacts'], (current) =>
				current ? { artifacts: current.artifacts.filter((other) => !(other.sessionId === artifact.sessionId && other.path === artifact.path)) } : current,
			);
			void queryClient.invalidateQueries({ queryKey: ['artifacts'] });
			void queryClient.invalidateQueries({ queryKey: ['outputs', artifact.sessionId] });
			onDeleted?.();
		},
	});
}

/** Mount heavy previews only near the viewport; scrolling away releases them again. */
function useNearViewport<T extends Element>(): [React.RefObject<T | null>, boolean] {
	const ref = useRef<T>(null);
	const [near, setNear] = useState(false);
	useEffect(() => {
		const element = ref.current;
		if (!element || typeof IntersectionObserver === 'undefined') return;
		const observer = new IntersectionObserver(([entry]) => setNear(entry.isIntersecting), { rootMargin: '200px' });
		observer.observe(element);
		return () => observer.disconnect();
	}, []);
	return [ref, near];
}

/** The first lines of a text file, faded out at the card's edge. */
function Snippet({ artifact }: { artifact: Artifact }) {
	const text = useQuery({
		queryKey: ['artifact-snippet', artifact.sessionId, artifact.path],
		queryFn: async () => (await api.outputText(artifact.sessionId, artifact.path)).slice(0, 1200),
		staleTime: 60_000,
		gcTime: 0,
	});
	return (
		<pre className="m-0 h-full overflow-hidden px-3.5 pt-3 font-mono text-nano leading-[14px] whitespace-pre-wrap wrap-anywhere text-(--text-tertiary) [mask-image:linear-gradient(180deg,#000_55%,transparent)]">
			{(text.data ?? '').slice(0, 1200)}
		</pre>
	);
}

/** Apps never execute in the gallery. Only opening one mounts its live frame. */
function Thumb({ artifact }: { artifact: Artifact }) {
	const [ref, near] = useNearViewport<HTMLDivElement>();
	const category = categoryOf(artifact.path);
	const info = categoryInfo(category);
	let body: ReactNode = (
		<span className="flex h-full flex-col items-center justify-center gap-2">
			<Icon icon={info.icon} size={22} className={info.tone} />
			<span className="text-nano tracking-[0.08em] text-(--text-tertiary)">{extensionOf(artifact.path)}</span>
			{category === 'app' ? <span className="text-micro text-(--text-tertiary)">Open to run app</span> : null}
		</span>
	);
	// Large originals stay in the detail view; CSS resizing would still decode the full image here.
	if (near && kindOf(artifact.path) === 'image' && artifact.size <= 2 * 1024 * 1024)
		body = <span className="absolute inset-0"><OutputThumb item={artifact} /></span>;
	else if (near && category !== 'app' && isText(artifact.path) && artifact.size < 256 * 1024) body = <Snippet artifact={artifact} />;
	return (
		<div ref={ref} className="relative aspect-[16/10] overflow-hidden border-b border-(--border-subtle) bg-(--bg-inset)">
			{body}
		</div>
	);
}

/** The skill a file you added was installed as, if it was. */
function useInstalledFrom(artifact: Artifact, enabled: boolean) {
	const plugins = useQuery({ queryKey: ['plugins'], queryFn: api.plugins, enabled, staleTime: 30_000 });
	return plugins.data?.plugins.find((plugin) => plugin.source.repo === ADDED_FILES && plugin.source.path === artifact.path) ?? null;
}

/**
 * Installs a Markdown file you added as a skill, or a skill's folder zipped with its scripts, or updates the
 * skill it was installed as. Its name comes from the SKILL.md's front matter, so any file name will do. The menu stays open to say how it went.
 */
function InstallSkillItem({ artifact, open }: { artifact: Artifact; open: boolean }) {
	const queryClient = useQueryClient();
	const known = useInstalledFrom(artifact, open);
	const install = useMutation({
		mutationFn: () => api.installAddedSkill(artifact.path),
		onSuccess: (result) => queryClient.setQueryData<{ plugins: unknown[]; marketplaces: string[] }>(['plugins'], (current) => (current ? { ...current, plugins: result.plugins } : current)),
	});
	const installedAs = install.data?.plugins.find((plugin) => plugin.source.repo === ADDED_FILES && plugin.source.path === artifact.path) ?? known;
	return (
		<>
			<MenuItem
				icon={Sparkles}
				disabled={install.isPending}
				onSelect={(event) => {
					event.preventDefault();
					install.mutate();
				}}
			>
				{install.isPending ? 'Installing…' : installedAs ? 'Update the skill' : 'Install as skill'}
			</MenuItem>
			{install.isSuccess || install.isError || installedAs ? (
				<div className={cn('max-w-[240px] px-2 pb-1 text-micro leading-[15px] text-pretty', install.isError ? 'text-(--danger-text)' : 'text-(--text-tertiary)')}>
					{install.isError ? (
						install.error.message
					) : (
						<>
							Installed as <span className="font-sans">{installedAs?.skills[0]?.name ?? installedAs?.name}</span>, in{' '}
							<Link to="/settings/$section" params={{ section: 'skills' }} className="underline underline-offset-2">
								Settings › Skills
							</Link>
							.
						</>
					)}
				</div>
			) : null}
		</>
	);
}

/** Opening it elsewhere, saving it, going to the task it came from, or deleting it. Delete asks twice inside the menu. */
function ArtifactMenu({ artifact }: { artifact: Artifact }) {
	const navigate = useNavigate();
	const app = categoryOf(artifact.path) === 'app';
	const [confirming, setConfirming] = useState(false);
	const [open, setOpen] = useState(false);
	const remove = useDeleteArtifact(artifact);
	return (
		<Menu
			onOpenChange={(next) => {
				setOpen(next);
				if (!next) setConfirming(false);
			}}
		>
			<MenuTrigger asChild>
				<IconBtn icon={MoreVertical} size="xs" label={`Actions for ${artifact.title}`} className="shrink-0" />
			</MenuTrigger>
			<MenuContent align="end" sideOffset={4}>
				{app ? (
					<MenuItem icon={ExternalLink} onSelect={() => window.open(frameUrl(artifact.sessionId, artifact.path), '_blank', 'noopener')}>
						Open in a new tab
					</MenuItem>
				) : null}
				<MenuItem icon={Download} onSelect={() => download(artifact)}>
					Download
				</MenuItem>
				{artifact.added ? null : (
					<MenuItem
						icon={ArrowUpRight}
						onSelect={() =>
							artifact.task.spaceId
								? void navigate({ to: '/projects/$spaceId/threads/$threadId', params: { spaceId: artifact.task.spaceId, threadId: artifact.sessionId } })
								: void navigate({ to: '/agents/$sessionId', params: { sessionId: artifact.sessionId }, search: { app: 'code' } })
						}
					>
						Go to the task
					</MenuItem>
				)}
				{artifact.added && (isMarkdown(artifact.path) || /\.zip$/i.test(artifact.path)) ? <InstallSkillItem artifact={artifact} open={open} /> : null}
				<MenuSeparator />
				<MenuItem
					icon={Trash2}
					className="sg-menu-item--destructive"
					disabled={remove.isPending}
					onSelect={(event) => {
						event.preventDefault();
						if (!confirming) return setConfirming(true);
						remove.mutate();
					}}
				>
					{remove.isPending ? 'Deleting…' : confirming ? 'Click again to delete' : 'Delete'}
				</MenuItem>
				{confirming && !remove.isError ? (
					<div className="max-w-[240px] px-2 pb-1 text-micro leading-[15px] text-(--text-tertiary)">
						{artifact.added ? 'Tasks it was attached to keep their own copy.' : "It leaves the task's Library too. Replies that showed it say it was deleted."}
					</div>
				) : null}
				{remove.isError ? <div className="max-w-[240px] px-2 pb-1 text-micro leading-[15px] text-(--danger-text)">{remove.error.message}</div> : null}
			</MenuContent>
		</Menu>
	);
}

/** One artifact: what it looks like, its name, and the task it came from. The whole card opens it; its menu sits above the link. */
type Selection = { keys: Set<string>; toggle: (artifact: Artifact) => void; disabled: boolean };

function ArtifactCard({ artifact, selection }: { artifact: Artifact; selection?: Selection }) {
	const info = categoryInfo(categoryOf(artifact.path));
	return (
		<div className="in-card group relative flex flex-col overflow-hidden transition-colors duration-(--duration-micro) hover:border-(--border-default) has-[:focus-visible]:shadow-(--focus-ring)">
			<Thumb artifact={artifact} />
			<div className="flex min-w-0 items-start gap-2 py-2.5 pr-1.5 pl-3">
				<Icon icon={info.icon} size={13} className={cn('mt-[3px] shrink-0', info.tone)} />
				<div className="flex min-w-0 flex-1 flex-col gap-0.5">
					<span title={artifact.title} className="truncate text-body text-(--text-primary)">{artifact.title}</span>
					<span className="truncate text-small text-(--text-tertiary)">
						{artifact.task.title} · {when(artifact)}
					</span>
				</div>
				<span className="relative z-10 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 has-data-[state=open]:opacity-100 pointer-coarse:opacity-100">
					{selection ? null : <ArtifactMenu artifact={artifact} />}
				</span>
			</div>
			{selection ? (
				<label className="absolute inset-0 cursor-pointer">
					<input
						type="checkbox"
						aria-label={`Select ${artifact.title}`}
						checked={selection.keys.has(artifactKey(artifact))}
						onChange={() => selection.toggle(artifact)}
						disabled={selection.disabled}
						className="absolute top-3 left-3 size-5 accent-(--accent-text)"
					/>
				</label>
			) : (
				<Link
					to="/artifacts/$taskId"
					params={{ taskId: artifact.sessionId }}
					search={{ path: artifact.path }}
					aria-label={`${artifact.title}, ${info.one.toLowerCase()} from ${artifact.task.title}`}
					className="absolute inset-0 outline-none"
				/>
			)}
		</div>
	);
}

function Grid({ items, selection }: { items: Artifact[]; selection?: Selection }) {
	return (
		<div className="grid grid-cols-[repeat(auto-fill,minmax(min(220px,100%),1fr))] gap-3">
			{items.map((artifact) => (
				<ArtifactCard key={artifactKey(artifact)} artifact={artifact} selection={selection} />
			))}
		</div>
	);
}

function Section({ label, count, children }: { label: string; count: number; children: ReactNode }) {
	return (
		<section aria-label={label} className="flex flex-col gap-2.5">
			<h2 className="m-0 flex items-baseline gap-2 text-body font-medium text-(--text-secondary)">
				{label}
				<span className="in-num text-micro font-normal text-(--text-disabled)">{count}</span>
			</h2>
			{children}
		</section>
	);
}

function matches(artifact: Artifact, query: string): boolean {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	const haystack = `${artifact.title} ${artifact.path} ${artifact.task.title}`.toLowerCase();
	return words.every((word) => haystack.includes(word));
}

/**
 * Adds files of your own, such as a skill's SKILL.md, which any task can then be given from the composer's + menu.
 * A folder goes in as one .zip named for it, and a folder with a SKILL.md is installed as a skill straight away,
 * scripts and all.
 */
function AddFiles() {
	const picker = useRef<HTMLInputElement>(null);
	const folderPicker = useRef<HTMLInputElement>(null);
	const queryClient = useQueryClient();
	const add = useMutation({
		mutationFn: async (files: File[]) => {
			for (const file of files) await api.addArtifact(file);
			return null;
		},
		onSettled: () => void queryClient.invalidateQueries({ queryKey: ['artifacts'] }),
	});
	const addFolder = useMutation({
		mutationFn: async (files: File[]) => {
			const { file, skill } = await zipFolder(files);
			const { path } = await api.addArtifact(file);
			if (!skill) return `Added ${path}.`;
			const { plugins } = await api.installAddedSkill(path);
			queryClient.setQueryData<{ plugins: unknown[]; marketplaces: string[] }>(['plugins'], (current) => (current ? { ...current, plugins } : current));
			const installed = plugins.find((plugin) => plugin.source.repo === ADDED_FILES && plugin.source.path === path);
			return `Added ${path} and installed it as the skill ${installed?.skills[0]?.name ?? installed?.name ?? ''}, in Settings › Skills.`;
		},
		onSettled: () => void queryClient.invalidateQueries({ queryKey: ['artifacts'] }),
	});
	const problem = add.error ?? addFolder.error;
	const busy = add.isPending || addFolder.isPending;
	return (
		<>
			<input
				ref={picker}
				type="file"
				multiple
				hidden
				aria-label="Files to add"
				onChange={(event) => {
					const files = [...(event.target.files ?? [])];
					event.target.value = '';
					if (files.length) add.mutate(files);
				}}
			/>
			<input
				ref={folderPicker}
				type="file"
				multiple
				hidden
				aria-label="Folder to add"
				// React does not know the attribute; browsers that pick folders all read it.
				{...{ webkitdirectory: '' }}
				onChange={(event) => {
					const files = [...(event.target.files ?? [])];
					event.target.value = '';
					if (files.length) addFolder.mutate(files);
				}}
			/>
			{problem ? <span className="text-small text-(--danger-text)">{problem.message}</span> : null}
			{addFolder.isSuccess && addFolder.data ? <span className="text-small text-(--text-tertiary)">{addFolder.data}</span> : null}
			<Btn size="sm" variant="ghost" icon={FolderUp} disabled={busy} onClick={() => folderPicker.current?.click()} className="shrink-0">
				{addFolder.isPending ? 'Adding…' : 'Add folder'}
			</Btn>
			<Btn size="sm" variant="ghost" icon={Upload} disabled={busy} onClick={() => picker.current?.click()} className="shrink-0">
				{add.isPending ? 'Adding…' : 'Add files'}
			</Btn>
		</>
	);
}

/** One archive, not many browser downloads. Release the temporary Blob URL after it starts. */
function saveArchive(blob: Blob) {
	const url = URL.createObjectURL(blob);
	const link = document.createElement('a');
	link.href = url;
	link.download = 'artifacts.zip';
	link.click();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function BulkActions({ selected, shown, keys, setKeys, busy, setBusy, finish }: {
	selected: Artifact[]; shown: Artifact[]; keys: Set<string>;
	setKeys: (keys: Set<string>) => void; busy: boolean; setBusy: (busy: boolean) => void; finish: () => void;
}) {
	const queryClient = useQueryClient();
	const [confirming, setConfirming] = useState<Set<string> | null>(null);
	const [notice, setNotice] = useState('');
	const [error, setError] = useState('');
	const [operation, setOperation] = useState<'download' | 'delete' | null>(null);
	const hidden = selected.filter((item) => !shown.some((other) => artifactKey(other) === artifactKey(item))).length;
	// A confirmation always describes exactly the selection that will be deleted.

	const downloadSelected = async () => {
		setBusy(true); setOperation('download'); setError(''); setNotice(''); setConfirming(null);
		try {
			saveArchive(await api.downloadArtifacts(selected.map(({ sessionId, path }) => ({ sessionId, path }))));
			setNotice('ZIP download started.');
		} catch (error) {
			setError(`${error instanceof Error ? error.message : 'Download failed.'} Try again, or select fewer files.`);
		} finally { setBusy(false); setOperation(null); }
	};
	const deleteSelected = async () => {
		setBusy(true); setOperation('delete'); setError(''); setNotice('');
		const removed = new Set<string>();
		const failures: string[] = [];
		let next = 0;
		// Bounded concurrency; preserve failed items for a retry rather than pretending the batch is atomic.
		await Promise.all(Array.from({ length: Math.min(3, selected.length) }, async () => {
			while (next < selected.length) {
				const item = selected[next++];
				try { await api.deleteOutput(item.sessionId, item.path); removed.add(artifactKey(item)); }
				catch (error) { failures.push(`${item.title}: ${error instanceof Error ? error.message : 'Delete failed.'}`); }
			}
		}));
		queryClient.setQueryData<{ artifacts: Artifact[] }>(['artifacts'], (current) => current ? { artifacts: current.artifacts.filter((item) => !removed.has(artifactKey(item))) } : current);
		setKeys(new Set([...keys].filter((key) => !removed.has(key))));
		void queryClient.invalidateQueries({ queryKey: ['artifacts'] });
		for (const id of new Set(selected.map((item) => item.sessionId))) void queryClient.invalidateQueries({ queryKey: ['outputs', id] });
		setConfirming(null); setBusy(false); setOperation(null);
		setNotice(`${removed.size} artifact${removed.size === 1 ? '' : 's'} deleted.`);
		if (failures.length) setError(`${failures.length} could not be deleted. They remain selected; retry Delete. ${failures.slice(0, 3).join(' · ')}`);
	};
	return (
		<div className="flex flex-col gap-2 rounded-control border border-(--border-default) bg-(--bg-inset) p-3" role="group" aria-label="Artifact selection">
			<div className="flex flex-wrap items-center gap-2">
				<span role="status" className="mr-1 text-body text-(--text-secondary)">{selected.length} selected{hidden ? ` (${hidden} hidden by filters)` : ''}</span>
				<Btn size="sm" disabled={busy || !shown.length} onClick={() => setKeys(new Set([...keys, ...shown.map(artifactKey)]))}>Select all shown</Btn>
				<Btn size="sm" variant="ghost" disabled={busy || !selected.length} onClick={() => setKeys(new Set())}>Clear selection</Btn>
				<span className="flex-1" />
				<Btn size="sm" icon={Download} disabled={busy || !selected.length} onClick={() => void downloadSelected()}>{operation === 'download' ? 'Preparing ZIP…' : 'Download ZIP'}</Btn>
				<Btn size="sm" variant="dangerGhost" icon={Trash2} disabled={busy || !selected.length} onClick={() => { setConfirming(keys); setError(''); }}>{operation === 'delete' ? 'Deleting…' : 'Delete selected'}</Btn>
				<Btn size="sm" variant="ghost" disabled={busy} onClick={finish}>Done</Btn>
			</div>
			{confirming === keys ? <div className="flex flex-wrap items-center gap-2 text-small text-(--text-secondary)">
				<p className="m-0 basis-full">Delete {selected.length} selected artifact{selected.length === 1 ? '' : 's'}{hidden ? ', including those hidden by filters' : ''}? This cannot be undone. They leave their tasks’ Libraries too, and replies show them as deleted. Tasks keep their own copies of files you added and attached.</p>
				<Btn size="sm" variant="danger" disabled={busy} onClick={() => void deleteSelected()}>Confirm delete</Btn>
				<Btn size="sm" variant="ghost" disabled={busy} onClick={() => setConfirming(null)}>Cancel</Btn>
			</div> : null}
			<p className="m-0 text-micro text-(--text-tertiary)">ZIP: up to 500 files and 50 MB per download. Selections stay selected across filters.</p>
			{notice ? <p role="status" className="m-0 text-small text-(--text-secondary)">{notice}</p> : null}
			{error ? <p role="alert" className="m-0 text-small break-words text-(--danger-text)">{error}</p> : null}
		</div>
	);
}

/** Every artifact, newest first: apps on top, then the files; or one kind, picked above. */
export function ArtifactsPage() {
	const search = useSearch({ from: '/artifacts' });
	const navigate = useNavigate();
	const artifacts = useQuery({ queryKey: ['artifacts'], queryFn: api.artifacts, refetchInterval: SAFETY_NET_MS });
	const all = artifacts.data?.artifacts ?? [];
	const query = search.q ?? '';
	const type = search.type;
	const found = useMemo(() => (query ? all.filter((artifact) => matches(artifact, query)) : all), [all, query]);
	const counts = useMemo(() => {
		const byCategory = new Map<Category, number>();
		for (const artifact of found) byCategory.set(categoryOf(artifact.path), (byCategory.get(categoryOf(artifact.path)) ?? 0) + 1);
		return byCategory;
	}, [found]);
	const shown = type ? found.filter((artifact) => categoryOf(artifact.path) === type) : found;
	const apps = shown.filter((artifact) => categoryOf(artifact.path) === 'app');
	const files = shown.filter((artifact) => categoryOf(artifact.path) !== 'app');
	const [selecting, setSelecting] = useState(false);
	const [keys, setKeys] = useState<Set<string>>(new Set());
	const [busy, setBusy] = useState(false);
	const selected = all.filter((item) => keys.has(artifactKey(item)));
	useEffect(() => {
		if (!artifacts.data) return;
		const existing = new Set(artifacts.data.artifacts.map(artifactKey));
		setKeys((current) => [...current].some((key) => !existing.has(key)) ? new Set([...current].filter((key) => existing.has(key))) : current);
	}, [artifacts.data]);
	const selection: Selection | undefined = selecting ? { keys, disabled: busy, toggle: (artifact) => {
		const next = new Set(keys);
		const key = artifactKey(artifact);
		if (next.has(key)) next.delete(key); else next.add(key);
		setKeys(next);
	} } : undefined;
	const setSearch = (next: ArtifactsSearch) => void navigate({ to: '/artifacts', search: next, replace: true });

	return (
		<PageFrame title="Artifacts" description="What the agent made and saved across every task: reports, pages, images and files.">
			<div className="flex flex-wrap items-center gap-2">
				<Segmented label="Kind" className="max-w-full flex-wrap [&>button]:shrink-0">
					<SegmentedItem size="sm" on={!type} onClick={() => setSearch({ q: query || undefined })}>
						All
						<span className="in-num text-(--text-disabled)">{found.length}</span>
					</SegmentedItem>
					{CATEGORIES.filter((category) => counts.get(category.key) || type === category.key).map((category) => (
						<SegmentedItem key={category.key} size="sm" on={type === category.key} onClick={() => setSearch({ type: category.key, q: query || undefined })}>
							{category.label}
							<span className="in-num text-(--text-disabled)">{counts.get(category.key) ?? 0}</span>
						</SegmentedItem>
					))}
				</Segmented>
				<span className="min-w-0 flex-1" />
				{!selecting && all.length ? <Btn size="sm" variant="ghost" icon={CheckSquare} onClick={() => setSelecting(true)}>Select</Btn> : null}
				<AddFiles />
				<SearchField value={query} onChange={(next) => setSearch({ type, q: next || undefined })} placeholder="Search artifacts" className="w-full sm:w-[240px]" />
			</div>

			{selecting ? <BulkActions selected={selected} shown={shown} keys={keys} setKeys={setKeys} busy={busy} setBusy={setBusy} finish={() => { setSelecting(false); setKeys(new Set()); }} /> : null}
			{artifacts.isPending ? (
				<div className="flex h-7 items-center gap-2 text-small text-(--text-tertiary)">
					<Spinner size={12} />
					Loading artifacts
				</div>
			) : artifacts.isError ? (
				<EmptyState title="Artifacts unavailable" body={artifacts.error.message} />
			) : all.length === 0 ? (
				<EmptyState
					art={<LibraryArt className="w-full max-w-[320px]" />}
					title="Nothing made yet"
					body="Apps the agent draws in a reply, and the reports, images and data it saves, gather here from every task. Files you add here, such as a skill, can be given to any task from the composer's + menu."
				/>
			) : shown.length === 0 ? (
				<EmptyState title="Nothing matches" body={query ? 'Try other words, or clear the search.' : 'Pick another kind, or All.'} />
			) : type ? (
				<Grid items={shown} selection={selection} />
			) : (
				<>
					{apps.length ? (
						<Section label="Apps" count={apps.length}>
							<Grid items={apps} selection={selection} />
						</Section>
					) : null}
					{files.length ? (
						<Section label="Files" count={files.length}>
							<Grid items={files} selection={selection} />
						</Section>
					) : null}
				</>
			)}
		</PageFrame>
	);
}

/** One artifact, full size: an app live (or its source), a document rendered (or its text), any other file as the Library shows it. */
export function ArtifactView() {
	const { taskId: sessionId } = useParams({ from: '/artifacts/$taskId' });
	const { path = '' } = useSearch({ from: '/artifacts/$taskId' });
	const artifacts = useQuery({ queryKey: ['artifacts'], queryFn: api.artifacts, refetchInterval: SAFETY_NET_MS });
	const added = sessionId === ADDED_FILES;
	const session = useQuery({ queryKey: ['session', sessionId], queryFn: () => api.session(sessionId), enabled: !added });
	const listed = artifacts.data?.artifacts.find((artifact) => artifact.sessionId === sessionId && artifact.path === path);
	const artifact: Artifact = listed ?? {
		sessionId,
		path,
		title: nameOf(path),
		size: 0,
		mtimeMs: Date.now(),
		task: { title: added ? 'Added by you' : (session.data?.title ?? 'Task'), spaceId: session.data?.spaceId ?? null, chat: false },
		added,
	};
	const category = categoryOf(path);
	const info = categoryInfo(category);
	const app = category === 'app';
	const readable = app || isMarkdown(path);
	const [code, setCode] = useState(false);
	const text = isText(path);
	const navigate = useNavigate();
	const deleted = useDeletedOutput(sessionId, path);
	const [confirming, setConfirming] = useState(false);
	const remove = useDeleteArtifact(artifact, () => void navigate({ to: '/artifacts' }));
	useEffect(() => {
		if (!confirming) return;
		const timer = setTimeout(() => setConfirming(false), 4000);
		return () => clearTimeout(timer);
	}, [confirming]);

	const body = deleted ? (
		<DeletedArtifact path={path} variant="stage" className="min-h-[320px]" />
	) : (
		<OutputPreview item={{ sessionId, path }} code={code} title={artifact.title} />
	);

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<header className="flex h-11 shrink-0 items-center gap-1.5 border-b border-(--border-subtle) pr-2 pl-2 md:pl-3">
				<MenuButton />
				<Link to="/artifacts" aria-label="All artifacts" title="All artifacts" className="sg-btn sg-icon-btn sg-btn--ghost sg-btn--sm">
					<Icon icon={ChevronLeft} size={14} />
				</Link>
				<Icon icon={info.icon} size={14} className={cn('shrink-0', info.tone)} />
				<div className="flex min-w-0 flex-1 items-baseline gap-2">
					<h1 className="m-0 min-w-0 truncate text-body font-medium text-(--text-primary)">{artifact.title}</h1>
					<TaskLink artifact={artifact} className="hidden min-w-0 truncate text-small text-(--text-tertiary) outline-none hover:text-(--text-secondary) focus-visible:shadow-(--focus-ring) sm:inline">
						{artifact.task.title}
						{listed ? ` · ${when(artifact)}` : ''}
					</TaskLink>
				</div>
				{readable && !deleted ? (
					<Segmented label="Show" role="radiogroup" className="shrink-0">
						<SegmentedItem role="radio" size="sm" on={!code} onClick={() => setCode(false)}>
							Preview
						</SegmentedItem>
						<SegmentedItem role="radio" size="sm" on={code} onClick={() => setCode(true)}>
							Code
						</SegmentedItem>
					</Segmented>
				) : null}
				{deleted ? null : (
					<>
						{text ? <CopiedText sessionId={sessionId} path={path} /> : null}
						<IconBtn icon={Download} size="sm" label="Download" onClick={() => download(artifact)} />
						{app ? (
							<a href={frameUrl(sessionId, path)} target="_blank" rel="noreferrer" aria-label="Open in a new tab" title="Open in a new tab" className="sg-btn sg-icon-btn sg-btn--ghost sg-btn--sm">
								<Icon icon={ExternalLink} size={14} />
							</a>
						) : null}
						{confirming || remove.isPending ? (
							<Btn size="sm" variant="danger" icon={Trash2} disabled={remove.isPending} onClick={() => remove.mutate()} className="shrink-0">
								{remove.isPending ? 'Deleting…' : 'Confirm delete'}
							</Btn>
						) : (
							<IconBtn icon={Trash2} size="sm" label="Delete" onClick={() => setConfirming(true)} />
						)}
					</>
				)}
			</header>
			{remove.isError ? <div className="border-b border-(--border-subtle) px-3 py-1.5 text-small text-(--danger-text)">{remove.error.message}</div> : null}
			<div className={cn('min-h-0 flex-1', app && !code ? 'overflow-hidden' : 'overflow-y-auto')}>{body}</div>
		</div>
	);
}

/** Copies the file's text, read when first asked for. */
function CopiedText({ sessionId, path }: { sessionId: string; path: string }) {
	const content = useQuery({ queryKey: ['output', sessionId, path], queryFn: () => api.outputText(sessionId, path), staleTime: 60_000 });
	return content.data !== undefined ? <CopyButton text={content.data} label="Copy contents" className="sg-btn--sm" /> : null;
}

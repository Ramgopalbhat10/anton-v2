import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useRouter, useSearch } from '@tanstack/react-router';
import { ArrowUpRight, Check, CheckSquare, ChevronDown, ChevronLeft, Download, ExternalLink, FolderUp, Link2, Maximize2, MoreVertical, Sparkles, Trash2, Upload, X } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { CopyButton } from '@/components/code-block';
import { frameUrl } from '@/components/html-frame';
import { LibraryArt } from '@/components/illustrations';
import { Segmented, SegmentedItem } from '@/components/instrument';
import { kindOf } from '@/components/library-tab';
import { MenuButton } from '@/components/nav';
import { DeletedArtifact, OutputPreview, OutputThumb } from '@/components/output-viewer';
import { TopBar } from '@/components/page-frame';
import { Btn, EmptyState, FilterChip, Icon, IconBtn, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, SearchField, Spinner } from '@/components/signal';
import { ADDED_FILES, api, type Artifact, outputUrl, SAFETY_NET_MS } from '@/lib/api';
import { CATEGORIES, type Category, categoryInfo, categoryOf, extensionOf, isMarkdown, isText, nameOf, zipFolder } from '@/lib/artifacts';
import { useDeletedOutput } from '@/lib/deleted-outputs';
import { age, fileSize } from '@/lib/format';
import { useOnePane } from '@/lib/one-pane';
import { cn } from '@/lib/utils';
import { taskQueries } from '@/lib/task-queries';

/*
 * Everything the agent made, in every task: apps (the pages it drew, which
 * keep their state wherever they are open) and files, as cards with what each
 * looks like. A card picks the artifact, which opens in a sheet beside the
 * gallery with where it came from; from there, or on a second click, it
 * opens here full size, with its source.
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
		<pre className="m-0 h-full overflow-hidden px-3.5 pt-3 font-mono text-nano leading-[14px] whitespace-pre-wrap wrap-anywhere text-(--text-3) [mask-image:linear-gradient(180deg,#000_55%,transparent)]">
			{(text.data ?? '').slice(0, 1200)}
		</pre>
	);
}

/** An app's card well: a drawn browser window with a chart in it, since the page only runs when it is open. */
function AppThumb() {
	return (
		<span data-preview="app" aria-hidden className="absolute inset-0 flex items-center justify-center bg-(--bg-app)">
			<span className="flex h-[58%] w-[74%] flex-col overflow-hidden rounded-control shadow-[0_0_0_1px_var(--line-strong)]">
				<span className="flex h-3 shrink-0 items-center gap-1 bg-(--bg-active) px-1.5">
					{[0, 1, 2].map((dot) => (
						<i key={dot} className="size-1 rounded-full bg-(--text-4)" />
					))}
				</span>
				<span className="flex min-h-0 flex-1 items-end gap-1.5 p-2">
					{[40, 70, 55, 90, 65, 80].map((height, bar) => (
						<i key={bar} className="flex-1 rounded-mark bg-(--accent) opacity-70" style={{ height: `${height}%` }} />
					))}
				</span>
			</span>
		</span>
	);
}

/** Apps never execute in the gallery. Only opening one mounts its live frame. */
function Thumb({ artifact }: { artifact: Artifact }) {
	const [ref, near] = useNearViewport<HTMLDivElement>();
	const category = categoryOf(artifact.path);
	const info = categoryInfo(category);
	let body: ReactNode = category === 'app' ? (
		<AppThumb />
	) : (
		<span className="flex h-full flex-col items-center justify-center gap-2">
			<Icon icon={info.icon} size={22} className={info.tone} />
			<span className="text-nano tracking-[0.08em] text-(--text-3)">{extensionOf(artifact.path)}</span>
		</span>
	);
	// Large originals stay in the detail view; CSS resizing would still decode the full image here.
	if (near && kindOf(artifact.path) === 'image' && artifact.size <= 2 * 1024 * 1024)
		body = <span className="absolute inset-0"><OutputThumb item={artifact} /></span>;
	else if (near && category !== 'app' && isText(artifact.path) && artifact.size < 256 * 1024) body = <Snippet artifact={artifact} />;
	return (
		<div ref={ref} className="relative aspect-[16/10] overflow-hidden border-b border-(--line) bg-(--bg-app)">
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
				<div className={cn('max-w-[240px] px-2 pb-1 text-micro leading-[15px] text-pretty', install.isError ? 'text-(--bad)' : 'text-(--text-3)')}>
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
					<div className="max-w-[240px] px-2 pb-1 text-micro leading-[15px] text-(--text-3)">
						{artifact.added ? 'Tasks it was attached to keep their own copy.' : "It leaves the task's Library too. Replies that showed it say it was deleted."}
					</div>
				) : null}
				{remove.isError ? <div className="max-w-[240px] px-2 pb-1 text-micro leading-[15px] text-(--bad)">{remove.error.message}</div> : null}
			</MenuContent>
		</Menu>
	);
}

/** One artifact: what it looks like, its name, and the task it came from. The whole card opens it; its menu sits above the link. */
type Selection = { keys: Set<string>; toggle: (artifact: Artifact) => void; disabled: boolean };
/** The card the sheet shows, and how a card asks to be it; absent where a card opens the artifact straight away. */
type Picking = { key: string | null; pick: (artifact: Artifact) => void };

function ArtifactCard({ artifact, selection, picking }: { artifact: Artifact; selection?: Selection; picking?: Picking }) {
	const info = categoryInfo(categoryOf(artifact.path));
	const picked = picking?.key === artifactKey(artifact);
	return (
		<div
			data-picked={picked || undefined}
			className={cn(
				'in-card group overflow-hidden transition-shadow duration-(--t-fast) has-[:focus-visible]:shadow-(--focus)',
				picked ? 'shadow-[inset_0_0_0_1px_var(--accent-line),0_0_0_3px_var(--accent-soft)]' : 'hover:shadow-[inset_0_0_0_1px_var(--line-strong)]',
			)}
		>
			<Thumb artifact={artifact} />
			<div className="flex min-w-0 items-start gap-1.5 py-2.5 pr-1.5 pl-3">
				<Icon icon={info.icon} size={13} className="mt-[3px] shrink-0 text-(--text-3)" />
				<div className="flex min-w-0 flex-1 flex-col gap-0.5">
					<span title={artifact.title} className="truncate text-body leading-[18px] font-medium text-(--text)">{artifact.title}</span>
					<span className="truncate text-small leading-4 text-(--text-3)">{artifact.task.title}</span>
					<span className="in-num truncate text-micro leading-4 text-(--text-4)">
						{fileSize(artifact.size)} · {when(artifact)}
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
					aria-current={picked || undefined}
					// A plain click picks the card for the sheet; a click on the picked card, or one meant for a new tab, opens it.
					onClick={(event) => {
						if (!picking || picked || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
						event.preventDefault();
						picking.pick(artifact);
					}}
					className="absolute inset-0 outline-none"
				/>
			)}
		</div>
	);
}

function Grid({ items, selection, picking }: { items: Artifact[]; selection?: Selection; picking?: Picking }) {
	return (
		<div className="grid grid-cols-[repeat(auto-fill,minmax(min(200px,100%),1fr))] gap-3">
			{items.map((artifact) => (
				<ArtifactCard key={artifactKey(artifact)} artifact={artifact} selection={selection} picking={picking} />
			))}
		</div>
	);
}

/** A fact about the picked artifact: its name on the left, what it is on the right. */
function Fact({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="flex items-start gap-2">
			<dt className="w-[72px] shrink-0 text-small leading-[18px] text-(--text-3)">{label}</dt>
			<dd className="m-0 min-w-0 flex-1 text-body leading-[18px] wrap-anywhere text-(--text)">{children}</dd>
		</div>
	);
}

/** The picked artifact beside the gallery: what it looks like, what it is, the task it came from, and the ways to take it. */
function ArtifactSheet({ artifact, onClose }: { artifact: Artifact; onClose: () => void }) {
	const router = useRouter();
	const info = categoryInfo(categoryOf(artifact.path));
	const [confirming, setConfirming] = useState(false);
	const [copied, setCopied] = useState(false);
	const remove = useDeleteArtifact(artifact, onClose);
	const key = artifactKey(artifact);
	useEffect(() => {
		setConfirming(false);
		setCopied(false);
	}, [key]);
	useEffect(() => {
		if (!copied) return;
		const timer = setTimeout(() => setCopied(false), 1600);
		return () => clearTimeout(timer);
	}, [copied]);
	const view = { to: '/artifacts/$taskId', params: { taskId: artifact.sessionId }, search: { path: artifact.path } } as const;
	return (
		<aside aria-label={`${artifact.title}, picked`} className="hidden w-[360px] shrink-0 flex-col border-l border-(--line) md:flex">
			<header className="flex h-11 shrink-0 items-center gap-1.5 border-b border-(--line) pr-2 pl-3.5">
				<Icon icon={info.icon} size={14} className="shrink-0 text-(--text-3)" />
				<h2 title={artifact.title} className="m-0 min-w-0 flex-1 truncate text-body font-medium text-(--text)">{artifact.title}</h2>
				<Link {...view} aria-label="Open full size" title="Open full size" className="sg-btn sg-icon-btn sg-btn--ghost sg-btn--sm">
					<Icon icon={Maximize2} size={13} />
				</Link>
				<IconBtn icon={X} size="sm" label="Close" onClick={onClose} />
			</header>
			<div className="min-h-0 flex-1 overflow-y-auto">
				<Link {...view} tabIndex={-1} aria-hidden className="block outline-none">
					<Thumb key={key} artifact={artifact} />
				</Link>
				<div className="flex flex-col gap-3 p-3.5">
					<dl className="m-0 flex flex-col gap-3">
						<Fact label="Kind">{info.one}</Fact>
						<Fact label="Size">
							<span className="in-num">{fileSize(artifact.size)}</span>
						</Fact>
						<Fact label="From">
							<TaskLink artifact={artifact} className={cn('rounded-inner outline-none', !artifact.added && 'hover:underline focus-visible:shadow-(--focus)')}>
								{artifact.task.title}
							</TaskLink>
						</Fact>
						<Fact label="Saved">
							<span title={new Date(artifact.mtimeMs).toLocaleString()}>{when(artifact)} ago</span>
						</Fact>
					</dl>
					<div className="flex items-center gap-1.5 pt-1">
						<Link {...view} className="sg-btn sg-btn--secondary sg-btn--sm min-w-0 flex-1">
							<Icon icon={ArrowUpRight} size={13} />
							Open
						</Link>
						<Btn size="sm" icon={Download} onClick={() => download(artifact)} className="min-w-0 flex-1">
							Download
						</Btn>
						<IconBtn
							icon={copied ? Check : Link2}
							size="sm"
							label={copied ? 'Link copied' : 'Copy link'}
							onClick={() => void navigator.clipboard.writeText(new URL(router.buildLocation(view).href, location.origin).href).then(() => setCopied(true), () => undefined)}
						/>
						<IconBtn
							icon={Trash2}
							size="sm"
							variant={confirming ? 'danger' : 'ghost'}
							label={remove.isPending ? 'Deleting…' : confirming ? 'Click again to delete' : 'Delete'}
							disabled={remove.isPending}
							onClick={() => (confirming ? remove.mutate() : setConfirming(true))}
						/>
					</div>
					{confirming && !remove.isError ? (
						<p className="m-0 text-small leading-4 text-(--text-3)">
							Click the bin again to delete it. {artifact.added ? 'Tasks it was attached to keep their own copy.' : "It leaves the task's Library too; replies that showed it say it was deleted."}
						</p>
					) : null}
					{remove.isError ? <p role="alert" className="m-0 text-small leading-4 text-(--bad)">{remove.error.message}</p> : null}
				</div>
			</div>
		</aside>
	);
}

function Section({ label, count, children }: { label: string; count: number; children: ReactNode }) {
	return (
		<section aria-label={label} className="flex flex-col gap-2">
			<h2 className="m-0 flex items-baseline gap-2 text-small font-medium text-(--text-3)">
				{label}
				<span className="in-num text-micro font-normal text-(--text-4)">{count}</span>
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
			{problem ? <span className="text-small text-(--bad)">{problem.message}</span> : null}
			{addFolder.isSuccess && addFolder.data ? <span className="text-small text-(--text-3)">{addFolder.data}</span> : null}
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
		<div className="flex flex-col gap-2 rounded-control border border-(--line-strong) bg-(--bg-app) p-3" role="group" aria-label="Artifact selection">
			<div className="flex flex-wrap items-center gap-2">
				<span role="status" className="mr-1 text-body text-(--text-2)">{selected.length} selected{hidden ? ` (${hidden} hidden by filters)` : ''}</span>
				<Btn size="sm" disabled={busy || !shown.length} onClick={() => setKeys(new Set([...keys, ...shown.map(artifactKey)]))}>Select all shown</Btn>
				<Btn size="sm" variant="ghost" disabled={busy || !selected.length} onClick={() => setKeys(new Set())}>Clear selection</Btn>
				<span className="flex-1" />
				<Btn size="sm" icon={Download} disabled={busy || !selected.length} onClick={() => void downloadSelected()}>{operation === 'download' ? 'Preparing ZIP…' : 'Download ZIP'}</Btn>
				<Btn size="sm" variant="dangerGhost" icon={Trash2} disabled={busy || !selected.length} onClick={() => { setConfirming(keys); setError(''); }}>{operation === 'delete' ? 'Deleting…' : 'Delete selected'}</Btn>
				<Btn size="sm" variant="ghost" disabled={busy} onClick={finish}>Done</Btn>
			</div>
			{confirming === keys ? <div className="flex flex-wrap items-center gap-2 text-small text-(--text-2)">
				<p className="m-0 basis-full">Delete {selected.length} selected artifact{selected.length === 1 ? '' : 's'}{hidden ? ', including those hidden by filters' : ''}? This cannot be undone. They leave their tasks’ Libraries too, and replies show them as deleted. Tasks keep their own copies of files you added and attached.</p>
				<Btn size="sm" variant="danger" disabled={busy} onClick={() => void deleteSelected()}>Confirm delete</Btn>
				<Btn size="sm" variant="ghost" disabled={busy} onClick={() => setConfirming(null)}>Cancel</Btn>
			</div> : null}
			<p className="m-0 text-micro text-(--text-3)">ZIP: up to 500 files and 50 MB per download. Selections stay selected across filters.</p>
			{notice ? <p role="status" className="m-0 text-small text-(--text-2)">{notice}</p> : null}
			{error ? <p role="alert" className="m-0 text-small break-words text-(--bad)">{error}</p> : null}
		</div>
	);
}

const SORTS = [
	{ id: 'newest', label: 'Newest first' },
	{ id: 'oldest', label: 'Oldest first' },
	{ id: 'name', label: 'Name A–Z' },
	{ id: 'largest', label: 'Largest first' },
] as const;
type SortId = (typeof SORTS)[number]['id'];

function sortArtifacts(items: Artifact[], sort: SortId): Artifact[] {
	const sorted = [...items];
	if (sort === 'oldest') sorted.sort((a, b) => a.mtimeMs - b.mtimeMs);
	else if (sort === 'name') sorted.sort((a, b) => a.title.localeCompare(b.title));
	else if (sort === 'largest') sorted.sort((a, b) => b.size - a.size);
	else sorted.sort((a, b) => b.mtimeMs - a.mtimeMs);
	return sorted;
}

/** The order the gallery lies in, picked from a quiet menu on the row's right. */
function SortMenu({ sort, onPick }: { sort: SortId; onPick: (sort: SortId) => void }) {
	const label = SORTS.find((entry) => entry.id === sort)?.label ?? 'Newest first';
	return (
		<Menu>
			<MenuTrigger asChild>
				<button
					type="button"
					className="ml-auto inline-flex h-6 shrink-0 items-center gap-1.5 rounded-control px-2 text-small text-(--text-3) outline-none transition-colors duration-(--t-fast) hover:bg-(--bg-hover) hover:text-(--text) focus-visible:shadow-(--focus)"
				>
					{label}
					<Icon icon={ChevronDown} size={12} className="text-(--text-4)" />
				</button>
			</MenuTrigger>
			<MenuContent align="end">
				{SORTS.map((entry) => (
					<MenuItem key={entry.id} checked={sort === entry.id} onSelect={() => onPick(entry.id)}>
						{entry.label}
					</MenuItem>
				))}
			</MenuContent>
		</Menu>
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
	const [sort, setSort] = useState<SortId>('newest');
	const found = useMemo(() => (query ? all.filter((artifact) => matches(artifact, query)) : all), [all, query]);
	const counts = useMemo(() => {
		const byCategory = new Map<Category, number>();
		for (const artifact of found) byCategory.set(categoryOf(artifact.path), (byCategory.get(categoryOf(artifact.path)) ?? 0) + 1);
		return byCategory;
	}, [found]);
	const shown = useMemo(() => sortArtifacts(type ? found.filter((artifact) => categoryOf(artifact.path) === type) : found, sort), [found, type, sort]);
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
	// On a wide screen a card picks the artifact for the sheet; on a phone, and while selecting, there is no sheet.
	const onePane = useOnePane();
	const [pickedKey, setPickedKey] = useState<string | null>(null);
	const picked = selecting || onePane ? undefined : shown.find((artifact) => artifactKey(artifact) === pickedKey);
	const picking: Picking | undefined = selecting || onePane ? undefined : { key: picked ? pickedKey : null, pick: (artifact) => setPickedKey(artifactKey(artifact)) };

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<TopBar crumbs={['Artifacts']}>
				<SearchField value={query} onChange={(next) => setSearch({ type, q: next || undefined })} placeholder="Search artifacts" label="Search artifacts" size="sm" className="w-[220px] max-w-[46vw] shrink" />
			</TopBar>
			<div className="flex h-10 shrink-0 items-center gap-1.5 overflow-x-auto border-b border-(--line) px-4 [scrollbar-width:none]">
				<FilterChip label="All" count={found.length} on={!type} onToggle={() => setSearch({ q: query || undefined })} />
				{CATEGORIES.filter((category) => counts.get(category.key) || type === category.key).map((category) => (
					<FilterChip
						key={category.key}
						label={category.label}
						count={counts.get(category.key) ?? 0}
						on={type === category.key}
						onToggle={() => setSearch(type === category.key ? { q: query || undefined } : { type: category.key, q: query || undefined })}
					/>
				))}
				<span className="min-w-2 flex-1" />
				{!selecting && all.length ? (
					<Btn size="sm" variant="ghost" icon={CheckSquare} onClick={() => setSelecting(true)} className="shrink-0">
						Select
					</Btn>
				) : null}
				<AddFiles />
				<SortMenu sort={sort} onPick={setSort} />
			</div>

			<div className="flex min-h-0 flex-1">
			<div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
			{selecting ? <BulkActions selected={selected} shown={shown} keys={keys} setKeys={setKeys} busy={busy} setBusy={setBusy} finish={() => { setSelecting(false); setKeys(new Set()); }} /> : null}
			{artifacts.isPending ? (
				<div className="flex h-7 items-center gap-2 text-small text-(--text-3)">
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
				<Grid items={shown} selection={selection} picking={picking} />
			) : (
				<>
					{apps.length ? (
						<Section label="Apps" count={apps.length}>
							<Grid items={apps} selection={selection} picking={picking} />
						</Section>
					) : null}
					{files.length ? (
						<Section label="Files" count={files.length}>
							<Grid items={files} selection={selection} picking={picking} />
						</Section>
					) : null}
				</>
			)}
			</div>
			{picked ? <ArtifactSheet artifact={picked} onClose={() => setPickedKey(null)} /> : null}
			</div>
		</div>
	);
}

/** One artifact, full size: an app live (or its source), a document rendered (or its text), any other file as the Library shows it. */
export function ArtifactView() {
	const { taskId: sessionId } = useParams({ from: '/artifacts/$taskId' });
	const { path = '' } = useSearch({ from: '/artifacts/$taskId' });
	const artifacts = useQuery({ queryKey: ['artifacts'], queryFn: api.artifacts, refetchInterval: SAFETY_NET_MS });
	const added = sessionId === ADDED_FILES;
	const session = useQuery({ ...taskQueries.session(sessionId), enabled: !added });
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
			<header className="flex h-11 shrink-0 items-center gap-1.5 border-b border-(--line) pr-2 pl-2 md:pl-3">
				<MenuButton />
				<Link to="/artifacts" aria-label="All artifacts" title="All artifacts" className="sg-btn sg-icon-btn sg-btn--ghost sg-btn--sm">
					<Icon icon={ChevronLeft} size={14} />
				</Link>
				<Icon icon={info.icon} size={14} className={cn('shrink-0', info.tone)} />
				<div className="flex min-w-0 flex-1 items-baseline gap-2">
					<h1 className="m-0 min-w-0 truncate text-body font-medium text-(--text)">{artifact.title}</h1>
					<TaskLink artifact={artifact} className="hidden min-w-0 truncate text-small text-(--text-3) outline-none hover:text-(--text-2) focus-visible:shadow-(--focus) sm:inline">
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
			{remove.isError ? <div className="border-b border-(--line) px-3 py-1.5 text-small text-(--bad)">{remove.error.message}</div> : null}
			<div className={cn('min-h-0 flex-1', app && !code ? 'overflow-hidden' : 'overflow-y-auto')}>{body}</div>
		</div>
	);
}

/** Copies the file's text, read when first asked for. */
function CopiedText({ sessionId, path }: { sessionId: string; path: string }) {
	const content = useQuery({ queryKey: ['output', sessionId, path], queryFn: () => api.outputText(sessionId, path), staleTime: 60_000 });
	return content.data !== undefined ? <CopyButton text={content.data} label="Copy contents" className="sg-btn--sm" /> : null;
}

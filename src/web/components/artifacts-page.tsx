import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { ArrowUpRight, CheckSquare, ChevronLeft, Download, ExternalLink, MoreVertical, Search, Sparkles, Trash2, Upload, X } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { CopyButton } from '@/components/code-block';
import { frameUrl, PageThumbnail } from '@/components/html-frame';
import { LibraryArt } from '@/components/illustrations';
import { Segmented, SegmentedItem } from '@/components/instrument';
import { kindOf } from '@/components/library-tab';
import { MenuButton } from '@/components/nav';
import { DeletedArtifact, OutputPreview, OutputThumb } from '@/components/output-viewer';
import { PageFrame } from '@/components/page-frame';
import { Btn, EmptyState, Icon, IconBtn, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, Spinner } from '@/components/signal';
import { ADDED_FILES, api, type Artifact, outputUrl, SAFETY_NET_MS } from '@/lib/api';
import { CATEGORIES, type Category, categoryInfo, categoryOf, extensionOf, isMarkdown, isText, nameOf } from '@/lib/artifacts';
import { useDeletedOutput } from '@/lib/deleted-outputs';
import { age } from '@/lib/format';
import { cn } from '@/lib/utils';

/*
 * Everything the agent made, in every task: apps (the pages it drew, which
 * keep their state wherever they are open) and files, as cards with what each
 * looks like. A card opens the artifact here, full size, with its source.
 */

export type ArtifactsSearch = { type?: Category; q?: string };

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

/** Preview resources live only while their card is on screen in an active tab. */
function useVisible<T extends Element>(): [React.RefObject<T | null>, boolean] {
	const ref = useRef<T>(null);
	const [visible, setVisible] = useState(false);
	const [active, setActive] = useState(!document.hidden);
	useEffect(() => {
		const element = ref.current;
		if (!element || typeof IntersectionObserver === 'undefined') return;
		const observer = new IntersectionObserver((entries) => setVisible(entries.some((entry) => entry.isIntersecting)));
		observer.observe(element);
		return () => observer.disconnect();
	}, []);
	useEffect(() => {
		const changed = () => setActive(!document.hidden);
		document.addEventListener('visibilitychange', changed);
		return () => document.removeEventListener('visibilitychange', changed);
	}, []);
	return [ref, visible && active];
}

/** The first lines of a text file, faded out at the card's edge. */
function Snippet({ artifact }: { artifact: Artifact }) {
	const text = useQuery({
		queryKey: ['output', artifact.sessionId, artifact.path],
		queryFn: () => api.outputText(artifact.sessionId, artifact.path),
		staleTime: 60_000,
		gcTime: 0,
	});
	return (
		<pre className="m-0 h-full overflow-hidden px-3.5 pt-3 font-mono text-[9.5px] leading-[14px] whitespace-pre-wrap wrap-anywhere text-(--text-tertiary) [mask-image:linear-gradient(180deg,#000_55%,transparent)]">
			{(text.data ?? '').slice(0, 1200)}
		</pre>
	);
}

/** What a card shows of its artifact: the app itself, the image, a text file's first lines, or its kind. */
function Thumb({ artifact, previews }: { artifact: Artifact; previews: boolean }) {
	const [ref, visible] = useVisible<HTMLDivElement>();
	const category = categoryOf(artifact.path);
	const info = categoryInfo(category);
	let body: ReactNode;
	if (visible && previews && category === 'app') body = <PageThumbnail sessionId={artifact.sessionId} path={artifact.path} />;
	// A picture that cannot be read shows its kind instead of a broken image.
	else if (visible && kindOf(artifact.path) === 'image')
		body = (
			<span className="absolute inset-0">
				<OutputThumb item={artifact} />
			</span>
		);
	else if (visible && category !== 'app' && isText(artifact.path) && artifact.size < 256 * 1024) body = <Snippet artifact={artifact} />;
	else {
		body = (
			<span className="flex h-full flex-col items-center justify-center gap-2">
				<Icon icon={info.icon} size={22} className={info.tone} />
				<span className="font-mono text-[10px] tracking-[0.08em] text-(--text-disabled)">{extensionOf(artifact.path)}</span>
				{category === 'app' ? <span className="text-[11px] text-(--text-tertiary)">Open to use app</span> : null}
			</span>
		);
	}
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
 * Installs a Markdown file you added as a skill, or updates the skill it was installed as. Its name comes
 * from the file's front matter, so any file name will do. The menu stays open to say how it went.
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
				<div className={cn('max-w-[240px] px-2 pb-1 text-[11px] leading-[15px] text-pretty', install.isError ? 'text-(--danger-text)' : 'text-(--text-tertiary)')}>
					{install.isError ? (
						install.error.message
					) : (
						<>
							Installed as <span className="font-mono">{installedAs?.skills[0]?.name ?? installedAs?.name}</span>, in{' '}
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
				{artifact.added && isMarkdown(artifact.path) ? <InstallSkillItem artifact={artifact} open={open} /> : null}
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
					<div className="max-w-[240px] px-2 pb-1 text-[11px] leading-[15px] text-(--text-tertiary)">
						{artifact.added ? 'Tasks it was attached to keep their own copy.' : "It leaves the task's Library too. Replies that showed it say it was deleted."}
					</div>
				) : null}
				{remove.isError ? <div className="max-w-[240px] px-2 pb-1 text-[11px] leading-[15px] text-(--danger-text)">{remove.error.message}</div> : null}
			</MenuContent>
		</Menu>
	);
}

/** One artifact: what it looks like, its name, and the task it came from. The whole card opens it; its menu sits above the link. */
function ArtifactCard({ artifact, previews, selecting, selected, disabled, onSelect }: { artifact: Artifact; previews: boolean; selecting: boolean; selected: boolean; disabled: boolean; onSelect: (artifact: Artifact) => void }) {
	const info = categoryInfo(categoryOf(artifact.path));
	return (
		<div className={cn('in-card group relative flex flex-col overflow-hidden transition-colors duration-(--duration-micro) hover:border-(--border-default) has-[:focus-visible]:shadow-(--focus-ring)', selected && 'ring-2 ring-(--text-secondary)')}>
			<Thumb artifact={artifact} previews={previews} />
			<div className="flex min-w-0 items-start gap-2 py-2.5 pr-1.5 pl-3">
				<Icon icon={info.icon} size={13} className={cn('mt-[3px] shrink-0', info.tone)} />
				<div className="flex min-w-0 flex-1 flex-col gap-0.5">
					<span className="truncate text-[13px] text-(--text-primary)">{artifact.title}</span>
					<span className="truncate text-[11.5px] text-(--text-tertiary)">
						{artifact.task.title} · {when(artifact)}
					</span>
				</div>
				{!selecting ? <span className="relative z-10 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 has-data-[state=open]:opacity-100 pointer-coarse:opacity-100">
					<ArtifactMenu artifact={artifact} />
				</span> : null}
			</div>
			{selecting ? (
				<label className="absolute inset-0 cursor-pointer">
					<input type="checkbox" aria-label={`Select ${artifact.title}`} checked={selected} disabled={disabled} onChange={() => onSelect(artifact)} className="absolute top-3 left-3 size-4" />
				</label>
			) : <Link
				to="/artifacts/$taskId"
				params={{ taskId: artifact.sessionId }}
				search={{ path: artifact.path }}
				aria-label={`${artifact.title}, ${info.one.toLowerCase()} from ${artifact.task.title}`}
				className="absolute inset-0 outline-none"
			/>}
		</div>
	);
}

const artifactKey = (artifact: Artifact) => JSON.stringify([artifact.sessionId, artifact.path]);
const PAGE_SIZE = 24;

function Grid({ items, previews, selecting, selected, disabled, onSelect }: { items: Artifact[]; previews: boolean; selecting: boolean; selected: Set<string>; disabled: boolean; onSelect: (artifact: Artifact) => void }) {
	return (
		<div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
			{items.map((artifact) => (
				<ArtifactCard key={artifactKey(artifact)} artifact={artifact} previews={previews} selecting={selecting} selected={selected.has(artifactKey(artifact))} disabled={disabled} onSelect={onSelect} />
			))}
		</div>
	);
}

function Section({ label, count, children }: { label: string; count: number; children: ReactNode }) {
	return (
		<section aria-label={label} className="flex flex-col gap-2.5">
			<h2 className="m-0 flex items-baseline gap-2 text-[13px] font-medium text-(--text-secondary)">
				{label}
				<span className="in-num text-[11px] font-normal text-(--text-disabled)">{count}</span>
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

function SelectionActions({ items, shown, selected, setSelected, busy, setBusy, onClose }: {
	items: Artifact[];
	shown: Artifact[];
	selected: Set<string>;
	setSelected: (next: Set<string>) => void;
	busy: boolean;
	setBusy: (next: boolean) => void;
	onClose: () => void;
}) {
	const client = useQueryClient();
	const [confirming, setConfirming] = useState<Set<string> | null>(null);
	const [result, setResult] = useState('');
	const [progress, setProgress] = useState(0);
	const picked = items.filter((item) => selected.has(artifactKey(item)));
	const remove = useMutation({
		mutationFn: async (targets: Artifact[]) => {
			const failed: Artifact[] = [];
			const errors: string[] = [];
			for (const [index, item] of targets.entries()) {
				try {
					await api.deleteOutput(item.sessionId, item.path);
					client.setQueryData<{ artifacts: Artifact[] }>(['artifacts'], (current) => current ? { artifacts: current.artifacts.filter((other) => artifactKey(other) !== artifactKey(item)) } : current);
				} catch (error) {
					failed.push(item);
					errors.push(`${item.title}: ${error instanceof Error ? error.message : 'Delete failed'}`);
				}
				setProgress(index + 1);
			}
			return { failed, errors, deleted: targets.length - failed.length };
		},
		onSuccess: ({ failed, errors, deleted }) => {
			setSelected(new Set(failed.map(artifactKey)));
			setResult(`Deleted ${deleted} artifact${deleted === 1 ? '' : 's'}.${failed.length ? ` ${failed.length} could not be deleted. ${errors.join('; ')}` : ''}`);
		},
		onSettled: (_data, _error, targets) => {
			setBusy(false);
			setConfirming(null);
			void client.invalidateQueries({ queryKey: ['artifacts'] });
			for (const id of new Set(targets.map((item) => item.sessionId))) void client.invalidateQueries({ queryKey: ['outputs', id] });
		},
	});
	return (
		<div className="in-card flex flex-col gap-2 p-3" aria-label="Artifact selection">
			<div className="flex flex-wrap items-center gap-2">
				<span className="text-[13px] text-(--text-primary)" role="status">{picked.length} selected</span>
				<Btn size="sm" variant="ghost" disabled={busy} onClick={() => setSelected(new Set(shown.map(artifactKey)))}>Select all {shown.length} matching</Btn>
				<Btn size="sm" variant="ghost" disabled={busy || !picked.length} onClick={() => setSelected(new Set())}>Clear selection</Btn>
				<span className="flex-1" />
				<Btn size="sm" variant="ghost" icon={Download} disabled={busy || !picked.length || picked.length > 1000} onClick={() => api.downloadArtifacts(picked)}>Download ZIP</Btn>
				<Btn size="sm" variant="ghost" icon={Trash2} disabled={busy || !picked.length} onClick={() => { setResult(''); setConfirming(selected); }}>{busy ? `Deleting… ${progress}` : 'Delete selected'}</Btn>
				<Btn size="sm" variant="ghost" disabled={busy} onClick={onClose}>Done</Btn>
			</div>
			{picked.length > 1000 ? <p className="m-0 text-[12px] text-(--text-secondary)">Download up to 1,000 artifacts at a time.</p> : null}
			{confirming === selected ? (
				<div role="alert" className="flex flex-wrap items-center gap-2 text-[12px] text-(--text-secondary)">
					<span>Permanently delete {picked.length} artifact{picked.length === 1 ? '' : 's'}? They leave their tasks’ Libraries too. This cannot be undone.</span>
					<Btn size="sm" variant="ghost" disabled={busy} onClick={() => { setBusy(true); setProgress(0); remove.mutate(picked); }}>Confirm delete selected</Btn>
					<Btn size="sm" variant="ghost" disabled={busy} onClick={() => setConfirming(null)}>Cancel</Btn>
				</div>
			) : null}
			{result ? <p role="status" className="m-0 text-[12px] text-(--text-secondary)">{result}</p> : null}
		</div>
	);
}

/** Adds files of your own, such as a skill's SKILL.md, which any task can then be given from the composer's + menu. */
function AddFiles() {
	const picker = useRef<HTMLInputElement>(null);
	const queryClient = useQueryClient();
	const add = useMutation({
		mutationFn: async (files: File[]) => {
			for (const file of files) await api.addArtifact(file);
		},
		onSettled: () => void queryClient.invalidateQueries({ queryKey: ['artifacts'] }),
	});
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
			{add.isError ? <span className="text-[12px] text-(--danger-text)">{add.error.message}</span> : null}
			<Btn size="sm" variant="ghost" icon={Upload} disabled={add.isPending} onClick={() => picker.current?.click()} className="shrink-0">
				{add.isPending ? 'Adding…' : 'Add files'}
			</Btn>
		</>
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
	const [previews, setPreviews] = useState(false);
	const [selecting, setSelecting] = useState(false);
	const [selected, setSelected] = useState(new Set<string>());
	const [busy, setBusy] = useState(false);
	const [pagination, setPagination] = useState({ scope: '', page: 1 });
	const found = useMemo(() => (query ? all.filter((artifact) => matches(artifact, query)) : all), [all, query]);
	const counts = useMemo(() => {
		const byCategory = new Map<Category, number>();
		for (const artifact of found) byCategory.set(categoryOf(artifact.path), (byCategory.get(categoryOf(artifact.path)) ?? 0) + 1);
		return byCategory;
	}, [found]);
	const shown = type ? found.filter((artifact) => categoryOf(artifact.path) === type) : found;
	const apps = shown.filter((artifact) => categoryOf(artifact.path) === 'app');
	const files = shown.filter((artifact) => categoryOf(artifact.path) !== 'app');
	const ordered = type ? shown : [...apps, ...files];
	const scope = JSON.stringify([type, query]);
	const pages = Math.max(1, Math.ceil(shown.length / PAGE_SIZE));
	const page = Math.min(pagination.scope === scope ? pagination.page : 1, pages);
	const visible = ordered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
	const setSearch = (next: ArtifactsSearch) => {
		setSelected(new Set());
		void navigate({ to: '/artifacts', search: next, replace: true });
	};
	const grid = (items: Artifact[]) => <Grid items={items} previews={previews} selecting={selecting} selected={selected} disabled={busy} onSelect={(item) => setSelected((current) => {
		const next = new Set(current);
		const key = artifactKey(item);
		if (next.has(key)) next.delete(key); else next.add(key);
		return next;
	})} />;

	return (
		<PageFrame title="Artifacts">
			<div className="flex flex-wrap items-center gap-2">
				<Segmented label="Kind" className="max-w-full overflow-x-auto">
					<SegmentedItem size="sm" disabled={busy} on={!type} onClick={() => setSearch({ q: query || undefined })}>
						All
						<span className="in-num text-(--text-disabled)">{found.length}</span>
					</SegmentedItem>
					{CATEGORIES.filter((category) => counts.get(category.key) || type === category.key).map((category) => (
						<SegmentedItem key={category.key} size="sm" disabled={busy} on={type === category.key} onClick={() => setSearch({ type: category.key, q: query || undefined })}>
							{category.label}
							<span className="in-num text-(--text-disabled)">{counts.get(category.key) ?? 0}</span>
						</SegmentedItem>
					))}
				</Segmented>
				<span className="min-w-0 flex-1" />
				{!selecting ? <Btn size="sm" variant="ghost" icon={CheckSquare} disabled={!shown.length} onClick={() => setSelecting(true)}>Select</Btn> : null}
				<AddFiles />
				<label className="flex h-8 w-full items-center gap-2 rounded-[9px] border border-(--border-subtle) bg-(--well-bg) px-2.5 focus-within:border-(--border-default) sm:w-[240px]">
					<Icon icon={Search} size={12} className="shrink-0 text-(--icon-tertiary)" />
					<input
						disabled={busy}
						value={query}
						onChange={(event) => setSearch({ type, q: event.target.value || undefined })}
						onKeyDown={(event) => event.key === 'Escape' && setSearch({ type })}
						placeholder="Search artifacts"
						aria-label="Search artifacts"
						className="min-w-0 flex-1 border-0 bg-transparent p-0 text-[13px] text-(--text-primary) outline-none"
					/>
					{query ? (
						<button type="button" disabled={busy} aria-label="Clear search" onClick={() => setSearch({ type })} className="inline-flex shrink-0 text-(--icon-tertiary) hover:text-(--text-primary)">
							<Icon icon={X} size={12} />
						</button>
					) : null}
				</label>
			</div>
			<div className="flex flex-wrap items-center gap-3 text-[12px] text-(--text-tertiary)">
				<label className="flex cursor-pointer items-center gap-2"><input type="checkbox" checked={previews} onChange={(event) => setPreviews(event.target.checked)} />Live app previews</label>
				<span>{previews ? 'Only on-screen apps run. Scrolling away reloads their previews.' : 'Apps run only when opened to keep this gallery light.'}</span>
			</div>
			{selecting ? <SelectionActions items={all} shown={shown} selected={selected} setSelected={setSelected} busy={busy} setBusy={setBusy} onClose={() => { setSelecting(false); setSelected(new Set()); }} /> : null}

			{artifacts.isPending ? (
				<div className="flex h-7 items-center gap-2 text-[12px] text-(--text-tertiary)">
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
				grid(visible)
			) : (
				<>
					{visible.some((item) => categoryOf(item.path) === 'app') ? (
						<Section label="Apps" count={apps.length}>
							{grid(visible.filter((item) => categoryOf(item.path) === 'app'))}
						</Section>
					) : null}
					{visible.some((item) => categoryOf(item.path) !== 'app') ? (
						<Section label="Files" count={files.length}>
							{grid(visible.filter((item) => categoryOf(item.path) !== 'app'))}
						</Section>
					) : null}
				</>
			)}
			{shown.length > PAGE_SIZE ? <nav aria-label="Artifact pages" className="flex items-center justify-center gap-3">
				<Btn size="sm" variant="ghost" disabled={busy || page === 1} onClick={() => setPagination({ scope, page: page - 1 })}>Previous page</Btn>
				<span role="status" className="text-[12px] text-(--text-tertiary)">Page {page} of {pages} · {shown.length} artifacts</span>
				<Btn size="sm" variant="ghost" disabled={busy || page === pages} onClick={() => setPagination({ scope, page: page + 1 })}>Next page</Btn>
			</nav> : null}
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
					<h1 className="m-0 min-w-0 truncate text-[13px] font-medium text-(--text-primary)">{artifact.title}</h1>
					<TaskLink artifact={artifact} className="hidden min-w-0 truncate text-[12px] text-(--text-tertiary) outline-none hover:text-(--text-secondary) focus-visible:shadow-(--focus-ring) sm:inline">
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
			{remove.isError ? <div className="border-b border-(--border-subtle) px-3 py-1.5 text-[12px] text-(--danger-text)">{remove.error.message}</div> : null}
			<div className={cn('min-h-0 flex-1', app && !code ? 'overflow-hidden' : 'overflow-y-auto')}>{body}</div>
		</div>
	);
}

/** Copies the file's text, read when first asked for. */
function CopiedText({ sessionId, path }: { sessionId: string; path: string }) {
	const content = useQuery({ queryKey: ['output', sessionId, path], queryFn: () => api.outputText(sessionId, path), staleTime: 60_000 });
	return content.data !== undefined ? <CopyButton text={content.data} label="Copy contents" className="sg-btn--sm" /> : null;
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { ArrowUpRight, ChevronLeft, Download, ExternalLink, MoreVertical, Search, Trash2, X } from 'lucide-react';
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
import { api, type Artifact, outputUrl, SAFETY_NET_MS } from '@/lib/api';
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

/** Where the task an artifact came from is: a project's thread opens inside its project. */
function TaskLink({ artifact, className, children }: { artifact: Artifact; className?: string; children: ReactNode }) {
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

/** True once the element has come near the screen, so cards fetch what they show only then. */
function useSeen<T extends Element>(): [React.RefObject<T | null>, boolean] {
	const ref = useRef<T>(null);
	const [seen, setSeen] = useState(false);
	useEffect(() => {
		const element = ref.current;
		if (!element || seen) return;
		if (typeof IntersectionObserver === 'undefined') return setSeen(true);
		const observer = new IntersectionObserver((entries) => entries.some((entry) => entry.isIntersecting) && setSeen(true), { rootMargin: '200px' });
		observer.observe(element);
		return () => observer.disconnect();
	}, [seen]);
	return [ref, seen];
}

/** The first lines of a text file, faded out at the card's edge. */
function Snippet({ artifact }: { artifact: Artifact }) {
	const text = useQuery({
		queryKey: ['output', artifact.sessionId, artifact.path],
		queryFn: () => api.outputText(artifact.sessionId, artifact.path),
		staleTime: 60_000,
	});
	return (
		<pre className="m-0 h-full overflow-hidden px-3.5 pt-3 font-mono text-[9.5px] leading-[14px] whitespace-pre-wrap wrap-anywhere text-(--text-tertiary) [mask-image:linear-gradient(180deg,#000_55%,transparent)]">
			{(text.data ?? '').slice(0, 1200)}
		</pre>
	);
}

/** What a card shows of its artifact: the app itself, the image, a text file's first lines, or its kind. */
function Thumb({ artifact }: { artifact: Artifact }) {
	const [ref, seen] = useSeen<HTMLDivElement>();
	const category = categoryOf(artifact.path);
	const info = categoryInfo(category);
	let body: ReactNode = null;
	if (seen && category === 'app') body = <PageThumbnail sessionId={artifact.sessionId} path={artifact.path} />;
	// A picture that cannot be read shows its kind instead of a broken image.
	else if (seen && kindOf(artifact.path) === 'image')
		body = (
			<span className="absolute inset-0">
				<OutputThumb item={artifact} />
			</span>
		);
	else if (seen && isText(artifact.path) && artifact.size < 256 * 1024) body = <Snippet artifact={artifact} />;
	else if (seen) {
		body = (
			<span className="flex h-full flex-col items-center justify-center gap-2">
				<Icon icon={info.icon} size={22} className={info.tone} />
				<span className="font-mono text-[10px] tracking-[0.08em] text-(--text-disabled)">{extensionOf(artifact.path)}</span>
			</span>
		);
	}
	return (
		<div ref={ref} className="relative aspect-[16/10] overflow-hidden border-b border-(--border-subtle) bg-(--bg-inset)">
			{body}
		</div>
	);
}

/** Opening it elsewhere, saving it, going to the task it came from, or deleting it. Delete asks twice inside the menu. */
function ArtifactMenu({ artifact }: { artifact: Artifact }) {
	const navigate = useNavigate();
	const app = categoryOf(artifact.path) === 'app';
	const [confirming, setConfirming] = useState(false);
	const remove = useDeleteArtifact(artifact);
	return (
		<Menu
			onOpenChange={(open) => {
				if (!open) setConfirming(false);
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
					<div className="max-w-[240px] px-2 pb-1 text-[11px] leading-[15px] text-(--text-tertiary)">It leaves the task's Library too. Replies that showed it say it was deleted.</div>
				) : null}
				{remove.isError ? <div className="max-w-[240px] px-2 pb-1 text-[11px] leading-[15px] text-(--danger-text)">{remove.error.message}</div> : null}
			</MenuContent>
		</Menu>
	);
}

/** One artifact: what it looks like, its name, and the task it came from. The whole card opens it; its menu sits above the link. */
function ArtifactCard({ artifact }: { artifact: Artifact }) {
	const info = categoryInfo(categoryOf(artifact.path));
	return (
		<div className="in-card group relative flex flex-col overflow-hidden transition-colors duration-(--duration-micro) hover:border-(--border-default) has-[a:focus-visible]:shadow-(--focus-ring)">
			<Thumb artifact={artifact} />
			<div className="flex min-w-0 items-start gap-2 py-2.5 pr-1.5 pl-3">
				<Icon icon={info.icon} size={13} className={cn('mt-[3px] shrink-0', info.tone)} />
				<div className="flex min-w-0 flex-1 flex-col gap-0.5">
					<span className="truncate text-[13px] text-(--text-primary)">{artifact.title}</span>
					<span className="truncate text-[11.5px] text-(--text-tertiary)">
						{artifact.task.title} · {when(artifact)}
					</span>
				</div>
				<span className="relative z-10 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 has-data-[state=open]:opacity-100 pointer-coarse:opacity-100">
					<ArtifactMenu artifact={artifact} />
				</span>
			</div>
			<Link
				to="/artifacts/$taskId"
				params={{ taskId: artifact.sessionId }}
				search={{ path: artifact.path }}
				aria-label={`${artifact.title}, ${info.one.toLowerCase()} from ${artifact.task.title}`}
				className="absolute inset-0 outline-none"
			/>
		</div>
	);
}

function Grid({ items }: { items: Artifact[] }) {
	return (
		<div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
			{items.map((artifact) => (
				<ArtifactCard key={`${artifact.sessionId}/${artifact.path}`} artifact={artifact} />
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
	const setSearch = (next: ArtifactsSearch) => void navigate({ to: '/artifacts', search: next, replace: true });

	return (
		<PageFrame title="Artifacts">
			<div className="flex flex-wrap items-center gap-2">
				<Segmented label="Kind" className="max-w-full overflow-x-auto">
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
				<label className="flex h-8 w-full items-center gap-2 rounded-[9px] border border-(--border-subtle) bg-(--well-bg) px-2.5 focus-within:border-(--border-default) sm:w-[240px]">
					<Icon icon={Search} size={12} className="shrink-0 text-(--icon-tertiary)" />
					<input
						value={query}
						onChange={(event) => setSearch({ type, q: event.target.value || undefined })}
						onKeyDown={(event) => event.key === 'Escape' && setSearch({ type })}
						placeholder="Search artifacts"
						aria-label="Search artifacts"
						className="min-w-0 flex-1 border-0 bg-transparent p-0 text-[13px] text-(--text-primary) outline-none"
					/>
					{query ? (
						<button type="button" aria-label="Clear search" onClick={() => setSearch({ type })} className="inline-flex shrink-0 text-(--icon-tertiary) hover:text-(--text-primary)">
							<Icon icon={X} size={12} />
						</button>
					) : null}
				</label>
			</div>

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
					body="Apps the agent draws in a reply, and the reports, images and data it saves, gather here from every task."
				/>
			) : shown.length === 0 ? (
				<EmptyState title="Nothing matches" body={query ? 'Try other words, or clear the search.' : 'Pick another kind, or All.'} />
			) : type ? (
				<Grid items={shown} />
			) : (
				<>
					{apps.length ? (
						<Section label="Apps" count={apps.length}>
							<Grid items={apps} />
						</Section>
					) : null}
					{files.length ? (
						<Section label="Files" count={files.length}>
							<Grid items={files} />
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
	const session = useQuery({ queryKey: ['session', sessionId], queryFn: () => api.session(sessionId) });
	const listed = artifacts.data?.artifacts.find((artifact) => artifact.sessionId === sessionId && artifact.path === path);
	const artifact: Artifact = listed ?? {
		sessionId,
		path,
		title: nameOf(path),
		size: 0,
		mtimeMs: Date.now(),
		task: { title: session.data?.title ?? 'Task', spaceId: session.data?.spaceId ?? null, chat: false },
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

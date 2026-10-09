import { useQuery } from '@tanstack/react-query';
import { Folder, FolderOpen, PanelLeftClose, PanelLeftOpen, Search, X } from 'lucide-react';
import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { FileIcon, FileIcons } from '@/components/file-icons';
import { Branch, buildTree, FileView, isMarkdown, MarkdownToggle, StatusChip } from '@/components/file-view';
import { ResizeHandle, useStoredState } from '@/components/split-pane';
import { EmptyState, Icon, IconBtn, Spinner } from '@/components/signal';
import { api, refreshFor } from '@/lib/api';
import { matchPaths } from '@/lib/completion';
import { cn } from '@/lib/utils';

/** Paths that match a search, as a flat list. */
function Matches({
	paths,
	selected,
	onOpen,
	statusOf,
}: {
	paths: string[];
	selected: string | null;
	onOpen: (path: string) => void;
	statusOf: (path: string) => string | undefined;
}) {
	if (paths.length === 0) return <div className="px-2 py-1.5 text-[12px] text-(--text-tertiary)">No files match.</div>;
	return (
		<div className="flex flex-col gap-px">
			{paths.map((path) => {
				const status = statusOf(path);
				const slash = path.lastIndexOf('/');
				return (
					<button
						type="button"
						key={path}
						onClick={() => onOpen(path)}
						aria-current={selected === path ? 'true' : undefined}
						className="sg-file-row flex h-[26px] items-center gap-2 rounded-[7px] pr-1.5 pl-2 text-left outline-none hover:bg-(--bg-hover) focus-visible:shadow-(--focus-ring)"
					>
						<FileIcon path={path} />
						<span className={cn('shrink-0 text-[12px]', selected === path ? 'text-(--text-primary)' : 'text-(--text-secondary)')}>{path.slice(slash + 1)}</span>
						<span className="min-w-0 flex-1 truncate text-[11px] text-(--text-disabled)">{path.slice(0, Math.max(slash, 0))}</span>
						{status ? <StatusChip status={status} /> : null}
					</button>
				);
			})}
		</div>
	);
}

const MATCHES_SHOWN = 200;

/** The file tree's width: remembered, and kept between these bounds; the viewer beside it takes the rest. */
const TREE_DEFAULT = 220;
const TREE_MIN = 140;
/** The open file keeps at least this much room. */
const VIEWER_MIN = 200;

export function FilesTab({ sessionId }: { sessionId: string }) {
	const [selected, setSelected] = useState<string | null>(null);
	const [opened, setOpened] = useState<string[]>([]);
	const viewerId = useId();
	const open = (path: string) => {
		setOpened((current) => (current.includes(path) ? current : [...current, path]));
		setSelected(path);
	};
	const close = (path: string) => {
		const next = opened.filter((item) => item !== path);
		setOpened(next);
		if (selected === path) setSelected(next[Math.min(opened.indexOf(path), next.length - 1)] ?? null);
	};
	const [query, setQuery] = useState('');
	// How each open Markdown file shows, chosen in the tab bar; rendered until you pick its source.
	const [sourceShown, setSourceShown] = useState<Set<string>>(() => new Set());
	const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
	const listing = useQuery({
		queryKey: ['files', sessionId],
		queryFn: () => api.files(sessionId),
		refetchInterval: (query) => refreshFor(query.state.data?.source),
	});
	const tree = useMemo(() => buildTree(listing.data?.paths ?? []), [listing.data?.paths]);
	const changes = useMemo(() => new Map((listing.data?.changes ?? []).map((change) => [change.path, change.status])), [listing.data?.changes]);

	function statusOf(path: string, folder: boolean) {
		if (!folder) return changes.get(path);
		for (const changed of changes.keys()) if (changed.startsWith(`${path}/`)) return 'M';
		return undefined;
	}


	// The tree has its own width, which you drag; beside an open file it can also be put away to read the file wide.
	const [treeWidth, setTreeWidth] = useStoredState('anton.files.tree-width', TREE_DEFAULT);
	const [treeHidden, setTreeHidden] = useStoredState('anton.files.tree-hidden', false);
	const row = useRef<HTMLDivElement>(null);
	const [rowWidth, setRowWidth] = useState(0);
	useLayoutEffect(() => {
		const element = row.current;
		if (!element) return;
		const measure = () => setRowWidth(Math.round(element.getBoundingClientRect().width));
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, []);
	const treeMax = Math.max(TREE_MIN, (rowWidth || 800) - VIEWER_MIN);
	const width = Math.min(treeMax, Math.max(TREE_MIN, treeWidth));
	const showTree = !selected || !treeHidden;

	return (
		<FileIcons>
			<div className="flex min-h-0 flex-1 flex-col gap-1">
				<div ref={row} className="flex min-h-0 flex-1">
					<div
						aria-label="File tree"
						hidden={!showTree}
						className={cn('min-h-0 shrink-0 flex-col overflow-auto', showTree ? 'flex' : 'hidden')}
						style={{ width }}
					>
						<label className="sg-file-search mb-1.5 flex h-8 shrink-0 items-center gap-2 rounded-lg border border-(--border-subtle) bg-(--well-bg) px-2.5">
							<Icon icon={Search} size={12} className="text-(--icon-tertiary)" />
							<input
								value={query}
								onChange={(event) => setQuery(event.target.value)}
								onKeyDown={(event) => {
									if (event.key === 'Escape') setQuery('');
								}}
								placeholder="Find a file"
								aria-label="Find a file"
								className="min-w-0 flex-1 bg-transparent text-[12px] text-(--text-primary) outline-none placeholder:text-(--text-disabled)"
							/>
						</label>
						{listing.isError ? (
							<EmptyState title="Files unavailable" body={listing.error.message} />
						) : listing.isPending ? (
							<div className="flex h-7 items-center gap-2 text-[12px] text-(--text-tertiary)">
								<Spinner size={12} />
								Listing files
							</div>
						) : query.trim() ? (
							<Matches
								selected={selected}
								paths={matchPaths(listing.data.paths, query.trim(), MATCHES_SHOWN)}
								onOpen={open}
								statusOf={(path) => changes.get(path)}
							/>
						) : tree.children.size === 0 ? (
							<EmptyState icon={Folder} title="Repository is empty" body="Files the agent creates show up here." />
						) : (
							<Branch
								selected={selected}
								node={tree}
								depth={0}
								expanded={expanded}
								onToggle={(path) =>
									setExpanded((current) => {
										const next = new Set(current);
										if (next.has(path)) next.delete(path);
										else next.add(path);
										return next;
									})
								}
								onOpen={open}
								statusOf={statusOf}
							/>
						)}
					</div>
					{showTree ? (
						<ResizeHandle label="Resize the file tree" width={width} min={TREE_MIN} max={treeMax} initial={TREE_DEFAULT} onResize={setTreeWidth} className="mx-0.5" />
					) : null}
					<div className="in-well flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-(--bg-inset)">
						{opened.length ? (
							<div className="flex shrink-0 items-center gap-1 border-b border-(--border-subtle) bg-[linear-gradient(180deg,var(--card-bg-top),var(--card-bg))] p-1">
								<IconBtn
									icon={treeHidden ? PanelLeftOpen : PanelLeftClose}
									size="xs"
									label={treeHidden ? 'Show the file tree' : 'Hide the file tree'}
									aria-pressed={!treeHidden}
									onClick={() => setTreeHidden(!treeHidden)}
									className="shrink-0"
								/>
								<span aria-hidden className="h-4 w-px shrink-0 bg-(--border-subtle)" />
								<div role="tablist" aria-label="Open files" className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
								{opened.map((path) => (
									<div
										key={path}
										className={cn(
											'group flex shrink-0 items-center gap-1 rounded-[7px] border',
											selected === path ? 'border-(--card-border) bg-[linear-gradient(180deg,var(--neutral-750),var(--neutral-800))] shadow-(--card-highlight)' : 'border-transparent hover:bg-(--bg-hover)',
										)}
									>
										<button
											type="button"
											role="tab"
											id={`${viewerId}-${encodeURIComponent(path)}`}
											aria-controls={viewerId}
											aria-selected={selected === path}
											title={path}
											onClick={() => setSelected(path)}
											className={cn(
												'flex h-[26px] items-center gap-1.5 rounded-[7px] px-2 text-[12px] outline-none focus-visible:shadow-(--focus-ring)',
												selected === path ? 'text-(--text-primary)' : 'text-(--text-secondary)',
											)}
										>
											<FileIcon path={path} />
											{path.split('/').pop()}
										</button>
										<IconBtn icon={X} size="xs" label={`Close ${path}`} onClick={() => close(path)} className="mr-1" />
									</div>
								))}
								</div>
								{selected && isMarkdown(selected) ? (
									<MarkdownToggle
										preview={!sourceShown.has(selected)}
										onChange={(preview) =>
											setSourceShown((current) => {
												const next = new Set(current);
												if (preview) next.delete(selected);
												else next.add(selected);
												return next;
											})
										}
										className="shrink-0"
									/>
								) : null}
							</div>
						) : null}
						{selected ? (
							<div role="tabpanel" id={viewerId} aria-labelledby={`${viewerId}-${encodeURIComponent(selected)}`} className="flex min-h-0 flex-1 flex-col">
								<FileView
										key={selected}
										path={selected}
										queryKey={['file', sessionId, selected]}
										read={() => api.file(sessionId, selected)}
										preview={!sourceShown.has(selected)}
									/>
							</div>
						) : (
							<EmptyState icon={FolderOpen} title="Open a file" body="Select a file to view its contents." />
						)}
					</div>
				</div>
			</div>
		</FileIcons>
	);
}

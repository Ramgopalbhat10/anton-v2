import { useQuery } from '@tanstack/react-query';
import { Folder, FolderOpen, Search, X } from 'lucide-react';
import { useEffect, useId, useMemo, useState } from 'react';
import { FileIcon, FileIcons } from '@/components/file-icons';
import { Branch, buildTree, FileView, STATUS_TONE } from '@/components/file-view';
import { SourceBar } from '@/components/source-bar';
import { EmptyState, Icon, IconBtn, Spinner } from '@/components/signal';
import { api, branchLabel, refreshFor } from '@/lib/api';
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
						className="sg-file-row flex h-[26px] items-center gap-2 rounded-md px-2 text-left outline-none hover:bg-(--bg-hover) focus-visible:shadow-(--focus-ring)"
					>
						<FileIcon path={path} />
						<span className={cn('shrink-0 text-[12px]', selected === path ? 'text-(--text-primary)' : 'text-(--text-secondary)')}>{path.slice(slash + 1)}</span>
						<span className="min-w-0 flex-1 truncate text-[11px] text-(--text-disabled)">{path.slice(0, Math.max(slash, 0))}</span>
						{status ? <span className={cn('text-[11px]', STATUS_TONE[status])}>{status}</span> : null}
					</button>
				);
			})}
		</div>
	);
}

const MATCHES_SHOWN = 200;

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
	const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
	const session = useQuery({ queryKey: ['session', sessionId], queryFn: () => api.session(sessionId) });
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

	const heading = session.data ? `${session.data.repo.split('/').pop()}/${branchLabel(session.data)}` : '';

	return (
		<FileIcons>
			<div className="flex min-h-0 flex-1 flex-col gap-1">
				<SourceBar sessionId={sessionId} source={listing.data?.source} at={listing.data?.at}>
					<span className="truncate text-(--text-disabled) uppercase">{heading}</span>
				</SourceBar>
				<div className="flex min-h-0 flex-1 gap-3">
					<div className={cn('flex min-h-0 shrink-0 flex-col overflow-auto', selected ? 'w-[38%] min-w-28 max-w-60' : 'flex-1')}>
						<label className="sg-file-search mb-1 flex h-8 shrink-0 items-center gap-2 rounded-lg bg-(--bg-surface) px-2.5">
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
					<div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-(--border-subtle)">
						{opened.length ? (
							<div role="tablist" aria-label="Open files" className="flex shrink-0 gap-1 overflow-x-auto bg-(--bg-surface) p-1">
								{opened.map((path) => (
									<div key={path} className={cn('group flex shrink-0 items-center gap-1 rounded-md', selected === path && 'bg-(--bg-overlay)')}>
										<button
											type="button"
											role="tab"
											id={`${viewerId}-${encodeURIComponent(path)}`}
											aria-controls={viewerId}
											aria-selected={selected === path}
											title={path}
											onClick={() => setSelected(path)}
											className="flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] text-(--text-secondary) outline-none focus-visible:shadow-(--focus-ring)"
										>
											<FileIcon path={path} />
											{path.split('/').pop()}
										</button>
										<IconBtn icon={X} size="xs" label={`Close ${path}`} onClick={() => close(path)} className="mr-1" />
									</div>
								))}
							</div>
						) : null}
						{selected ? (
							<div role="tabpanel" id={viewerId} aria-labelledby={`${viewerId}-${encodeURIComponent(selected)}`} className="flex min-h-0 flex-1 flex-col">
								<FileView key={selected} path={selected} queryKey={['file', sessionId, selected]} read={() => api.file(sessionId, selected)} />
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

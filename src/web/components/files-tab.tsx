import { useQuery } from '@tanstack/react-query';
import { Folder, FolderOpen, Search, X } from 'lucide-react';
import { useEffect, useId, useMemo, useState } from 'react';
import { FileIcon, FileIcons } from '@/components/file-icons';
import { Markdown } from '@/components/markdown';
import { SourceBar } from '@/components/source-bar';
import { Btn, EmptyState, Icon, IconBtn, Spinner } from '@/components/signal';
import { api, branchLabel, refreshFor } from '@/lib/api';
import { matchPaths } from '@/lib/completion';
import { highlight } from '@/lib/highlight';
import { cn } from '@/lib/utils';

type TreeNode = { name: string; path: string; children: Map<string, TreeNode>; file: boolean };

function buildTree(paths: string[]): TreeNode {
	const root: TreeNode = { name: '', path: '', children: new Map(), file: false };
	for (const path of paths) {
		let node = root;
		const parts = path.split('/').filter(Boolean);
		parts.forEach((part, index) => {
			const isFile = index === parts.length - 1;
			let child = node.children.get(part);
			if (!child) {
				child = { name: part, path: parts.slice(0, index + 1).join('/'), children: new Map(), file: isFile };
				node.children.set(part, child);
			}
			node = child;
		});
	}
	return root;
}

function sorted(node: TreeNode) {
	return [...node.children.values()].sort((a, b) => Number(a.file) - Number(b.file) || a.name.localeCompare(b.name));
}

const STATUS_TONE: Record<string, string> = {
	A: 'text-(--success-text)',
	M: 'text-(--warning-text)',
	D: 'text-(--danger-text)',
};

function Branch({
	node,
	selected,
	depth,
	expanded,
	onToggle,
	onOpen,
	statusOf,
}: {
	node: TreeNode;
	selected: string | null;
	depth: number;
	expanded: Set<string>;
	onToggle: (path: string) => void;
	onOpen: (path: string) => void;
	statusOf: (path: string, folder: boolean) => string | undefined;
}) {
	return (
		<div className="flex flex-col gap-px" style={{ paddingLeft: depth ? 16 : 0 }}>
			{sorted(node).map((child) => {
				const status = statusOf(child.path, !child.file);
				if (child.file) {
					return (
						<button
							type="button"
							key={child.path}
							onClick={() => onOpen(child.path)}
							aria-current={selected === child.path ? 'true' : undefined}
							className="sg-file-row flex h-[26px] items-center gap-2 rounded-md pr-2 pl-2 text-left outline-none hover:bg-(--bg-hover) focus-visible:shadow-(--focus-ring)"
						>
							<FileIcon path={child.path} />
							<span
								className={cn(
									'min-w-0 flex-1 truncate text-[12px]',
									selected === child.path ? 'text-(--text-primary)' : status ? 'text-(--text-secondary)' : 'text-(--text-tertiary)',
								)}
							>
								{child.name}
							</span>
							{status ? <span className={cn('text-[11px]', STATUS_TONE[status])}>{status}</span> : null}
						</button>
					);
				}
				const open = expanded.has(child.path);
				return (
					<div key={child.path} className="flex flex-col gap-px">
						<button
							type="button"
							aria-expanded={open}
							onClick={() => onToggle(child.path)}
							className="flex h-[26px] items-center gap-2 rounded-md px-2 text-left text-(--text-secondary) outline-none hover:bg-(--bg-hover) focus-visible:shadow-(--focus-ring)"
						>
							<Icon icon={open ? FolderOpen : Folder} size={12} className="text-(--icon-tertiary)" />
							<span className="min-w-0 flex-1 truncate text-[12px]">{child.name}</span>
							{status ? <span className={cn('text-[11px]', STATUS_TONE[status])}>{status}</span> : null}
						</button>
						{open ? (
							<Branch selected={selected} node={child} depth={depth + 1} expanded={expanded} onToggle={onToggle} onOpen={onOpen} statusOf={statusOf} />
						) : null}
					</div>
				);
			})}
		</div>
	);
}

/** Decodes a file for display, or returns null for binary content. */
function asText(bytes: Uint8Array): string | null {
	if (bytes.subarray(0, 8000).includes(0)) return null;
	return new TextDecoder().decode(bytes);
}

const IMAGE_TYPES: Record<string, string> = {
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	svg: 'image/svg+xml',
	avif: 'image/avif',
	ico: 'image/x-icon',
	bmp: 'image/bmp',
};

function FileView({ sessionId, path }: { sessionId: string; path: string }) {
	const imageType = IMAGE_TYPES[path.split('.').pop()?.toLowerCase() ?? ''];
	const markdown = /\.(md|markdown|mdown)$/i.test(path);
	const [preview, setPreview] = useState(true);
	const [imageUrl, setImageUrl] = useState('');
	const file = useQuery({ queryKey: ['file', sessionId, path], queryFn: () => api.file(sessionId, path) });
	const contents = file.data && !imageType ? asText(file.data) : '';
	useEffect(() => {
		if (!file.data || !imageType) return;
		const url = URL.createObjectURL(new Blob([new Uint8Array(file.data)], { type: imageType }));
		setImageUrl(url);
		return () => URL.revokeObjectURL(url);
	}, [file.data, imageType]);
	const colored = useQuery({
		queryKey: ['highlight', sessionId, path, file.dataUpdatedAt],
		queryFn: () => highlight(contents ?? '', path),
		enabled: Boolean(contents) && !imageType && (!markdown || !preview),
		staleTime: Number.POSITIVE_INFINITY,
	});
	const tokens = colored.data ?? null;
	return (
		<div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-(--bg-inset)">
			{markdown ? (
				<div className="flex shrink-0 justify-end gap-1 bg-(--bg-raised) px-2 py-1">
					<Btn size="xs" variant={!preview ? 'secondary' : 'ghost'} aria-pressed={!preview} onClick={() => setPreview(false)}>
						Source
					</Btn>
					<Btn size="xs" variant={preview ? 'secondary' : 'ghost'} aria-pressed={preview} onClick={() => setPreview(true)}>
						Preview
					</Btn>
				</div>
			) : null}
			<div className="min-h-0 flex-1 overflow-auto">
				{file.isError ? (
					<div className="px-3 py-2.5 text-[12px] text-(--danger-text)">{file.error.message || 'Could not read this file.'}</div>
				) : file.isPending ? (
					<div className="flex items-center gap-2 px-3 py-2.5 text-[12px] text-(--text-tertiary)">
						<Spinner size={12} />
						Reading
					</div>
				) : imageType ? (
					<div className="flex min-h-40 items-center justify-center p-4">
						<img src={imageUrl} alt={path.split('/').pop()} className="max-h-full max-w-full object-contain" />
					</div>
				) : markdown && preview && contents !== null ? (
					<div className="p-4">
						<Markdown text={contents} />
					</div>
				) : contents === null ? (
					<div className="px-3 py-2.5 text-[12px] text-(--text-tertiary)">Binary file, {file.data.length.toLocaleString()} bytes.</div>
				) : (
					<div className="overflow-x-auto py-1.5 font-mono text-[12px] leading-[18px]">
						<div className="min-w-max">
							{contents.split('\n').map((line, index) => (
								<div key={index} className="flex">
									<span className="w-11 shrink-0 pr-2.5 text-right text-(--text-disabled)">{index + 1}</span>
									<span className="pr-3 pl-2 whitespace-pre text-(--text-secondary)">
										{tokens?.[index]
											? tokens[index].map((token, at) => (
													<span key={at} style={{ color: token.color }}>
														{token.content}
													</span>
												))
											: line}
									</span>
								</div>
							))}
						</div>
					</div>
				)}
			</div>
		</div>
	);
}

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
								<FileView key={selected} sessionId={sessionId} path={selected} />
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

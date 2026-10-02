import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, Folder, FolderOpen } from 'lucide-react';
import { useMemo, useState } from 'react';
import { SourceBar } from '@/components/source-bar';
import { Btn, EmptyState, Icon, Spinner } from '@/components/signal';
import { api, refreshFor } from '@/lib/api';
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
	depth,
	expanded,
	onToggle,
	onOpen,
	statusOf,
}: {
	node: TreeNode;
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
							className="flex h-[26px] items-center gap-2 rounded-md pr-2 pl-7 text-left outline-none hover:bg-(--bg-hover) focus-visible:shadow-(--focus-ring)"
						>
							<span className={cn('min-w-0 flex-1 truncate text-[12px]', status ? 'text-(--text-secondary)' : 'text-(--text-tertiary)')}>
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
							<Branch node={child} depth={depth + 1} expanded={expanded} onToggle={onToggle} onOpen={onOpen} statusOf={statusOf} />
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

function FileView({ sessionId, path, status, onBack }: { sessionId: string; path: string; status?: string; onBack: () => void }) {
	const file = useQuery({ queryKey: ['file', sessionId, path], queryFn: () => api.file(sessionId, path) });
	const contents = file.data ? asText(file.data) : '';
	return (
		<div className="flex flex-col gap-2">
			<div className="flex h-7 items-center gap-2">
				<Btn variant="ghost" size="xs" icon={ChevronLeft} onClick={onBack}>
					Files
				</Btn>
			</div>
			<div className="overflow-hidden rounded-lg bg-(--bg-inset)">
				<div className="flex h-8 items-center gap-2 bg-(--bg-raised) px-3">
					<div className="min-w-0 flex-1 truncate text-[12px]">{path}</div>
					{status ? <span className={cn('text-[11px]', STATUS_TONE[status])}>{status}</span> : null}
				</div>
				{file.isError ? (
					<div className="px-3 py-2.5 text-[12px] text-(--danger-text)">{file.error.message || 'Could not read this file.'}</div>
				) : file.isPending ? (
					<div className="flex items-center gap-2 px-3 py-2.5 text-[12px] text-(--text-tertiary)">
						<Spinner size={12} />
						Reading
					</div>
				) : contents === null ? (
					<div className="px-3 py-2.5 text-[12px] text-(--text-tertiary)">Binary file, {file.data.length.toLocaleString()} bytes.</div>
				) : (
					<div className="overflow-x-auto py-1.5 font-mono text-[12px] leading-[18px]">
						<div className="min-w-max">
							{contents.split('\n').map((line, index) => (
								<div key={index} className="flex">
									<span className="w-11 shrink-0 pr-2.5 text-right text-(--text-disabled)">{index + 1}</span>
									<span className="pr-3 pl-2 whitespace-pre text-(--text-secondary)">{line}</span>
								</div>
							))}
						</div>
					</div>
				)}
			</div>
		</div>
	);
}

export function FilesTab({ sessionId }: { sessionId: string }) {
	const [selected, setSelected] = useState<string | null>(null);
	const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
	const session = useQuery({ queryKey: ['session', sessionId], queryFn: () => api.session(sessionId) });
	const listing = useQuery({
		queryKey: ['files', sessionId],
		queryFn: () => api.files(sessionId),
		refetchInterval: (query) => refreshFor(query.state.data?.source),
	});
	const tree = useMemo(() => buildTree(listing.data?.paths ?? []), [listing.data?.paths]);
	const changes = useMemo(
		() => new Map((listing.data?.changes ?? []).map((change) => [change.path, change.status])),
		[listing.data?.changes],
	);

	function statusOf(path: string, folder: boolean) {
		if (!folder) return changes.get(path);
		for (const changed of changes.keys()) if (changed.startsWith(`${path}/`)) return 'M';
		return undefined;
	}

	if (selected) {
		return <FileView sessionId={sessionId} path={selected} status={changes.get(selected)} onBack={() => setSelected(null)} />;
	}

	const heading = session.data ? `${session.data.repo.split('/').pop()}/${session.data.branch}` : '';

	return (
		<div className="flex flex-col gap-1">
			<SourceBar sessionId={sessionId} source={listing.data?.source} at={listing.data?.at}>
				<span className="truncate text-(--text-disabled) uppercase">{heading}</span>
			</SourceBar>
			{listing.isError ? (
				<EmptyState title="Files unavailable" body={listing.error.message} />
			) : listing.isPending ? (
				<div className="flex h-7 items-center gap-2 text-[12px] text-(--text-tertiary)">
					<Spinner size={12} />
					Listing files
				</div>
			) : tree.children.size === 0 ? (
				<EmptyState icon={Folder} title="Repository is empty" body="Files the agent creates show up here." />
			) : (
				<Branch
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
					onOpen={setSelected}
					statusOf={statusOf}
				/>
			)}
		</div>
	);
}

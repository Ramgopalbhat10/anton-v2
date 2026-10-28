import { useQuery } from '@tanstack/react-query';
import { Code, Eye, Folder, FolderOpen } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { FileIcon } from '@/components/file-icons';
import { Markdown } from '@/components/markdown';
import { Segmented, SegmentedItem } from '@/components/instrument';
import { Icon, Spinner } from '@/components/signal';
import { highlight } from '@/lib/highlight';
import { cn } from '@/lib/utils';

/** A folder tree and a file viewer, shared by a task's Files panel and plugin previews. */

type TreeNode = { name: string; path: string; children: Map<string, TreeNode>; file: boolean };

export function buildTree(paths: string[]): TreeNode {
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

/**
 * The tree with each run of folders that hold only one folder folded into
 * one row, `src/web/components`, as editors show a sparse tree. Each folded
 * row takes its deepest folder's path.
 */
export function compactTree(node: TreeNode): TreeNode {
	const children = new Map<string, TreeNode>();
	for (const [key, child] of node.children) {
		let folded = child;
		while (!folded.file && folded.children.size === 1) {
			const only = [...folded.children.values()][0];
			if (only.file) break;
			folded = { ...only, name: `${folded.name}/${only.name}` };
		}
		children.set(key, folded.file ? folded : compactTree(folded));
	}
	return { ...node, children };
}

function sorted(node: TreeNode) {
	return [...node.children.values()].sort((a, b) => Number(a.file) - Number(b.file) || a.name.localeCompare(b.name));
}

export const STATUS_TONE: Record<string, string> = {
	A: 'text-(--success-text)',
	M: 'text-(--warning-text)',
	D: 'text-(--danger-text)',
};

const STATUS_BG: Record<string, string> = {
	A: 'bg-(--success-bg)',
	M: 'bg-(--warning-bg)',
	D: 'bg-(--danger-bg)',
};

/** A file's git status as a small lettered chip: A added, M modified, D deleted. */
export function StatusChip({ status }: { status: string }) {
	return (
		<span className={cn('in-num inline-flex size-4 shrink-0 items-center justify-center rounded-[4px] text-[10px] font-medium', STATUS_TONE[status], STATUS_BG[status])}>
			{status}
		</span>
	);
}

export function Branch({
	node,
	selected,
	depth,
	expanded,
	onToggle,
	onOpen,
	statusOf,
	detailOf,
}: {
	node: TreeNode;
	selected: string | null;
	depth: number;
	expanded: Set<string>;
	onToggle: (path: string) => void;
	onOpen: (path: string) => void;
	statusOf?: (path: string, folder: boolean) => string | undefined;
	/** A small figure beside a file, such as the lines it adds. */
	detailOf?: (path: string) => ReactNode;
}) {
	return (
		<div className={cn('flex flex-col gap-px', depth > 0 && 'ml-[13px] border-l border-(--border-subtle) pl-1')}>
			{sorted(node).map((child) => {
				const status = statusOf?.(child.path, !child.file);
				if (child.file) {
					return (
						<button
							type="button"
							key={child.path}
							onClick={() => onOpen(child.path)}
							aria-current={selected === child.path ? 'true' : undefined}
							className="sg-file-row flex h-[26px] items-center gap-2 rounded-[7px] pr-1.5 pl-2 text-left outline-none hover:bg-(--bg-hover) focus-visible:shadow-(--focus-ring)"
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
							{detailOf?.(child.path)}
							{status ? <StatusChip status={status} /> : null}
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
							className="flex h-[26px] items-center gap-2 rounded-[7px] pr-1.5 pl-2 text-left text-(--text-secondary) outline-none hover:bg-(--bg-hover) focus-visible:shadow-(--focus-ring)"
						>
							<Icon icon={open ? FolderOpen : Folder} size={12} className={open ? 'text-(--icon-secondary)' : 'text-(--icon-tertiary)'} />
							<span className="min-w-0 flex-1 truncate text-[12px]">{child.name}</span>
							{status ? <StatusChip status={status} /> : null}
						</button>
						{open ? (
							<Branch selected={selected} node={child} depth={depth + 1} expanded={expanded} onToggle={onToggle} onOpen={onOpen} statusOf={statusOf} detailOf={detailOf} />
						) : null}
					</div>
				);
			})}
		</div>
	);
}

/** True when two reads of a file returned the same bytes. */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return false;
	return true;
}

/**
 * A number for each distinct read of a file. The highlighted copy is kept by
 * it, so a refetch that brings the same bytes reuses the colours it has
 * rather than highlighting the file again and caching another copy.
 */
const versions = new WeakMap<Uint8Array, number>();
let nextVersion = 0;
function versionOf(bytes: Uint8Array): number {
	let version = versions.get(bytes);
	if (version === undefined) versions.set(bytes, (version = nextVersion++));
	return version;
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

/** YAML front matter, as SKILL.md files open with, split from the Markdown after it. */
const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** Markdown rendered, with any front matter as a table of its fields rather than a stray heading. */
function RenderedMarkdown({ text }: { text: string }) {
	const front = FRONT_MATTER.exec(text);
	const fields = (front?.[1] ?? '')
		.split(/\r?\n/)
		.map((line) => /^([\w-]+):\s*(.*)$/.exec(line))
		.filter((match): match is RegExpExecArray => match !== null);
	return (
		<div className="flex flex-col gap-4 p-4">
			{fields.length ? (
				<table className="in-well w-full border-separate border-spacing-0 overflow-hidden text-[12px]">
					<tbody>
						{fields.map(([, key, value]) => (
							<tr key={key} className="[&:last-child>*]:border-b-0">
								<th className="in-caption w-[120px] border-b border-(--border-subtle) px-2.5 py-2 text-left align-top font-normal">{key}</th>
								<td className="border-b border-(--border-subtle) px-2.5 py-1.5 text-pretty text-(--text-secondary)">{value.replace(/^(["'])(.*)\1$/, '$2')}</td>
							</tr>
						))}
					</tbody>
				</table>
			) : null}
			<Markdown text={front && fields.length ? text.slice(front[0].length) : text} />
		</div>
	);
}

export const isMarkdown = (path: string) => /\.(md|markdown|mdown)$/i.test(path);

/** Two icons for how a Markdown file shows: its source, or rendered. */
export function MarkdownToggle({ preview, onChange, className }: { preview: boolean; onChange: (preview: boolean) => void; className?: string }) {
	return (
		<Segmented label="Show Markdown as" role="radiogroup" className={className}>
			{(
				[
					[false, Code, 'Source'],
					[true, Eye, 'Preview'],
				] as const
			).map(([value, icon, label]) => (
				<SegmentedItem key={label} role="radio" size="sm" on={preview === value} onClick={() => onChange(value)} title={label} className="px-1.5">
					<Icon icon={icon} size={12} />
					<span className="sr-only">{label}</span>
				</SegmentedItem>
			))}
		</Segmented>
	);
}

/**
 * One file: an image shown, Markdown rendered or as source, code highlighted
 * with line numbers, or a note for binary content. `read` fetches its bytes.
 * Pass `preview` to choose how Markdown shows from outside, as a tab bar does;
 * without it the file has its own icons for that, in its top corner.
 */
export function FileView({
	path,
	queryKey,
	read,
	preview: chosen,
	line: markedLine,
}: {
	path: string;
	queryKey: unknown[];
	read: () => Promise<Uint8Array>;
	preview?: boolean;
	/** A line to bring into view and mark, as when a reply links to it. */
	line?: number;
}) {
	const imageType = IMAGE_TYPES[path.split('.').pop()?.toLowerCase() ?? ''];
	const markdown = isMarkdown(path);
	const [own, setOwn] = useState(true);
	const preview = chosen ?? own;
	const [imageUrl, setImageUrl] = useState('');
	// Tool calls refetch open files; the same bytes keep the same array, so nothing below re-renders or re-highlights.
	const file = useQuery({ queryKey, queryFn: read, structuralSharing: (old, next) => (old instanceof Uint8Array && next instanceof Uint8Array && sameBytes(old, next) ? old : next) });
	const contents = useMemo(() => (file.data && !imageType ? asText(file.data) : ''), [file.data, imageType]);
	const lines = useMemo(() => (contents ? contents.split('\n') : []), [contents]);
	useEffect(() => {
		if (!file.data || !imageType) return;
		const url = URL.createObjectURL(new Blob([new Uint8Array(file.data)], { type: imageType }));
		setImageUrl(url);
		return () => URL.revokeObjectURL(url);
	}, [file.data, imageType]);
	const colored = useQuery({
		queryKey: ['highlight', ...queryKey, file.data ? versionOf(file.data) : -1],
		queryFn: () => highlight(contents ?? '', path),
		enabled: Boolean(contents) && !imageType && (!markdown || !preview),
		staleTime: Number.POSITIVE_INFINITY,
		// An earlier version's colours are only wanted again while the file shows it.
		gcTime: 10_000,
	});
	const tokens = colored.data ?? null;
	const marked = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (markedLine && lines.length) marked.current?.scrollIntoView({ block: 'center' });
	}, [markedLine, lines.length]);
	return (
		<div className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-(--bg-inset)">
			{markdown && chosen === undefined ? <MarkdownToggle preview={preview} onChange={setOwn} className="absolute top-2 right-3 z-10" /> : null}
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
					<RenderedMarkdown text={contents} />
				) : contents === null ? (
					<div className="px-3 py-2.5 text-[12px] text-(--text-tertiary)">Binary file, {file.data.length.toLocaleString()} bytes.</div>
				) : (
					<div className="overflow-x-auto py-1.5 font-mono text-[12px] leading-[19px]">
						<div className="min-w-max">
							{lines.map((line, index) => (
								<div key={index} ref={index + 1 === markedLine ? marked : undefined} className={cn('flex', index + 1 === markedLine && 'bg-(--accent-bg-subtle)')}>
									<span className="w-12 shrink-0 border-r border-(--border-subtle) pr-2.5 text-right text-(--text-disabled) select-none">{index + 1}</span>
									<span className="pr-3 pl-3 whitespace-pre text-(--text-secondary)">
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


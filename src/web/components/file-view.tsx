import { useQuery } from '@tanstack/react-query';
import { Folder, FolderOpen } from 'lucide-react';
import { useEffect, useState } from 'react';
import { FileIcon } from '@/components/file-icons';
import { Markdown } from '@/components/markdown';
import { Btn, Icon, Spinner } from '@/components/signal';
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

function sorted(node: TreeNode) {
	return [...node.children.values()].sort((a, b) => Number(a.file) - Number(b.file) || a.name.localeCompare(b.name));
}

export const STATUS_TONE: Record<string, string> = {
	A: 'text-(--success-text)',
	M: 'text-(--warning-text)',
	D: 'text-(--danger-text)',
};

export function Branch({
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
	statusOf?: (path: string, folder: boolean) => string | undefined;
}) {
	return (
		<div className="flex flex-col gap-px" style={{ paddingLeft: depth ? 16 : 0 }}>
			{sorted(node).map((child) => {
				const status = statusOf?.(child.path, !child.file);
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
				<table className="w-full border-collapse overflow-hidden rounded-lg text-[12px]">
					<tbody>
						{fields.map(([, key, value]) => (
							<tr key={key} className="border-b border-(--border-subtle) last:border-0">
								<th className="w-[120px] bg-(--bg-raised) px-2.5 py-1.5 text-left align-top font-mono font-normal text-(--text-tertiary)">{key}</th>
								<td className="bg-(--bg-surface) px-2.5 py-1.5 text-pretty text-(--text-secondary)">{value.replace(/^(["'])(.*)\1$/, '$2')}</td>
							</tr>
						))}
					</tbody>
				</table>
			) : null}
			<Markdown text={front && fields.length ? text.slice(front[0].length) : text} />
		</div>
	);
}

/**
 * One file: an image shown, Markdown rendered or as source, code highlighted
 * with line numbers, or a note for binary content. `read` fetches its bytes.
 */
export function FileView({ path, queryKey, read }: { path: string; queryKey: unknown[]; read: () => Promise<Uint8Array> }) {
	const imageType = IMAGE_TYPES[path.split('.').pop()?.toLowerCase() ?? ''];
	const markdown = /\.(md|markdown|mdown)$/i.test(path);
	const [preview, setPreview] = useState(true);
	const [imageUrl, setImageUrl] = useState('');
	const file = useQuery({ queryKey, queryFn: read });
	const contents = file.data && !imageType ? asText(file.data) : '';
	useEffect(() => {
		if (!file.data || !imageType) return;
		const url = URL.createObjectURL(new Blob([new Uint8Array(file.data)], { type: imageType }));
		setImageUrl(url);
		return () => URL.revokeObjectURL(url);
	}, [file.data, imageType]);
	const colored = useQuery({
		queryKey: ['highlight', ...queryKey, file.dataUpdatedAt],
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
					<RenderedMarkdown text={contents} />
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


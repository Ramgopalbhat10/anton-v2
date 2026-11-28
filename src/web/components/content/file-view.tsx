import type { File as PierreFileClass, FileContents, PostRenderPhase, SelectedLineRange } from '@pierre/diffs';
import { File as PierreFile } from '@pierre/diffs/react';
import { useQuery } from '@tanstack/react-query';
import { Code, Eye, Folder, FolderOpen } from '@/lib/icons';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DocumentMarkdown } from '@/components/content/document-markdown';
import { DiffScrollContainer } from '@/components/content/diff-scroll-container';
import { FileIcon } from '@/components/marks/file-icons';
import { type FileImages as FileImagesValue } from '@/components/content/markdown';
import { Segmented, SegmentedItem } from '@/components/kit/instrument';
import { Icon, Spinner } from '@/components/kit/signal';
import { hashText } from '@/lib/highlight';
import { ANTON_DIFF_UNSAFE_CSS, AURA_DIFF_THEMES, DiffWorkerProvider } from '@/lib/pierre-diffs';
import { useTheme } from '@/lib/theme';
import { cn } from '@/lib/utils';

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

/** Folds each run of single-child folders into one row (`src/web/components`), as editors show a sparse tree; the row takes its deepest folder's path. */
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
	A: 'text-(--ok)',
	M: 'text-(--warn)',
	D: 'text-(--bad)',
};

const STATUS_BG: Record<string, string> = {
	A: 'bg-(--diff-add)',
	M: 'bg-(--warn-soft)',
	D: 'bg-(--bad-soft)',
};

export function StatusChip({ status }: { status: string }) {
	return (
		<span className={cn('in-num inline-flex size-4 shrink-0 items-center justify-center rounded-control text-nano font-medium', STATUS_TONE[status], STATUS_BG[status])}>
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
		<div className={cn('flex flex-col gap-px', depth > 0 && 'ml-[13px] border-l border-(--line) pl-1')}>
			{sorted(node).map((child) => {
				const status = statusOf?.(child.path, !child.file);
				if (child.file) {
					return (
						<button
							type="button"
							key={child.path}
							onClick={() => onOpen(child.path)}
							aria-current={selected === child.path ? 'true' : undefined}
							className="sg-file-row flex h-[26px] items-center gap-2 rounded-control pr-1.5 pl-2 text-left outline-none hover:bg-(--bg-hover) focus-visible:shadow-(--focus)"
						>
							<FileIcon path={child.path} />
							<span
								className={cn(
									'min-w-0 flex-1 truncate text-small',
									selected === child.path ? 'text-(--text)' : status ? 'text-(--text-2)' : 'text-(--text-3)',
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
							className="flex h-[26px] items-center gap-2 rounded-control pr-1.5 pl-2 text-left text-(--text-2) outline-none hover:bg-(--bg-hover) focus-visible:shadow-(--focus)"
						>
							<Icon icon={open ? FolderOpen : Folder} size={12} className={open ? 'text-(--text-2)' : 'text-(--text-3)'} />
							<span className="min-w-0 flex-1 truncate text-small">{child.name}</span>
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

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return false;
	return true;
}

function asText(bytes: Uint8Array): string | null {
	if (bytes.subarray(0, 8000).includes(0)) return null;
	return new TextDecoder().decode(bytes);
}

export const IMAGE_TYPES: Record<string, string> = {
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

export const isMarkdown = (path: string) => /\.(md|markdown|mdown)$/i.test(path);

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

/** `VirtualizedFile` adds these to the base instance; present only inside a `<Virtualizer>`. */
type ScrollableFileInstance = {
	scrollToLine?: (lineNumber: number, align: ScrollLogicalPosition, onDone: () => void) => void;
	getLinePosition?: (lineNumber: number) => { top: number; height: number } | undefined;
};

/**
 * Source code through `@pierre/diffs`'s `<File>`: highlighting runs in the shared worker pool and
 * long files virtualize inside the scroll container instead of mounting every line. The marked
 * line of a `path:line` deep link is painted as the selected line and centered once the layout
 * can measure it; renders before that retry through `onPostRender`.
 */
function SourceView({ path, contents, markedLine }: { path: string; contents: string; markedLine?: number }) {
	const theme = useTheme();
	const hostRef = useRef<HTMLDivElement>(null);
	const instanceRef = useRef<(PierreFileClass & ScrollableFileInstance) | null>(null);
	const pendingLineRef = useRef<number | null>(null);
	const file = useMemo<FileContents>(
		() => ({ name: path, contents, cacheKey: `anton-file:${path}:${contents.length}:${hashText(contents)}` }),
		[path, contents],
	);

	const scrollToLine = useCallback((line: number): boolean => {
		const instance = instanceRef.current;
		if (instance?.scrollToLine && instance.getLinePosition) {
			if (instance.getLinePosition(line) == null) return false;
			instance.scrollToLine(line, 'center', () => {});
			return true;
		}
		const row = hostRef.current?.querySelector('diffs-container')?.shadowRoot?.querySelector(`[data-line="${line}"]`);
		if (row instanceof HTMLElement) {
			row.scrollIntoView({ block: 'center' });
			return true;
		}
		return false;
	}, []);

	const handlePostRender = useCallback(
		(_node: HTMLElement, instance: PierreFileClass, phase: PostRenderPhase) => {
			instanceRef.current = phase === 'unmount' ? null : (instance as PierreFileClass & ScrollableFileInstance);
			if (phase === 'unmount') return;
			const line = pendingLineRef.current;
			if (line != null && scrollToLine(line)) pendingLineRef.current = null;
		},
		[scrollToLine],
	);

	useEffect(() => {
		if (!markedLine) return;
		pendingLineRef.current = markedLine;
		if (scrollToLine(markedLine)) pendingLineRef.current = null;
	}, [markedLine, scrollToLine]);

	const options = useMemo(
		() => ({
			theme: AURA_DIFF_THEMES,
			themeType: theme,
			preferredHighlighter: 'highlights' as const,
			disableFileHeader: true,
			overflow: 'scroll' as const,
			unsafeCSS: ANTON_DIFF_UNSAFE_CSS,
			tokenizeMaxLineLength: 4_000,
			onPostRender: handlePostRender,
		}),
		[theme, handlePostRender],
	);

	const selectedLines = useMemo<SelectedLineRange | null>(() => (markedLine ? { start: markedLine, end: markedLine } : null), [markedLine]);

	return (
		<div ref={hostRef} className="anton-diff flex min-h-0 flex-1 flex-col">
			<DiffWorkerProvider>
				<DiffScrollContainer className="min-h-0 flex-1 overflow-auto">
					<PierreFile file={file} options={options} selectedLines={selectedLines} />
				</DiffScrollContainer>
			</DiffWorkerProvider>
		</div>
	);
}

/** Pass `preview` to choose how Markdown shows from outside, as a tab bar does; without it the file has its own toggle. */
export function FileView({
	path,
	queryKey,
	read,
	preview: chosen,
	line: markedLine,
	images,
	className,
}: {
	path: string;
	queryKey: unknown[];
	read: () => Promise<Uint8Array>;
	preview?: boolean;
	line?: number;
	/** How the file's own images draw, as a plugin preview resolves them. */
	images?: FileImagesValue | null;
	className?: string;
}) {
	const imageType = IMAGE_TYPES[path.split('.').pop()?.toLowerCase() ?? ''];
	const markdown = isMarkdown(path);
	const [own, setOwn] = useState(true);
	const preview = chosen ?? own;
	const [imageUrl, setImageUrl] = useState('');
	// Tool calls refetch open files; the same bytes keep the same array, so nothing below re-renders or re-highlights.
	const file = useQuery({ queryKey, queryFn: read, structuralSharing: (old, next) => (old instanceof Uint8Array && next instanceof Uint8Array && sameBytes(old, next) ? old : next) });
	const contents = useMemo(() => (file.data && !imageType ? asText(file.data) : ''), [file.data, imageType]);
	useEffect(() => {
		if (!file.data || !imageType) return;
		const url = URL.createObjectURL(new Blob([new Uint8Array(file.data)], { type: imageType }));
		setImageUrl(url);
		return () => URL.revokeObjectURL(url);
	}, [file.data, imageType]);
	const source = !file.isError && !file.isPending && !imageType && !(markdown && preview && contents !== null) && contents !== null;
	return (
		<div className={cn('relative flex min-h-0 flex-1 flex-col overflow-hidden bg-(--bg-app)', className)}>
			{markdown && chosen === undefined ? <MarkdownToggle preview={preview} onChange={setOwn} className="my-2 me-3 self-end shrink-0" /> : null}
			{source ? (
				<SourceView path={path} contents={contents} markedLine={markedLine} />
			) : (
				<div className="min-h-0 flex-1 overflow-auto">
					{file.isError ? (
						<div className="px-3 py-2.5 text-small text-(--bad)">{file.error.message || 'Could not read this file.'}</div>
					) : file.isPending ? (
						<div className="flex items-center gap-2 px-3 py-2.5 text-small text-(--text-3)">
							<Spinner size={12} />
							Reading
						</div>
					) : imageType ? (
						<div className="flex min-h-40 items-center justify-center p-4">
							<img src={imageUrl} alt={path.split('/').pop()} className="max-h-full max-w-full object-contain" />
						</div>
					) : markdown && preview && contents !== null ? (
						<DocumentMarkdown text={contents} images={images} className="p-4" />
					) : contents === null ? (
						<div className="px-3 py-2.5 text-small text-(--text-3)">Binary file, {file.data.length.toLocaleString()} bytes.</div>
					) : null}
				</div>
			)}
		</div>
	);
}


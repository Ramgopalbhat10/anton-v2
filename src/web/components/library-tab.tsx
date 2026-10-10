import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileTree, useFileTree } from '@pierre/trees/react';
import type { LucideIcon } from 'lucide-react';
import { ChevronDown, ChevronLeft, ChevronRight, Copy, Download, ExternalLink, FileText, Image, LayoutGrid, List as List_, MoreVertical, Plus, Sheet, Trash2 } from 'lucide-react';
import { type CSSProperties, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { LibraryArt } from '@/components/illustrations';
import { Segmented, SegmentedItem } from '@/components/instrument';
import { Btn, EmptyState, Icon, IconBtn, Menu, MenuContent, MenuItem, MenuTrigger, Spinner } from '@/components/signal';
import { useStoredState } from '@/components/split-pane';
import { api, type Output, outputUrl, refreshFor } from '@/lib/api';
import { MAX_ROWS, parseCsv } from '@/lib/csv';
import { age } from '@/lib/format';
import { cn } from '@/lib/utils';

type Kind = 'image' | 'pdf' | 'table' | 'text' | 'other';

const KINDS: Array<[RegExp, Kind]> = [
	[/\.(png|jpe?g|gif|webp)$/i, 'image'],
	[/\.pdf$/i, 'pdf'],
	[/\.(csv|tsv)$/i, 'table'],
	[/\.(md|txt|log|json|ya?ml|xml|html?|diff|patch|sh|[cm]?[jt]sx?|py|go|rs|sql)$/i, 'text'],
];

const kindOf = (path: string): Kind => KINDS.find(([pattern]) => pattern.test(path))?.[1] ?? 'other';

function size(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Reads the file as text, then shows it with `render`. */
function TextFile({ sessionId, path, render }: { sessionId: string; path: string; render: (text: string) => ReactNode }) {
	const content = useQuery({ queryKey: ['output', sessionId, path], queryFn: () => api.outputText(sessionId, path) });
	if (content.isPending) {
		return (
			<div className="flex items-center gap-2 px-3 py-2.5 text-[12px] text-(--text-tertiary)">
				<Spinner size={12} />
				Reading
			</div>
		);
	}
	if (content.isError) return <div className="px-3 py-2.5 text-[12px] text-(--danger-text)">{content.error.message}</div>;
	return render(content.data);
}

const plain = (text: string) => (
	<pre className="m-0 overflow-x-auto px-3 py-2.5 font-mono text-[12px] leading-[18px] whitespace-pre text-(--text-secondary)">{text}</pre>
);

/** The first row is the header; a file cut at MAX_ROWS says so. */
function Table({ text, separator }: { text: string; separator: string }) {
	const parsed = parseCsv(text, separator, MAX_ROWS + 1);
	const [header = [], ...rows] = parsed.slice(0, MAX_ROWS);
	const cell = 'max-w-[320px] truncate border-b border-(--border-subtle) px-3 py-1.5 text-left';
	const head = 'max-w-[320px] truncate border-b border-(--border-default) px-3 py-2 text-left';
	return (
		<div className="overflow-x-auto">
			<table className="w-full border-collapse text-[12px]">
				<thead className="bg-(--card-bg)">
					<tr>
						{header.map((name, index) => (
							<th key={index} className={`${head} in-caption font-medium text-(--text-tertiary)`}>
								{name}
							</th>
						))}
					</tr>
				</thead>
				<tbody className="text-(--text-secondary)">
					{rows.map((row, index) => (
						<tr key={index} className="hover:bg-(--bg-hover)">
							{row.map((value, column) => (
								<td key={column} className={`${cell} ${/^-?[\d.,]+%?$/.test(value) ? 'in-num' : ''}`} title={value}>
									{value}
								</td>
							))}
						</tr>
					))}
				</tbody>
			</table>
			{parsed.length > MAX_ROWS ? (
				<div className="px-3 py-2 text-[12px] text-(--text-tertiary)">Showing the first {MAX_ROWS} rows. Download the file for the rest.</div>
			) : null}
		</div>
	);
}

const PREVIEWS: Record<Kind, (props: { sessionId: string; path: string }) => ReactNode> = {
	image: ({ sessionId, path }) => <img src={outputUrl(sessionId, path)} alt={path} className="block max-w-full" />,
	pdf: ({ sessionId, path }) => <iframe src={outputUrl(sessionId, path)} title={path} className="block h-[70vh] w-full border-0 bg-white" />,
	table: ({ sessionId, path }) => (
		<TextFile sessionId={sessionId} path={path} render={(text) => <Table text={text} separator={/\.tsv$/i.test(path) ? '\t' : ','} />} />
	),
	text: ({ sessionId, path }) => <TextFile sessionId={sessionId} path={path} render={plain} />,
	other: () => <div className="px-3 py-2.5 text-[12px] text-(--text-tertiary)">No preview for this file type. Download it to open it.</div>,
};

function Preview({ sessionId, output, onBack }: { sessionId: string; output: Output; onBack: () => void }) {
	const Body = PREVIEWS[kindOf(output.path)];
	return (
		<div className="flex flex-col gap-2">
			<div className="flex h-8 items-center gap-2">
				<Btn variant="ghost" size="xs" icon={ChevronLeft} onClick={onBack}>
					Library
				</Btn>
			</div>
			<div className="in-well overflow-hidden bg-(--bg-inset)">
				<div className="flex h-9 items-center gap-2 border-b border-(--border-subtle) bg-[linear-gradient(180deg,var(--card-bg-top),var(--card-bg))] pr-1.5 pl-3">
					<Icon icon={ICONS[kindOf(output.path)]} size={13} className={KIND_TONE[kindOf(output.path)]} />
					<div className="min-w-0 flex-1 truncate text-[12px] text-(--text-primary)">{output.path}</div>
					<span className="in-num text-[11px] text-(--text-disabled)">{size(output.size)}</span>
					<a
						href={outputUrl(sessionId, output.path)}
						download={output.path.split('/').pop()}
						aria-label="Download"
						title="Download"
						className="sg-btn sg-icon-btn sg-btn--ghost sg-btn--xs"
					>
						<Icon icon={Download} size={12} />
					</a>
				</div>
				<Body sessionId={sessionId} path={output.path} />
			</div>
		</div>
	);
}

const ICONS: Record<Kind, typeof FileText> = { image: Image, pdf: FileText, table: Sheet, text: FileText, other: FileText };

/** Each kind keeps one data hue, so a report and a table read apart at a glance. */
const KIND_TONE: Record<Kind, string> = {
	image: 'text-(--data-5)',
	pdf: 'text-(--data-3)',
	table: 'text-(--data-4)',
	text: 'text-(--data-1)',
	other: 'text-(--icon-tertiary)',
};

const extension = (path: string) => (path.includes('.') ? (path.split('.').pop()?.toUpperCase() ?? 'FILE') : 'FILE');
const nameOf = (path: string) => path.split('/').pop() ?? path;

/** What the Type menu narrows the Library to. */
const TYPES: Array<{ key: 'all' | Kind; label: string }> = [
	{ key: 'all', label: 'All types' },
	{ key: 'image', label: 'Images' },
	{ key: 'pdf', label: 'PDFs' },
	{ key: 'table', label: 'Tables' },
	{ key: 'text', label: 'Text and code' },
	{ key: 'other', label: 'Other' },
];

const modified = (output: Output) => new Date(output.mtimeMs).toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
/** The same, in fixed widths (two-digit days and hours), for the list's column. */
const stamp = (output: Output) => new Date(output.mtimeMs).toLocaleString([], { month: 'short', day: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

type Folder = { path: string; name: string; count: number; mtimeMs: number };

/** What is directly in `folder`: its subfolders, each with how many files it holds in all, and its own files. */
function entriesIn(outputs: Output[], folder: string): { folders: Folder[]; files: Output[] } {
	const prefix = folder ? `${folder}/` : '';
	const folders = new Map<string, Folder>();
	const files: Output[] = [];
	for (const output of outputs) {
		if (!output.path.startsWith(prefix)) continue;
		const rest = output.path.slice(prefix.length);
		const slash = rest.indexOf('/');
		if (slash === -1) {
			files.push(output);
			continue;
		}
		const name = rest.slice(0, slash);
		const entry = folders.get(name) ?? { path: `${prefix}${name}`, name, count: 0, mtimeMs: 0 };
		entry.count += 1;
		entry.mtimeMs = Math.max(entry.mtimeMs, output.mtimeMs);
		folders.set(name, entry);
	}
	return { folders: [...folders.values()].sort((a, b) => a.name.localeCompare(b.name)), files: files.sort((a, b) => b.mtimeMs - a.mtimeMs) };
}

/** What can be done to one entry: open it, copy where it is, download it, or delete it (asking twice). */
function ItemActions({
	sessionId,
	path,
	folder,
	onOpen,
	onDone,
	variant,
}: {
	sessionId: string;
	path: string;
	folder: boolean;
	onOpen: () => void;
	onDone?: () => void;
	variant: 'menu' | 'list' | 'list-above';
}) {
	const queryClient = useQueryClient();
	const [confirming, setConfirming] = useState(false);
	const [copied, setCopied] = useState(false);
	const remove = useMutation({
		mutationFn: () => api.deleteOutput(sessionId, path),
		onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['outputs', sessionId] }),
	});
	const actions: Array<{ icon: LucideIcon; label: string; run: (event: Event | React.MouseEvent) => void; danger?: boolean; keep?: boolean } | null> = [
		{ icon: ExternalLink, label: 'Open', run: onOpen },
		{
			icon: Copy,
			label: copied ? 'Path copied' : 'Copy path',
			keep: true,
			run: () => void navigator.clipboard?.writeText(`outputs/${path}`).then(() => setCopied(true)),
		},
		folder
			? null
			: {
					icon: Download,
					label: 'Download',
					run: () => {
						const link = document.createElement('a');
						link.href = outputUrl(sessionId, path);
						link.download = nameOf(path);
						link.click();
					},
				},
		folder
			? null
			: {
					icon: Trash2,
					label: remove.isPending ? 'Deleting…' : confirming ? 'Click again to delete' : 'Delete',
					danger: true,
					keep: !confirming,
					run: () => (confirming ? remove.mutate() : setConfirming(true)),
				},
	];
	const shown = actions.filter((action): action is NonNullable<typeof action> => action !== null);
	if (variant !== 'menu') {
		// Inside the tree's own menu slot at the row's end: plain buttons in a popover card, opening leftward, and upward near the bottom.
		return (
			<div
				data-file-tree-context-menu-root="true"
				role="menu"
				className={cn('in-pop absolute right-0 z-20 flex min-w-[168px] flex-col p-1', variant === 'list-above' ? 'bottom-full mb-1' : 'top-full mt-1')}
			>
				{shown.map((action) => (
					<button
						key={action.label}
						type="button"
						role="menuitem"
						onClick={(event) => {
							action.run(event);
							if (!action.keep) onDone?.();
						}}
						className={cn(
							'flex h-8 items-center gap-2 rounded-[7px] px-2 text-left text-[12.5px] outline-none hover:bg-(--bg-hover) focus-visible:bg-(--bg-hover)',
							action.danger ? 'text-(--danger-text)' : 'text-(--text-primary)',
						)}
					>
						<Icon icon={action.icon} size={13} />
						{action.label}
					</button>
				))}
			</div>
		);
	}
	// Menu events bubble through its portal to the card, which would open the file; they stop here.
	return (
		<span className="inline-flex" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
			<Menu
				onOpenChange={(open) => {
					if (open) return;
					setConfirming(false);
					setCopied(false);
				}}
			>
				<MenuTrigger asChild>
					<IconBtn icon={MoreVertical} size="xs" label={`Actions for ${nameOf(path)}`} className="shrink-0" />
				</MenuTrigger>
				<MenuContent align="end" sideOffset={4}>
					{shown.map((action) => (
						<MenuItem
							key={action.label}
							icon={action.icon}
							className={action.danger ? 'sg-menu-item--destructive' : undefined}
							onSelect={(event) => {
								if (action.keep) event.preventDefault();
								action.run(event);
							}}
						>
							{action.label}
						</MenuItem>
					))}
				</MenuContent>
			</Menu>
		</span>
	);
}

/** A folder as a card with a tab, like a paper folder: its name, how much is in it, and when it last changed. */
function FolderCard({ sessionId, folder, onOpen }: { sessionId: string; folder: Folder; onOpen: () => void }) {
	return (
		<div className="group relative pt-2.5">
			<span aria-hidden className="absolute top-0 left-0 h-3.5 w-12 rounded-t-[7px] border border-b-0 border-(--card-border) bg-(--card-bg-top)" />
			<div
				role="button"
				tabIndex={0}
				onClick={onOpen}
				onKeyDown={(event) => (event.key === 'Enter' || event.key === ' ') && onOpen()}
				className="in-card relative flex h-[104px] cursor-pointer flex-col justify-between rounded-tl-none p-3 text-left outline-none transition-colors duration-(--duration-micro) hover:border-(--border-default) focus-visible:shadow-(--focus-ring)"
			>
				<span className="flex min-w-0 items-start gap-2">
					<span className="min-w-0 flex-1 truncate text-[12.5px] text-(--text-primary)">{folder.name}</span>
					<span className="opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
						<ItemActions sessionId={sessionId} path={folder.path} folder onOpen={onOpen} variant="menu" />
					</span>
				</span>
				<span className="in-num flex items-center justify-between text-[10.5px] text-(--text-disabled)">
					<span>
						{folder.count} {folder.count === 1 ? 'item' : 'items'}
					</span>
					<span>{age(new Date(folder.mtimeMs).toISOString())}</span>
				</span>
			</div>
		</div>
	);
}

/** A file as a card: an image fills it, anything else shows its name; its type sits in the corner. */
function FileCard({ sessionId, output, onOpen }: { sessionId: string; output: Output; onOpen: () => void }) {
	const kind = kindOf(output.path);
	const name = nameOf(output.path);
	return (
		<div
			role="button"
			tabIndex={0}
			onClick={onOpen}
			onKeyDown={(event) => (event.key === 'Enter' || event.key === ' ') && onOpen()}
			title={`${name} · ${size(output.size)} · ${modified(output)}`}
			className="in-card group relative mt-2.5 flex h-[104px] cursor-pointer flex-col overflow-hidden text-left outline-none transition-colors duration-(--duration-micro) hover:border-(--border-default) focus-visible:shadow-(--focus-ring)"
		>
			{kind === 'image' ? (
				<img src={outputUrl(sessionId, output.path)} alt="" loading="lazy" className="absolute inset-0 size-full object-cover object-top opacity-90 transition-opacity group-hover:opacity-100" />
			) : (
				<span className="flex min-w-0 items-start gap-1.5 p-3 pr-1.5">
					<Icon icon={ICONS[kind]} size={13} className={cn('mt-0.5 shrink-0', KIND_TONE[kind])} />
					<span className="line-clamp-2 min-w-0 flex-1 text-[12.5px] leading-[17px] break-all text-(--text-primary)">{name}</span>
				</span>
			)}
			<span className="absolute top-1.5 right-1.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
				<span className="inline-flex rounded-[7px] bg-(--bg-scrim)">
					<ItemActions sessionId={sessionId} path={output.path} folder={false} onOpen={onOpen} variant="menu" />
				</span>
			</span>
			<span className="relative mt-auto flex items-center gap-1.5 p-2">
				<span className="rounded-[5px] bg-(--bg-scrim) px-1.5 py-0.5 font-mono text-[9.5px] tracking-[0.06em] text-(--text-secondary) backdrop-blur-sm">{extension(output.path)}</span>
				{kind === 'image' ? null : <span className="in-num ml-auto text-[10.5px] text-(--text-disabled)">{size(output.size)}</span>}
			</span>
		</div>
	);
}

function Grid({ sessionId, outputs, folder, onFolder, onOpen }: { sessionId: string; outputs: Output[]; folder: string; onFolder: (path: string) => void; onOpen: (output: Output) => void }) {
	const { folders, files } = entriesIn(outputs, folder);
	return (
		<div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-x-2.5 gap-y-1.5">
			{folders.map((entry) => (
				<FolderCard key={entry.path} sessionId={sessionId} folder={entry} onOpen={() => onFolder(entry.path)} />
			))}
			{files.map((output) => (
				<FileCard key={output.path} sessionId={sessionId} output={output} onOpen={() => onOpen(output)} />
			))}
		</div>
	);
}

/** The tree's own look, in the app's tokens, so it sits in the panel like the rest. */
const TREE_STYLE = {
	'--trees-bg-override': 'transparent',
	'--trees-fg-override': 'var(--text-secondary)',
	'--trees-fg-muted-override': 'var(--text-tertiary)',
	'--trees-bg-muted-override': 'var(--bg-hover)',
	'--trees-selected-bg-override': 'var(--neutral-750)',
	'--trees-selected-fg-override': 'var(--text-primary)',
	'--trees-accent-override': 'var(--accent-base)',
	'--trees-border-color-override': 'var(--border-subtle)',
	'--trees-indent-guide-bg-override': 'var(--border-subtle)',
	'--trees-focus-ring-color-override': 'var(--accent-base)',
	'--trees-font-family-override': 'inherit',
	'--trees-font-size-override': '12.5px',
	'--trees-border-radius-override': '7px',
	// Rows start at the panel's edge, under the Name heading.
	'--trees-padding-inline-override': '0px',
	'--trees-item-margin-x-override': '0px',
	height: '100%',
} as CSSProperties;

/** Modified and size as columns: fixed-width text in Anton's mono type, kept on one line with its spaces. */
const TREE_CSS = `[data-item-section="decoration"] > span { white-space: pre; font-family: var(--font-mono); font-size: 11px; font-variant-numeric: tabular-nums; }`;
const COLUMN_GAP = 3;

/**
 * Every saved file in folders, as Pierre's file tree: when each file changed
 * and its size at the row's end, and its actions on the row's menu.
 */
function List({ sessionId, outputs, onOpen }: { sessionId: string; outputs: Output[]; onOpen: (output: Output) => void }) {
	const byPath = useMemo(() => new Map(outputs.map((output) => [output.path, output])), [outputs]);
	const latest = useRef(byPath);
	latest.current = byPath;
	const open = useRef(onOpen);
	open.current = onOpen;
	// Each column as wide as its longest value or its heading, in characters.
	const widths = { date: Math.max(8, ...outputs.map((output) => stamp(output).length)), size: Math.max(4, ...outputs.map((output) => size(output.size).length)) };
	const columns = useRef(widths);
	columns.current = widths;
	const { model } = useFileTree({
		unsafeCSS: TREE_CSS,
		paths: outputs.map((output) => output.path),
		initialExpansion: 'open',
		flattenEmptyDirectories: true,
		composition: { contextMenu: { enabled: true, triggerMode: 'both', buttonVisibility: 'when-needed' } },
		renderRowDecoration: ({ item }) => {
			const output = item.kind === 'file' ? latest.current.get(item.path) : undefined;
			if (!output) return null;
			const { date, size: wide } = columns.current;
			return { text: `${stamp(output).padStart(date)}${' '.repeat(COLUMN_GAP)}${size(output.size).padStart(wide)}`, title: `${modified(output)} · ${size(output.size)}` };
		},
		onSelectionChange: (paths) => {
			const output = paths.length === 1 ? latest.current.get(paths[0]) : undefined;
			if (output) open.current(output);
		},
	});
	// New and removed files, as the agent saves or you delete them.
	const paths = outputs.map((output) => output.path).join('\n');
	const shown = useRef(paths);
	useEffect(() => {
		if (shown.current === paths) return;
		shown.current = paths;
		model.resetPaths(paths ? paths.split('\n') : []);
	}, [model, paths]);
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			{/* The rows' padding, then the lane the tree keeps for its row menu button (18px and a 6px gap), sit right of the columns. */}
			<div className="flex h-7 shrink-0 items-center justify-between border-b border-(--border-subtle) pr-8 pl-2">
				<span className="in-caption">Name</span>
				{/* Measured in the rows' own type, so each heading ends where its column does. */}
				<span className="flex font-mono text-[11px]">
					<span className="flex justify-end" style={{ width: `${widths.date}ch` }}>
						<span className="in-caption">Modified</span>
					</span>
					<span className="flex justify-end" style={{ width: `${widths.size + COLUMN_GAP}ch` }}>
						<span className="in-caption">Size</span>
					</span>
				</span>
			</div>
			<div className="min-h-0 flex-1 pt-1">
				<FileTree
					model={model}
					aria-label="Library files"
					style={TREE_STYLE}
					renderContextMenu={(item, context) => (
						<ItemActions
							sessionId={sessionId}
							path={item.path.replace(/\/$/, '')}
							folder={item.kind === 'directory'}
							variant={context.anchorRect.bottom + 200 > window.innerHeight ? 'list-above' : 'list'}
							onDone={() => context.close()}
							onOpen={() => {
								context.close();
								const output = byPath.get(item.path);
								if (output) onOpen(output);
								else model.getItem(item.path)?.focus();
							}}
						/>
					)}
				/>
			</div>
		</div>
	);
}

/** Where you are in the Library's folders, each step a link back up. */
function Crumbs({ folder, onFolder }: { folder: string; onFolder: (path: string) => void }) {
	const parts = folder ? folder.split('/') : [];
	return (
		<nav aria-label="Folder" className="flex min-w-0 items-center gap-1 text-[12.5px]">
			<button
				type="button"
				onClick={() => onFolder('')}
				className={cn('shrink-0 rounded-[6px] px-1 outline-none hover:text-(--text-primary) focus-visible:shadow-(--focus-ring)', parts.length ? 'text-(--text-tertiary)' : 'text-(--text-primary)')}
			>
				All files
			</button>
			{parts.map((part, index) => (
				<span key={index} className="flex min-w-0 items-center gap-1">
					<Icon icon={ChevronRight} size={11} className="shrink-0 text-(--icon-disabled)" />
					<button
						type="button"
						onClick={() => onFolder(parts.slice(0, index + 1).join('/'))}
						aria-current={index === parts.length - 1 ? 'page' : undefined}
						className={cn(
							'min-w-0 truncate rounded-[6px] px-1 outline-none hover:text-(--text-primary) focus-visible:shadow-(--focus-ring)',
							index === parts.length - 1 ? 'text-(--text-primary)' : 'text-(--text-tertiary)',
						)}
					>
						{part}
					</button>
				</span>
			))}
		</nav>
	);
}

/** Reports, screenshots and exports the agent saved, and files you added: as cards in folders, or as a tree. */
export function LibraryTab({ sessionId }: { sessionId: string }) {
	const queryClient = useQueryClient();
	const [selected, setSelected] = useState<Output | null>(null);
	const [view, setView] = useStoredState<'grid' | 'list'>('anton.library.view', 'grid');
	const [type, setType] = useState<'all' | Kind>('all');
	const [folder, setFolder] = useState('');
	const [notice, setNotice] = useState<string | null>(null);
	const picker = useRef<HTMLInputElement>(null);
	const outputs = useQuery({
		queryKey: ['outputs', sessionId],
		queryFn: () => api.outputs(sessionId),
		refetchInterval: (query) => refreshFor(query.state.data?.source),
	});
	const add = useMutation({
		mutationFn: async (files: File[]) => {
			for (const file of files) await api.uploadOutput(sessionId, file);
		},
		onSuccess: (_, files) => setNotice(`Added ${files.length === 1 ? files[0].name : `${files.length} files`} to uploads`),
		onError: (error) => setNotice(error.message),
		onSettled: () => void queryClient.invalidateQueries({ queryKey: ['outputs', sessionId] }),
	});
	useEffect(() => {
		if (!notice) return;
		const timer = setTimeout(() => setNotice(null), 3000);
		return () => clearTimeout(timer);
	}, [notice]);

	if (selected) return <Preview sessionId={sessionId} output={selected} onBack={() => setSelected(null)} />;

	const all = outputs.data?.outputs ?? [];
	const items = type === 'all' ? all : all.filter((output) => kindOf(output.path) === type);
	// A folder that a filter or a delete emptied gives way to the top.
	const inFolder = folder && !items.some((output) => output.path.startsWith(`${folder}/`)) ? '' : folder;

	return (
		<div className="flex h-full min-h-0 flex-col gap-2.5">
			<div className="flex h-8 shrink-0 items-center gap-2">
				<Menu>
					<MenuTrigger asChild>
						<Btn variant="ghost" size="xs" className="shrink-0">
							{TYPES.find((entry) => entry.key === type)?.label === 'All types' ? 'Type' : TYPES.find((entry) => entry.key === type)?.label}
							<Icon icon={ChevronDown} size={11} className="text-(--icon-tertiary)" />
						</Btn>
					</MenuTrigger>
					<MenuContent align="start" sideOffset={4}>
						{TYPES.map((entry) => (
							<MenuItem key={entry.key} checked={type === entry.key} hint={entry.key === 'all' ? all.length : all.filter((output) => kindOf(output.path) === entry.key).length} onSelect={() => setType(entry.key)}>
								{entry.label}
							</MenuItem>
						))}
					</MenuContent>
				</Menu>
				<div className="min-w-0 flex-1">{view === 'grid' ? <Crumbs folder={inFolder} onFolder={setFolder} /> : null}</div>
				<Segmented label="View" role="radiogroup" className="shrink-0">
					<SegmentedItem role="radio" size="sm" on={view === 'grid'} onClick={() => setView('grid')} title="Grid" className="px-1.5">
						<Icon icon={LayoutGrid} size={12} />
						<span className="sr-only">Grid</span>
					</SegmentedItem>
					<SegmentedItem role="radio" size="sm" on={view === 'list'} onClick={() => setView('list')} title="List" className="px-1.5">
						<Icon icon={List_} size={12} />
						<span className="sr-only">List</span>
					</SegmentedItem>
				</Segmented>
				<input
					ref={picker}
					type="file"
					multiple
					hidden
					onChange={(event) => {
						const files = [...(event.target.files ?? [])];
						event.target.value = '';
						if (files.length) add.mutate(files);
					}}
				/>
				<Btn size="xs" variant="primary" icon={Plus} disabled={add.isPending} onClick={() => picker.current?.click()} className="shrink-0">
					{add.isPending ? 'Adding…' : 'Add'}
				</Btn>
			</div>

			{notice ? (
				<div role="status" className="shrink-0 text-[11.5px] text-(--text-tertiary)">
					{notice}
				</div>
			) : null}

			<div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
				{outputs.isError ? (
					<EmptyState title="Library unavailable" body={outputs.error.message} />
				) : outputs.isPending ? (
					<div className="flex h-7 items-center gap-2 text-[12px] text-(--text-tertiary)">
						<Spinner size={12} />
						Loading the library
					</div>
				) : all.length === 0 ? (
					<EmptyState
						art={<LibraryArt className="w-full max-w-[320px]" />}
						title="Nothing saved yet"
						body="Reports, screenshots and exports the agent saves show up here, and so do files you add."
					/>
				) : items.length === 0 ? (
					<EmptyState title="Nothing of this type" body="Pick another type, or All types." />
				) : view === 'grid' ? (
					<Grid sessionId={sessionId} outputs={items} folder={inFolder} onFolder={setFolder} onOpen={setSelected} />
				) : (
					<List sessionId={sessionId} outputs={items} onOpen={setSelected} />
				)}
			</div>

			{all.length ? (
				<div className="in-caption flex shrink-0 items-center justify-between border-t border-(--border-subtle) pt-2">
					<span>
						{type === 'all' ? `${all.length} ${all.length === 1 ? 'file' : 'files'}` : `${items.length} of ${all.length} files`}
					</span>
					<span className="in-num">{size(items.reduce((sum, output) => sum + output.size, 0))}</span>
				</div>
			) : null}
		</div>
	);
}

import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, Download, FileText, Image, Library, Sheet } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { SourceBar } from '@/components/source-bar';
import { LibraryArt } from '@/components/illustrations';
import { Caption } from '@/components/instrument';
import { Btn, EmptyState, Icon, Spinner } from '@/components/signal';
import { api, type Output, outputUrl, refreshFor } from '@/lib/api';
import { MAX_ROWS, parseCsv } from '@/lib/csv';
import { age } from '@/lib/format';

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
			<div className="flex h-7 items-center gap-2">
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

const extension = (path: string) => (path.includes('.') ? path.split('.').pop()?.toUpperCase() : 'FILE');

/** A saved file as a tile: a thumbnail for an image, its kind's glyph for anything else. */
function Tile({ sessionId, output, onOpen }: { sessionId: string; output: Output; onOpen: () => void }) {
	const kind = kindOf(output.path);
	const name = output.path.split('/').pop() ?? output.path;
	return (
		<button
			type="button"
			onClick={onOpen}
			title={output.path}
			className="in-card group overflow-hidden text-left outline-none transition-colors duration-(--duration-micro) hover:border-(--border-default) focus-visible:shadow-(--focus-ring)"
		>
			<span className="in-grid relative flex h-[92px] items-center justify-center border-b border-(--border-subtle)">
				{kind === 'image' ? (
					<img src={outputUrl(sessionId, output.path)} alt="" loading="lazy" className="absolute inset-0 size-full object-cover object-top opacity-90 group-hover:opacity-100" />
				) : (
					<span className="flex flex-col items-center gap-1.5">
						<span className="inline-flex size-9 items-center justify-center rounded-[9px] border border-dashed border-(--border-strong) bg-(--card-bg)">
							<Icon icon={ICONS[kind]} size={16} className={KIND_TONE[kind]} />
						</span>
						<Caption>{extension(output.path)}</Caption>
					</span>
				)}
			</span>
			<span className="flex flex-col gap-0.5 px-3 py-2.5">
				<span className="truncate text-[12.5px] text-(--text-primary)">{name}</span>
				<span className="in-num truncate text-[10.5px] text-(--text-disabled)">
					{size(output.size)} · {age(new Date(output.mtimeMs).toISOString())}
					{output.path !== name ? ` · ${output.path.slice(0, output.path.length - name.length - 1)}` : ''}
				</span>
			</span>
		</button>
	);
}

/** Deliverables the agent saved outside the repo: reports, screenshots, exports. */
export function LibraryTab({ sessionId }: { sessionId: string }) {
	const [selected, setSelected] = useState<Output | null>(null);
	const outputs = useQuery({
		queryKey: ['outputs', sessionId],
		queryFn: () => api.outputs(sessionId),
		refetchInterval: (query) => refreshFor(query.state.data?.source),
	});

	if (selected) return <Preview sessionId={sessionId} output={selected} onBack={() => setSelected(null)} />;

	const items = outputs.data?.outputs ?? [];
	return (
		<div className="flex flex-col gap-2">
			<SourceBar sessionId={sessionId} source={outputs.data?.source} at={outputs.data?.at}>
				<span>
					{items.length} {items.length === 1 ? 'file' : 'files'}
				</span>
			</SourceBar>
			{outputs.isError ? (
				<EmptyState title="Library unavailable" body={outputs.error.message} />
			) : outputs.isPending ? (
				<div className="flex h-7 items-center gap-2 text-[12px] text-(--text-tertiary)">
					<Spinner size={12} />
					Loading the library
				</div>
			) : items.length === 0 ? (
				<EmptyState
					art={<LibraryArt className="w-[210px]" />}
					className="pt-10"
					title="Nothing saved yet"
					body="Reports, screenshots and exports the agent saves show up here after each step."
				/>
			) : (
				<div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2">
					{items.map((output) => (
						<Tile key={output.path} sessionId={sessionId} output={output} onOpen={() => setSelected(output)} />
					))}
				</div>
			)}
		</div>
	);
}

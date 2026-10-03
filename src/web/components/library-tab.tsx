import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, Download, FileText, Image, Library, Sheet } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { SourceBar } from '@/components/source-bar';
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
	return (
		<div className="overflow-x-auto">
			<table className="w-full border-collapse text-[12px]">
				<thead className="bg-(--bg-raised) text-(--text-primary)">
					<tr>
						{header.map((name, index) => (
							<th key={index} className={`${cell} font-medium`}>
								{name}
							</th>
						))}
					</tr>
				</thead>
				<tbody className="text-(--text-secondary)">
					{rows.map((row, index) => (
						<tr key={index}>
							{row.map((value, column) => (
								<td key={column} className={cell} title={value}>
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
			<div className="overflow-hidden rounded-lg bg-(--bg-inset)">
				<div className="flex h-8 items-center gap-2 bg-(--bg-raised) pr-1.5 pl-3">
					<div className="min-w-0 flex-1 truncate text-[12px]">{output.path}</div>
					<span className="text-[11px] text-(--text-disabled)">{size(output.size)}</span>
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
		<div className="flex flex-col gap-1">
			<SourceBar sessionId={sessionId} source={outputs.data?.source} at={outputs.data?.at}>
				<span className="text-(--text-disabled)">
					{items.length} {items.length === 1 ? 'FILE' : 'FILES'}
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
					icon={Library}
					title="Nothing saved yet"
					body="Reports, screenshots and exports the agent saves show up here after each step."
				/>
			) : (
				<div className="flex flex-col gap-px">
					{items.map((output) => (
						<button
							type="button"
							key={output.path}
							onClick={() => setSelected(output)}
							className="flex h-7 items-center gap-2 rounded-md px-2 text-left outline-none hover:bg-(--bg-hover) focus-visible:shadow-(--focus-ring)"
						>
							<Icon icon={ICONS[kindOf(output.path)]} size={12} className="text-(--icon-tertiary)" />
							<span className="min-w-0 flex-1 truncate text-[12px] text-(--text-secondary)">{output.path}</span>
							<span className="shrink-0 text-[11px] text-(--text-disabled)">{size(output.size)}</span>
							<span className="w-8 shrink-0 text-right text-[11px] text-(--text-disabled)">{age(new Date(output.mtimeMs).toISOString())}</span>
						</button>
					))}
				</div>
			)}
		</div>
	);
}

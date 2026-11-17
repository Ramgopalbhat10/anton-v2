import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { CodeBlock } from '@/components/content/code-block';
import { HtmlFrame } from '@/components/content/html-frame';
import { EmptyLine, Spinner } from '@/components/kit/signal';
import { outputUrl } from '@/lib/api';
import { MAX_ROWS, parseCsv } from '@/lib/csv';
import { type Kind, nameOf, type Place, taskPlace } from '@/lib/library';

export function TextFile({ sessionId, path, render }: { sessionId: string; path: string; render: (text: string) => ReactNode }) {
	return <TextAt place={taskPlace(sessionId, path)} render={render} />;
}

export function TextAt({ place, render }: { place: Place; render: (text: string) => ReactNode }) {
	const content = useQuery({ queryKey: place.textKey, queryFn: place.text });
	if (content.isPending) {
		return (
			<div className="flex items-center gap-2 px-3 py-2.5 text-small text-(--text-3)">
				<Spinner size={12} />
				Reading
			</div>
		);
	}
	if (content.isError) return <div className="px-3 py-2.5 text-small text-(--bad)">{content.error.message}</div>;
	return render(content.data);
}

export const plain = (text: string) => (
	<pre className="m-0 overflow-x-auto px-3 py-2.5 font-mono text-small leading-[18px] whitespace-pre text-(--text-2)">{text}</pre>
);

/** The first row is the header; a file cut at MAX_ROWS says so. */
export function Table({ text, separator }: { text: string; separator: string }) {
	const parsed = parseCsv(text, separator, MAX_ROWS + 1);
	const [header = [], ...rows] = parsed.slice(0, MAX_ROWS);
	const cell = 'max-w-[320px] truncate border-b border-(--line) px-3 py-1.5 text-left';
	const head = 'max-w-[320px] truncate border-b border-(--line-strong) px-3 py-2 text-left';
	return (
		<div className="overflow-x-auto">
			<table className="w-full border-collapse text-small">
				<thead className="bg-(--bg-surface)">
					<tr>
						{header.map((name, index) => (
							<th key={index} className={`${head} in-caption font-medium text-(--text-3)`}>
								{name}
							</th>
						))}
					</tr>
				</thead>
				<tbody className="text-(--text-2)">
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
				<div className="px-3 py-2 text-small text-(--text-3)">Showing the first {MAX_ROWS} rows. Download the file for the rest.</div>
			) : null}
		</div>
	);
}

export const PREVIEWS: Record<Kind, (props: { sessionId: string; path: string }) => ReactNode> = {
	page: ({ sessionId, path }) => (
		<div className="p-3">
			<HtmlFrame sessionId={sessionId} path={path} title={nameOf(path)} actions={false} />
		</div>
	),
	image: ({ sessionId, path }) => <img src={outputUrl(sessionId, path)} alt={path} className="block max-w-full" />,
	pdf: ({ sessionId, path }) => <iframe src={outputUrl(sessionId, path)} title={path} className="block h-[70vh] w-full border-0 bg-white" />,
	table: ({ sessionId, path }) => (
		<TextFile sessionId={sessionId} path={path} render={(text) => <Table text={text} separator={/\.tsv$/i.test(path) ? '\t' : ','} />} />
	),
	text: ({ sessionId, path }) => <TextFile sessionId={sessionId} path={path} render={plain} />,
	other: () => <EmptyLine className="px-3 py-2.5">No preview for this file type. Download it to open it.</EmptyLine>,
};

export function Source({ sessionId, path }: { sessionId: string; path: string }) {
	return <SourceAt place={taskPlace(sessionId, path)} />;
}

export function SourceAt({ place }: { place: Place }) {
	const language = place.path.split('.').pop()?.toLowerCase() ?? 'txt';
	return <TextAt place={place} render={(text) => <CodeBlock code={text} language={language} className="mb-0! rounded-none! border-0!" />} />;
}

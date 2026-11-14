import { useMemo, type ReactNode } from 'react';
import { parseDocument } from 'yaml';

/** Delimiters are recognized only at the start, never a thematic break in the body. */
const FRONTMATTER = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;

function splitFrontmatter(text: string) {
	const match = FRONTMATTER.exec(text);
	if (!match) return { body: text, raw: null, value: null, error: false };
	try {
		const document = parseDocument(match[1], { schema: 'core', uniqueKeys: true, intAsBigInt: true });
		if (document.errors.length || document.warnings.length) throw new Error('Invalid YAML');
		// Bound alias expansion; cyclic/oversized data falls back to its exact source.
		const value: unknown = document.toJS({ maxAliasCount: 50 });
		JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? String(item) : item);
		return { body: text.slice(match[0].length), raw: match[1], value, error: false };
	} catch {
		return { body: text.slice(match[0].length), raw: match[1], value: null, error: true };
	}
}

function Value({ value }: { value: unknown }): ReactNode {
	if (Array.isArray(value)) {
		if (!value.length) return <span className="font-mono">[]</span>;
		return <ol className="m-0 flex list-decimal flex-col gap-1 ps-4">{value.map((item, index) => <li key={index}><Value value={item} /></li>)}</ol>;
	}
	if (value !== null && typeof value === 'object') {
		const fields = Object.entries(value);
		if (!fields.length) return <span className="font-mono">{'{}'}</span>;
		return (
			<dl className="@container/frontmatter m-0 min-w-0">
				{fields.map(([key, item]) => (
					<div key={key} className="grid min-w-0 gap-1 border-b border-(--line) px-2.5 py-2 last:border-b-0 @min-[480px]/frontmatter:grid-cols-[120px_minmax(0,1fr)]">
						<dt className="in-caption break-words">{key}</dt>
						<dd className="m-0 min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]"><Value value={item} /></dd>
					</div>
				))}
			</dl>
		);
	}
	return <>{value === null ? 'null' : value === '' ? '""' : String(value)}</>;
}

/** Shared by file previews: structured YAML, never an incomplete line-based summary. */
export function useFrontmatter(text: string) {
	return useMemo(() => splitFrontmatter(text), [text]);
}

export function Frontmatter({ front }: { front: ReturnType<typeof useFrontmatter> }) {
	if (front.raw === null) return null;
	return (
		<section aria-label="Frontmatter" className="@container/frontmatter in-well min-w-0 text-small text-(--text-2)">
			{front.error ? (
				<div className="p-2.5">
					<p className="m-0 mb-2 text-(--text-3)">Could not parse frontmatter. Showing its source.</p>
					<pre className="m-0 whitespace-pre-wrap [overflow-wrap:anywhere]">{front.raw}</pre>
				</div>
			) : <Value value={front.value} />}
		</section>
	);
}

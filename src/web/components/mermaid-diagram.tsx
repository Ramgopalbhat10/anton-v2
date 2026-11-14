import type { Mermaid } from 'mermaid';
import { useEffect, useId, useState } from 'react';
import { CodeBlock, useSettled } from '@/components/code-block';

/*
 * A ```mermaid block in a reply, drawn as a diagram. Mermaid is large, so it
 * loads only when a reply has one. It runs at its strictest: labels are text,
 * clicks and links in the diagram do nothing, and its SVG is sanitized.
 */

let loading: Promise<Mermaid> | null = null;
let queue: Promise<unknown> = Promise.resolve();

function loadMermaid(): Promise<Mermaid> {
	loading ??= import('mermaid')
		.then(({ default: mermaid }) => {
			const style = getComputedStyle(document.documentElement);
			const token = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
			mermaid.initialize({
				startOnLoad: false,
				securityLevel: 'strict',
				theme: 'base',
				fontFamily: token('--font', 'ui-sans-serif, system-ui, sans-serif'),
				themeVariables: {
					darkMode: true,
					background: 'transparent',
					primaryColor: token('--bg-overlay', '#1f1f1f'),
					primaryTextColor: token('--text', '#ededed'),
					primaryBorderColor: token('--line-strong', '#3a3a3a'),
					lineColor: token('--text-3', '#7a7a7a'),
					secondaryColor: token('--bg-active', '#262626'),
					tertiaryColor: token('--bg-raised', '#181818'),
					noteBkgColor: token('--bg-overlay', '#1f1f1f'),
					noteTextColor: token('--text-2', '#a1a1a1'),
					fontSize: '13px',
				},
			});
			return mermaid;
		})
		.catch((error: unknown) => {
			loading = null;
			throw error;
		});
	return loading;
}

/** Mermaid draws one diagram at a time; renders wait their turn. */
async function draw(id: string, source: string): Promise<string | null> {
	const mermaid = await loadMermaid();
	const run = queue.then(async () => {
		if (!(await mermaid.parse(source, { suppressErrors: true }))) return null;
		const { svg } = await mermaid.render(id, source);
		return svg;
	});
	queue = run.catch(() => undefined);
	return run;
}

export function MermaidDiagram({ source }: { source: string }) {
	const settled = useSettled(source.trim(), 400);
	const id = `mermaid-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
	const [svg, setSvg] = useState<string | null>(null);
	const [failed, setFailed] = useState(false);
	useEffect(() => {
		let current = true;
		draw(id, settled).then(
			(drawn) => {
				if (!current) return;
				// A diagram still being written may not parse yet; the last one that did stays.
				if (drawn) setSvg(drawn);
				setFailed(!drawn);
			},
			() => current && setFailed(true),
		);
		return () => {
			current = false;
		};
	}, [id, settled]);
	if (!svg) return <CodeBlock code={source} language="mermaid" />;
	return (
		<figure className="sg-mermaid mb-2.5 overflow-x-auto rounded-card border border-(--line) bg-(--bg-app) px-3 py-3" aria-label="Diagram" data-stale={failed || undefined}>
			{/* Mermaid's own output, sanitized by it at securityLevel strict. */}
			<div className="flex justify-center [&_svg]:h-auto [&_svg]:max-w-full" dangerouslySetInnerHTML={{ __html: svg }} />
		</figure>
	);
}

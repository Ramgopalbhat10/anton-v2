import { useQuery } from '@tanstack/react-query';
import { Check, Copy } from '@/lib/icons';
import { Fragment, useEffect, useMemo, useState } from 'react';
import { IconBtn } from '@/components/kit/signal';
import { hashText, highlight } from '@/lib/highlight';
import { cn } from '@/lib/utils';

/** Waits for a value to stop changing, so a block still streaming is highlighted once it settles, not on every chunk. */
export function useSettled<T>(value: T, delay = 250): T {
	const [settled, setSettled] = useState(value);
	useEffect(() => {
		const timer = setTimeout(() => setSettled(value), delay);
		return () => clearTimeout(timer);
	}, [value, delay]);
	return settled;
}

export function CopyButton({ text, label = 'Copy', className }: { text: string; label?: string; className?: string }) {
	const [copied, setCopied] = useState(false);
	useEffect(() => {
		if (!copied) return;
		const timer = setTimeout(() => setCopied(false), 1600);
		return () => clearTimeout(timer);
	}, [copied]);
	return (
		<IconBtn
			size="xs"
			icon={copied ? Check : Copy}
			label={copied ? 'Copied' : label}
			className={className}
			onClick={() => void navigator.clipboard.writeText(text).then(() => setCopied(true), () => undefined)}
		/>
	);
}

export function CodeBlock({ code, language, className, source = false }: { code: string; language?: string; className?: string; source?: boolean }) {
	const text = source ? code.replace(/\r\n?/g, '\n') : code.replace(/\n$/, '');
	const settled = useSettled(text);
	const textId = useMemo(() => hashText(settled), [settled]);
	const colored = useQuery({
		queryKey: ['highlight-block', language ?? '', settled.length, textId],
		queryFn: () => highlight(settled, `block.${language ?? 'txt'}`),
		enabled: Boolean(language) && settled.length > 0,
		staleTime: Number.POSITIVE_INFINITY,
		gcTime: 60_000,
	});
	// Colours for an earlier version of a block still being written would land on the wrong lines.
	const tokens = settled === text ? (colored.data ?? null) : null;
	const numbers = useMemo(() => source ? text.split('\n').map((_, index) => index + 1).join('\n') : '', [source, text]);
	const header = (
		<div className="flex h-7 shrink-0 items-center gap-2 border-b border-(--line) ps-3 pe-1">
			<span className="in-caption min-w-0 flex-1 truncate">{language || 'text'}</span>
			<CopyButton text={source ? code : text} label="Copy code" className="opacity-0 transition-opacity duration-(--t-fast) group-hover/code:opacity-100 focus-visible:opacity-100" />
		</div>
	);
	if (source) {
		return (
			<div className={cn('group/code flex min-h-0 min-w-0 flex-col bg-(--bg-app)', className)}>
				{header}
				<div role="region" aria-label="Source code" tabIndex={0} dir="ltr" className="sg-source-scroll min-h-0 flex-1 overflow-auto overscroll-contain font-mono text-small leading-[19px] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--accent-line)">
					<div className="flex min-w-max">
						<div aria-hidden="true" className="sticky start-0 min-w-12 shrink-0 border-e border-(--line) bg-(--bg-app) px-2.5 py-2.5 text-end whitespace-pre text-(--text-3) tabular-nums select-none">{numbers}</div>
						<pre className="m-0 px-3 py-2.5 whitespace-pre text-(--text-2)"><code>
							{tokens ? tokens.map((line, index) => (
								<Fragment key={index}>
									{index > 0 ? '\n' : null}
									{line.map((token, at) => <span key={at} style={{ color: token.color }}>{token.content}</span>)}
								</Fragment>
							)) : text}
						</code></pre>
					</div>
				</div>
			</div>
		);
	}
	return (
		<div className={cn('sg-code group/code relative mb-2.5 overflow-hidden p-0 whitespace-normal rounded-card border border-(--line) bg-(--bg-app)', className)}>
			{header}
			<pre className="m-0! rounded-none! bg-transparent!">
				<code>
					{tokens
						? tokens.map((line, index) => (
								<span key={index} className="block">
									{line.length
										? line.map((token, at) => (
												<span key={at} style={{ color: token.color }}>
													{token.content}
												</span>
											))
										: '\n'}
								</span>
							))
						: text}
				</code>
			</pre>
		</div>
	);
}

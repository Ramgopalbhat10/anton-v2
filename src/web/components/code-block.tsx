import { useQuery } from '@tanstack/react-query';
import { Check, Copy } from 'lucide-react';
import { useEffect, useState } from 'react';
import { IconBtn } from '@/components/signal';
import { highlight } from '@/lib/highlight';
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

/**
 * A fenced code block in a reply: highlighted by Shiki once it stops
 * changing, with its language and a copy button above it.
 */
export function CodeBlock({ code, language, className }: { code: string; language?: string; className?: string }) {
	const text = code.replace(/\n$/, '');
	const settled = useSettled(text);
	const colored = useQuery({
		queryKey: ['highlight-block', language ?? '', settled],
		queryFn: () => highlight(settled, `block.${language ?? 'txt'}`),
		enabled: Boolean(language) && settled.length > 0,
		staleTime: Number.POSITIVE_INFINITY,
		gcTime: 60_000,
	});
	// Colours for an earlier version of a block still being written would land on the wrong lines.
	const tokens = settled === text ? (colored.data ?? null) : null;
	return (
		<div className={cn('sg-code group/code relative mb-2.5 overflow-hidden rounded-(--radius-md) border border-(--border-subtle) bg-(--bg-inset)', className)}>
			<div className="flex h-7 items-center gap-2 border-b border-(--border-subtle) pr-1 pl-3">
				<span className="in-caption min-w-0 flex-1 truncate">{language || 'text'}</span>
				<CopyButton text={text} label="Copy code" className="opacity-0 transition-opacity duration-(--duration-micro) group-hover/code:opacity-100 focus-visible:opacity-100" />
			</div>
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

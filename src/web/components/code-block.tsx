import { useQuery } from '@tanstack/react-query';
import { Check, Copy } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
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
 * A short stand-in for a block's text in its query key: the cache hashes the key on every
 * render, and a long block as its own key was hashed whole each time. 53 bits (cyrb53) and
 * the length, so two blocks in view practically never share one. Worked out once per settled text.
 */
function textHash(text: string): string {
	let h1 = 0xdeadbeef;
	let h2 = 0x41c6ce57;
	for (let index = 0; index < text.length; index++) {
		const code = text.charCodeAt(index);
		h1 = Math.imul(h1 ^ code, 2654435761);
		h2 = Math.imul(h2 ^ code, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/**
 * A fenced code block in a reply: highlighted by Shiki once it stops
 * changing, with its language and a copy button above it.
 */
export function CodeBlock({ code, language, className }: { code: string; language?: string; className?: string }) {
	const text = code.replace(/\n$/, '');
	const settled = useSettled(text);
	const textId = useMemo(() => textHash(settled), [settled]);
	const colored = useQuery({
		queryKey: ['highlight-block', language ?? '', settled.length, textId],
		queryFn: () => highlight(settled, `block.${language ?? 'txt'}`),
		enabled: Boolean(language) && settled.length > 0,
		staleTime: Number.POSITIVE_INFINITY,
		gcTime: 60_000,
	});
	// Colours for an earlier version of a block still being written would land on the wrong lines.
	const tokens = settled === text ? (colored.data ?? null) : null;
	return (
		<div className={cn('sg-code group/code relative mb-2.5 overflow-hidden rounded-card border border-(--line) bg-(--bg-app)', className)}>
			<div className="flex h-7 items-center gap-2 border-b border-(--line) pr-1 pl-3">
				<span className="in-caption min-w-0 flex-1 truncate">{language || 'text'}</span>
				<CopyButton text={text} label="Copy code" className="opacity-0 transition-opacity duration-(--t-fast) group-hover/code:opacity-100 focus-visible:opacity-100" />
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

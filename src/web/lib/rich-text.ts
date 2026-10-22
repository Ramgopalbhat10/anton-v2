/** What stands out in typed text: a web link, a `/command` at its start, or an `@path` file reference. */
export type RichKind = 'link' | 'command' | 'file';
export type RichRange = { kind: RichKind; start: number; end: number };

/** Links, a leading command, and `@` references that begin a word. */
const RICH = /(https?:\/\/[^\s<>"'`]+)|(^\/[\w-]+(?=\s|$))|((?:^|(?<=\s))@[^\s@]+)/g;
/** Punctuation that ends a sentence rather than a link or a path. */
const TRAILING = /[.,;:!?'")\]}]+$/;

/** Where links, commands and file references sit in a message, in order. */
export function richRanges(text: string): RichRange[] {
	const ranges: RichRange[] = [];
	for (const match of text.matchAll(RICH)) {
		const kind: RichKind = match[1] ? 'link' : match[2] ? 'command' : 'file';
		const word = kind === 'command' ? match[0] : match[0].replace(TRAILING, '');
		// A bare `@` or `http://` is not a reference yet.
		if (word.length < (kind === 'link' ? 10 : 2)) continue;
		ranges.push({ kind, start: match.index, end: match.index + word.length });
	}
	return ranges;
}

/** A stretch of the text, split where the ranges begin and end; each piece carries its kind, if any. */
export function splitRich(text: string, start: number, end: number, ranges: RichRange[]): Array<{ text: string; kind?: RichKind; start: number; end: number }> {
	const out: Array<{ text: string; kind?: RichKind; start: number; end: number }> = [];
	let at = start;
	for (const range of ranges) {
		if (range.end <= at || range.start >= end) continue;
		const from = Math.max(range.start, at);
		const to = Math.min(range.end, end);
		if (from > at) out.push({ text: text.slice(at, from), start: at, end: from });
		out.push({ text: text.slice(from, to), kind: range.kind, start: from, end: to });
		at = to;
	}
	if (at < end) out.push({ text: text.slice(at, end), start: at, end });
	return out;
}

/** The look of each kind, shared by the composer's draft and a sent message, so they read the same. */
export const RICH_CLASS: Record<RichKind | 'chip', string> = {
	link: 'text-(--accent-text) underline decoration-(--accent-border) underline-offset-2',
	command: 'font-mono text-[12px] text-(--accent-text)',
	file: 'font-mono text-[12px] text-(--accent-text)',
	chip: 'inline-block max-w-full rounded-md border border-(--accent-border) bg-(--accent-bg-subtle) px-1.5 align-baseline font-mono text-[12px] leading-[18px] text-(--accent-text)',
};

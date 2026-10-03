/** What is being completed: `@path` anywhere in the message, or `/name` at its very start. */
export type Trigger = { kind: '@' | '/'; query: string; start: number; end: number };

export function triggerAt(text: string, caret: number): Trigger | null {
	const before = text.slice(0, caret);
	const slash = /^\/([\w-]*)$/.exec(before);
	if (slash) return { kind: '/', query: slash[1], start: 0, end: caret };
	const at = /(?:^|\s)@([^\s@]*)$/.exec(before);
	if (at) return { kind: '@', query: at[1], start: caret - at[1].length - 1, end: caret };
	return null;
}

export const SHOWN = 8;

/** Paths whose file name starts with the query first, then any path containing it. */
export function matchPaths(paths: string[], query: string, limit = SHOWN): string[] {
	const wanted = query.toLowerCase();
	const name = (path: string) => path.slice(path.lastIndexOf('/') + 1).toLowerCase();
	const starts = paths.filter((path) => name(path).startsWith(wanted));
	const contains = paths.filter((path) => !name(path).startsWith(wanted) && path.toLowerCase().includes(wanted));
	return [...starts, ...contains].slice(0, limit);
}

/**
 * What the agent's browser tool has already shown it, so a step answers with
 * what changed rather than the whole page again. Every step's answer stays in
 * the subagent's conversation and is read again on each later call, so a page
 * described in full at every step is most of a browsing job's tokens. Here a
 * page the agent has seen comes back as "unchanged", or as the lines that
 * changed with a little context; anything else, or `full`, comes back whole.
 */

/** Pages remembered per browser (a task's panel or sandbox browser), and browsers remembered in all. */
const PAGES_PER_BROWSER = 12;
const BROWSERS = 200;
/** Lines of unchanged context around each change. */
const CONTEXT = 2;
/** A diff longer than this share of the page is no saving; the page comes back whole. */
const MAX_DIFF_SHARE = 0.6;
/** Pages longer than this many lines are not diffed line by line (the comparison is quadratic); they come back whole or unchanged. */
const MAX_DIFF_LINES = 1500;

type Seen = { snapshot: string; step: number };
type Browser = { pages: Map<string, Seen>; steps: number };
const browsers = new Map<string, Browser>();

function browserOf(key: string): Browser {
	let browser = browsers.get(key);
	if (browser) {
		// Most recently used last, so the oldest is the first to go.
		browsers.delete(key);
	} else {
		browser = { pages: new Map(), steps: 0 };
	}
	browsers.set(key, browser);
	for (const stale of [...browsers.keys()].slice(0, Math.max(0, browsers.size - BROWSERS))) browsers.delete(stale);
	return browser;
}

/** Where on a page a step's answer is about: the address without its fragment, which never changes what is shown. */
const pageOf = (url: string) => url.replace(/#.*$/, '');

/** Line-level edit script: for each line of `after`, whether it is new; and the lines of `before` that are gone. */
function diffLines(before: string[], after: string[]): { added: boolean[]; removed: Array<{ at: number; line: string }> } {
	const n = before.length;
	const m = after.length;
	// Longest common subsequence lengths, from the end, in one flat array.
	const table = new Uint32Array((n + 1) * (m + 1));
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			table[i * (m + 1) + j] = before[i] === after[j] ? table[(i + 1) * (m + 1) + j + 1] + 1 : Math.max(table[(i + 1) * (m + 1) + j], table[i * (m + 1) + j + 1]);
		}
	}
	const added = new Array<boolean>(m).fill(true);
	const removed: Array<{ at: number; line: string }> = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (before[i] === after[j]) {
			added[j] = false;
			i++;
			j++;
		} else if (table[(i + 1) * (m + 1) + j] >= table[i * (m + 1) + j + 1]) {
			removed.push({ at: j, line: before[i++] });
		} else {
			j++;
		}
	}
	while (i < n) removed.push({ at: m, line: before[i++] });
	return { added, removed };
}

/** The changes as hunks: `+` for new lines, `-` for gone ones, unchanged lines around them for where they sit. */
function hunks(before: string[], after: string[]): { text: string; changed: number } {
	const { added, removed } = diffLines(before, after);
	const changed = added.filter(Boolean).length + removed.length;
	const keep = new Array<boolean>(after.length).fill(false);
	const mark = (at: number) => {
		for (let k = Math.max(0, at - CONTEXT); k <= Math.min(after.length - 1, at + CONTEXT); k++) keep[k] = true;
	};
	added.forEach((isNew, index) => isNew && mark(index));
	for (const gone of removed) mark(Math.min(gone.at, after.length - 1));
	const out: string[] = [];
	let skipped = false;
	for (let index = 0; index <= after.length; index++) {
		for (const gone of removed.filter((entry) => entry.at === index)) out.push(`- ${gone.line}`);
		if (index === after.length) break;
		if (keep[index]) {
			if (skipped) out.push('  …');
			skipped = false;
			out.push(`${added[index] ? '+' : ' '} ${after[index]}`);
		} else {
			skipped = true;
		}
	}
	return { text: out.join('\n'), changed };
}

/**
 * The page description to give the agent for this step in browser `key`:
 * the snapshot itself the first time or with `full`, else a note that it is
 * unchanged, or its changes.
 */
export function pageForAgent(key: string, url: string, snapshot: string, full = false): string {
	const browser = browserOf(key);
	const step = ++browser.steps;
	const page = pageOf(url);
	const seen = browser.pages.get(page);
	browser.pages.delete(page);
	browser.pages.set(page, { snapshot, step });
	for (const stale of [...browser.pages.keys()].slice(0, Math.max(0, browser.pages.size - PAGES_PER_BROWSER))) browser.pages.delete(stale);
	if (full || !seen || !snapshot) return snapshot;
	const ago = step - seen.step === 1 ? 'the last step' : `${step - seen.step} steps ago`;
	if (seen.snapshot === snapshot) return `(This page is unchanged since ${ago}; its description is above. Use look to have it again in full.)`;
	const before = seen.snapshot.split('\n');
	const after = snapshot.split('\n');
	if (before.length > MAX_DIFF_LINES || after.length > MAX_DIFF_LINES) return snapshot;
	const { text, changed } = hunks(before, after);
	if (changed > after.length * MAX_DIFF_SHARE) return snapshot;
	return `(Changes since ${ago}, as a diff of the page description: + new, - gone, unchanged lines for context. Use look for the whole page.)\n${text}`;
}

/** Forgets what a browser has shown, as when its page was replaced by the user. */
export function forgetPages(key: string): void {
	browsers.delete(key);
}

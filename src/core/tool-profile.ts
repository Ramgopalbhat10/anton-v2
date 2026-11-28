import { unrouted } from './model-route.ts';

/**
 * Each model family is trained on its own editing tool. Given only `edit`, a GPT model wrote files with heredocs and
 * `python -c` instead: 79 shell writes against 45 edits in a 20-task benchmark.
 */
export type ToolProfile = 'patch' | 'edit';

export type ToolProfileSetting = 'auto' | ToolProfile;

export const asToolProfileSetting = (value: string): ToolProfileSetting => (value === 'patch' || value === 'edit' ? value : 'auto');

/**
 * Between a line's number and its text in `read`. A tab there read as one more level of indentation in tab-indented code:
 * Devin and Antigravity copied it into edit's oldText, and 22 of their 34 failed edits (Nov 2026) missed by exactly one tab.
 */
export const LINE_MARK = '→';

export const FILE_CHANGE_TOOLS: ReadonlySet<string> = new Set(['write', 'edit', 'apply_patch']);

/** Gateways that name a model `<maker>/<model>` after their own name, with `~` before an alias that follows the maker's latest. */
const BY_MAKER = new Set(['openrouter', 'vercel']);
const ONE_MAKER: Record<string, string> = { openai: 'openai', 'claude-code': 'anthropic' };
const OPENAI_NAME = /^(?:gpt|codex|o\d)(?:-|$)/i;

/** Told from the specifier alone, so the answer never waits on a model list and is the same on every render. */
export function madeByOpenAi(model: string): boolean {
	const plain = unrouted(model).replace(/\[[^\]]*\]$/, '');
	const slash = plain.indexOf('/');
	if (slash < 0) return OPENAI_NAME.test(plain);
	const gateway = plain.slice(0, slash);
	const rest = plain.slice(slash + 1);
	if (gateway in ONE_MAKER) return ONE_MAKER[gateway] === 'openai';
	if (BY_MAKER.has(gateway)) return rest.replace(/^~/, '').split('/')[0].toLowerCase() === 'openai';
	return OPENAI_NAME.test(rest.split('/').pop() ?? '');
}

export function toolProfileFor(model: string, setting: ToolProfileSetting = 'auto'): ToolProfile {
	if (setting !== 'auto') return setting;
	return madeByOpenAi(model) ? 'patch' : 'edit';
}

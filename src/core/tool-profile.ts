import { unrouted } from './model-route.ts';

/**
 * Which tools change files for a task's agent, by the family of the model it
 * runs on. Each family is trained on its own editing tool: Anthropic's on exact
 * text replacement (`edit`, with `write`), OpenAI's GPT and Codex models on
 * `apply_patch`, the tool Codex CLI gives them. Given only `edit`, a GPT model
 * wrote files with heredocs and `python -c` in the shell instead: 79 shell
 * writes against 45 edits in a 20-task benchmark.
 */
export type ToolProfile = 'patch' | 'edit';

/** `ANTON_TOOL_PROFILE`: `auto` picks by the model's maker; `patch` or `edit` forces one for every model, to compare them on the same model. */
export type ToolProfileSetting = 'auto' | ToolProfile;

export const asToolProfileSetting = (value: string): ToolProfileSetting => (value === 'patch' || value === 'edit' ? value : 'auto');

/** The tools that change files, under either profile. */
export const FILE_CHANGE_TOOLS: ReadonlySet<string> = new Set(['write', 'edit', 'apply_patch']);

/** Gateways that name a model `<maker>/<model>` after their own name, with `~` before an alias that follows the maker's latest. */
const BY_MAKER = new Set(['openrouter', 'vercel']);
/** Gateways that serve only one maker's models: the ChatGPT plan's are OpenAI's, Claude Code's Anthropic's. */
const ONE_MAKER: Record<string, string> = { openai: 'openai', 'claude-code': 'anthropic' };
/** A model OpenAI makes, by the name a plan that serves several makers' models gives it (Cursor, OpenCode Go): GPT, Codex and the o-series. */
const OPENAI_NAME = /^(?:gpt|codex|o\d)(?:-|$)/i;

/**
 * Whether OpenAI made the model a specifier names (`<gateway>/<model>`, with a
 * route or variant or not), told from the specifier alone, so the answer never
 * waits on a model list and is the same on every render while the model is.
 */
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

/** The task's editing tools, for the model it runs on, unless the setting forces one profile. */
export function toolProfileFor(model: string, setting: ToolProfileSetting = 'auto'): ToolProfile {
	if (setting !== 'auto') return setting;
	return madeByOpenAi(model) ? 'patch' : 'edit';
}

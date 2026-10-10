import type { Question } from '../core/ports.ts';
import { decide, yesOf } from './decisions.ts';

/**
 * The decision model's judgements about a page the browser subagent reads:
 * which parts of a long page matter for its job, and whether the page needs
 * the user (a sign-in or a human check) before anything else can happen.
 * Each is one call of a fraction of a cent; without a decision model, or when
 * it cannot answer, the page is left as it was.
 */

/** Pages shorter than this are given whole; trimming them saves too little. */
const MIN_TRIM = 4000;
/**
 * A part judged less likely than this to matter is left out. Parts the job
 * might need come in around one half; the agent sees what was left out and
 * can look again for the whole page, so a firm line costs little.
 */
const RELEVANT = 0.55;
const MAX_PARTS = 24;
const EXCERPT = 600;

type Part = { lines: string[] };

/**
 * The page's parts: its top-level blocks, with any block that is most of the
 * page opened into its children, as far down as it takes (pages built of
 * nested tables or wrappers have one block holding everything).
 */
export function partsOf(snapshot: string): Part[] {
	const split = (lines: string[], indent: string): Part[] => {
		const parts: Part[] = [];
		for (const line of lines) {
			if (line.startsWith(`${indent}- `) || !parts.length) parts.push({ lines: [line] });
			else parts[parts.length - 1].lines.push(line);
		}
		return parts;
	};
	const size = (part: Part) => part.lines.join('\n').length;
	let parts = split(snapshot.split('\n'), '');
	for (let depth = 1; depth <= 12; depth++) {
		const biggest = parts.reduce((max, part) => (size(part) > size(max) ? part : max), parts[0]);
		if (!biggest || size(biggest) <= snapshot.length * 0.7 || biggest.lines.length < 2) break;
		const indent = /^\s*/.exec(biggest.lines[0])?.[0] ?? '';
		const children = split(biggest.lines.slice(1), `${indent}  `);
		parts = parts.flatMap((part) => (part === biggest ? [{ lines: [biggest.lines[0]] }, ...children] : [part]));
	}
	// Past the limit, the rest stay together as one last part.
	if (parts.length > MAX_PARTS) parts = [...parts.slice(0, MAX_PARTS - 1), { lines: parts.slice(MAX_PARTS - 1).flatMap((part) => part.lines) }];
	return parts;
}

/**
 * A long page cut to the parts that matter for `job`: the others become one
 * line each saying how much was left out, so the agent can ask for them.
 */
export async function trimToJob(id: string, job: string | null, url: string, snapshot: string): Promise<string> {
	if (!job || snapshot.length < MIN_TRIM) return snapshot;
	const parts = partsOf(snapshot);
	if (parts.length < 3) return snapshot;
	const questions: Record<string, Question> = {};
	const state: Record<string, unknown> = { job: job.slice(0, 4000), url };
	parts.forEach((part, index) => {
		state[`part${index}`] = part.lines.join('\n').slice(0, EXCERPT);
		questions[`part${index}`] = { type: 'yes-no', instructions: `Does part${index} of the page hold anything the job needs: content to read, or a link, button or field to use?` };
	});
	const answers = await decide(id, state, questions);
	if (!answers) return snapshot;
	let left = 0;
	const kept = parts.flatMap((part, index) => {
		// A part with no answer is kept, as is any one-line part (a heading on its own costs nothing).
		if (part.lines.length === 1 || (yesOf(answers[`part${index}`]) ?? 1) >= RELEVANT) return part.lines;
		left += 1;
		const indent = /^\s*/.exec(part.lines[0])?.[0] ?? '';
		return [`${indent}${part.lines[0].trim().replace(/:$/, '')}: (${part.lines.length - 1} lines left out as not needed for the job)`];
	});
	if (!left) return snapshot;
	return `(Parts of this page that do not bear on your job are left out; use look to see them.)\n${kept.join('\n')}`;
}

/**
 * What a sign-in wall or a human check shows: a password field, or a CAPTCHA
 * or "are you human" check. A page that only links to a sign-in (most sites
 * do) is not put to the decision model.
 */
const LOOKS_GATED = /textbox "[^"]*password|password:|captcha|verify (?:you are|that you are) (?:a )?human|are you a robot|security check|just a moment/i;

/** Whether the page needs the user to sign in or prove they are human before it shows what it is for. */
export async function needsTheUser(id: string, url: string, title: string, snapshot: string): Promise<boolean> {
	if (!LOOKS_GATED.test(`${title}\n${snapshot}`)) return false;
	const answers = await decide(
		id,
		{ url, title, page: snapshot.slice(0, 6000) },
		{ gated: { type: 'yes-no', instructions: 'Must a person sign in, or prove they are human (a CAPTCHA or security check), before this page shows what it is for?' } },
	);
	return (yesOf(answers?.gated) ?? 0) >= 0.6;
}

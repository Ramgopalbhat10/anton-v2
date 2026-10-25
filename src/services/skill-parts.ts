import { cutResult, keepResult, MORE_TOOL, partAt, resultText } from './tool-results.ts';

/*
 * A skill as the agent takes it on activation. The runtime's `activate_skill`
 * answers with the skill's instructions and a line per supporting file, each
 * naming the file's whole packaged path: a skill with a hundred files lists
 * 40KB of paths, which then ride along with every later call. The list is
 * given once per folder instead, every file still named. Instructions past
 * 32KB keep their first 16KB and a list of the sections after it, each read
 * with `read_full_result` from where it starts.
 */

const LIST_START = 'Supporting skill resources are available but are not loaded into context unless needed:\n<skill_resources>\n';
const LIST_END = '</skill_resources>';
const ENTRY = /^- (.+?) → read_skill_resource (.+)$/;
/** Instructions up to this size are kept whole: most skills' are. */
const WHOLE_INSTRUCTIONS = 32_768;
/** How much of longer instructions is kept before the list of what follows. */
const INSTRUCTIONS_HEAD = 16_384;

/** The supporting-file list, once per folder; null when it is not in the shape the runtime writes. */
export function groupResources(list: string): string | null {
	const files: string[] = [];
	let base: string | null = null;
	for (const line of list.split('\n').filter(Boolean)) {
		const match = ENTRY.exec(line);
		if (!match) return null;
		const [, relative, full] = match;
		const root = full.endsWith(`/${relative}`) ? full.slice(0, -relative.length - 1) : null;
		if (root === null || (base !== null && root !== base)) return null;
		base = root;
		files.push(relative);
	}
	if (base === null) return null;
	const folders = new Map<string, string[]>();
	for (const file of files) {
		const cut = file.lastIndexOf('/');
		const folder = cut < 0 ? '' : file.slice(0, cut + 1);
		folders.set(folder, [...(folders.get(folder) ?? []), file.slice(cut + 1)]);
	}
	const lines = [...folders].map(([folder, names]) => (folder ? `${folder} ${names.join(', ')}` : names.join(', ')));
	return `Supporting skill resources are available but are not loaded into context unless needed. Read one with read_skill_resource ${base}/<path>, the path as listed (folder, then file name):\n<skill_resources>\n${lines.join('\n')}\n`;
}

/** Long instructions' start, then each later section's heading and where it starts in the whole result. */
function headAndSections(text: string, from: number, to: number, toolCallId: string): string {
	const head = partAt(text, from, INSTRUCTIONS_HEAD);
	const end = from + head.length;
	const sections: string[] = [];
	for (const match of text.slice(end, to).matchAll(/^#{1,3} .+$/gm)) sections.push(`- ${match[0]} (offset ${end + match.index})`);
	return (
		`${head}\n\n[The instructions go on for ${(to - end).toLocaleString('en-US')} more characters. ` +
		`Read the sections the work needs with ${MORE_TOOL}, id "${toolCallId}" and the offset given:\n${sections.join('\n') || `- the rest (offset ${end})`}]\n`
	);
}

/**
 * An activated skill's result with its supporting files listed once per folder and, for an agent that can read on
 * (`conversation`), instructions past 32KB in parts, else cut as any long result. A subagent's is never cut.
 */
export function skillInParts<T>(result: T, toolCallId: string, conversation: string | null): T {
	const text = resultText(result);
	if (text === null) return result;
	let split = false;
	let changed = text;
	const listAt = text.indexOf(LIST_START);
	const listEnd = listAt < 0 ? -1 : text.indexOf(LIST_END, listAt);
	if (listEnd > 0) {
		const grouped = groupResources(text.slice(listAt + LIST_START.length, listEnd));
		if (grouped) changed = text.slice(0, listAt) + grouped + text.slice(listEnd);
	}
	const open = changed.indexOf('<skill_instructions>\n');
	const close = changed.indexOf('</skill_instructions>');
	if (conversation && open >= 0 && close - open > WHOLE_INSTRUCTIONS) {
		keepResult(conversation, toolCallId, changed);
		const from = open + '<skill_instructions>\n'.length;
		changed = changed.slice(0, from) + headAndSections(changed, from, close, toolCallId) + changed.slice(close);
		split = true;
	}
	const content = (result as { content: Array<{ type: string; text?: string }> }).content;
	const given = changed === text ? result : { ...result, content: [{ type: 'text', text: changed }, ...content.filter((part) => part.type !== 'text')] };
	// Cutting again would replace the whole kept for the sections' offsets.
	return conversation && !split ? cutResult(conversation, toolCallId, 'activate_skill', given) : given;
}

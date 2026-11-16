import { cutResult, keepResult, MORE_TOOL, partAt, resultText } from './tool-results.ts';

/*
 * The runtime's `activate_skill` lists each supporting file's whole path, 40KB for a hundred files, riding along with every
 * later call; here the list is given once per folder. Instructions past 32KB keep 16KB and a list of later sections.
 */

const LIST_START = 'Supporting skill resources are available but are not loaded into context unless needed:\n<skill_resources>\n';
const LIST_END = '</skill_resources>';
const ENTRY = /^- (.+?) → read_skill_resource (.+)$/;
const WHOLE_INSTRUCTIONS = 32_768;
const INSTRUCTIONS_HEAD = 16_384;

/** Null when it is not in the shape the runtime writes. */
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

/** A subagent's is never cut. */
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

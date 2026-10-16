/**
 * Files attached to a message. The original is saved where the agent's tools
 * reach it (a task's Library under `uploads/`, or a project's Library), and the
 * message carries each as an `<attachment>` block after the typed text, with
 * the file's text when Anton could read it: the same for every model and
 * runtime, since a runtime takes only images as attachments of their own.
 * Shared by the server (which writes a block's contents) and the page (which
 * shows a sent message's blocks as chips).
 */

/** A file the server saved and read for a message. `text` is null when it has no text Anton can read; `cut` is its full length when `text` was cut. */
export type AttachedFile = { name: string; path: string; size: number; kind: string; text: string | null; cut: number | null };

/** Where an attached file was saved: a task's own Library, or the project's, which the coordinator and every thread read. */
export type AttachmentPlace = 'task' | 'project';

const OPEN = /<attachment name="([^"]*)" path="([^"]*)" kind="([^"]*)" size="(\d+)"(?: library="project")?>\n?/;
const CLOSE = '</attachment>';

const attr = (value: string) => value.replace(/["<>\n]/g, '_');

/** The block for one attached file. A closing tag inside the file's text is escaped, so the block ends where it says. */
export function attachmentBlock(file: AttachedFile, place: AttachmentPlace): string {
	const head = `<attachment name="${attr(file.name)}" path="${attr(file.path)}" kind="${attr(file.kind)}" size="${file.size}"${place === 'project' ? ' library="project"' : ''}>`;
	const read = place === 'project' ? 'read_project_file' : 'read_attachment';
	const body =
		file.text === null
			? / image$/.test(file.kind)
				? 'An image: given with this message as a picture, or described after it for a model that cannot see.'
				: 'Not read as text (an archive or a format Anton does not convert): open the original at its path.'
			: `${file.text.replaceAll(CLOSE, '<\\/attachment>')}${file.cut ? `\n[Cut at ${file.text.length.toLocaleString('en-US')} of ${file.cut.toLocaleString('en-US')} characters: read the rest with ${read} from offset ${file.text.length}.]` : ''}`;
	return `${head}\n${body}\n${CLOSE}`;
}

/** What a message only of files says, since the agent always gets text. */
export function attachmentsOnly(count: number): string {
	return count === 1 ? 'Look at the attached file.' : 'Look at the attached files.';
}

/** The typed text with each file's block after it. */
export function withAttachments(text: string, files: AttachedFile[], place: AttachmentPlace): string {
	if (!files.length) return text;
	return [text.trim() || attachmentsOnly(files.length), ...files.map((file) => attachmentBlock(file, place))].join('\n\n');
}

export type AttachmentRef = { name: string; path: string; kind: string; size: number; place: AttachmentPlace };

/** A sent message split into what was typed and the files attached to it, for showing it. */
export function splitAttachments(message: string): { text: string; files: AttachmentRef[] } {
	const files: AttachmentRef[] = [];
	let first = -1;
	// One block after another: a tag in a file's own text is inside its block, so it is skipped with it.
	const open = new RegExp(OPEN.source, 'g');
	for (let match = open.exec(message); match; match = open.exec(message)) {
		const end = message.indexOf(CLOSE, open.lastIndex);
		if (end === -1) break;
		if (first === -1) first = match.index;
		files.push({ name: match[1], path: match[2], kind: match[3], size: Number(match[4]), place: match[0].includes('library="project"') ? 'project' : 'task' });
		open.lastIndex = end + CLOSE.length;
	}
	if (first === -1) return { text: message, files };
	const text = message.slice(0, first).trim();
	return { text: text === attachmentsOnly(files.length) ? '' : text, files };
}

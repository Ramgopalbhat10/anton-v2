import { createHash } from 'node:crypto';
import { OfficeParser } from 'officeparser';
import * as XLSX from 'xlsx';

/**
 * A file's text for the agent, the way chat apps read attachments: PDFs and
 * office documents become Markdown through officeparser (headings, lists and
 * tables kept, slides with their notes), spreadsheets become one CSV per sheet
 * through SheetJS, and any other file that is UTF-8 text is read as it is.
 * Null for a file with no text to read (an image, an archive, a legacy .doc),
 * which the agent opens from its original instead.
 */
export type DocumentText = { kind: string; text: string };

const OFFICE: Record<string, string> = {
	pdf: 'PDF',
	docx: 'Word document',
	docm: 'Word document',
	pptx: 'PowerPoint presentation',
	pptm: 'PowerPoint presentation',
	odt: 'OpenDocument text',
	odp: 'OpenDocument presentation',
	rtf: 'Rich text document',
	epub: 'EPUB book',
};
const SHEETS: Record<string, string> = {
	xlsx: 'Excel spreadsheet',
	xlsm: 'Excel spreadsheet',
	xlsb: 'Excel spreadsheet',
	xls: 'Excel spreadsheet',
	ods: 'OpenDocument spreadsheet',
	numbers: 'Numbers spreadsheet',
};
const TEXT: Record<string, string> = {
	csv: 'CSV',
	tsv: 'TSV',
	md: 'Markdown',
	markdown: 'Markdown',
	txt: 'Text',
	json: 'JSON',
	jsonl: 'JSON lines',
	xml: 'XML',
	html: 'HTML',
	htm: 'HTML',
	yaml: 'YAML',
	yml: 'YAML',
	log: 'Log',
};
const IMAGES: Record<string, string> = { png: 'PNG image', jpg: 'JPEG image', jpeg: 'JPEG image', gif: 'GIF image', webp: 'WebP image', svg: 'SVG image', heic: 'HEIC image' };

/** How long one file may take to read before it is left to the agent's own tools. */
const READ_MS = 30_000;

const extension = (name: string) => /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? '';

/** A short name for the file's type, for the agent and the chip. */
export function documentKind(name: string): string {
	const ext = extension(name);
	return OFFICE[ext] ?? SHEETS[ext] ?? TEXT[ext] ?? IMAGES[ext] ?? (ext ? `${ext.toUpperCase()} file` : 'File');
}

const strict = new TextDecoder('utf-8', { fatal: true });

/** The file as UTF-8 text, or null for binary: invalid UTF-8 or a NUL byte. */
function plainText(bytes: Uint8Array): string | null {
	try {
		const text = strict.decode(bytes);
		return text.includes('\0') ? null : text.replace(/^﻿/, '');
	} catch {
		return null;
	}
}

/** Every sheet as CSV under its name; formulas give their saved values. */
function sheets(bytes: Uint8Array): string {
	const book = XLSX.read(bytes, { type: 'array', dense: true });
	return book.SheetNames.map((name) => {
		const sheet = book.Sheets[name];
		const csv = sheet ? XLSX.utils.sheet_to_csv(sheet, { blankrows: false }).trimEnd() : '';
		return `## Sheet: ${name}\n\n${csv || '(empty)'}`;
	}).join('\n\n');
}

async function office(bytes: Uint8Array, ext: string): Promise<string> {
	const ast = await OfficeParser.parseOffice(Buffer.from(bytes), {
		// Macro-enabled files are the same format as their plain kind.
		fileType: (ext === 'docm' ? 'docx' : ext === 'pptm' ? 'pptx' : ext) as 'docx',
		abortSignal: AbortSignal.timeout(READ_MS),
	});
	const markdown = String((await ast.to('md')).value);
	return (
		markdown
			// The YAML header carries the file's metadata (author, dates), which the reader rarely needs.
			.replace(/^---\n[\s\S]*?\n---\n+/, '')
			// So do the anchors headings get, and the rule before the first page or slide.
			.replace(/^(#{1,6} .*?) \{#[\w-]+\}$/gm, '$1')
			.replace(/^(?:---\n+)+/, '')
			.trim()
	);
}

export async function documentText(name: string, bytes: Uint8Array): Promise<DocumentText | null> {
	const ext = extension(name);
	const kind = documentKind(name);
	if (IMAGES[ext]) return null;
	if (OFFICE[ext]) return { kind, text: await office(bytes, ext) };
	if (SHEETS[ext]) return { kind, text: sheets(bytes) };
	const text = plainText(bytes);
	return text === null ? null : { kind, text };
}

const cache = new Map<string, Promise<DocumentText | null>>();
const CACHED = 8;

/**
 * The same, kept for the last few files read, so reading a long document in
 * parts converts it once. Keyed by its name and contents; a failed read is not kept.
 */
export function cachedDocumentText(name: string, bytes: Uint8Array): Promise<DocumentText | null> {
	const id = `${extension(name)}:${createHash('sha256').update(bytes).digest('hex')}`;
	const hit = cache.get(id);
	if (hit) return hit;
	const pending = documentText(name, bytes);
	cache.set(id, pending);
	pending.catch(() => cache.delete(id));
	while (cache.size > CACHED) cache.delete(cache.keys().next().value!);
	return pending;
}

/** The most text one read hands the agent. */
export const READ_CHARS = 60_000;

/**
 * The file's text from `offset`, at most `READ_CHARS` of it, saying where the
 * next part starts; for the agent's tools that read the Library.
 */
export async function documentSlice(name: string, bytes: Uint8Array, offset = 0, how = 'read the next part with the same tool'): Promise<string> {
	const doc = await cachedDocumentText(name, bytes);
	if (!doc) return `${name} (${documentKind(name)}, ${bytes.length.toLocaleString('en-US')} bytes) has no text to read here. Open the original in your sandbox, where you can process it with your own tools.`;
	const start = Math.max(0, Math.min(Math.floor(offset), doc.text.length));
	const part = doc.text.slice(start, start + READ_CHARS);
	const end = start + part.length;
	if (start === 0 && end === doc.text.length) return part || '(The file has no text.)';
	return `${part}\n[Characters ${start.toLocaleString('en-US')} to ${end.toLocaleString('en-US')} of ${doc.text.length.toLocaleString('en-US')}${end < doc.text.length ? `; ${how} from offset ${end}` : ''}.]`;
}

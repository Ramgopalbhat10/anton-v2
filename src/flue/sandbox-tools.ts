import { Type } from '@earendil-works/pi-ai';
import { createBashTool, createEditTool, createGlobTool, createGrepTool, createReadTool, createWriteTool, type Sandbox, type SandboxToolFactory } from '@flue/runtime';

type Tool = ReturnType<SandboxToolFactory>[number];

const IMAGE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
/** As the composer sends images. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export const imageType = (path: string): string | undefined => IMAGE_TYPES[/\.(\w+)$/.exec(path)?.[1]?.toLowerCase() ?? ''];

/** How the agent's model takes an image: as a picture, or in words from the vision model when it cannot see. */
export type ImageSight = { sees: () => Promise<boolean>; describe: (bytes: Uint8Array, mimeType: string) => Promise<string> };

const text = (value: string) => ({ type: 'text' as const, text: value });

/**
 * Flue's standard file and shell tools, with a `read` that shows an image.
 * The standard one reads every file as text, so the agent could never look at
 * a picture in its sandbox: a reference image from the project's files, an
 * attachment, or a screenshot it took. An image comes back as a picture for a
 * model that sees, and described by the vision model for one that does not.
 */
export function sandboxTools(sight: ImageSight): SandboxToolFactory {
	return (sandbox) => {
		const read = createReadTool(sandbox);
		const readImage: Tool = {
			...read,
			description: `${read.description} An image (PNG, JPEG, GIF or WebP) comes back as the picture itself, to look at.`,
			async execute(toolCallId, params, signal, onUpdate) {
				const input = params as Parameters<typeof read.execute>[1];
				const { path } = input;
				const mimeType = imageType(path);
				if (!mimeType) return read.execute(toolCallId, input, signal, onUpdate);
				const bytes = await sandbox.readFileBuffer(path);
				const details = { path, size: bytes.length };
				if (bytes.length > MAX_IMAGE_BYTES) {
					return { content: [text(`${path} is an image of ${(bytes.length / 1024 / 1024).toFixed(1)} MB, too large to look at. Make a smaller copy (with ImageMagick or Python) and read that.`)], details };
				}
				if (await sight.sees()) return { content: [text(`${path}, an image:`), { type: 'image', data: Buffer.from(bytes).toString('base64'), mimeType }], details };
				const words = await sight.describe(bytes, mimeType).catch((error: unknown) => `No vision model could describe it: ${error instanceof Error ? error.message : String(error)}`);
				return { content: [text(`${path} is an image, and your model cannot see images, so a vision model described it:\n\n${words}`)], details };
			},
		};
		return [readImage, createWriteTool(sandbox), editMany(sandbox), createBashTool(sandbox), createGrepTool(sandbox), createGlobTool(sandbox)];
	};
}

type Replacement = { path: string; oldText: string; newText: string; replaceAll?: boolean };
type EditInput = Replacement & { more?: Array<Omit<Replacement, 'path'> & { path?: string }> };

const Replace = {
	oldText: Type.String({ description: 'Exact text to find (must be unique)' }),
	newText: Type.String({ description: 'Replacement text' }),
	replaceAll: Type.Optional(Type.Boolean({ description: 'Replace all occurrences' })),
};

/** The text after one replacement, or why it cannot be made, as Flue's own edit words it. */
function replaced(content: string, edit: Replacement): string | Error {
	if (edit.oldText === '') return new Error('oldText must be a non-empty string.');
	const count = content.split(edit.oldText).length - 1;
	if (count === 0) return new Error(`Could not find the exact text in ${edit.path}. Make sure your oldText matches exactly, including whitespace and indentation.`);
	if (edit.replaceAll) return content.replaceAll(edit.oldText, () => edit.newText);
	if (count > 1) return new Error(`Found ${count} occurrences of the text in ${edit.path}. Provide more surrounding context to make the match unique, or use replaceAll.`);
	return content.replace(edit.oldText, () => edit.newText);
}

/**
 * Flue's edit, which can also make several replacements in one call (`more`), in the same file or others. Each step
 * sends the whole conversation to the model again, and agents often make a change as a run of edits, one a step, so a
 * planned run made in one call saves a step's worth of context for each edit. The edits apply in order, and all or
 * none: when one cannot be made, no file is changed and the error names it. An edit without `more` is Flue's own.
 */
export function editMany(sandbox: Sandbox): Tool {
	const edit = createEditTool(sandbox);
	return {
		...edit,
		description: `${edit.description} To make several edits, in this file or others, put the rest in \`more\` and make them all in one call: each call sends the whole conversation again. They apply in order, and none is made if one fails.`,
		parameters: Type.Object({
			path: Type.String({ description: 'Path to the file to edit' }),
			...Replace,
			more: Type.Optional(
				Type.Array(Type.Object({ path: Type.Optional(Type.String({ description: 'Path to the file, when not the one above' })), ...Replace }), {
					description: 'Further edits to make in the same call, in order',
				}),
			),
		}),
		async execute(toolCallId, params, signal, onUpdate) {
			const input = params as EditInput;
			if (!input.more?.length) return edit.execute(toolCallId, input, signal, onUpdate);
			const edits: Replacement[] = [input, ...input.more.map((next) => ({ ...next, path: next.path || input.path }))];
			const contents = new Map<string, string>();
			for (const [index, next] of edits.entries()) {
				signal?.throwIfAborted();
				const content = contents.get(next.path) ?? (await sandbox.readFile(next.path));
				const after = replaced(content, next);
				if (after instanceof Error) throw new Error(`Edit ${index + 1} of ${edits.length}: ${after.message} No file was changed.`);
				contents.set(next.path, after);
			}
			for (const [path, content] of contents) {
				signal?.throwIfAborted();
				await sandbox.writeFile(path, content);
			}
			const files = [...contents.keys()];
			return {
				content: [text(`Made ${edits.length} edits in ${files.length === 1 ? files[0] : `${files.length} files: ${files.join(', ')}`}.`)],
				details: { path: input.path, paths: files, edits: edits.length },
			};
		},
	};
}

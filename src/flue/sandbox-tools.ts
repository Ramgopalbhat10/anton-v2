import { createBashTool, createEditTool, createGlobTool, createGrepTool, createReadTool, createWriteTool, type SandboxToolFactory } from '@flue/runtime';

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
		return [readImage, createWriteTool(sandbox), createEditTool(sandbox), createBashTool(sandbox), createGrepTool(sandbox), createGlobTool(sandbox)];
	};
}

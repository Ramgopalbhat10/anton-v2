import { createBashTool, createEditTool, createGlobTool, createGrepTool, createReadTool, createWriteTool, type SandboxToolFactory } from '@flue/runtime';

type Tool = ReturnType<SandboxToolFactory>[number];

const IMAGE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
/** As the composer sends images. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export const imageType = (path: string): string | undefined => IMAGE_TYPES[/\.(\w+)$/.exec(path)?.[1]?.toLowerCase() ?? ''];

/** How the agent's model takes an image: as a picture, or in words from the vision model when it cannot see. */
export type ImageSight = { sees: () => Promise<boolean>; describe: (bytes: Uint8Array, mimeType: string) => Promise<string> };

const text = (value: string) => ({ type: 'text' as const, text: value });

const ascii = (bytes: Uint8Array, from: number, length: number) => String.fromCharCode(...bytes.subarray(from, from + length));

/**
 * Whether an image's bytes end where its format says it ends. A screenshot read
 * while it was written, or cut short on its way out of the sandbox, otherwise
 * reaches the model as a broken picture: the provider refuses the whole request
 * ("could not parse image"), and as the picture stays in the conversation, every
 * later call of that agent fails the same way.
 */
export function isWholeImage(bytes: Uint8Array, mimeType: string): boolean {
	switch (mimeType) {
		case 'image/png':
			// The last chunk is IEND: a zero length, its type, and its CRC.
			return bytes.length >= 20 && bytes[0] === 0x89 && ascii(bytes, 1, 3) === 'PNG' && ascii(bytes, bytes.length - 8, 4) === 'IEND';
		case 'image/jpeg': {
			// Ends with EOI, though some writers pad a few bytes after it.
			const tail = bytes.subarray(Math.max(2, bytes.length - 64));
			return bytes[0] === 0xff && bytes[1] === 0xd8 && tail.some((byte, index) => byte === 0xff && tail[index + 1] === 0xd9);
		}
		case 'image/gif':
			return ascii(bytes, 0, 3) === 'GIF' && bytes[bytes.length - 1] === 0x3b;
		case 'image/webp':
			// RIFF gives the size of what follows its first 8 bytes.
			return ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP' && new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true) + 8 <= bytes.length;
		default:
			return true;
	}
}

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
				if (!isWholeImage(bytes, mimeType)) {
					return { content: [text(`${path} is not a whole ${mimeType.slice(6).toUpperCase()} (${bytes.length} bytes): it may still be being written, or is damaged. Read it again in a moment, or take the screenshot again.`)], details };
				}
				if (await sight.sees()) return { content: [text(`${path}, an image:`), { type: 'image', data: Buffer.from(bytes).toString('base64'), mimeType }], details };
				const words = await sight.describe(bytes, mimeType).catch((error: unknown) => `No vision model could describe it: ${error instanceof Error ? error.message : String(error)}`);
				return { content: [text(`${path} is an image, and your model cannot see images, so a vision model described it:\n\n${words}`)], details };
			},
		};
		return [readImage, createWriteTool(sandbox), createEditTool(sandbox), createBashTool(sandbox), createGrepTool(sandbox), createGlobTool(sandbox)];
	};
}

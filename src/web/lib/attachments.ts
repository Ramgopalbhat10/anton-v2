/** An image picked for the next message: the bytes for the agent and a URL for the preview. */
export type ImageAttachment = { id: string; filename: string; mimeType: string; data: string; preview: string };

export const MAX_IMAGES = 4;
const MAX_BYTES = 5 * 1024 * 1024;
const TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

function readAsDataUrl(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result));
		reader.onerror = () => reject(reader.error ?? new Error('Could not read the file'));
		reader.readAsDataURL(file);
	});
}

/** Reads the files the user picked, pasted or dropped; returns the images and why any were left out. */
export async function readImages(files: File[], room: number): Promise<{ images: ImageAttachment[]; rejected: string | null }> {
	const usable = files.filter((file) => TYPES.has(file.type) && file.size <= MAX_BYTES);
	const kept = usable.slice(0, Math.max(0, room));
	const images = await Promise.all(
		kept.map(async (file) => {
			const preview = await readAsDataUrl(file);
			return { id: crypto.randomUUID(), filename: file.name || 'image', mimeType: file.type, data: preview.slice(preview.indexOf(',') + 1), preview };
		}),
	);
	const rejected =
		usable.length < files.length
			? 'Only PNG, JPEG, GIF and WebP images up to 5 MB can be attached.'
			: kept.length < usable.length
				? `Up to ${MAX_IMAGES} images per message.`
				: null;
	return { images, rejected };
}

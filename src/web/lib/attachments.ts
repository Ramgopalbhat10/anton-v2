/** An image picked for the next message: the bytes for the agent and a URL for the preview. */
export type ImageAttachment = { id: string; filename: string; mimeType: string; data: string; preview: string };

/** An image from its base64 bytes. */
export const imageFromBase64 = (data: string, filename: string, mimeType = 'image/png', id: string = crypto.randomUUID()): ImageAttachment => ({
	id,
	filename,
	mimeType,
	data,
	preview: `data:${mimeType};base64,${data}`,
});

/** An image from a data URL, as a file reader or a canvas gives one. */
export function imageFromDataUrl(url: string, filename: string): ImageAttachment {
	return imageFromBase64(url.slice(url.indexOf(',') + 1), filename, /^data:([^;,]+)/.exec(url)?.[1] ?? 'image/png');
}

export const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** Any other file picked for the next message: uploaded when it is sent, saved where the agent's tools reach it and read as text. */
export type FileAttachment = { id: string; file: File; name: string; size: number };
export const MAX_FILES = 10;
/** As the server takes (MAX_UPLOAD_BYTES). */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

function readAsDataUrl(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result));
		reader.onerror = () => reject(reader.error ?? new Error('Could not read the file'));
		reader.readAsDataURL(file);
	});
}

/** Whether the model is handed the file as a picture: an image it can see, small enough to send as one. */
export const sentAsImage = (file: File) => IMAGE_TYPES.has(file.type) && file.size <= MAX_IMAGE_BYTES;

/**
 * Sorts the files the user picked, pasted or dropped: images the model sees go
 * as images, every other file (and an image too large to send as one) as a
 * file. `imagesAsFiles` sends images as files too, where a message carries no
 * pictures (a new thread's brief). Says why any were left out.
 */
export async function readAttachments(
	files: File[],
	room: { images: number; files: number },
	imagesAsFiles = false,
): Promise<{ images: ImageAttachment[]; files: FileAttachment[]; rejected: string | null }> {
	const fits = files.filter((file) => file.size <= MAX_FILE_BYTES);
	const pictures = imagesAsFiles ? [] : fits.filter(sentAsImage);
	const others = fits.filter((file) => !pictures.includes(file));
	const keptPictures = pictures.slice(0, Math.max(0, room.images));
	const keptOthers = others.slice(0, Math.max(0, room.files));
	const images = await Promise.all(keptPictures.map(async (file) => imageFromDataUrl(await readAsDataUrl(file), file.name || 'image')));
	const attached = keptOthers.map((file) => ({ id: crypto.randomUUID(), file, name: file.name || 'file', size: file.size }));
	const rejected =
		fits.length < files.length
			? 'Files up to 20 MB can be attached.'
			: keptPictures.length < pictures.length
				? `Up to ${MAX_IMAGES} images per message.`
				: keptOthers.length < others.length
					? `Up to ${MAX_FILES} files per message.`
					: null;
	return { images, files: attached, rejected };
}

/** Images as the agent runtime takes them with a message. */
export const deliveredImages = (images: ImageAttachment[]) => images.map(({ data, mimeType, filename }) => ({ type: 'image' as const, data, mimeType, filename }));

/** An image back as a file, to save it where a message carries no pictures of its own (the project Library). */
export function imageFile(image: ImageAttachment): File {
	const bytes = Uint8Array.from(atob(image.data), (char) => char.charCodeAt(0));
	return new File([bytes], image.filename, { type: image.mimeType });
}

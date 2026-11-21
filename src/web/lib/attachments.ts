/** An image picked for the next message: the bytes for the agent, a URL for the preview, and the original File when read from disk/clipboard. */
export type ImageAttachment = { id: string; filename: string; mimeType: string; data: string; preview: string; file?: File };

export const imageFromBase64 = (data: string, filename: string, mimeType = 'image/png', id: string = crypto.randomUUID()): ImageAttachment => ({
	id,
	filename,
	mimeType,
	data,
	preview: `data:${mimeType};base64,${data}`,
});

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

/** Sorts picked, pasted or dropped files: images the model sees go as images, anything else (and an image too large) as a file; `imagesAsFiles` sends images as files too, and `overflowImagesAsFiles` keeps images past the image limit as ordinary files in selection order instead of dropping them. Says why any were left out. */
export async function readAttachments(
	files: File[],
	room: { images: number; files: number },
	options: boolean | { imagesAsFiles?: boolean; overflowImagesAsFiles?: boolean } = false,
): Promise<{ images: ImageAttachment[]; files: FileAttachment[]; rejected: string | null }> {
	const imagesAsFiles = typeof options === 'boolean' ? options : Boolean(options.imagesAsFiles);
	const overflowImagesAsFiles = typeof options === 'boolean' ? false : Boolean(options.overflowImagesAsFiles);
	const fits = files.filter((file) => file.size <= MAX_FILE_BYTES);
	const pictures = imagesAsFiles ? [] : fits.filter(sentAsImage);
	const keptPictures = pictures.slice(0, Math.max(0, room.images));
	const previewed = new Set(keptPictures);
	const skippedPictures = overflowImagesAsFiles ? null : new Set(pictures.slice(keptPictures.length));
	const others = fits.filter((file) => !previewed.has(file) && !skippedPictures?.has(file));
	const keptOthers = others.slice(0, Math.max(0, room.files));
	const settled = await Promise.allSettled(
		keptPictures.map(async (file) => ({ ...imageFromDataUrl(await readAsDataUrl(file), file.name || 'image'), file })),
	);
	const images: ImageAttachment[] = [];
	const unreadable: string[] = [];
	settled.forEach((result, index) => {
		if (result.status === 'fulfilled') images.push(result.value);
		else unreadable.push(keptPictures[index]?.name || 'image');
	});
	const attached = keptOthers.map((file) => ({ id: crypto.randomUUID(), file, name: file.name || 'file', size: file.size }));
	const notes: string[] = [];
	if (unreadable.length) notes.push(`Could not read ${unreadable.join(', ')}.`);
	if (fits.length < files.length) notes.push('Files up to 20 MB can be attached.');
	else if (!overflowImagesAsFiles && keptPictures.length < pictures.length) notes.push(`Up to ${MAX_IMAGES} images per message.`);
	else if (keptOthers.length < others.length) notes.push(`Up to ${MAX_FILES} files per message.`);
	return { images, files: attached, rejected: notes.length ? notes.join(' ') : null };
}

/** Images as the agent runtime takes them with a message. */
export const deliveredImages = (images: ImageAttachment[]) => images.map(({ data, mimeType, filename }) => ({ type: 'image' as const, data, mimeType, filename }));

export function imageFile(image: ImageAttachment): File {
	if (image.file) {
		return image.file.name === image.filename
			? image.file
			: new File([image.file], image.filename, { type: image.file.type || image.mimeType, lastModified: image.file.lastModified });
	}
	const bytes = Uint8Array.from(atob(image.data), (char) => char.charCodeAt(0));
	return new File([bytes], image.filename, { type: image.mimeType });
}

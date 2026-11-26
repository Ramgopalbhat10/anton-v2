import type { FileAttachment, ImageAttachment } from '@/lib/attachments';
import type { SentPicture } from '@/components/thread/sent-images';

/** A message shows at once while it is prepared. Its pictures and files show as they will once sent. */
export type PendingSend = { text: string; attaching?: string; pictures?: SentPicture[]; files?: { name: string; size: number }[] };

/** What a composer says of a message: on its way (`PendingSend`), shown by the conversation (`'sent'`), or neither. */
export type PendingChange = PendingSend | 'sent' | null;

/** What a message's attachments show as while it waits on them: the pictures from the bytes in hand, the files by name. */
export const placeholders = (taken: { images: ImageAttachment[]; files: FileAttachment[] }): Pick<PendingSend, 'pictures' | 'files'> => ({
	pictures: taken.images.map((image) => ({ src: image.preview, name: image.filename })),
	files: taken.files.map((file) => ({ name: file.name, size: file.size })),
});

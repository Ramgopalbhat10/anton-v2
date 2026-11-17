import type { FlueConversationMessage } from '@flue/react';
import { FileImage } from '@/lib/icons';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Icon, Spinner } from '@/components/kit/signal';
import type { AttachmentRef } from '../../../core/attachments';
import { openViewer, type ViewerItem } from '@/lib/viewer';
import { cn } from '@/lib/utils';

/** A picture sent with a message: first the bytes this page sent, then the copy the conversation stored. */
export type SentPicture = { src: string; name: string };

export function sentPictures(message: FlueConversationMessage): SentPicture[] {
	const pictures: SentPicture[] = [];
	for (const part of message.parts) {
		if (part.type !== 'file' || !part.mediaType.startsWith('image/') || !part.url) continue;
		pictures.push({ src: part.url, name: part.filename ?? `image-${pictures.length + 1}.${part.mediaType.slice(6) || 'png'}` });
	}
	return pictures;
}

/** An image sent with the message is saved to the Library too, so its chip says again what its picture shows. */
export function besidePictures(files: AttachmentRef[], pictures: SentPicture[]): AttachmentRef[] {
	if (!pictures.length) return files;
	const names = new Set(pictures.map((picture) => picture.name));
	const images = files.filter((file) => / image$/.test(file.kind));
	// The Library may rename a file it already holds, so when every image has its picture the names need not match.
	const all = images.length <= pictures.length;
	return files.filter((file) => !(/ image$/.test(file.kind) && (all || names.has(file.name))));
}

/** Pictures open in the viewer beside the chat, which steps through the others sent with them. */
export const pictureItems = (pictures: SentPicture[]): ViewerItem[] => pictures.map((picture) => ({ sessionId: '', path: picture.name, src: picture.src }));

/** Sources drawn lately, so the same picture drawn again (a sent message taking over from its waiting one) shows from its first frame. A data: URL is the whole picture, so only a few are kept. */
const drawn: string[] = [];
const KEPT = 16;
function remember(src: string): void {
	if (drawn.includes(src)) return;
	drawn.push(src);
	if (drawn.length > KEPT) drawn.shift();
}

/**
 * Keeps showing the picture it has until the next source has loaded: a sent message's images change from the
 * bytes the page sent to the copy the conversation stored, and swapping the element would blink the picture out.
 */
function SentImage({ picture, uploading, onOpen }: { picture: SentPicture; uploading?: boolean; onOpen?: () => void }) {
	const { src, name } = picture;
	const [shown, setShown] = useState<string | null>(() => (drawn.includes(src) ? src : null));
	const [broken, setBroken] = useState(false);
	const img = useRef<HTMLImageElement>(null);
	// A picture the browser already holds draws in the first frame, without its placeholder.
	useLayoutEffect(() => {
		const element = img.current;
		if (element?.complete && element.naturalWidth > 0) setShown(element.getAttribute('src'));
	}, []);
	useEffect(() => {
		if (shown === null || shown === src) return;
		let live = true;
		const next = new Image();
		next.src = src;
		next.decode().then(
			() => {
				remember(src);
				if (live) setShown(src);
			},
			() => undefined,
		);
		return () => {
			live = false;
		};
	}, [src, shown]);
	const ready = shown !== null;
	return (
		<button
			type="button"
			onClick={onOpen}
			disabled={!onOpen}
			aria-label={uploading ? `Uploading ${name}` : `Open ${name}`}
			title={name}
			className={cn(
				'relative block shrink-0 overflow-hidden rounded-card bg-(--bg-raised) shadow-[0_0_0_1px_var(--line)] outline-none focus-visible:shadow-(--focus) enabled:cursor-zoom-in',
				!ready && 'h-24 w-32',
				!ready && !broken && 'in-sweep',
			)}
		>
			{broken ? (
				<span className="flex size-full items-center justify-center text-(--text-3)">
					<Icon icon={FileImage} size={18} />
				</span>
			) : (
				<img
					ref={img}
					src={shown ?? src}
					alt={name}
					draggable={false}
					onLoad={(event) => {
						const loaded = event.currentTarget.getAttribute('src');
						if (!loaded) return;
						remember(loaded);
						setShown(loaded);
					}}
					onError={() => {
						if (!ready) setBroken(true);
					}}
					className={cn('block transition-opacity duration-(--t-fast)', ready ? 'max-h-40 max-w-60' : 'absolute inset-0 size-full object-cover opacity-0', ready && uploading && 'opacity-60')}
				/>
			)}
			{uploading ? (
				<span className="absolute right-1.5 bottom-1.5 inline-flex size-5 items-center justify-center rounded-full bg-(--bg-scrim) text-(--text)">
					<Spinner size={11} tone="neutral" />
				</span>
			) : null}
		</button>
	);
}

/** Keyed by place, not source, so a picture stays the same element when its source changes. `composer` takes a drawing on one. */
export function SentImages({ pictures, composer, uploading, className }: { pictures: SentPicture[]; composer?: string | null; uploading?: boolean; className?: string }) {
	if (!pictures.length) return null;
	const items = pictureItems(pictures);
	return (
		<div className={cn('flex max-w-[520px] flex-wrap justify-end gap-1.5', className)}>
			{pictures.map((picture, index) => (
				<SentImage key={index} picture={picture} uploading={uploading} onOpen={uploading ? undefined : () => openViewer(items[index]!, items, composer ?? null)} />
			))}
		</div>
	);
}

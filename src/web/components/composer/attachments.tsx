import { File as FileGlyph, FileArchive, FileCode, FileImage, FileSpreadsheet, FileText, type IconComponent, Paperclip, Presentation, X } from '@/lib/icons';
import { type ClipboardEvent, type DragEvent, useCallback, useRef, useState } from 'react';
import { Icon, IconBtn, Spinner } from '@/components/kit/signal';
import type { AttachmentRef } from '../../../core/attachments';
import { uniqueUploadNames } from '../../../core/upload-name';
import { type FileAttachment, type ImageAttachment, imageFile, MAX_FILES, MAX_IMAGES, readAttachments, sentAsImage } from '@/lib/attachments';
import { cn } from '@/lib/utils';

const EXTENSION_ICONS: Array<[RegExp, IconComponent]> = [
	[/\.(xlsx|xlsm|xlsb|xls|ods|numbers|csv|tsv)$/i, FileSpreadsheet],
	[/\.(pptx|pptm|ppt|odp|key)$/i, Presentation],
	[/\.(png|jpe?g|gif|webp|svg|heic|bmp|tiff?)$/i, FileImage],
	[/\.(zip|tar|gz|tgz|7z|rar|cab)$/i, FileArchive],
	[/\.(json|ya?ml|xml|html?|js|ts|tsx|jsx|py|go|rs|rb|java|c|cpp|h|sh|sql|toml)$/i, FileCode],
	[/\.(pdf|docx?|docm|odt|rtf|md|markdown|txt|epub|log)$/i, FileText],
];

export function fileGlyph(name: string): IconComponent {
	return EXTENSION_ICONS.find(([pattern]) => pattern.test(name))?.[1] ?? FileGlyph;
}

export function fileSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function FileChip({ name, note, title, uploading, onRemove }: { name: string; note: string; title?: string; uploading?: boolean; onRemove?: () => void }) {
	return (
		<div title={title ?? name} className="flex h-9 max-w-[240px] items-center gap-2 rounded-control border border-(--line) bg-(--bg-raised) pr-1 pl-2">
			{uploading ? (
				<span className="inline-flex size-3.5 shrink-0 items-center justify-center">
					<Spinner size={12} tone="neutral" />
				</span>
			) : (
				<Icon icon={fileGlyph(name)} size={14} className="shrink-0 text-(--text-2)" />
			)}
			<span className="flex min-w-0 flex-col">
				<span className="truncate text-small text-(--text)">{name}</span>
				<span className="truncate text-micro text-(--text-3)">{note}</span>
			</span>
			{onRemove ? (
				<button
					type="button"
					aria-label={`Remove ${name}`}
					onClick={onRemove}
					className="inline-flex size-5 shrink-0 items-center justify-center rounded-control text-(--text-3) hover:bg-(--bg-hover) hover:text-(--text)"
				>
					<Icon icon={X} size={10} />
				</button>
			) : (
				<span className="w-1" />
			)}
		</div>
	);
}

/** What a composer holds besides its text: images the model sees, and files saved for the agent and read as text. */
export type Attachments = ReturnType<typeof useAttachments>;

/** Keep both drafts' files, assigning a different normalized upload name to each. */
function uniqueFiles(files: FileAttachment[]): FileAttachment[] {
	const names = uniqueUploadNames(files.map((file) => file.name));
	return files.map((file, index) => {
		const name = names[index]!;
		return name === file.name ? file : { ...file, name, file: new File([file.file], name, { type: file.file.type, lastModified: file.file.lastModified }) };
	});
}

/** `imagesAsFiles` sends all images as files; `overflowImagesAsFiles` previews supported images up to MAX_IMAGES and retains any beyond that as ordinary file attachments. */
export function useAttachments({ imagesAsFiles = false, overflowImagesAsFiles = false }: { imagesAsFiles?: boolean; overflowImagesAsFiles?: boolean } = {}) {
	const [state, setState] = useState<{ images: ImageAttachment[]; files: FileAttachment[]; notice: string | null; noticeWave: number }>({
		images: [],
		files: [],
		notice: null,
		noticeWave: 0,
	});
	const { images, files, notice } = state;
	/** Pictures still being read, which the tray holds a place for. */
	const [reading, setReading] = useState(0);
	const latest = useRef({ images, files });
	latest.current = { images, files };
	const inFlight = useRef(0);
	const waveRef = useRef(0);
	const setNotice = useCallback((next: string | null) => {
		setState((current) => (current.notice === next && next !== null ? current : { ...current, notice: next, noticeWave: next ? current.noticeWave : 0 }));
	}, []);
	const attach = useCallback(
		async (list: File[]) => {
			if (list.length === 0) return;
			// A fresh attachment action after prior reads settled starts a new wave; overlapping reads share a wave so a later success never erases an earlier failure notice.
			if (inFlight.current === 0) waveRef.current += 1;
			const wave = waveRef.current;
			inFlight.current += 1;
			const current = latest.current;
			const order = new Map(list.map((file, index) => [file, index]));
			const pictures = imagesAsFiles ? 0 : Math.min(list.filter(sentAsImage).length, Math.max(0, MAX_IMAGES - current.images.length));
			setReading((count) => count + pictures);
			let read: Awaited<ReturnType<typeof readAttachments>>;
			try {
				// Retain all ordinary-file candidates through the async image read so file capacity is applied against live state at commit time.
				read = await readAttachments(
					list,
					{ images: MAX_IMAGES - current.images.length, files: list.length },
					{ imagesAsFiles, overflowImagesAsFiles },
				);
			} catch {
				setState((before) => {
					const msg = 'Could not read the attached files.';
					const prev = before.noticeWave === wave && before.notice ? [before.notice] : [];
					if (!prev.includes(msg)) prev.push(msg);
					return { ...before, notice: prev.join(' '), noticeWave: wave };
				});
				return;
			} finally {
				inFlight.current = Math.max(0, inFlight.current - 1);
				setReading((count) => count - pictures);
			}
			// Allocate preview and file slots together against the latest queued state so overlapping reads never drop overflow silently.
			setState((before) => {
				const imageRoom = Math.max(0, MAX_IMAGES - before.images.length);
				const keptImages = read.images.slice(0, imageRoom);
				const spilledImages = read.images.slice(keptImages.length);
				const spilledFiles: FileAttachment[] = overflowImagesAsFiles
					? spilledImages.map((image) => {
							const file = imageFile(image);
							return { id: image.id, file, name: image.filename, size: file.size };
						})
					: [];
				const candidateFiles = [...spilledFiles, ...read.files].sort(
					(a, b) => (order.get(a.file) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.file) ?? Number.MAX_SAFE_INTEGER),
				);
				const fileRoom = Math.max(0, MAX_FILES - before.files.length);
				const keptFiles = candidateFiles.slice(0, fileRoom);
				const notes: string[] = before.noticeWave === wave && before.notice ? [before.notice] : [];
				const addNote = (text: string) => {
					if (!notes.some((existing) => existing.includes(text))) notes.push(text);
				};
				if (read.rejected) addNote(read.rejected);
				if (!overflowImagesAsFiles && spilledImages.length > 0) addNote(`Up to ${MAX_IMAGES} images per message.`);
				if (keptFiles.length < candidateFiles.length) addNote(`Up to ${MAX_FILES} files per message.`);
				return {
					images: [...before.images, ...keptImages],
					files: uniqueFiles([...before.files, ...keptFiles]),
					notice: notes.length ? notes.join(' ') : null,
					noticeWave: notes.length ? wave : 0,
				};
			});
		},
		[imagesAsFiles, overflowImagesAsFiles],
	);
	const addImages = useCallback((added: ImageAttachment[]) => {
		setState((before) => {
			const room = Math.max(0, MAX_IMAGES - before.images.length);
			return {
				...before,
				images: [...before.images, ...added.slice(0, room)],
				notice: added.length > room ? `Up to ${MAX_IMAGES} images per message.` : null,
				noticeWave: 0,
			};
		});
	}, []);
	const onPaste = useCallback(
		(event: ClipboardEvent<HTMLElement>) => {
			const pasted = [...event.clipboardData.files];
			if (pasted.length === 0) return;
			// Copying from Word or Excel also puts a picture of the selection on the clipboard: there the text is what was meant.
			if (pasted.every((file) => file.type.startsWith('image/')) && event.clipboardData.getData('text/plain').trim()) return;
			event.preventDefault();
			// A pasted screenshot is always "image.png"; a time keeps two apart.
			const stamp = new Date().toISOString().slice(11, 19).replaceAll(':', '');
			void attach(pasted.map((file) => (/^image\.\w+$/.test(file.name) ? new File([file], file.name.replace('image', `pasted-${stamp}`), { type: file.type }) : file)));
		},
		[attach],
	);
	const dropZone = {
		onDragOver: (event: DragEvent<HTMLElement>) => {
			if (event.dataTransfer.types.includes('Files')) event.preventDefault();
		},
		onDrop: (event: DragEvent<HTMLElement>) => {
			if (!event.dataTransfer.files.length) return;
			event.preventDefault();
			void attach([...event.dataTransfer.files]);
		},
	};
	const take = useCallback(() => {
		const taken = latest.current;
		setState({ images: [], files: [], notice: null, noticeWave: 0 });
		return taken;
	}, []);
	/** Puts back both the failed send and any newer attachments, without dropping over-limit items. */
	const restore = useCallback((taken: { images: ImageAttachment[]; files: FileAttachment[] }) => {
		setState((current) => ({
			...current,
			images: [...taken.images, ...current.images],
			files: uniqueFiles([...taken.files, ...current.files]),
		}));
	}, []);
	const limitError = images.length > MAX_IMAGES ? `Remove ${images.length - MAX_IMAGES} image${images.length - MAX_IMAGES === 1 ? '' : 's'} to send (up to ${MAX_IMAGES} per message).` : files.length > MAX_FILES ? `Remove ${files.length - MAX_FILES} file${files.length - MAX_FILES === 1 ? '' : 's'} to send (up to ${MAX_FILES} per message).` : null;
	return {
		images,
		files,
		reading,
		notice,
		limitError,
		setNotice,
		attach,
		addImages,
		onPaste,
		dropZone,
		take,
		restore,
		removeImage: (id: string) => setState((current) => ({ ...current, images: current.images.filter((image) => image.id !== id) })),
		removeFile: (id: string) => setState((current) => ({ ...current, files: current.files.filter((file) => file.id !== id) })),
		count: images.length + files.length,
		full: images.length >= MAX_IMAGES && files.length >= MAX_FILES,
	};
}

/** A picture's thumbnail, waiting to be sent or saved already. */
export function ImageThumb({ src, name, onRemove }: { src: string; name: string; onRemove?: () => void }) {
	return (
		<div title={name} className="relative size-14 overflow-hidden rounded-control border border-(--line)">
			<img src={src} alt={name} className="size-full object-cover" />
			{onRemove ? (
				<button
					type="button"
					aria-label={`Remove ${name}`}
					onClick={onRemove}
					className="absolute top-0.5 right-0.5 inline-flex size-4 items-center justify-center rounded-control bg-(--bg-scrim) text-(--text)"
				>
					<Icon icon={X} size={10} />
				</button>
			) : null}
		</div>
	);
}

export function AttachmentTray({ attachments, className }: { attachments: Attachments; className?: string }) {
	const { images, files, reading, removeImage, removeFile } = attachments;
	if (images.length === 0 && files.length === 0 && reading === 0) return null;
	return (
		<div className={cn('flex flex-wrap items-center gap-1.5', className)}>
			{images.map((image) => (
				<ImageThumb key={image.id} src={image.preview} name={image.filename} onRemove={() => removeImage(image.id)} />
			))}
			{/* Shown only if reading takes long enough to notice, so a quick paste never blinks a placeholder. */}
			{Array.from({ length: reading }, (_, index) => (
				<div key={`reading-${index}`} aria-hidden className="in-enter in-sweep size-14 rounded-control border border-(--line) bg-(--bg-raised)" style={{ animationDelay: '150ms' }} />
			))}
			{files.map((file) => (
				<FileChip key={file.id} name={file.name} note={fileSize(file.size)} onRemove={() => removeFile(file.id)} />
			))}
		</div>
	);
}

export function AttachButton({ attachments, label = 'Attach files' }: { attachments: Attachments; label?: string }) {
	const picker = useRef<HTMLInputElement>(null);
	return (
		<>
			<input
				ref={picker}
				type="file"
				multiple
				hidden
				onChange={(event) => {
					void attachments.attach([...(event.target.files ?? [])]);
					event.target.value = '';
				}}
			/>
			<IconBtn icon={Paperclip} size="sm" label={label} onClick={() => picker.current?.click()} disabled={attachments.full} />
		</>
	);
}

export function SentAttachments({ files, className }: { files: AttachmentRef[]; className?: string }) {
	if (!files.length) return null;
	return (
		<div className={cn('flex max-w-[520px] flex-wrap justify-end gap-1.5', className)}>
			{files.map((file) => (
				<FileChip
					key={file.path}
					name={file.name}
					note={`${file.kind} · ${fileSize(file.size)}`}
					title={`${file.name}\n${file.place === 'project' ? 'In the project Library' : `In the Library at ${file.path}`}`}
				/>
			))}
		</div>
	);
}

/** Files of a message still on their way, as the chips the sent message will show. */
export function UploadingFiles({ files, className }: { files: { name: string; size: number }[]; className?: string }) {
	if (!files.length) return null;
	return (
		<div className={cn('flex max-w-[520px] flex-wrap justify-end gap-1.5', className)}>
			{files.map((file, index) => (
				<FileChip key={index} name={file.name} note={`Uploading · ${fileSize(file.size)}`} uploading />
			))}
		</div>
	);
}

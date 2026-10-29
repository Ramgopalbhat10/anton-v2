import { File as FileGlyph, FileArchive, FileCode, FileImage, FileSpreadsheet, FileText, type LucideIcon, Paperclip, Presentation, X } from 'lucide-react';
import { type ClipboardEvent, type DragEvent, useCallback, useRef, useState } from 'react';
import { Icon, IconBtn } from '@/components/signal';
import type { AttachmentRef } from '../../core/attachments';
import { type FileAttachment, type ImageAttachment, MAX_FILES, MAX_IMAGES, readAttachments } from '@/lib/attachments';
import { cn } from '@/lib/utils';

const EXTENSION_ICONS: Array<[RegExp, LucideIcon]> = [
	[/\.(xlsx|xlsm|xlsb|xls|ods|numbers|csv|tsv)$/i, FileSpreadsheet],
	[/\.(pptx|pptm|ppt|odp|key)$/i, Presentation],
	[/\.(png|jpe?g|gif|webp|svg|heic|bmp|tiff?)$/i, FileImage],
	[/\.(zip|tar|gz|tgz|7z|rar|cab)$/i, FileArchive],
	[/\.(json|ya?ml|xml|html?|js|ts|tsx|jsx|py|go|rs|rb|java|c|cpp|h|sh|sql|toml)$/i, FileCode],
	[/\.(pdf|docx?|docm|odt|rtf|md|markdown|txt|epub|log)$/i, FileText],
];

/** A glyph for a file by its name. */
export function fileGlyph(name: string): LucideIcon {
	return EXTENSION_ICONS.find(([pattern]) => pattern.test(name))?.[1] ?? FileGlyph;
}

export function fileSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** One file as a chip: its glyph, name and a note under it, with a remove button while it is a draft. */
function FileChip({ name, note, title, onRemove }: { name: string; note: string; title?: string; onRemove?: () => void }) {
	return (
		<div title={title ?? name} className="flex h-9 max-w-[240px] items-center gap-2 rounded-md border border-(--border-subtle) bg-(--well-bg) pr-1 pl-2">
			<Icon icon={fileGlyph(name)} size={14} className="shrink-0 text-(--icon-secondary)" />
			<span className="flex min-w-0 flex-col">
				<span className="truncate text-[11.5px] text-(--text-primary)">{name}</span>
				<span className="truncate text-[10.5px] text-(--text-tertiary)">{note}</span>
			</span>
			{onRemove ? (
				<button
					type="button"
					aria-label={`Remove ${name}`}
					onClick={onRemove}
					className="inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-(--icon-tertiary) hover:bg-(--bg-hover) hover:text-(--text-primary)"
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

/** A name not already taken in the draft, so two files never land on one path. */
function freeName(name: string, taken: Set<string>): string {
	if (!taken.has(name)) return name;
	const dot = name.lastIndexOf('.');
	const [base, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
	for (let index = 2; ; index++) if (!taken.has(`${base}-${index}${ext}`)) return `${base}-${index}${ext}`;
}

/**
 * The attachments every composer shares: picked with the paperclip, pasted, or
 * dropped on the box. `imagesAsFiles` is for a box whose message carries no
 * pictures (a new thread's brief), where images are saved as files.
 */
export function useAttachments({ imagesAsFiles = false }: { imagesAsFiles?: boolean } = {}) {
	const [images, setImages] = useState<ImageAttachment[]>([]);
	const [files, setFiles] = useState<FileAttachment[]>([]);
	const [notice, setNotice] = useState<string | null>(null);
	const latest = useRef({ images, files });
	latest.current = { images, files };
	const attach = useCallback(
		async (list: File[]) => {
			if (list.length === 0) return;
			const current = latest.current;
			const read = await readAttachments(list, { images: MAX_IMAGES - current.images.length, files: MAX_FILES - current.files.length }, imagesAsFiles);
			// Clamped here too: two quick pastes both read the counts from before either landed.
			setImages((before) => [...before, ...read.images].slice(0, MAX_IMAGES));
			setFiles((before) => {
				const taken = new Set(before.map((file) => file.name));
				const named = read.files.map((file) => {
					const name = freeName(file.name, taken);
					taken.add(name);
					return name === file.name ? file : { ...file, name, file: new File([file.file], name, { type: file.file.type }) };
				});
				return [...before, ...named].slice(0, MAX_FILES);
			});
			setNotice(read.rejected);
		},
		[imagesAsFiles],
	);
	/** Images handed over by a panel (a drawing, a picked element's picture). */
	const addImages = useCallback((added: ImageAttachment[]) => {
		const room = MAX_IMAGES - latest.current.images.length;
		setImages((before) => [...before, ...added].slice(0, MAX_IMAGES));
		setNotice(added.length > room ? `Up to ${MAX_IMAGES} images per message.` : null);
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
	/** Empties the draft's attachments and hands them over, for sending. */
	const take = useCallback(() => {
		const taken = latest.current;
		setImages([]);
		setFiles([]);
		setNotice(null);
		return taken;
	}, []);
	/** Puts back attachments a send could not deliver, unless new ones were added since. */
	const restore = useCallback((taken: { images: ImageAttachment[]; files: FileAttachment[] }) => {
		setImages((current) => [...taken.images, ...current]);
		setFiles((current) => [...taken.files, ...current]);
	}, []);
	return {
		images,
		files,
		notice,
		setNotice,
		attach,
		addImages,
		onPaste,
		dropZone,
		take,
		restore,
		removeImage: (id: string) => setImages((current) => current.filter((image) => image.id !== id)),
		removeFile: (id: string) => setFiles((current) => current.filter((file) => file.id !== id)),
		count: images.length + files.length,
		full: images.length >= MAX_IMAGES && files.length >= MAX_FILES,
	};
}

/** The draft's images as thumbnails and its files as chips, each removable. */
export function AttachmentTray({ attachments, className }: { attachments: Attachments; className?: string }) {
	const { images, files, removeImage, removeFile } = attachments;
	if (images.length === 0 && files.length === 0) return null;
	return (
		<div className={cn('flex flex-wrap items-center gap-1.5', className)}>
			{images.map((image) => (
				<div key={image.id} className="relative size-14 overflow-hidden rounded-md border border-(--border-subtle)">
					<img src={image.preview} alt={image.filename} className="size-full object-cover" />
					<button
						type="button"
						aria-label={`Remove ${image.filename}`}
						onClick={() => removeImage(image.id)}
						className="absolute top-0.5 right-0.5 inline-flex size-4 items-center justify-center rounded-sm bg-(--bg-scrim) text-(--text-primary)"
					>
						<Icon icon={X} size={10} />
					</button>
				</div>
			))}
			{files.map((file) => (
				<FileChip key={file.id} name={file.name} note={fileSize(file.size)} onRemove={() => removeFile(file.id)} />
			))}
		</div>
	);
}

/** The paperclip: picks any files, images included. */
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

/** The files a sent message carried, as chips under it. */
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

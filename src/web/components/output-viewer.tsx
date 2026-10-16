import { useQuery } from '@tanstack/react-query';
import { useRouterState } from '@tanstack/react-router';
import { ChevronLeft, ChevronRight, Download, ExternalLink, PencilLine, X } from 'lucide-react';
import { type CSSProperties, type ReactNode, useEffect, useLayoutEffect, useState } from 'react';
import { HtmlFrame } from '@/components/html-frame';
import { kindOf, PREVIEWS, Source, TextFile } from '@/components/library-tab';
import { Markdown } from '@/components/markdown';
import { Btn, Icon, IconBtn, Spinner } from '@/components/signal';
import { Sketch } from '@/components/sketch';
import { outputUrl } from '@/lib/api';
import { categoryInfo, categoryOf, extensionOf, isMarkdown, isText, nameOf } from '@/lib/artifacts';
import { imageFromDataUrl } from '@/lib/attachments';
import { addToComposer } from '@/lib/composer-inbox';
import { useElementSize } from '@/lib/use-element-size';
import { cn } from '@/lib/utils';
import { closeViewer, openViewer, stepViewer, useViewer, type ViewerItem, type ViewerState } from '@/lib/viewer';
import { isImagePath } from '../../core/outputs';

/*
 * What the agent made, where you read its reply: cards under the reply for
 * the files it saved and linked, and a viewer beside the conversation that
 * shows one full size. An image can be marked up there (a pen, arrows, boxes,
 * text) and handed to the composer, to ask the agent about what you circled.
 */

const keyOf = (item: ViewerItem) => `${item.sessionId}\n${item.path}`;

function download(item: ViewerItem) {
	const link = document.createElement('a');
	link.href = outputUrl(item.sessionId, item.path);
	link.download = nameOf(item.path);
	link.click();
}

/** A file's kind as an icon and its extension, where there is no picture of it. */
export function FileFace({ path, size = 20 }: { path: string; size?: number }) {
	const info = categoryInfo(categoryOf(path));
	return (
		<span className="flex size-full flex-col items-center justify-center gap-1.5">
			<Icon icon={info.icon} size={size} className={info.tone} />
			{size >= 16 ? <span className="font-mono text-[9.5px] tracking-[0.08em] text-(--text-disabled)">{extensionOf(path)}</span> : null}
		</span>
	);
}

/** An image of the file, or its kind when it is not one or cannot be read. */
export function OutputThumb({ item, className, fit }: { item: ViewerItem; className?: string; fit?: 'cover' | 'contain' }) {
	const [broken, setBroken] = useState(false);
	// A wide picture (a chart, a banner) is shown whole; others fill the card from their top, as a page's screenshot reads.
	const [wide, setWide] = useState(false);
	if (!isImagePath(item.path) || broken) return <FileFace path={item.path} />;
	const contain = (fit ?? (wide ? 'contain' : 'cover')) === 'contain';
	return (
		<img
			src={outputUrl(item.sessionId, item.path)}
			alt=""
			loading="lazy"
			onError={() => setBroken(true)}
			onLoad={(event) => setWide(event.currentTarget.naturalWidth > 2 * event.currentTarget.naturalHeight)}
			className={cn('block size-full', contain ? 'object-contain' : 'object-cover object-top', className)}
		/>
	);
}

/** How many cards a reply shows before the rest go behind one that counts them. */
const SHOWN = 6;

/**
 * The files a reply made, as cards: images as pictures, other files as their
 * kind. A card opens the file in the viewer, the reply's others a step away.
 */
export function OutputCards({ items, composer }: { items: ViewerItem[]; composer: string | null }) {
	if (items.length === 0) return null;
	const shown = items.length > SHOWN ? items.slice(0, SHOWN - 1) : items;
	const rest = items.length - shown.length;
	return (
		<div className="flex flex-wrap gap-2" role="list" aria-label="Files from this reply">
			{shown.map((item) => (
				<button
					key={keyOf(item)}
					type="button"
					role="listitem"
					title={`Open ${item.path}`}
					onClick={() => openViewer(item, items, composer)}
					className="group/out flex w-[156px] flex-col overflow-hidden rounded-[10px] border border-(--card-border) bg-(--card-bg) text-left shadow-(--card-highlight) outline-none transition-colors duration-(--duration-micro) hover:border-(--border-strong) focus-visible:shadow-(--focus-ring)"
				>
					<span className="relative block h-[96px] overflow-hidden border-b border-(--border-subtle) bg-(--bg-inset)">
						<OutputThumb item={item} />
						<span className="absolute top-1.5 left-1.5 rounded-[5px] border border-(--border-subtle) bg-(--bg-canvas)/80 px-1 py-px font-mono text-[9.5px] leading-[14px] tracking-[0.06em] text-(--text-tertiary) backdrop-blur-sm">
							{extensionOf(item.path)}
						</span>
					</span>
					<span className="line-clamp-2 px-2.5 py-2 text-[12px] leading-[16px] break-all text-(--text-secondary) group-hover/out:text-(--text-primary)">{nameOf(item.path)}</span>
				</button>
			))}
			{rest > 0 ? (
				<button
					type="button"
					onClick={() => openViewer(items[shown.length], items, composer)}
					className="flex w-[72px] flex-col items-center justify-center gap-0.5 rounded-[10px] border border-dashed border-(--border-default) text-(--text-tertiary) outline-none hover:border-(--border-strong) hover:text-(--text-secondary) focus-visible:shadow-(--focus-ring)"
					title={`${rest} more`}
				>
					<span className="in-num text-[13px]">+{rest}</span>
					<span className="text-[11px]">more</span>
				</button>
			) : null}
		</div>
	);
}

/** A file full size, as the Library and Artifacts show it: a page live, a document rendered, an image, a table. */
export function OutputPreview({ item, code = false, title }: { item: ViewerItem; code?: boolean; title?: string }) {
	const { sessionId, path } = item;
	const app = categoryOf(path) === 'app';
	const readable = app || isMarkdown(path);
	if (app && !code)
		return (
			<div className="mx-auto h-full max-w-[960px] px-4 pt-6 md:px-6">
				<HtmlFrame sessionId={sessionId} path={path} title={title ?? nameOf(path)} fill />
			</div>
		);
	if (code || (isText(path) && !readable && kindOf(path) !== 'table')) return <Source sessionId={sessionId} path={path} />;
	if (isMarkdown(path))
		return (
			<div className="mx-auto max-w-[760px] px-5 py-6">
				<TextFile sessionId={sessionId} path={path} render={(content) => <Markdown text={content} />} />
			</div>
		);
	const Preview = PREVIEWS[kindOf(path)];
	return <Preview sessionId={sessionId} path={path} />;
}

/** The image fit to the viewer; a click shows it at its own size, to look closer. */
function ImageStage({ item }: { item: ViewerItem }) {
	const [actual, setActual] = useState(false);
	const [broken, setBroken] = useState(false);
	useEffect(() => {
		setActual(false);
		setBroken(false);
	}, [item.sessionId, item.path]);
	if (broken)
		return (
			<div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
				<span className="size-12">
					<FileFace path={item.path} size={22} />
				</span>
				<span className="text-[13px] text-(--text-secondary)">This image could not be loaded</span>
				<span className="max-w-[360px] text-[12px] leading-[17px] text-(--text-tertiary)">It is not in the task's Library any more, or its sandbox has not saved it yet.</span>
			</div>
		);
	return (
		<div className={cn('flex h-full min-h-0 overflow-auto p-4', !actual && 'items-center justify-center')}>
			<img
				src={outputUrl(item.sessionId, item.path)}
				alt={nameOf(item.path)}
				onError={() => setBroken(true)}
				onClick={() => setActual((current) => !current)}
				className={cn(
					'block rounded-[6px] shadow-[0_0_0_1px_var(--border-subtle),0_12px_32px_-12px_rgba(0,0,0,0.6)]',
					actual ? 'm-auto max-w-none cursor-zoom-out' : 'max-h-full max-w-full cursor-zoom-in object-contain',
				)}
			/>
		</div>
	);
}

/** The longest side a picture is drawn on at, so a huge screenshot stays quick to mark up and send. */
const MAX_SIDE = 2400;

/** The image as a PNG data URL at a size fit to draw on: Sketch flattens the marks onto it, so it must carry its own bytes. */
async function rasterize(url: string): Promise<{ src: string; width: number; height: number }> {
	const image = new Image();
	image.src = url;
	await image.decode();
	// An SVG without a size of its own draws at a usual screen size.
	const naturalWidth = image.naturalWidth || 1200;
	const naturalHeight = image.naturalHeight || 800;
	const scale = Math.min(1, MAX_SIDE / Math.max(naturalWidth, naturalHeight));
	const width = Math.round(naturalWidth * scale);
	const height = Math.round(naturalHeight * scale);
	const canvas = document.createElement('canvas');
	canvas.width = width;
	canvas.height = height;
	canvas.getContext('2d')!.drawImage(image, 0, 0, width, height);
	return { src: canvas.toDataURL('image/png'), width, height };
}

/** Drawing on the image, fit to the viewer; "Add to chat" puts the drawing in the composer. */
function MarkupStage({ item, composer, onDone }: { item: ViewerItem; composer: string; onDone: (added: boolean) => void }) {
	const picture = useQuery({
		queryKey: ['viewer-picture', item.sessionId, item.path],
		queryFn: () => rasterize(outputUrl(item.sessionId, item.path)),
		staleTime: Number.POSITIVE_INFINITY,
		gcTime: 60_000,
	});
	const [area, size] = useElementSize<HTMLDivElement>();
	const fit = picture.data && size.width && size.height ? Math.min(size.width / picture.data.width, size.height / picture.data.height) : 0;
	return (
		<div ref={area} className="absolute inset-4 bottom-16 flex items-center justify-center">
			{picture.isError ? (
				<span className="text-[12px] text-(--danger-text)">The image could not be opened for drawing.</span>
			) : !picture.data || !fit ? (
				<span className="flex items-center gap-2 text-[12px] text-(--text-tertiary)">
					<Spinner size={12} />
					Getting the image ready
				</span>
			) : (
				// The box has the picture's shape, so a mark lands where the pointer is. Sketch's toolbar sits below it.
				<div className="relative" style={{ width: picture.data.width * fit, height: picture.data.height * fit }}>
					<div className="pointer-events-none absolute inset-0 rounded-[2px] shadow-[0_0_0_1px_var(--accent-border)]" />
					<Sketch
							toolbarBelow
							src={picture.data.src}
							width={picture.data.width}
							height={picture.data.height}
							onClose={() => onDone(false)}
							onAttach={(png) => {
								addToComposer(composer, { kind: 'image', image: imageFromDataUrl(png, `marked-${nameOf(item.path).replace(/\.[^.]+$/, '')}.png`) });
								onDone(true);
							}}
						/>
				</div>
			)}
		</div>
	);
}

/** The narrowest side panel the viewer takes the place of; a narrower one leaves it at its own width. */
const DOCK_MIN = 440;

/**
 * Where the viewer sits: over the page's side panel when it has one wide
 * enough, so the conversation stays as it was beside it; else at its own
 * width along the right edge.
 */
function useDock(): CSSProperties | undefined {
	const [box, setBox] = useState<DOMRect | null>(null);
	useLayoutEffect(() => {
		const panel = document.querySelector<HTMLElement>('.sg-workspace');
		if (!panel) return;
		const measure = () => {
			const rect = panel.getBoundingClientRect();
			setBox(rect.width >= DOCK_MIN && rect.left > 0 ? rect : null);
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(panel);
		window.addEventListener('resize', measure);
		return () => {
			observer.disconnect();
			window.removeEventListener('resize', measure);
		};
	}, []);
	return box ? { top: box.top, left: box.left, width: box.width, height: box.height, bottom: 'auto' } : undefined;
}

/** The viewer's frame: what is open, where it is among the reply's files, and what can be done with it. */
function ViewerPanel({ viewer }: { viewer: ViewerState }) {
	const item = viewer.items[viewer.index];
	const image = isImagePath(item.path);
	const [marking, setMarking] = useState(false);
	const [notice, setNotice] = useState<string | null>(null);
	const many = viewer.items.length > 1;
	const info = categoryInfo(categoryOf(item.path));
	const dock = useDock();

	useEffect(() => setMarking(false), [item.sessionId, item.path]);
	useEffect(() => {
		if (!notice) return;
		const timer = setTimeout(() => setNotice(null), 3000);
		return () => clearTimeout(timer);
	}, [notice]);
	// Escape closes it (or stops drawing), and the arrows step through the reply's files. Caught first, so
	// Escape here never also leaves the page, as it does on a thread.
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			// Keys typed into the composer beside it are the composer's.
			if (event.target instanceof Element && event.target.closest('input, textarea, [contenteditable="true"]')) return;
			if (event.key === 'Escape') {
				event.stopPropagation();
				if (marking) setMarking(false);
				else closeViewer();
			} else if (!marking && event.key === 'ArrowLeft') stepViewer(-1);
			else if (!marking && event.key === 'ArrowRight') stepViewer(1);
		};
		window.addEventListener('keydown', onKey, true);
		return () => window.removeEventListener('keydown', onKey, true);
	}, [marking]);

	return (
		<aside
			aria-label={`Viewing ${nameOf(item.path)}`}
			style={dock}
			className="fixed inset-y-0 right-0 z-40 flex w-full flex-col border-l border-(--border-default) bg-(--bg-surface) shadow-[-24px_0_60px_-24px_rgba(0,0,0,0.7)] duration-200 animate-in fade-in-0 slide-in-from-right-6 sm:w-[min(920px,max(480px,54vw))]"
		>
			<header className="flex h-12 shrink-0 items-center gap-2 border-b border-(--border-subtle) pr-2 pl-3">
				<span className="inline-flex size-[26px] shrink-0 items-center justify-center rounded-[8px] border border-(--border-subtle) bg-(--bg-inset)">
					<Icon icon={info.icon} size={13} className={info.tone} />
				</span>
				<div className="flex min-w-0 flex-1 flex-col">
					<span className="truncate text-[13px] leading-[17px] font-medium text-(--text-primary)" title={item.path}>
						{nameOf(item.path)}
					</span>
					<span className="truncate text-[11px] leading-[15px] text-(--text-tertiary)">
						{notice ?? (item.path.includes('/') ? item.path.slice(0, item.path.lastIndexOf('/')) : 'Library')}
					</span>
				</div>
				{many ? (
					<span className="flex shrink-0 items-center gap-0.5">
						<IconBtn icon={ChevronLeft} size="sm" label="Previous file" disabled={marking} onClick={() => stepViewer(-1)} />
						<span className="in-num min-w-[42px] text-center text-[11px] text-(--text-tertiary)">
							{viewer.index + 1} of {viewer.items.length}
						</span>
						<IconBtn icon={ChevronRight} size="sm" label="Next file" disabled={marking} onClick={() => stepViewer(1)} />
					</span>
				) : null}
				{image && viewer.composer ? (
					<Btn size="sm" variant={marking ? 'secondary' : 'ghost'} icon={PencilLine} onClick={() => setMarking((current) => !current)} className="shrink-0">
						<span className="max-sm:hidden">{marking ? 'Drawing' : 'Mark up'}</span>
					</Btn>
				) : null}
				<a
					href={outputUrl(item.sessionId, item.path)}
					target="_blank"
					rel="noreferrer"
					aria-label="Open in a new tab"
					title="Open in a new tab"
					className="sg-btn sg-icon-btn sg-btn--ghost sg-btn--sm shrink-0"
				>
					<Icon icon={ExternalLink} size={14} />
				</a>
				<IconBtn icon={Download} size="sm" label="Download" onClick={() => download(item)} className="shrink-0" />
				<IconBtn icon={X} size="sm" label="Close" onClick={closeViewer} className="shrink-0" />
			</header>
			<div className={cn('relative min-h-0 flex-1 bg-(--bg-inset)', image ? 'overflow-hidden' : 'overflow-y-auto')}>
				{marking && viewer.composer ? (
					<MarkupStage
						key={keyOf(item)}
						item={item}
						composer={viewer.composer}
						onDone={(added) => {
							setMarking(false);
							if (added) setNotice('Added your drawing to the message');
						}}
					/>
				) : image ? (
					<ImageStage item={item} />
				) : (
					<OutputPreview key={keyOf(item)} item={item} />
				)}
			</div>
			{many ? (
				<nav aria-label="Files" className="flex shrink-0 gap-1.5 overflow-x-auto border-t border-(--border-subtle) px-3 py-2">
					{viewer.items.map((other, index) => (
						<button
							key={keyOf(other)}
							type="button"
							title={other.path}
							aria-current={index === viewer.index}
							disabled={marking}
							onClick={() => openViewer(other, viewer.items, viewer.composer)}
							className={cn(
								'size-11 shrink-0 overflow-hidden rounded-[7px] border bg-(--bg-inset) outline-none focus-visible:shadow-(--focus-ring) disabled:opacity-50',
								index === viewer.index ? 'border-(--accent-border) shadow-[0_0_0_1px_var(--accent-border)]' : 'border-(--border-subtle) opacity-70 hover:opacity-100',
							)}
						>
							<OutputThumb item={other} />
						</button>
					))}
				</nav>
			) : null}
		</aside>
	);
}

/** The viewer, once for the app: it closes when you go to another page. */
export function OutputViewerHost(): ReactNode {
	const viewer = useViewer();
	const pathname = useRouterState({ select: (state) => state.location.pathname });
	useEffect(() => closeViewer(), [pathname]);
	return viewer ? <ViewerPanel viewer={viewer} /> : null;
}

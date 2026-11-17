import { useQuery } from '@tanstack/react-query';
import { useRouterState } from '@tanstack/react-router';
import { ChevronLeft, ChevronRight, Download, ExternalLink, FileX2, PencilLine, X } from '@/lib/icons';
import { type ReactNode, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { HtmlFrame } from '@/components/content/html-frame';
import { kindOf } from '@/lib/library';
import { PREVIEWS, Source, TextFile } from '@/components/content/file-previews';
import { Markdown } from '@/components/content/markdown';
import { Btn, Icon, IconBtn, Spinner } from '@/components/kit/signal';
import { Sketch } from '@/components/content/sketch';
import { outputUrl } from '@/lib/api/outputs';
import { categoryInfo, categoryOf, extensionOf, isMarkdown, isText, nameOf } from '@/lib/artifacts';
import { imageFromDataUrl } from '@/lib/attachments';
import { addToComposer } from '@/lib/composer-inbox';
import { deletedNoun, useDeletedOutput } from '@/lib/deleted-outputs';
import { useElementSize } from '@/lib/use-element-size';
import { useOnePane } from '@/lib/one-pane';
import { cn } from '@/lib/utils';
import { closeViewer, openViewer, setViewerDock, stepViewer, useViewer, useViewerDock, type ViewerItem, type ViewerState } from '@/lib/viewer';
import { isImagePath } from '../../../core/outputs';

const keyOf = (item: ViewerItem) => `${item.sessionId}\n${item.path}`;

function download(item: ViewerItem) {
	const link = document.createElement('a');
	link.href = outputUrl(item.sessionId, item.path);
	link.download = nameOf(item.path);
	link.click();
}

export function FileFace({ path, size = 20 }: { path: string; size?: number }) {
	const info = categoryInfo(categoryOf(path));
	return (
		<span className="flex size-full flex-col items-center justify-center gap-1.5">
			<Icon icon={info.icon} size={size} className={info.tone} />
			{size >= 16 ? <span className="text-nano text-(--text-4)">{extensionOf(path)}</span> : null}
		</span>
	);
}

export function DeletedArtifact({ path, variant = 'block', className }: { path: string; variant?: 'block' | 'thumb' | 'stage'; className?: string }) {
	const noun = deletedNoun(path);
	if (variant === 'thumb') {
		return (
			<span className={cn('flex size-full flex-col items-center justify-center gap-1.5 text-(--text-4)', className)}>
				<Icon icon={FileX2} size={18} />
				<span className="text-micro">Deleted</span>
			</span>
		);
	}
	const stage = variant === 'stage';
	return (
		<div
			role="note"
			aria-label={`Deleted ${noun}: ${nameOf(path)}`}
			className={cn(
				'flex items-center gap-3 text-left',
				stage ? 'h-full flex-col justify-center px-6 text-center' : 'max-w-[520px] self-start rounded-control border border-dashed border-(--line-strong) bg-(--bg-app) px-3.5 py-3',
				className,
			)}
		>
			<span className={cn('inline-flex shrink-0 items-center justify-center text-(--text-3)', stage ? 'size-11' : 'size-8')}>
				<Icon icon={FileX2} size={stage ? 24 : 18} />
			</span>
			<span className={cn('flex min-w-0 flex-col gap-0.5', stage && 'items-center')}>
				<span className="text-body leading-[18px] text-(--text-2)">This {noun} was deleted</span>
				<span className="truncate text-micro leading-[16px] text-(--text-4)" title={path}>
					{nameOf(path)}
				</span>
				{stage ? <span className="mt-1 max-w-[360px] text-small leading-[17px] text-(--text-3)">It was removed from the task's Library, so there is nothing to show here any more.</span> : null}
			</span>
		</div>
	);
}

export function OutputThumb({ item, className, fit }: { item: ViewerItem; className?: string; fit?: 'cover' | 'contain' }) {
	const [broken, setBroken] = useState(false);
	// A wide picture (a chart, a banner) is shown whole; others fill the card from their top, as a page's screenshot reads.
	const [wide, setWide] = useState(false);
	const deleted = useDeletedOutput(item.sessionId, item.path);
	if (deleted) return <DeletedArtifact path={item.path} variant="thumb" />;
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

function OutputCard({ item, items, composer }: { item: ViewerItem; items: ViewerItem[]; composer: string | null }) {
	const deleted = useDeletedOutput(item.sessionId, item.path);
	const face = (
		<>
			<span className="relative block h-[96px] overflow-hidden border-b border-(--line) bg-(--bg-app)">
				<OutputThumb item={item} />
				<span className="absolute top-1.5 left-1.5 rounded-control border border-(--line) bg-(--bg-panel)/80 px-1 py-px text-nano leading-[14px] text-(--text-3) backdrop-blur-sm">
					{extensionOf(item.path)}
				</span>
			</span>
			<span
				className={cn(
					'line-clamp-2 px-2.5 py-2 text-small leading-[16px] break-all',
					deleted ? 'text-(--text-4) line-through' : 'text-(--text-2) group-hover/out:text-(--text)',
				)}
			>
				{nameOf(item.path)}
			</span>
		</>
	);
	if (deleted) {
		return (
			<div
				role="listitem"
				title={`${item.path} was deleted`}
				className="flex w-[156px] flex-col overflow-hidden rounded-card border border-dashed border-(--line-strong) bg-transparent text-left"
			>
				{face}
			</div>
		);
	}
	return (
		<button
			type="button"
			role="listitem"
			title={`Open ${item.path}`}
			onClick={() => openViewer(item, items, composer)}
			className="group/out in-tile flex w-[156px] flex-col overflow-hidden text-left outline-none transition-colors duration-(--t-fast) hover:border-(--line-strong) focus-visible:shadow-(--focus)"
		>
			{face}
		</button>
	);
}

const SHOWN = 6;

export function OutputCards({ items, composer }: { items: ViewerItem[]; composer: string | null }) {
	if (items.length === 0) return null;
	const shown = items.length > SHOWN ? items.slice(0, SHOWN - 1) : items;
	const rest = items.length - shown.length;
	return (
		<div className="flex flex-wrap gap-2" role="list" aria-label="Files from this reply">
			{shown.map((item) => (
				<OutputCard key={keyOf(item)} item={item} items={items} composer={composer} />
			))}
			{rest > 0 ? (
				<button
					type="button"
					onClick={() => openViewer(items[shown.length], items, composer)}
					className="flex w-[72px] flex-col items-center justify-center gap-0.5 rounded-card border border-dashed border-(--line-strong) text-(--text-3) outline-none hover:border-(--line-strong) hover:text-(--text-2) focus-visible:shadow-(--focus)"
					title={`${rest} more`}
				>
					<span className="in-num text-body">+{rest}</span>
					<span className="text-micro">more</span>
				</button>
			) : null}
		</div>
	);
}

export function OutputPreview({ item, code = false, title }: { item: ViewerItem; code?: boolean; title?: string }) {
	const { sessionId, path } = item;
	const app = categoryOf(path) === 'app';
	const readable = app || isMarkdown(path);
	const deleted = useDeletedOutput(sessionId, path);
	if (deleted) return <DeletedArtifact path={path} variant="stage" className="min-h-[320px]" />;
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

function ImageStage({ item }: { item: ViewerItem }) {
	const [actual, setActual] = useState(false);
	const [broken, setBroken] = useState(false);
	const deleted = useDeletedOutput(item.sessionId, item.path);
	useEffect(() => {
		setActual(false);
		setBroken(false);
	}, [item.sessionId, item.path]);
	if (deleted) return <DeletedArtifact path={item.path} variant="stage" />;
	if (broken)
		return (
			<div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
				<span className="size-12">
					<FileFace path={item.path} size={22} />
				</span>
				<span className="text-body text-(--text-2)">This image could not be loaded</span>
				<span className="max-w-[360px] text-small leading-[17px] text-(--text-3)">It is not in the task's Library any more, or its sandbox has not saved it yet.</span>
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
					'block rounded-control shadow-[0_0_0_1px_var(--line),var(--sh-1)]',
					actual ? 'm-auto max-w-none cursor-zoom-out' : 'max-h-full max-w-full cursor-zoom-in object-contain',
				)}
			/>
		</div>
	);
}

/** The longest side a picture is drawn on at, so a huge screenshot stays quick to mark up and send. */
const MAX_SIDE = 2400;

/** A PNG data URL: Sketch flattens the marks onto it, so it must carry its own bytes. */
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
				<span className="text-small text-(--bad)">The image could not be opened for drawing.</span>
			) : !picture.data || !fit ? (
				<span className="flex items-center gap-2 text-small text-(--text-3)">
					<Spinner size={12} />
					Getting the image ready
				</span>
			) : (
				// The box has the picture's shape, so a mark lands where the pointer is. Sketch's toolbar sits below it.
				<div className="relative" style={{ width: picture.data.width * fit, height: picture.data.height * fit }}>
					<div className="pointer-events-none absolute inset-0 rounded-mark shadow-[0_0_0_1px_var(--accent-line)]" />
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

export function OutputViewerDock({ active }: { active: boolean }) {
	return <div ref={setViewerDock} className={cn('min-h-0 min-w-0 flex-1 flex-col', active ? 'flex' : 'hidden')} />;
}

function ViewerPanel({ viewer, docked }: { viewer: ViewerState; docked: boolean }) {
	const item = viewer.items[viewer.index];
	const image = isImagePath(item.path);
	const [marking, setMarking] = useState(false);
	const [notice, setNotice] = useState<string | null>(null);
	const many = viewer.items.length > 1;
	const info = categoryInfo(categoryOf(item.path));
	const deleted = useDeletedOutput(item.sessionId, item.path);

	useEffect(() => setMarking(false), [item.sessionId, item.path, deleted]);
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
			className={cn(
				'@container/viewer flex min-h-0 min-w-0 flex-col overflow-hidden bg-(--bg-panel)',
				docked ? 'flex-1' : 'sg-viewer-sheet fixed z-40 rounded-card shadow-(--sh-2) duration-200 animate-in fade-in-0 slide-in-from-right-6 sm:w-[min(920px,max(480px,54vw))]',
			)}
		>
			<header className="flex h-11 min-w-0 shrink-0 items-center gap-1 border-b border-(--line) pr-2 pl-3 @min-[480px]/viewer:gap-2">
				<span className="hidden size-[26px] shrink-0 items-center justify-center @min-[480px]/viewer:inline-flex">
					<Icon icon={info.icon} size={16} className={info.tone} />
				</span>
				<div className="flex min-w-0 flex-1 flex-col">
					<span className="truncate text-body leading-[17px] font-medium text-(--text)" title={item.path}>
						{nameOf(item.path)}
					</span>
					<span className="truncate text-micro leading-[15px] text-(--text-3)">
						{notice ?? (item.path.includes('/') ? item.path.slice(0, item.path.lastIndexOf('/')) : 'Library')}
					</span>
				</div>
				{many ? (
					<span className="flex shrink-0 items-center gap-0.5">
						<IconBtn icon={ChevronLeft} size="sm" label="Previous file" disabled={marking} onClick={() => stepViewer(-1)} />
						<span className="in-num sr-only text-center text-micro text-(--text-3) @min-[480px]/viewer:not-sr-only @min-[480px]/viewer:min-w-[42px]">
							{viewer.index + 1} of {viewer.items.length}
						</span>
						<IconBtn icon={ChevronRight} size="sm" label="Next file" disabled={marking} onClick={() => stepViewer(1)} />
					</span>
				) : null}
				{image && viewer.composer && !deleted ? (
					<Btn size="sm" variant={marking ? 'secondary' : 'ghost'} icon={PencilLine} aria-label={marking ? 'Drawing' : 'Mark up'} onClick={() => setMarking((current) => !current)} className="shrink-0">
						<span className="hidden @min-[600px]/viewer:inline">{marking ? 'Drawing' : 'Mark up'}</span>
					</Btn>
				) : null}
				{deleted ? null : (
					<>
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
					</>
				)}
				<IconBtn icon={X} size="sm" label="Close" onClick={closeViewer} className="shrink-0" />
			</header>
			<div className={cn('relative min-h-0 flex-1 bg-(--bg-app)', image ? 'overflow-hidden' : 'overflow-y-auto')}>
				{marking && viewer.composer && !deleted ? (
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
				<nav aria-label="Files" className="flex shrink-0 gap-1.5 overflow-x-auto border-t border-(--line) px-3 py-2">
					{viewer.items.map((other, index) => (
						<button
							key={keyOf(other)}
							type="button"
							title={other.path}
							aria-current={index === viewer.index}
							disabled={marking}
							onClick={() => openViewer(other, viewer.items, viewer.composer)}
							className={cn(
								'size-11 shrink-0 overflow-hidden rounded-control border bg-(--bg-app) outline-none focus-visible:shadow-(--focus) disabled:opacity-50',
								index === viewer.index ? 'border-(--accent-line) shadow-[0_0_0_1px_var(--accent-line)]' : 'border-(--line) opacity-70 hover:opacity-100',
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

export function OutputViewerHost(): ReactNode {
	const viewer = useViewer();
	const dock = useViewerDock();
	const onePane = useOnePane();
	const pathname = useRouterState({ select: (state) => state.location.pathname });
	useEffect(() => closeViewer(), [pathname]);
	if (!viewer) return null;
	return dock && !onePane ? createPortal(<ViewerPanel viewer={viewer} docked />, dock) : <ViewerPanel viewer={viewer} docked={false} />;
}

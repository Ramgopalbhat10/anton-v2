import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AppWindow, ArrowLeft, ArrowRight, Globe, Lock, PencilLine, Power, RotateCw, SquareDashedMousePointer } from 'lucide-react';
import { type FormEvent, type PointerEvent, useEffect, useRef, useState } from 'react';
import { Sketch } from '@/components/sketch';
import { Btn, EmptyState, Icon, IconBtn, Spinner } from '@/components/signal';
import { api, type BrowserView } from '@/lib/api';
import { imageFromDataUrl } from '@/lib/attachments';
import { addToComposer, elementLabel } from '@/lib/composer-inbox';
import { useElementSize } from '@/lib/use-element-size';
import { cn } from '@/lib/utils';

/*
 * The Browser panel: a real Chromium on Kernel, one per task, shown through
 * its live view. Anton draws the address bar and drives the same browser for
 * it, for picking an element to send to the agent (its HTML, the React
 * components around it, a picture), and for drawing on the page.
 */

type Viewport = { width: number; height: number };

/**
 * The live view, remounted if no frames arrive in time: it reports when video
 * plays, and a connection that stalls does not retry by itself.
 */
function LiveView({ url, onPlaying }: { url: string; onPlaying: (playing: boolean) => void }) {
	const frame = useRef<HTMLIFrameElement>(null);
	const [attempt, setAttempt] = useState(0);
	const [playing, setPlaying] = useState(false);
	useEffect(() => {
		const onMessage = (event: MessageEvent) => {
			if (event.source !== frame.current?.contentWindow) return;
			const type = (event.data as { type?: string } | null)?.type;
			if (type === 'KERNEL_PLAYING') setPlaying(true);
			if (type === 'KERNEL_PAUSED') setPlaying(false);
			if (type === 'KERNEL_CONNECTION_FAILED' && attempt < 2) setAttempt((count) => count + 1);
		};
		window.addEventListener('message', onMessage);
		// No frames in time: load it again, twice at most.
		const watchdog = playing ? undefined : setTimeout(() => setAttempt((count) => (count < 2 ? count + 1 : count)), 15_000);
		return () => {
			window.removeEventListener('message', onMessage);
			clearTimeout(watchdog);
		};
	}, [attempt, playing]);
	useEffect(() => {
		onPlaying(playing);
	}, [playing, onPlaying]);
	return (
		<iframe
			ref={frame}
			key={attempt}
			src={url}
			title="Browser"
			allow="autoplay; clipboard-read; clipboard-write"
			className="absolute inset-0 size-full border-0 bg-white"
			onLoad={() => frame.current?.focus()}
		/>
	);
}

function OpenForm({ sessionId, available }: { sessionId: string; available: boolean }) {
	const queryClient = useQueryClient();
	const [address, setAddress] = useState('');
	const open = useMutation({
		mutationFn: () => api.openBrowser(sessionId, address),
		onSuccess: (view) => queryClient.setQueryData(['browser', sessionId], view),
	});
	if (!available) {
		return (
			<EmptyState
				icon={AppWindow}
				title="The browser needs a Kernel key"
				body="Add KERNEL_API_KEY to Anton's .env and restart it. Kernel's free plan includes monthly credits, and an idle browser is not billed."
			/>
		);
	}
	return (
		<EmptyState
			icon={AppWindow}
			title="Browse any site"
			body="A real Chromium on Kernel, one for this task. Pick an element or draw on the page to show the agent what you mean. It closes after 30 idle minutes."
		>
			<form
				className="flex w-full max-w-[360px] items-center gap-1.5"
				onSubmit={(event) => {
					event.preventDefault();
					open.mutate();
				}}
			>
				<input
					value={address}
					onChange={(event) => setAddress(event.target.value)}
					placeholder="Address or search"
					aria-label="Address to open"
					className="h-7 min-w-0 flex-1 rounded-lg border border-(--border-subtle) bg-(--well-bg) px-2.5 text-[12px] text-(--text-primary) outline-none placeholder:text-(--text-placeholder) focus-visible:shadow-(--focus-ring)"
				/>
				<Btn type="submit" size="sm" variant="primary" disabled={open.isPending}>
					{open.isPending ? 'Opening…' : 'Open browser'}
				</Btn>
			</form>
			{open.isError ? <p className="m-0 text-[12px] text-(--danger-text)">{open.error.message}</p> : null}
		</EmptyState>
	);
}

/** Moves within the page and between pages; the field shows where the page is, and takes an address or a search. */
function AddressBar({ sessionId, view, children }: { sessionId: string; view: NonNullable<BrowserView['browser']>; children: React.ReactNode }) {
	const queryClient = useQueryClient();
	const page = view.page;
	const [draft, setDraft] = useState<string | null>(null);
	const go = useMutation({
		mutationFn: (to: { url: string } | { action: 'back' | 'forward' | 'reload' }) => api.navigateBrowser(sessionId, to),
		onSuccess: (next) => {
			setDraft(null);
			queryClient.setQueryData<BrowserView>(['browser', sessionId], (current) => (current?.browser ? { ...current, browser: { ...current.browser, page: next } } : current));
		},
	});
	const secure = page?.url.startsWith('https://');
	return (
		<div className="flex h-8 shrink-0 items-center gap-1">
			<IconBtn icon={ArrowLeft} size="sm" label="Back" disabled={!page?.canGoBack || go.isPending} onClick={() => go.mutate({ action: 'back' })} />
			<IconBtn icon={ArrowRight} size="sm" label="Forward" disabled={!page?.canGoForward || go.isPending} onClick={() => go.mutate({ action: 'forward' })} />
			<IconBtn icon={RotateCw} size="sm" label="Reload" disabled={go.isPending} onClick={() => go.mutate({ action: 'reload' })} className={cn(go.isPending && '[&_svg]:animate-spin')} />
			<form
				className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-lg border border-(--border-subtle) bg-(--well-bg) px-2.5 focus-within:shadow-(--focus-ring)"
				onSubmit={(event: FormEvent) => {
					event.preventDefault();
					if (draft?.trim()) go.mutate({ url: draft });
				}}
			>
				<Icon icon={secure ? Lock : Globe} size={11} className="shrink-0 text-(--icon-tertiary)" />
				<input
					value={draft ?? page?.url ?? ''}
					onChange={(event) => setDraft(event.target.value)}
					onFocus={(event) => event.currentTarget.select()}
					onBlur={() => setDraft((current) => (current === page?.url ? null : current))}
					onKeyDown={(event) => event.key === 'Escape' && setDraft(null)}
					aria-label="Address"
					placeholder="Address or search"
					spellCheck={false}
					className="in-num min-w-0 flex-1 border-0 bg-transparent p-0 text-[11.5px] text-(--text-secondary) outline-none placeholder:text-(--text-placeholder) focus:text-(--text-primary)"
				/>
			</form>
			{children}
			{go.isError ? <span className="sr-only" role="alert">{go.error.message}</span> : null}
		</div>
	);
}

/** While picking, a pane over the live view that turns the pointer into highlights, and a click into an element for the message. */
function PickLayer({ sessionId, viewport, onPicked, onCancel }: { sessionId: string; viewport: Viewport; onPicked: (label: string) => void; onCancel: () => void }) {
	const busy = useRef(false);
	const latest = useRef<{ x: number; y: number } | null>(null);
	const sent = useRef<{ x: number; y: number } | null>(null);
	const [picking, setPicking] = useState(false);
	// The latest handler, so the effect below runs once, not with every render of the panel.
	const cancel = useRef(onCancel);
	cancel.current = onCancel;

	const toPage = (event: PointerEvent<HTMLDivElement>) => {
		const box = event.currentTarget.getBoundingClientRect();
		return { x: ((event.clientX - box.left) / box.width) * viewport.width, y: ((event.clientY - box.top) / box.height) * viewport.height };
	};

	// One highlight request at a time; the newest point wins.
	const highlight = async () => {
		if (busy.current || !latest.current) return;
		busy.current = true;
		const point = latest.current;
		latest.current = null;
		sent.current = point;
		await api.inspectBrowser(sessionId, { ...point, pick: false }).catch(() => undefined);
		busy.current = false;
		void highlight();
	};

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => event.key === 'Escape' && cancel.current();
		window.addEventListener('keydown', onKey);
		return () => {
			window.removeEventListener('keydown', onKey);
			void api.clearBrowserHighlight(sessionId).catch(() => undefined);
		};
	}, [sessionId]);

	return (
		<div
			role="button"
			tabIndex={-1}
			aria-label="Pick an element on the page"
			className={cn('absolute inset-0 z-10 cursor-crosshair', picking && 'cursor-wait')}
			onPointerMove={(event) => {
				const point = toPage(event);
				// A few pixels on the page is the same element; only a real move asks the browser again.
				const last = latest.current ?? sent.current;
				if (last && Math.abs(point.x - last.x) < 4 && Math.abs(point.y - last.y) < 4) return;
				latest.current = point;
				void highlight();
			}}
			onClick={async (event) => {
				if (picking) return;
				const point = toPage(event as unknown as PointerEvent<HTMLDivElement>);
				const keep = event.shiftKey;
				setPicking(true);
				try {
					const { element } = await api.inspectBrowser(sessionId, { ...point, pick: true });
					if (element) {
						addToComposer(sessionId, { kind: 'element', id: crypto.randomUUID(), element });
						onPicked(elementLabel(element));
					}
				} finally {
					setPicking(false);
				}
				if (!keep) onCancel();
			}}
		/>
	);
}

export function BrowserTab({ sessionId }: { sessionId: string }) {
	const queryClient = useQueryClient();
	const view = useQuery({ queryKey: ['browser', sessionId], queryFn: () => api.browser(sessionId) });
	const browser = view.data?.browser ?? null;
	const viewport = browser?.viewport ?? { width: 1280, height: 800 };
	// The largest box with the page's proportions that fits the area, so a point in it maps straight to the page.
	const [area, room] = useElementSize<HTMLDivElement>();
	const scale = Math.min(room.width / viewport.width, room.height / viewport.height);
	const size = { width: Math.floor(viewport.width * scale), height: Math.floor(viewport.height * scale) };
	const [picking, setPicking] = useState(false);
	// A picture of the page while drawing on it.
	const [sketch, setSketch] = useState<{ data: string; width: number; height: number } | null>(null);
	const [playing, setPlaying] = useState(false);
	const [notice, setNotice] = useState<string | null>(null);

	const close = useMutation({
		mutationFn: () => api.closeBrowser(sessionId),
		onSuccess: () => {
			setPicking(false);
			setSketch(null);
			void queryClient.invalidateQueries({ queryKey: ['browser', sessionId] });
		},
	});
	const capture = useMutation({ mutationFn: () => api.browserScreenshot(sessionId), onSuccess: setSketch });

	useEffect(() => {
		if (!notice) return;
		const timer = setTimeout(() => setNotice(null), 2500);
		return () => clearTimeout(timer);
	}, [notice]);

	if (view.isPending) {
		return (
			<div className="flex h-7 items-center gap-2 text-[12px] text-(--text-tertiary)">
				<Spinner size={12} />
				Checking the browser
			</div>
		);
	}
	if (view.isError) return <EmptyState title="Browser unavailable" body={view.error.message} />;
	if (!browser) return <OpenForm sessionId={sessionId} available={view.data.available} />;

	// One note over the page at a time: an error, what just happened, how to pick, or that the agent is browsing.
	const status = capture.error?.message ?? close.error?.message ?? notice ?? (picking ? 'Click an element to add it to the message · Shift-click to keep picking · Esc to stop' : null);
	const agentNote = !status && !sketch && browser.agentBusy;

	return (
		<div className="flex h-full min-h-0 flex-col gap-2">
			<AddressBar sessionId={sessionId} view={browser}>
				<span aria-hidden className="mx-0.5 h-4 w-px shrink-0 bg-(--border-subtle)" />
				<IconBtn
					icon={SquareDashedMousePointer}
					size="sm"
					label={picking ? 'Stop picking' : 'Pick an element for the message'}
					aria-pressed={picking}
					onClick={() => {
						setPicking(!picking);
						setSketch(null);
					}}
					className={cn(picking && 'bg-(--accent-bg-subtle) text-(--accent-text)')}
				/>
				<IconBtn
					icon={PencilLine}
					size="sm"
					label={sketch ? 'Stop drawing' : 'Draw on the page'}
					aria-pressed={Boolean(sketch)}
					disabled={capture.isPending}
					onClick={() => {
						setPicking(false);
						if (sketch) setSketch(null);
						else capture.mutate();
					}}
					className={cn(sketch && 'bg-(--accent-bg-subtle) text-(--accent-text)', capture.isPending && '[&_svg]:animate-pulse')}
				/>
				<IconBtn icon={Power} size="sm" label="Close the browser" disabled={close.isPending} onClick={() => close.mutate()} />
			</AddressBar>
			<div ref={area} className="relative flex min-h-[240px] flex-1 items-center justify-center">
				<div className="in-well relative overflow-hidden" style={{ width: size.width, height: size.height }}>
					<LiveView url={browser.liveViewUrl} onPlaying={setPlaying} />
					{!playing ? (
						<div className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2 bg-(--bg-inset) text-[12px] text-(--text-tertiary)">
							<Spinner size={12} />
							Connecting to the browser
						</div>
					) : null}
					{picking ? <PickLayer sessionId={sessionId} viewport={viewport} onPicked={(label) => setNotice(`Added ${label} to the message`)} onCancel={() => setPicking(false)} /> : null}
					{sketch ? (
						// The picture is the page alone; a scrollbar takes the rest of the window, so it covers that much of the view.
						<div className="absolute top-0 left-0 z-20" style={{ width: `${(sketch.width / viewport.width) * 100}%`, height: `${(sketch.height / viewport.height) * 100}%` }}>
							<Sketch
								image={sketch.data}
								width={sketch.width}
								height={sketch.height}
								onClose={() => setSketch(null)}
								onAttach={(png) => {
									addToComposer(sessionId, { kind: 'image', image: imageFromDataUrl(png, 'drawing.png') });
									setNotice('Added the drawing to the message');
									setSketch(null);
								}}
							/>
						</div>
					) : null}
					{status || agentNote ? (
						<div className="pointer-events-none absolute inset-x-0 top-2 z-30 flex justify-center">
							<span role="status" className="in-pop flex items-center gap-1.5 px-2.5 py-1 text-[11.5px] text-(--text-secondary)">
								{agentNote ? <span className="in-pulse size-1.5 rounded-full bg-(--accent-base)" /> : null}
								{status ?? 'The agent is using this browser'}
							</span>
						</div>
					) : null}
				</div>
			</div>
		</div>
	);
}

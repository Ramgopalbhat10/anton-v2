import { Link } from '@tanstack/react-router';
import { ExternalLink, Maximize2 } from 'lucide-react';
import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Icon } from '@/components/signal';
import { addToComposer } from '@/lib/composer-inbox';
import { onPageChange } from '@/lib/live-updates';

/*
 * A page the agent wrote with render_html, in the thread. It loads inside
 * Anton's frame page (src/services/renders.ts), sandboxed, reaching the web
 * only through Anton (src/services/page-fetch.ts); the two speak the MCP Apps protocol over postMessage. The
 * frame takes the page's height as it reports it, opens links only after
 * asking, and puts text the page hands over into the composer, unsent. When
 * another copy of the page (a tab of its own, the Library, Artifacts) saves
 * its state, the frame page hears it from here and brings the page up to date.
 */

const MIN_HEIGHT = 60;
const MAX_HEIGHT = 1600;

/** Anton's tokens under the names a page uses (renders.ts lists them for the agent). */
const THEME: Record<string, string> = {
	'--text-primary': '--text-primary',
	'--text-secondary': '--text-secondary',
	'--text-tertiary': '--text-tertiary',
	'--accent': '--accent-base',
	'--accent-text': '--accent-text',
	'--border': '--border-default',
	'--surface': '--card-bg',
	'--surface-inset': '--bg-inset',
	'--success': '--success-base',
	'--warning': '--warning-base',
	'--danger': '--danger-base',
	'--data-1': '--data-1',
	'--data-2': '--data-2',
	'--data-3': '--data-3',
	'--data-4': '--data-4',
	'--data-5': '--data-5',
	'--font-sans': '--font-sans',
	'--font-mono': '--font-mono',
};

function themeVariables(): Record<string, string> {
	const style = getComputedStyle(document.documentElement);
	const variables: Record<string, string> = { '--radius': '10px' };
	for (const [name, token] of Object.entries(THEME)) {
		const value = style.getPropertyValue(token).trim();
		if (value) variables[name] = value;
	}
	return variables;
}

export const frameUrl = (sessionId: string, path: string) => `/api/sessions/${encodeURIComponent(sessionId)}/render-frame?path=${encodeURIComponent(path)}`;

const chrome =
	'inline-flex size-7 items-center justify-center rounded-lg border border-(--card-border) bg-(--bg-overlay) text-(--icon-secondary) shadow-(--card-highlight) outline-none hover:text-(--icon-primary) focus-visible:shadow-(--focus-ring)';

/**
 * The page, live. In the thread it is as tall as the page says and offers to
 * open it in Artifacts or a tab of its own; with `fill` it fills its box and
 * scrolls inside it, for the Library and Artifacts.
 */
export const HtmlFrame = memo(function HtmlFrame({
	sessionId,
	path,
	title,
	height: initial = 360,
	fill = false,
	actions = true,
}: {
	sessionId: string;
	path: string;
	title: string;
	height?: number;
	fill?: boolean;
	/** Whether it offers to open the page in Artifacts or a tab of its own; off where the page around it does. */
	actions?: boolean;
}) {
	const frame = useRef<HTMLIFrameElement>(null);
	const [height, setHeight] = useState(() => Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, initial)));
	// Another copy saved the page's state: the frame page fetches it, unless the save was its own.
	useEffect(
		() =>
			onPageChange((change) => {
				if (change.id !== sessionId || change.path !== path) return;
				frame.current?.contentWindow?.postMessage(
					{ jsonrpc: '2.0', method: 'anton/page-changed', params: { version: change.version, from: change.from } },
					window.location.origin,
				);
			}),
		[sessionId, path],
	);
	useEffect(() => {
		const onMessage = (event: MessageEvent) => {
			if (event.source !== frame.current?.contentWindow || event.origin !== window.location.origin) return;
			const data = event.data as { jsonrpc?: string; method?: string; params?: Record<string, unknown> } | null;
			if (!data || data.jsonrpc !== '2.0' || typeof data.method !== 'string') return;
			const params = data.params ?? {};
			switch (data.method) {
				case 'ui/notifications/initialized':
					frame.current?.contentWindow?.postMessage(
						{ jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: { theme: 'dark', styles: { variables: themeVariables() } } },
						window.location.origin,
					);
					break;
				case 'ui/notifications/size-changed':
					if (typeof params.height === 'number' && Number.isFinite(params.height)) setHeight(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.ceil(params.height))));
					break;
				case 'ui/open-link': {
					const url = typeof params.url === 'string' ? params.url : '';
					if (/^https?:\/\//.test(url) && window.confirm(`Open this link from "${title}"?\n\n${url}`)) window.open(url, '_blank', 'noopener,noreferrer');
					break;
				}
				case 'ui/message': {
					const content = Array.isArray(params.content) ? params.content : [];
					const text = content
						.map((item) => (item && typeof item === 'object' && typeof (item as { text?: unknown }).text === 'string' ? (item as { text: string }).text : ''))
						.join('\n')
						.trim();
					if (text) addToComposer(sessionId, { kind: 'text', text: text.slice(0, 4000) });
					break;
				}
			}
		};
		window.addEventListener('message', onMessage);
		return () => window.removeEventListener('message', onMessage);
	}, [sessionId, title]);
	const url = frameUrl(sessionId, path);
	if (fill) {
		return <iframe ref={frame} src={url} title={title} className="block size-full border-0 bg-transparent" style={{ colorScheme: 'dark' }} />;
	}
	return (
		<figure className="group/page relative m-0">
			<iframe ref={frame} src={url} title={title} loading="lazy" className="block w-full rounded-[10px] border-0 bg-transparent" style={{ height, colorScheme: 'dark' }} />
			{actions ? (
			<div className="absolute top-2 right-2 flex gap-1 opacity-0 transition-opacity duration-(--duration-micro) group-hover/page:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100">
				<Link to="/artifacts/$taskId" params={{ taskId: sessionId }} search={{ path }} aria-label={`Open ${title} in Artifacts`} title="Open in Artifacts" className={chrome}>
					<Icon icon={Maximize2} size={13} />
				</Link>
				<a href={url} target="_blank" rel="noreferrer" aria-label={`Open ${title} in a new tab`} title="Open in a new tab" className={chrome}>
					<Icon icon={ExternalLink} size={13} />
				</a>
			</div>
			) : null}
		</figure>
	);
});

/** The width a thumbnail lays the page out at, about the thread's, before scaling it down to its card. */
const THUMBNAIL_WIDTH = 520;

/**
 * A page drawn small on a card: laid out at the thread's width and scaled to
 * fit, behind the card's own link, so it can be seen but not used.
 */
export function PageThumbnail({ sessionId, path }: { sessionId: string; path: string }) {
	const box = useRef<HTMLDivElement>(null);
	const [size, setSize] = useState<{ scale: number; height: number } | null>(null);
	useLayoutEffect(() => {
		const element = box.current;
		if (!element) return;
		const observer = new ResizeObserver(([entry]) => {
			const { width, height } = entry.contentRect;
			if (width > 0) setSize({ scale: width / THUMBNAIL_WIDTH, height: height / (width / THUMBNAIL_WIDTH) });
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, []);
	return (
		// Inset from the card's edges, as the page sits inside a reply's margins.
		<div ref={box} aria-hidden className="pointer-events-none absolute inset-x-3 top-3 bottom-0 overflow-hidden">
			{size ? (
				<iframe
					src={frameUrl(sessionId, path)}
					title=""
					tabIndex={-1}
					loading="lazy"
					className="block origin-top-left border-0 bg-transparent"
					style={{ width: THUMBNAIL_WIDTH, height: size.height, transform: `scale(${size.scale})`, colorScheme: 'dark' }}
				/>
			) : null}
		</div>
	);
}

import { Maximize2 } from 'lucide-react';
import { memo, useEffect, useRef, useState } from 'react';
import { Icon } from '@/components/signal';
import { addToComposer } from '@/lib/composer-inbox';

/*
 * A page the agent wrote with render_html, in the thread. It loads inside
 * Anton's frame page (src/services/renders.ts), sandboxed and cut off from
 * the network; the two speak the MCP Apps protocol over postMessage. The
 * frame takes the page's height as it reports it, opens links only after
 * asking, and puts text the page hands over into the composer, unsent.
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

export const HtmlFrame = memo(function HtmlFrame({ sessionId, path, title, height: initial }: { sessionId: string; path: string; title: string; height: number }) {
	const frame = useRef<HTMLIFrameElement>(null);
	const [height, setHeight] = useState(() => Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, initial)));
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
	return (
		<figure className="group/page relative m-0">
			<iframe ref={frame} src={url} title={title} loading="lazy" className="block w-full rounded-[10px] border-0 bg-transparent" style={{ height, colorScheme: 'dark' }} />
			<a
				href={url}
				target="_blank"
				rel="noreferrer"
				aria-label={`Open ${title} in a new tab`}
				title="Open in a new tab"
				className="absolute top-2 right-2 inline-flex size-7 items-center justify-center rounded-lg border border-(--card-border) bg-(--bg-overlay) text-(--icon-secondary) opacity-0 shadow-(--card-highlight) transition-opacity duration-(--duration-micro) group-hover/page:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
			>
				<Icon icon={Maximize2} size={13} />
			</a>
		</figure>
	);
});

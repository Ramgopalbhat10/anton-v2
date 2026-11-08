import { type ReactNode, useEffect, useState } from 'react';
import blackHole from '@/assets/science/black-hole.webp';

export const BACKGROUND_DAY_MS = 86_400_000;
export const SCIENCE_FALLBACK = blackHole;
export type DailyBackground = { url: string; title: string; date: string; credit: string; sourceUrl: string; licenseUrl: string };

export function nextBackgroundDelay(now: number): number {
	return BACKGROUND_DAY_MS - ((now % BACKGROUND_DAY_MS) + BACKGROUND_DAY_MS) % BACKGROUND_DAY_MS;
}

function BackgroundImage({ src, onError }: { src: string; onError: () => void }) {
	const [loaded, setLoaded] = useState(false);
	return <img src={src} alt="" draggable={false} decoding="async" fetchPriority="low" data-loaded={loaded} onLoad={() => setLoaded(true)} onError={onError} />;
}

/** One still, one daily timer; NASA requests and image bytes are cached server-side. */
export function ScienceBackground({ children }: { children?: ReactNode }) {
	const [daily, setDaily] = useState<DailyBackground | null>(null);
	const [failed, setFailed] = useState<string | null>(null);
	useEffect(() => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		let controller: AbortController | undefined;
		let disposed = false;
		let checkedDay = -1;
		function sync() {
			clearTimeout(timer);
			if (document.visibilityState === 'hidden') return;
			const now = Date.now();
			const day = Math.floor(now / BACKGROUND_DAY_MS);
			if (day !== checkedDay) {
				checkedDay = day;
				controller?.abort();
				controller = new AbortController();
				void fetch('/api/science-background', { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]) })
					.then(async (response) => {
						if (!response.ok) throw new Error('Daily image unavailable');
						const data = await response.json() as { image: DailyBackground | null };
						// Keep all image requests same-origin, even on a malformed metadata response.
						if (data.image && (!/^\/api\/science-background\/image\?id=[a-f0-9]{16}$/.test(data.image.url) || !data.image.sourceUrl.startsWith('https://www.nasa.gov/') || !data.image.licenseUrl.startsWith('https://'))) throw new Error('Invalid daily image');
						if (!disposed && data.image) { setDaily(data.image); setFailed(null); }
					})
					.catch(() => { /* Keep the last usable image, or the bundled fallback. */ });
			}
			timer = setTimeout(sync, nextBackgroundDelay(now));
		}
		sync();
		document.addEventListener('visibilitychange', sync);
		window.addEventListener('pageshow', sync);
		window.addEventListener('focus', sync);
		return () => {
			disposed = true;
			controller?.abort();
			clearTimeout(timer);
			document.removeEventListener('visibilitychange', sync);
			window.removeEventListener('pageshow', sync);
			window.removeEventListener('focus', sync);
		};
	}, []);
	const image = daily && daily.url !== failed ? daily : null;
	const src = image?.url ?? SCIENCE_FALLBACK;
	return (
		<main className="science-canvas flex min-h-0 min-w-0 flex-1 flex-col">
			<div className="science-background" aria-hidden="true">
				<BackgroundImage key={src} src={src} onError={() => setFailed(src)} />
			</div>
			{children}
			<footer className="science-credit">
				{image ? <>
					<a href={image.sourceUrl} target="_blank" rel="noreferrer">NASA image of the day: {image.title} ({image.date})</a>
					<span>Credit: {image.credit}. <a href={image.licenseUrl} target="_blank" rel="noreferrer">Usage terms</a>.</span>
				</> : <a href="/backgrounds/credits.html" target="_blank" rel="noreferrer">Space imagery: NASA’s Goddard Space Flight Center/Jeremy Schnittman</a>}
				<a href="/backgrounds/credits.html" target="_blank" rel="noreferrer">Image treatment & credits</a>
			</footer>
		</main>
	);
}

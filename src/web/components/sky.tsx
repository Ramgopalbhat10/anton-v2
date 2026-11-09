import { type CSSProperties, useEffect, useId, useRef, useState } from 'react';
import { SKY_BRIGHTNESS_DEFAULT, setSkyBrightness, type SkyImage, skyLook, skySource, useSkyBrightness } from '@/lib/sky';
import { cn } from '@/lib/utils';

/** CSS pixels per cell of the mesh. */
const CELL = 5;
/** Levels per colour channel after dithering: enough to keep the picture's gradients smooth, few enough to read as pixels. */
const LEVELS = 12;
/** A 4×4 Bayer matrix, scaled to -0.5…0.5. */
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((value) => value / 16 - 0.5);

/**
 * Draws `image` as a pixel mesh: the picture cropped to cover the box, cut into
 * 5px cells, each cell ordered-dithered to a few levels per channel with a little
 * grain, and a dark hairline between cells. It draws once per picture and size,
 * so nothing runs while the page is still.
 */
function paint(canvas: HTMLCanvasElement, picture: HTMLImageElement) {
	const width = canvas.clientWidth;
	const height = canvas.clientHeight;
	if (!width || !height) return;
	const ratio = Math.min(window.devicePixelRatio || 1, 2);
	const cols = Math.ceil(width / CELL);
	const rows = Math.ceil(height / CELL);

	// The picture, cropped to cover, at one pixel per cell.
	const small = document.createElement('canvas');
	small.width = cols;
	small.height = rows;
	const sctx = small.getContext('2d', { willReadFrequently: true });
	if (!sctx) return;
	const scale = Math.max(cols / picture.naturalWidth, rows / picture.naturalHeight);
	const drawnW = picture.naturalWidth * scale;
	const drawnH = picture.naturalHeight * scale;
	sctx.imageSmoothingQuality = 'high';
	sctx.drawImage(picture, (cols - drawnW) / 2, (rows - drawnH) / 2, drawnW, drawnH);
	const data = sctx.getImageData(0, 0, cols, rows);
	const px = data.data;
	const step = 255 / (LEVELS - 1);
	for (let y = 0; y < rows; y++) {
		for (let x = 0; x < cols; x++) {
			const at = (y * cols + x) * 4;
			const threshold = BAYER[(y % 4) * 4 + (x % 4)];
			// A little grain per cell, the same for all three channels, so the sparkle stays in the picture's hues.
			const grain = (Math.random() - 0.5) * 0.18;
			for (let channel = 0; channel < 3; channel++) {
				const value = px[at + channel] / step + threshold + grain;
				px[at + channel] = Math.max(0, Math.min(255, Math.round(value) * step));
			}
		}
	}
	sctx.putImageData(data, 0, 0);

	canvas.width = Math.round(width * ratio);
	canvas.height = Math.round(height * ratio);
	const ctx = canvas.getContext('2d');
	if (!ctx) return;
	ctx.imageSmoothingEnabled = false;
	const cell = CELL * ratio;
	ctx.drawImage(small, 0, 0, cols * cell, rows * cell);
	// The mesh: a hairline between cells.
	ctx.fillStyle = 'rgba(12, 12, 12, 0.5)';
	const line = Math.max(1, Math.round(ratio));
	for (let x = 0; x < cols; x++) ctx.fillRect(Math.round(x * cell), 0, line, canvas.height);
	for (let y = 0; y < rows; y++) ctx.fillRect(0, Math.round(y * cell), canvas.width, line);
}

/**
 * The hour's picture behind the app, as a pixel mesh under a veil. The veil
 * (`data-sky` on the page, see `.sky` in styles) sets how much shows through:
 * all of it on Home, a little behind lists, almost none behind a conversation.
 */
export function Sky({ image }: { image: SkyImage }) {
	const canvas = useRef<HTMLCanvasElement>(null);
	const look = skyLook(useSkyBrightness());
	const [shown, setShown] = useState<string | null>(null);
	useEffect(() => {
		const element = canvas.current;
		if (!element) return;
		let picture: HTMLImageElement | null = null;
		let frame = 0;
		const draw = () => {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(() => {
				if (picture) paint(element, picture);
			});
		};
		const next = new Image();
		next.decoding = 'async';
		next.onload = () => {
			picture = next;
			paint(element, next);
			setShown(image.slug);
		};
		next.src = skySource(image);
		// Redrawn when the window settles on a new size, not on every step of a drag.
		let settle: ReturnType<typeof setTimeout>;
		const observer = new ResizeObserver(() => {
			clearTimeout(settle);
			settle = setTimeout(draw, 120);
		});
		observer.observe(element);
		return () => {
			observer.disconnect();
			clearTimeout(settle);
			cancelAnimationFrame(frame);
			next.onload = null;
		};
	}, [image]);
	return (
		<div aria-hidden className="sky pointer-events-none fixed inset-0 z-0 overflow-hidden" style={look}>
			<canvas ref={canvas} className="sky-canvas absolute inset-0 size-full" data-shown={shown === image.slug} />
			<div className="sky-shade absolute inset-0" />
		</div>
	);
}

/**
 * The sky's brightness as a slider, from dim to bright, with the default
 * marked. Used in the sky's menu on Home and in Settings › General; keys
 * stay with the slider so a menu around it does not take them.
 */
export function SkyBrightnessSlider({ className }: { className?: string }) {
	const value = useSkyBrightness();
	const id = useId();
	const word = value < 25 ? 'Faint' : value < 50 ? 'Dim' : value <= 70 ? 'As drawn' : value < 90 ? 'Bright' : 'Vivid';
	return (
		<div className={cn('flex flex-col gap-1.5', className)}>
			<div className="flex items-center justify-between text-[12px]">
				<label htmlFor={id} className="text-(--text-secondary)">
					Brightness
				</label>
				<span className="in-num text-(--text-tertiary)">{word}</span>
			</div>
			<input
				id={id}
				type="range"
				min={0}
				max={100}
				step={1}
				value={value}
				aria-valuetext={`${value} percent, ${word.toLowerCase()}`}
				onChange={(event) => setSkyBrightness(Number(event.target.value))}
				onKeyDown={(event) => event.stopPropagation()}
				onDoubleClick={() => setSkyBrightness(SKY_BRIGHTNESS_DEFAULT)}
				title="Double-click to reset"
				className="sky-range"
				style={{ '--range-fill': `${value}%`, '--range-mark': `${SKY_BRIGHTNESS_DEFAULT}%` } as CSSProperties}
			/>
		</div>
	);
}

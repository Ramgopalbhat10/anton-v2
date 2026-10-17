import { useQuery } from '@tanstack/react-query';
import type { LucideIcon, LucideProps } from 'lucide-react';
import { forwardRef } from 'react';
import { api, type McpServer } from '@/lib/api';
import type { Brand, BrandId } from '@/lib/brand-icons';
import { cn } from '@/lib/utils';

/**
 * Connectors drawn as the products they are: Gmail, Google, and each MCP
 * server by the product its address belongs to, else MCP's own mark. A mark's
 * icon takes the same props as a Lucide icon, so it goes wherever one does
 * (`Icon`, a tool row); `MarkTile` puts it on the light tile apps use for
 * their icons, the same in both themes.
 */

export type Mark = {
	title: string;
	icon: LucideIcon;
	/** The tile's colour for a mark too light to read on white; its icon is then drawn dark. */
	tile?: string;
};

type Path = { d: string; fill?: string };

function glyph(name: string, viewBox: string, paths: Path[], fill = 'currentColor'): LucideIcon {
	const Glyph = forwardRef<SVGSVGElement, LucideProps>(function Glyph({ size = 24, color, strokeWidth: _stroke, absoluteStrokeWidth: _absolute, ...rest }, ref) {
		return (
			<svg ref={ref} xmlns="http://www.w3.org/2000/svg" viewBox={viewBox} width={size} height={size} fill={color ?? fill} {...rest}>
				{paths.map((path) => (
					<path key={path.d} d={path.d} fill={path.fill} />
				))}
			</svg>
		);
	});
	Glyph.displayName = name;
	return Glyph as LucideIcon;
}

/** Gmail's M in its four colours. */
export const GMAIL: Mark = {
	title: 'Gmail',
	icon: glyph('Gmail', '52 42 88 66', [
		{ d: 'M58 108h14V74L52 59v43c0 3.32 2.69 6 6 6', fill: '#4285F4' },
		{ d: 'M120 108h14c3.32 0 6-2.69 6-6V59l-20 15', fill: '#34A853' },
		{ d: 'M120 48v26l20-15v-8c0-7.42-8.47-11.65-14.4-7.2', fill: '#FBBC04' },
		{ d: 'M72 74V48l24 18 24-18v26L96 92', fill: '#EA4335' },
		{ d: 'M52 51v8l20 15V48l-5.6-4.2c-5.94-4.45-14.4-.22-14.4 7.2', fill: '#C5221F' },
	]),
};

/** Google's G, as LobeHub's set draws it (MIT), the file the model picker shows for Google. */
export const GOOGLE: Mark = {
	title: 'Google',
	icon: glyph('Google', '0 0 24 24', [
		{ d: 'M23 12.245c0-.905-.075-1.565-.236-2.25h-10.54v4.083h6.186c-.124 1.014-.797 2.542-2.294 3.569l-.021.136 3.332 2.53.23.022C21.779 18.417 23 15.593 23 12.245z', fill: '#4285F4' },
		{ d: 'M12.225 23c3.03 0 5.574-.978 7.433-2.665l-3.542-2.688c-.948.648-2.22 1.1-3.891 1.1a6.745 6.745 0 01-6.386-4.572l-.132.011-3.465 2.628-.045.124C4.043 20.531 7.835 23 12.225 23z', fill: '#34A853' },
		{ d: 'M5.84 14.175A6.65 6.65 0 015.463 12c0-.758.138-1.491.361-2.175l-.006-.147-3.508-2.67-.115.054A10.831 10.831 0 001 12c0 1.772.436 3.447 1.197 4.938l3.642-2.763z', fill: '#FBBC05' },
		{ d: 'M12.225 5.253c2.108 0 3.529.892 4.34 1.638l3.167-3.031C17.787 2.088 15.255 1 12.225 1 7.834 1 4.043 3.469 2.197 7.062l3.63 2.763a6.77 6.77 0 016.398-4.572z', fill: '#EB4335' },
	]),
};

/** The Model Context Protocol's mark (Simple Icons, CC0), for a server that names no product Anton knows. */
export const MCP: Mark = {
	title: 'MCP server',
	icon: glyph('Mcp', '0 0 24 24', [
		{
			d: 'M13.85 0a4.16 4.16 0 0 0-2.95 1.217L1.456 10.66a.835.835 0 0 0 0 1.18.835.835 0 0 0 1.18 0l9.442-9.442a2.49 2.49 0 0 1 3.541 0 2.49 2.49 0 0 1 0 3.541L8.59 12.97l-.1.1a.835.835 0 0 0 0 1.18.835.835 0 0 0 1.18 0l.1-.098 7.03-7.034a2.49 2.49 0 0 1 3.542 0l.049.05a2.49 2.49 0 0 1 0 3.54l-8.54 8.54a1.96 1.96 0 0 0 0 2.755l1.753 1.753a.835.835 0 0 0 1.18 0 .835.835 0 0 0 0-1.18l-1.753-1.753a.266.266 0 0 1 0-.394l8.54-8.54a4.185 4.185 0 0 0 0-5.9l-.05-.05a4.16 4.16 0 0 0-2.95-1.218c-.2 0-.401.02-.6.048a4.17 4.17 0 0 0-1.17-3.552A4.16 4.16 0 0 0 13.85 0m0 3.333a.84.84 0 0 0-.59.245L6.275 10.56a4.186 4.186 0 0 0 0 5.902 4.186 4.186 0 0 0 5.902 0L19.16 9.48a.835.835 0 0 0 0-1.18.835.835 0 0 0-1.18 0l-6.985 6.984a2.49 2.49 0 0 1-3.54 0 2.49 2.49 0 0 1 0-3.54l6.983-6.985a.835.835 0 0 0 0-1.18.84.84 0 0 0-.59-.245',
		},
	]),
};

/** Relative luminance of a `#rrggbb` colour, 0 for black to 1 for white. */
export function luminance(hex: string): number {
	const [r, g, b] = [1, 3, 5].map((at) => {
		const channel = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
		return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const brandMarks = new Map<string, Mark>();

/** A product's mark in its colour; one near black takes the text colour, so it reads in the dark theme too. */
export function brandMark(brand: Brand): Mark {
	let mark = brandMarks.get(brand.title);
	if (!mark) {
		const light = luminance(brand.hex) > 0.6;
		const fill = light || luminance(brand.hex) < 0.05 ? 'currentColor' : brand.hex;
		mark = { title: brand.title, icon: glyph(brand.title, '0 0 24 24', [{ d: brand.path }], fill), ...(light ? { tile: brand.hex } : {}) };
		brandMarks.set(brand.title, mark);
	}
	return mark;
}

type Brands = typeof import('@/lib/brand-icons');

/** The product a server's address belongs to: its host's domain, or any domain above it, in the list. */
export function serverMark(url: string, brands: Brands | undefined): Mark {
	if (!brands) return MCP;
	let host: string;
	try {
		host = new URL(url).hostname.toLowerCase();
	} catch {
		return MCP;
	}
	const labels = host.split('.');
	for (let at = 0; at < labels.length - 1; at++) {
		const id = brands.BRAND_DOMAINS[labels.slice(at).join('.')];
		if (id === 'google') return GOOGLE;
		if (id) return brandMark(brands.BRANDS[id as BrandId]);
	}
	return MCP;
}

/** The product marks, loaded the first time a server is drawn rather than with the app. */
export function useBrands(enabled = true): Brands | undefined {
	return useQuery({ queryKey: ['brand-icons'], queryFn: () => import('@/lib/brand-icons'), enabled, staleTime: Infinity, gcTime: Infinity, structuralSharing: false }).data;
}

export function useServerMark(url: string): Mark {
	return serverMark(url, useBrands());
}

/** The mark of the server a tool named `mcp__<server>__<tool>` belongs to, or null for any other tool. */
export function toolServerMark(toolName: string, servers: McpServer[] | undefined, brands: Brands | undefined): Mark | null {
	const server = /^mcp__(.+?)__/.exec(toolName)?.[1];
	if (!server) return null;
	// Tool names carry the server's name with anything but letters, digits and _ made _.
	const match = servers?.find((item) => item.name.replace(/[^\w]/g, '_') === server);
	return match ? serverMark(match.url, brands) : MCP;
}

/** The MCP servers of Settings › Connectors, for drawing a tool call by its server. */
export function useMcpServers(enabled = true): McpServer[] | undefined {
	return useQuery({ queryKey: ['connectors'], queryFn: api.connectors, enabled, staleTime: 60_000 }).data?.mcpServers;
}

/** A mark on a light tile, as an app icon is drawn. With `label` it names the product to a screen reader; without, it is decoration. */
export function MarkTile({ mark, size = 26, label, className }: { mark: Mark; size?: number; label?: string; className?: string }) {
	const Glyph = mark.icon;
	return (
		<span
			{...(label ? { role: 'img', 'aria-label': label, title: label } : { 'aria-hidden': true })}
			className={cn('inline-flex shrink-0 items-center justify-center rounded-[8px] border border-black/10 text-[#1f1f1f]', className)}
			style={{ width: size, height: size, background: mark.tile ?? '#fff' }}
		>
			<Glyph size={Math.round(size * 0.58)} aria-hidden />
		</span>
	);
}

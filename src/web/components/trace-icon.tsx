import type { LucideIcon, LucideProps } from 'lucide-react';
import { forwardRef } from 'react';

/**
 * A reply's trace as an icon: its spans as a small waterfall, each call
 * hanging from the one that made it. Takes a Lucide icon's props, so it
 * goes wherever one does.
 */
export const TraceIcon = forwardRef<SVGSVGElement, LucideProps>(function TraceIcon({ size = 24, color = 'currentColor', strokeWidth = 2, absoluteStrokeWidth: _absolute, ...rest }, ref) {
	return (
		<svg ref={ref} xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" {...rest}>
			<path d="M6 7v3a2 2 0 0 0 2 2h1M12 14v3a2 2 0 0 0 2 2" />
			<path d="M4 5h8M11 12h7M15 19h5" strokeWidth={Number(strokeWidth) * 2} />
		</svg>
	);
}) as LucideIcon;

import type { Session, ThreadState } from '@/lib/api';
import { failed, stateOf } from '@/lib/spaces';
import { cn } from '@/lib/utils';

/** A thread's state as one mark, with failure as its own: a failed thread waits on you, but in red. */
export type GlyphKind = ThreadState | 'failed';

export const glyphKind = (thread: Session): GlyphKind => {
	const state = stateOf(thread);
	return state === 'waiting' && failed(thread) ? 'failed' : state;
};

/** The colour each state draws with, in rings, bars and splits. */
export const STATE_COLOR: Record<GlyphKind, string> = {
	failed: 'var(--danger-base)',
	waiting: 'var(--warning-base)',
	working: 'var(--accent-base)',
	queued: 'var(--neutral-600)',
	review: 'var(--success-base)',
	landing: 'color-mix(in srgb, var(--success-base) 55%, var(--neutral-100))',
	idle: 'var(--neutral-500)',
	resolved: 'var(--neutral-700)',
};

/** The order states take in rings, splits and legends: what needs you first, what is done last. */
export const KINDS: GlyphKind[] = ['failed', 'waiting', 'working', 'queued', 'review', 'landing', 'idle', 'resolved'];

export const KIND_LABEL: Record<GlyphKind, string> = {
	failed: 'Failed',
	waiting: 'Needs you',
	working: 'Working',
	queued: 'Queued',
	review: 'Review',
	landing: 'Approved',
	idle: 'Idle',
	resolved: 'Done',
};

const CHECK = 'M5.4 8.3l1.8 1.8 3.5-3.8';

/**
 * A state as a small drawn mark, so a list reads at a glance without words:
 * a turning dashed ring while it works, an amber dot that calls out while it
 * waits on you, red with a bang when it failed, dotted while queued, a green
 * check when ready, filled when approved, and a green check on a soft disc once done.
 */
export function Glyph({ kind, size = 14, className, title }: { kind: GlyphKind; size?: number; className?: string; title?: string }) {
	const color = STATE_COLOR[kind];
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 16 16"
			fill="none"
			role={title ? 'img' : undefined}
			aria-label={title}
			aria-hidden={title ? undefined : true}
			className={cn('shrink-0 overflow-visible', className)}
			data-glyph={kind}
		>
			{kind === 'working' ? (
				<>
					<circle cx="8" cy="8" r="6" stroke={color} strokeOpacity="0.28" strokeWidth="1.5" />
					<circle className="glyph-spin" cx="8" cy="8" r="6" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeDasharray="9 28.7" />
					<circle className="in-pulse" cx="8" cy="8" r="2" fill={color} />
				</>
			) : kind === 'waiting' ? (
				<>
					<circle className="glyph-halo" cx="8" cy="8" r="6" stroke={color} strokeWidth="1.5" />
					<circle cx="8" cy="8" r="6" stroke={color} strokeWidth="1.5" />
					<circle cx="8" cy="8" r="2.5" fill={color} />
				</>
			) : kind === 'failed' ? (
				<>
					<circle cx="8" cy="8" r="6" fill="var(--danger-bg)" stroke={color} strokeWidth="1.5" />
					<path d="M8 4.9v3.6" stroke={color} strokeWidth="1.6" strokeLinecap="round" />
					<circle cx="8" cy="10.9" r="0.95" fill={color} />
				</>
			) : kind === 'queued' ? (
				<circle cx="8" cy="8" r="6" stroke="var(--neutral-500)" strokeWidth="1.6" strokeLinecap="round" strokeDasharray="0.1 2.95" />
			) : kind === 'review' ? (
				<>
					<circle cx="8" cy="8" r="6" stroke={color} strokeWidth="1.5" />
					<path d={CHECK} stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
				</>
			) : kind === 'landing' ? (
				<>
					<circle cx="8" cy="8" r="6.75" fill="var(--success-base)" />
					<path d={CHECK} stroke="var(--neutral-950)" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
				</>
			) : kind === 'idle' ? (
				<>
					<circle cx="8" cy="8" r="6" stroke={color} strokeWidth="1.5" strokeDasharray="3.1 2.2" />
					<circle cx="8" cy="8" r="1.6" fill={color} />
				</>
			) : (
				<>
					<circle cx="8" cy="8" r="6.75" fill="color-mix(in oklab, var(--success-base) 20%, transparent)" />
					<path d={CHECK} stroke="var(--success-text)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
				</>
			)}
		</svg>
	);
}

export function ThreadGlyph({ thread, size, className }: { thread: Session; size?: number; className?: string }) {
	return <Glyph kind={glyphKind(thread)} size={size} className={className} />;
}

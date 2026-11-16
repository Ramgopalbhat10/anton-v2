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
	failed: 'var(--bad)',
	waiting: 'var(--warn)',
	working: 'var(--accent)',
	queued: 'var(--track)',
	review: 'var(--merged)',
	landing: 'var(--ok)',
	idle: 'var(--text-4)',
	resolved: 'var(--bg-active)',
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

const CHECK = 'M5 8.2l2.1 2.1 3.9-4.2';

/**
 * A state as a small drawn mark, so a list reads by shape as well as colour:
 * a dashed ring while queued, an accent ring with a turning wedge while it
 * works, an amber ring and dot while it waits on you, a violet ring three
 * quarters full in review, a green ring with a check once approved, a solid
 * green check when done, solid red with a bang when it failed, and a plain
 * grey ring when idle.
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
					<circle cx="8" cy="8" r="6.6" stroke={color} strokeWidth="1.6" />
					{/* A wedge: a thick stroke on a small circle, dashed to three fifths of the way round. */}
					<circle className="glyph-spin" cx="8" cy="8" r="2" stroke={color} strokeWidth="4" strokeDasharray="7.54 5.03" />
				</>
			) : kind === 'waiting' ? (
				<>
					<circle cx="8" cy="8" r="6.6" stroke={color} strokeWidth="1.6" />
					<circle cx="8" cy="8" r="3.4" fill={color} />
				</>
			) : kind === 'failed' ? (
				<>
					<circle cx="8" cy="8" r="7.4" fill={color} />
					<path d="M8 4.5v4" stroke="var(--bg-panel)" strokeWidth="1.7" strokeLinecap="round" />
					<circle cx="8" cy="11.2" r="1" fill="var(--bg-panel)" />
				</>
			) : kind === 'queued' ? (
				<circle cx="8" cy="8" r="6.6" stroke="var(--text-4)" strokeWidth="1.6" strokeDasharray="2.6 2.58" />
			) : kind === 'review' ? (
				<>
					<circle cx="8" cy="8" r="6.6" stroke={color} strokeWidth="1.6" />
					<circle cx="8" cy="8" r="2" stroke={color} strokeWidth="4" strokeDasharray="9.42 3.15" transform="rotate(-90 8 8)" />
				</>
			) : kind === 'landing' ? (
				<>
					<circle cx="8" cy="8" r="6.6" stroke={color} strokeWidth="1.6" />
					<path d={CHECK} stroke={color} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
				</>
			) : kind === 'idle' ? (
				<circle cx="8" cy="8" r="6.6" stroke={color} strokeWidth="1.6" />
			) : (
				<>
					<circle cx="8" cy="8" r="7.4" fill="var(--ok)" />
					<path d={CHECK} stroke="var(--bg-panel)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
				</>
			)}
		</svg>
	);
}

export function ThreadGlyph({ thread, size, className }: { thread: Session; size?: number; className?: string }) {
	return <Glyph kind={glyphKind(thread)} size={size} className={className} />;
}

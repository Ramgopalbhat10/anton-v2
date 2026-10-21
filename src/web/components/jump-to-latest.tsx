import { ArrowDown } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * The way back to the newest content, shown once the reader has scrolled up
 * from it, with a pulsing dot while more is still arriving. Put it last inside
 * the scroller: it rides at the bottom of the view and takes no room of its own.
 */
export function JumpToLatest({ show, live, onJump, className }: { show: boolean; live?: boolean; onJump: () => void; className?: string }) {
	return (
		<div aria-hidden={!show} className={cn('pointer-events-none sticky bottom-3 z-10 flex h-0 justify-center', className)}>
			<button
				type="button"
				tabIndex={show ? 0 : -1}
				onClick={onJump}
				className={cn(
					'flex h-7 -translate-y-full items-center gap-1.5 rounded-full border border-(--card-border) bg-(--card-bg-top) pr-3 pl-2.5 text-[12px] text-(--text-secondary) shadow-(--shadow-overlay) outline-none transition-opacity duration-150 hover:border-(--border-strong) hover:text-(--text-primary) focus-visible:shadow-(--focus-ring)',
					show ? 'pointer-events-auto opacity-100' : 'opacity-0',
				)}
			>
				<ArrowDown aria-hidden size={13} />
				Jump to latest
				{live ? <span aria-hidden className="in-pulse size-1.5 rounded-full bg-(--accent-base)" /> : null}
			</button>
		</div>
	);
}

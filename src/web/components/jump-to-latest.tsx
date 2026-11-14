import { ArrowDown } from 'lucide-react';
import { memo } from 'react';
import { cn } from '@/lib/utils';
import { StatusDot } from '@/components/instrument';

/**
 * The way back to the newest content, shown once the reader has scrolled up
 * from it, with a pulsing dot while more is still arriving. Put it last inside
 * the scroller: it rides at the bottom of the view and takes no room of its own.
 */
export const JumpToLatest = memo(function JumpToLatest({ show, live, onJump, className }: { show: boolean; live?: boolean; onJump: () => void; className?: string }) {
	return (
		<div aria-hidden={!show} className={cn('pointer-events-none sticky bottom-3 z-10 flex h-0 justify-center', className)}>
			<button
				type="button"
				tabIndex={show ? 0 : -1}
				onClick={onJump}
				className={cn(
					'flex h-7 -translate-y-full items-center gap-1.5 rounded-full border border-(--line) bg-(--bg-surface) pr-3 pl-2.5 text-small text-(--text-2) shadow-(--sh-2) outline-none transition-opacity duration-150 hover:border-(--line-strong) hover:text-(--text) focus-visible:shadow-(--focus)',
					show ? 'pointer-events-auto opacity-100' : 'opacity-0',
				)}
			>
				<ArrowDown aria-hidden size={13} />
				Jump to latest
				{live ? <StatusDot tone="accent" pulse /> : null}
			</button>
		</div>
	);
});

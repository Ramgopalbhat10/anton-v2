import { CircleAlert } from '@/lib/icons';
import { Btn, Icon } from '@/components/kit/signal';
import { dismissFailure, type FailedDeletion, useFailedDeletions } from '@/lib/deleting';
import { cn } from '@/lib/utils';

/** As a part that could not be drawn says so, in the same place and the same card. */
function Failure({ failure, className }: { failure: FailedDeletion; className?: string }) {
	return (
		<div role="alert" className={cn('flex items-start gap-2 rounded-control border border-(--bad-line) bg-(--bad-soft) px-3 py-2 text-small leading-[18px] text-(--bad)', className)}>
			<Icon icon={CircleAlert} size={12} className="mt-[3px]" />
			<div className="flex min-w-0 flex-1 flex-col items-start gap-2">
				<span className="break-words">
					Could not delete “{failure.title}”. {failure.error} It is back in the list.
				</span>
				<Btn size="sm" onClick={() => dismissFailure(failure.id)}>
					Dismiss
				</Btn>
			</div>
		</div>
	);
}

/** A delete shows by the task leaving its lists; only one that fails, and puts it back, needs words. `className` places them as the shell's other floating cards. */
export function DeletionFailures({ className }: { className: string }) {
	const failures = useFailedDeletions();
	if (!failures.length) return null;
	return (
		<div className={cn('flex flex-col gap-2', className)}>
			{/* The tint is see-through; over a page it needs a solid card under it. */}
			{failures.map((failure) => (
				<div key={failure.id} className="rounded-control bg-(--bg-overlay)">
					<Failure failure={failure} />
				</div>
			))}
		</div>
	);
}

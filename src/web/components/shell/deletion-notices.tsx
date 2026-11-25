import { Check, CircleAlert, X } from '@/lib/icons';
import { Icon, IconBtn, Spinner } from '@/components/kit/signal';
import { dismissDeletion, type Deletion, useDeletions } from '@/lib/deleting';

function Notice({ deletion }: { deletion: Deletion }) {
	const { title, state, error, thread } = deletion;
	return (
		<div
			role={state === 'failed' ? 'alert' : 'status'}
			className="pointer-events-auto flex w-full max-w-[360px] items-start gap-2.5 rounded-card border border-(--line) bg-(--bg-overlay) px-3 py-2 text-small leading-[18px] text-(--text-2) shadow-(--sh-2)"
		>
			<span aria-hidden className="flex h-[18px] shrink-0 items-center">
				{state === 'deleting' ? <Spinner size={12} tone="neutral" /> : state === 'deleted' ? <Icon icon={Check} size={13} className="text-(--ok)" /> : <Icon icon={CircleAlert} size={13} className="text-(--bad)" />}
			</span>
			<span className="min-w-0 flex-1 break-words">
				{state === 'deleting' ? (
					<>Deleting “{title}”…</>
				) : state === 'deleted' ? (
					<>
						Deleted “{title}”.{thread ? <span className="text-(--text-3)"> Its files are in the project Library.</span> : null}
					</>
				) : (
					<>
						<span className="text-(--text)">Could not delete “{title}”.</span> {error} <span className="text-(--text-3)">It is back in the list.</span>
					</>
				)}
			</span>
			{state === 'deleting' ? null : <IconBtn icon={X} size="xs" label="Dismiss" onClick={() => dismissDeletion(deletion.id)} className="-my-0.5 -mr-1 shrink-0" />}
		</div>
	);
}

/** What happens to the tasks and threads you delete, as a delete leaves the lists before it is done. Under the header, clear of the composers at the foot of each page. */
export function DeletionNotices() {
	const deletions = useDeletions();
	if (!deletions.length) return null;
	return (
		<div className="pointer-events-none fixed inset-x-4 top-[calc(env(safe-area-inset-top)+52px)] z-50 flex flex-col items-center gap-2">
			{deletions.map((deletion) => (
				<Notice key={deletion.id} deletion={deletion} />
			))}
		</div>
	);
}

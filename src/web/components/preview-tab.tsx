import { useQuery } from '@tanstack/react-query';
import { ArrowUpRight, Globe, Play, RotateCw } from 'lucide-react';
import { useState } from 'react';
import { useResume } from '@/components/source-bar';
import { Btn, EmptyState, Icon, IconBtn, Spinner } from '@/components/signal';
import { api, type Preview } from '@/lib/api';
import { cn } from '@/lib/utils';

function PortChip({ preview, active, onSelect }: { preview: Preview; active: boolean; onSelect: () => void }) {
	return (
		<button
			type="button"
			onClick={onSelect}
			aria-pressed={active}
			className={cn(
				'flex h-6 shrink-0 items-center gap-1.5 rounded-md px-2 text-[12px] outline-none focus-visible:shadow-(--focus-ring)',
				active ? 'bg-(--bg-overlay) text-(--text-primary)' : 'text-(--text-tertiary) hover:bg-(--bg-hover)',
			)}
		>
			<span className={cn('size-1.5 rounded-full', preview.listening ? 'bg-(--success-base)' : 'bg-(--text-disabled)')} />
			{preview.port}
		</button>
	);
}

function NotRunning({ sessionId }: { sessionId: string }) {
	const resume = useResume(sessionId);
	return (
		<EmptyState icon={Globe} title="The sandbox is not running" body="Previews come from servers running in the task's sandbox. Resume it to see them.">
			<Btn size="sm" icon={Play} disabled={resume.isPending} onClick={() => resume.mutate()}>
				{resume.isPending ? 'Starting…' : 'Resume'}
			</Btn>
		</EmptyState>
	);
}

/** The app the agent is running, through the sandbox's public URL for each preview port. */
export function PreviewTab({ sessionId }: { sessionId: string }) {
	const [chosen, setChosen] = useState<number | null>(null);
	const [reloads, setReloads] = useState(0);
	const session = useQuery({ queryKey: ['session', sessionId], queryFn: () => api.session(sessionId) });
	const starting = session.data?.status === 'starting';
	// Checking ports runs a command in the sandbox, and any command keeps it from stopping when idle.
	// So no polling: the list is checked again when the agent runs a tool (that is how servers start), or on Reload.
	const previews = useQuery({ queryKey: ['previews', sessionId], queryFn: () => api.previews(sessionId) });

	if (previews.isPending || (starting && !previews.data?.live)) {
		return (
			<div className="flex h-7 items-center gap-2 text-[12px] text-(--text-tertiary)">
				<Spinner size={12} />
				{starting ? 'Starting the sandbox' : 'Looking for running servers'}
			</div>
		);
	}
	if (previews.isError) return <EmptyState title="Preview unavailable" body={previews.error.message} />;
	if (!previews.data.live) return <NotRunning sessionId={sessionId} />;

	const list = previews.data.previews;
	const current = list.find((item) => item.port === chosen) ?? list.find((item) => item.listening) ?? list[0];
	if (!current) return <EmptyState icon={Globe} title="No preview ports" body="Add preview ports in the repository settings." />;

	return (
		<div className="flex h-full min-h-0 flex-col gap-2">
			<div className="flex h-7 shrink-0 items-center gap-1">
				<div data-noscrollbar className="flex min-w-0 flex-auto items-center gap-0.5 overflow-x-auto">
					{list.map((item) => (
						<PortChip key={item.port} preview={item} active={item.port === current.port} onSelect={() => setChosen(item.port)} />
					))}
				</div>
				<IconBtn
					icon={RotateCw}
					size="sm"
					label="Reload"
					onClick={() => {
						setReloads((count) => count + 1);
						void previews.refetch();
					}}
				/>
				{current.url ? (
					<a
						href={current.url}
						target="_blank"
						rel="noreferrer"
						aria-label="Open in a new tab"
						title="Open in a new tab"
						className="sg-btn sg-icon-btn sg-btn--ghost sg-btn--sm"
					>
						<Icon icon={ArrowUpRight} size={14} />
					</a>
				) : null}
			</div>
			{current.listening && current.url ? (
				<iframe
					key={`${current.url}#${reloads}`}
					src={current.url}
					title={`Preview of port ${current.port}`}
					className="min-h-[360px] w-full flex-1 rounded-lg border border-(--border-subtle) bg-white"
				/>
			) : (
				<EmptyState
					icon={Globe}
					title={`Nothing is serving on port ${current.port}`}
					body={
						current.url
							? 'Ask the agent to start the dev server on this port, bound to 0.0.0.0. If you start it from the terminal, press Reload.'
							: 'This port has no public URL. Sandboxes started before it was added to the repository settings do not expose it; stop and resume the task.'
					}
				/>
			)}
		</div>
	);
}

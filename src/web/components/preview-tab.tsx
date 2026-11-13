import { useQuery } from '@tanstack/react-query';
import { ArrowUpRight, Globe, Monitor, Play, RotateCw } from 'lucide-react';
import { useState } from 'react';
import { useResume } from '@/components/source-bar';
import { LinkArt, SandboxArt } from '@/components/illustrations';
import { Segmented, SegmentedItem, StatusDot } from '@/components/instrument';
import { Btn, EmptyState, Icon, IconBtn, Spinner } from '@/components/signal';
import type { Preview } from '@/lib/api';
import { taskQueries } from '@/lib/task-queries';

function PortChip({ preview, active, onSelect }: { preview: Preview; active: boolean; onSelect: () => void }) {
	return (
		<SegmentedItem role="button" size="sm" on={active} onClick={onSelect} title={preview.listening ? `Port ${preview.port} is serving` : `Nothing is serving on port ${preview.port}`} className="in-num">
			<StatusDot tone={preview.listening ? 'success' : 'off'} />:{preview.port}
		</SegmentedItem>
	);
}

function NotRunning({ sessionId }: { sessionId: string }) {
	const resume = useResume(sessionId);
	return (
		<EmptyState art={<SandboxArt className="w-full max-w-[300px]" label="stopped" />} title="The sandbox is not running" body="Previews come from servers running in the task's sandbox. Resume it to see them.">
			<Btn size="sm" icon={Play} disabled={resume.isPending} onClick={() => resume.mutate()}>
				{resume.isPending ? 'Starting…' : 'Resume'}
			</Btn>
		</EmptyState>
	);
}

/** The app the agent is running, through the sandbox's public URL for each preview port. */
export function PreviewTab({ sessionId, onWatchTest }: { sessionId: string; onWatchTest?: () => void }) {
	const [chosen, setChosen] = useState<number | null>(null);
	const [reloads, setReloads] = useState(0);
	const session = useQuery(taskQueries.session(sessionId));
	const starting = session.data?.status === 'starting';
	// Checking ports runs a command in the sandbox, and any command keeps it from stopping when idle.
	// So no polling: the list is checked again when the agent runs a tool (that is how servers start), or on Reload.
	const previews = useQuery(taskQueries.previews(sessionId));

	if (previews.isPending || (starting && !previews.data?.live)) {
		return (
			<div className="flex h-7 items-center gap-2 text-small text-(--text-tertiary)">
				<Spinner size={12} />
				{starting ? 'Starting the sandbox' : 'Looking for running servers'}
			</div>
		);
	}
	if (previews.isError) return <EmptyState title="Preview unavailable" body={previews.error.message} />;
	if (!previews.data.live) return <NotRunning sessionId={sessionId} />;

	const list = previews.data.previews;
	const current = list.find((item) => item.port === chosen) ?? list.find((item) => item.listening) ?? list[0];
	if (!current) return <EmptyState art={<LinkArt className="w-full max-w-[340px]" />} title="No preview ports" body="Add preview ports in the repository settings." />;

	return (
		<div className="flex h-full min-h-0 flex-col gap-2">
			<div className="flex h-8 shrink-0 items-center gap-1.5">
				<Segmented label="Ports" role="group" className="max-w-[60%] shrink-0 overflow-x-auto">
					{list.map((item) => (
						<PortChip key={item.port} preview={item} active={item.port === current.port} onSelect={() => setChosen(item.port)} />
					))}
				</Segmented>
				<div className="in-num flex h-7 min-w-0 flex-auto items-center gap-1.5 rounded-tile border border-(--border-subtle) bg-(--well-bg) px-2.5 text-small text-(--text-tertiary)">
					<Icon icon={Globe} size={12} className={current.listening ? 'text-(--success-text)' : 'text-(--icon-tertiary)'} />
					<span className="min-w-0 truncate">{current.url ?? `Port ${current.port} has no public URL`}</span>
				</div>
				{onWatchTest ? <IconBtn icon={Monitor} size="sm" label="Watch the agent's test in Computer" onClick={onWatchTest} /> : null}
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
					className="in-well min-h-[360px] w-full flex-1 bg-white"
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

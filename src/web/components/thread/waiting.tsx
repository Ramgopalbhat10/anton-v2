import { useQuery } from '@tanstack/react-query';
import { memo, useContext, useEffect, useState } from 'react';
import { useStopRun, useSubagentRuns } from '@/components/thread/subagents';
import { lookOf } from '@/lib/subagents';
import { Btn, Spinner } from '@/components/kit/signal';
import { elapsed } from '@/lib/format';
import { nowText, type ReplyPhase } from '@/lib/now-text';
import { taskQueries } from '@/lib/task-queries';
import { type Block } from '@/components/thread/blocks';
import { SessionId } from '@/components/thread/session-context';

function useSince(since: string | null): number {
	const [clock, setClock] = useState(() => Date.now());
	useEffect(() => {
		if (!since) return;
		setClock(Date.now());
		const timer = setInterval(() => setClock(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [since]);
	return since ? Math.max(0, clock - new Date(since).getTime()) : 0;
}

function useNow(sessionId: string) {
	const now = useQuery(taskQueries.now(sessionId)).data?.now ?? null;
	return { now, took: useSince(now?.since ?? null) };
}

/** Its own component, so the clock ticking re-renders it and not the card. */
export function NowLabel() {
	const { now, took } = useNow(useContext(SessionId));
	return (
		<div className="flex min-w-0 flex-auto items-center gap-2 text-body">
			<span className="in-shimmer min-w-0 truncate">{nowText(now, 'replying')}</span>
			{now && took >= 1000 ? (
				<span className="in-num shrink-0 text-(--text-4)" aria-hidden>
					{elapsed(took)}
				</span>
			) : null}
		</div>
	);
}

/** The thread shows a step only once it is whole, so without this a file being written or a long think reads as nothing happening. */
function NowLine({ sessionId, phase, quiet }: { sessionId: string; phase: ReplyPhase; quiet: boolean }) {
	const heard = useNow(sessionId);
	const reviewing = heard.now?.by === 'reviewer';
	// Text is written only into a reply still being written; once the reply is whole, the agent is wrapping up whatever was last heard.
	const { now, took } = !reviewing && heard.now?.what === 'replying' && phase !== 'replying' ? { now: null, took: 0 } : heard;
	if (quiet && !reviewing && now?.what === 'replying') return null;
	return (
		<div className="flex min-w-0 items-center gap-2 text-body text-(--text-2)">
			<Spinner size={13} />
			<span className="min-w-0 truncate">{nowText(now, phase)}</span>
			{now && took >= 1000 ? (
				<span className="in-num shrink-0 text-(--text-4)" aria-hidden>
					{elapsed(took)}
				</span>
			) : null}
		</div>
	);
}

/** While a subagent runs, a waiting message is read only when it finishes, so this says so and lets you stop it. Otherwise it says what the agent or the Reviewer is doing, unless the steps card or streaming text already does. */
export const Waiting = memo(function Waiting({ sessionId, queued, phase, tail }: { sessionId: string; queued: boolean; phase: ReplyPhase; tail: Block['kind'] | null }) {
	const running = (useSubagentRuns(sessionId).data?.runs ?? []).filter((run) => run.status === 'running');
	const stop = useStopRun(sessionId);
	// The Reviewer starts after the reply has ended, so no steps card or streaming text of the reply says what it does.
	const now = useQuery(taskQueries.now(sessionId)).data?.now;
	const reviewing = now?.by === 'reviewer';
	// A stopping reply reads nothing more, so it no longer offers to stop its subagents.
	if (!queued || !running.length || now?.what === 'stopping') return tail === 'steps' && !reviewing ? null : <NowLine sessionId={sessionId} phase={phase} quiet={tail === 'text'} />;
	const names = [...new Set(running.map((run) => lookOf(run.agent).label.toLowerCase()))];
	const who = running.length === 1 ? `the ${names[0]} agent` : `${running.length} agents`;
	return (
		<div role="status" className="in-callout flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2 text-body leading-[19px] text-(--text-2)">
			<Spinner size={13} />
			<span className="min-w-0 flex-1">
				Anton reads your message when {who} {running.length === 1 ? 'finishes' : 'finish'}. Stop {running.length === 1 ? 'it' : 'them'} to have it read now.
			</span>
			<Btn
				size="sm"
				disabled={stop.isPending}
				onClick={() => {
					for (const run of running) stop.mutate(run.id);
				}}
			>
				{running.length === 1 ? `Stop ${names[0]} agent` : 'Stop agents'}
			</Btn>
		</div>
	);
});

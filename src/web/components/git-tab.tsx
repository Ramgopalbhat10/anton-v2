import { useQuery } from '@tanstack/react-query';
import { PatchDiff } from '@pierre/diffs/react';
import { useState } from 'react';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

const views = ['Diff', 'Review', 'Commits'] as const;

export function GitTab({ sessionId }: { sessionId: string }) {
	const [view, setView] = useState<(typeof views)[number]>('Diff');
	const git = useQuery({
		queryKey: ['git', sessionId],
		queryFn: () => api.git(sessionId),
		refetchInterval: 4000,
	});

	if (git.isError) {
		return <div className="p-4 text-[13px] text-destructive">VM unavailable. Start or retry the session.</div>;
	}
	if (!git.data) {
		return <div className="p-4 text-[13px] text-muted-foreground">Starting VM…</div>;
	}

	const { repo, branch, upstream, patch, log } = git.data;
	const base = upstream ?? 'main';

	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="flex h-10 shrink-0 items-center justify-between gap-3 border-b border-border px-3">
				<div className="truncate text-[13px] font-medium">{repo}</div>
				<div className="shrink-0 font-mono text-[11px] text-muted-foreground">
					{base} → {branch}
				</div>
			</div>
			<div className="flex h-10 shrink-0 items-center border-b border-border px-2">
				<div className="flex h-7 items-center gap-0.5 rounded-lg bg-muted p-0.5" role="tablist" aria-label="Git">
					{views.map((name) => (
						<button
							key={name}
							type="button"
							role="tab"
							aria-selected={view === name}
							onClick={() => setView(name)}
							className={cn(
								'flex h-6 items-center rounded-md px-2.5 text-[12px]',
								view === name
									? 'bg-background text-foreground shadow-sm'
									: 'text-muted-foreground hover:text-foreground',
							)}
						>
							{name}
						</button>
					))}
				</div>
			</div>
			<div className="min-h-0 flex-1 overflow-auto">
				{view === 'Commits' ? (
					log.length === 0 ? (
						<div className="flex h-full items-center justify-center text-[13px] text-muted-foreground">No commits yet</div>
					) : (
						<ul>
							{log.map((entry) => (
								<li key={entry.sha} className="flex h-10 items-center gap-3 border-b border-border px-3">
									<span className="shrink-0 font-mono text-[11px] text-muted-foreground">{entry.sha.slice(0, 7)}</span>
									<span className="truncate text-[13px]">{entry.subject}</span>
								</li>
							))}
						</ul>
					)
				) : patch.trim() ? (
					<PatchDiff patch={patch} />
				) : (
					<div className="flex h-full items-center justify-center px-6 text-center text-[13px] text-muted-foreground">
						{view === 'Review' ? 'Nothing to review' : 'No pushed changes'}
					</div>
				)}
			</div>
			<div className="flex h-8 shrink-0 items-center border-t border-border px-3 font-mono text-[11px] text-muted-foreground">
				{log[0] ? `${log[0].sha.slice(0, 7)}  ${log[0].subject}` : 'No commits yet'}
			</div>
		</div>
	);
}

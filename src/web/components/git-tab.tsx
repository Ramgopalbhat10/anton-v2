import { useQuery } from '@tanstack/react-query';
import { PatchDiff } from '@pierre/diffs/react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { api } from '@/lib/api';

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
				<ToggleGroup
					type="single"
					size="sm"
					spacing={1}
					value={view}
					onValueChange={(next) => {
						if (next) setView(next as (typeof views)[number]);
					}}
				>
					{views.map((name) => (
						<ToggleGroupItem key={name} value={name}>
							{name}
						</ToggleGroupItem>
					))}
				</ToggleGroup>
			</div>
			<ScrollArea className="min-h-0 flex-1">
				{view === 'Commits' ? (
					log.length === 0 ? (
						<Empty className="border-0">
							<EmptyHeader>
								<EmptyTitle>No commits yet</EmptyTitle>
							</EmptyHeader>
						</Empty>
					) : (
						<ul>
							{log.map((entry) => (
								<li key={entry.sha} className="flex h-9 items-center gap-3 rounded-lg px-3 hover:bg-muted">
									<Badge variant="secondary">{entry.sha.slice(0, 7)}</Badge>
									<span className="truncate text-[13px]">{entry.subject}</span>
								</li>
							))}
						</ul>
					)
				) : patch.trim() ? (
					<PatchDiff patch={patch} />
				) : (
					<Empty className="border-0">
						<EmptyHeader>
							<EmptyTitle>{view === 'Review' ? 'Nothing to review' : 'No pushed changes'}</EmptyTitle>
							<EmptyDescription>Changes in the sandbox show up here.</EmptyDescription>
						</EmptyHeader>
					</Empty>
				)}
			</ScrollArea>
			<Separator />
			<div className="flex h-8 shrink-0 items-center px-3 text-[11px] text-muted-foreground">
				{log[0] ? `${log[0].sha.slice(0, 7)}  ${log[0].subject}` : 'No commits yet'}
			</div>
		</div>
	);
}

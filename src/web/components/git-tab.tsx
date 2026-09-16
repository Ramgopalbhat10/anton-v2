import { useQuery } from '@tanstack/react-query';
import { PatchDiff } from '@pierre/diffs/react';
import { api } from '@/lib/api';

export function GitTab({ sessionId }: { sessionId: string }) {
	const git = useQuery({
		queryKey: ['git', sessionId],
		queryFn: () => api.git(sessionId),
		refetchInterval: 4000,
	});

	if (git.isError) {
		return <div className="p-4 text-sm text-destructive">VM unavailable. Start or retry the session.</div>;
	}
	if (!git.data) {
		return <div className="p-4 text-sm text-muted-foreground">Starting VM…</div>;
	}

	const { repo, branch, upstream, patch, log } = git.data;

	return (
		<div className="flex h-full flex-col">
			<div className="flex items-center justify-between border-b border-border px-3 py-2 text-sm">
				<div>
					<div className="font-medium">{repo}</div>
					<div className="text-xs text-muted-foreground">
						Branch {upstream ?? 'main'} → {branch}
					</div>
				</div>
			</div>
			<div className="flex gap-2 border-b border-border px-3 py-2 text-xs">
				<span className="rounded-md bg-accent px-2 py-1">Diff</span>
				<span className="px-2 py-1 text-muted-foreground">Review</span>
				<span className="px-2 py-1 text-muted-foreground">Commits</span>
			</div>
			<div className="min-h-0 flex-1 overflow-auto">
				{patch.trim() ? (
					<PatchDiff patch={patch} />
				) : (
					<div className="flex h-full items-center justify-center text-sm text-muted-foreground">No pushed changes</div>
				)}
			</div>
			<div className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
				{log[0] ? `Latest ${log[0].sha.slice(0, 7)} · ${log[0].subject}` : 'No commits yet'}
			</div>
		</div>
	);
}

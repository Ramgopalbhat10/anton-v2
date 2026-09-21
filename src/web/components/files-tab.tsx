import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

function dirname(path: string): string {
	const i = path.lastIndexOf('/');
	return i === -1 ? '' : path.slice(0, i);
}

function basename(path: string): string {
	const i = path.lastIndexOf('/');
	return i === -1 ? path : path.slice(i + 1);
}

export function FilesTab({ sessionId }: { sessionId: string }) {
	const [selected, setSelected] = useState<string | null>(null);
	const listing = useQuery({
		queryKey: ['files', sessionId],
		queryFn: () => api.files(sessionId),
		refetchInterval: 4000,
	});
	const file = useQuery({
		queryKey: ['file', sessionId, selected],
		queryFn: () => api.file(sessionId, selected!),
		enabled: Boolean(selected),
	});

	const folders = useMemo(() => {
		const paths = listing.data?.paths ?? [];
		const groups = new Map<string, string[]>();
		for (const path of paths) {
			const dir = dirname(path) || '/';
			const list = groups.get(dir) ?? [];
			list.push(path);
			groups.set(dir, list);
		}
		return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
	}, [listing.data?.paths]);

	return (
		<div className="grid h-full min-h-0 grid-cols-[200px_minmax(0,1fr)]">
			<ScrollArea className="min-h-0 border-r border-border">
				<div className="flex flex-col gap-2 py-2">
					{listing.isError ? (
						<p className="px-3 py-2 text-[13px] text-destructive">VM unavailable</p>
					) : listing.isPending ? (
						<div className="flex flex-col gap-1 px-2">
							<Skeleton className="h-7" />
							<Skeleton className="h-7" />
						</div>
					) : folders.length === 0 ? (
						<Empty className="border-0">
							<EmptyHeader>
								<EmptyTitle>Workspace is empty</EmptyTitle>
							</EmptyHeader>
						</Empty>
					) : (
						folders.map(([dir, paths]) => (
							<div key={dir} className="flex flex-col gap-0.5">
								<div className="flex h-6 items-center px-3 text-[11px] text-muted-foreground">
									{dir === '/' ? 'workspace' : dir}
								</div>
								{paths.map((path) => (
									<Button
										key={path}
										type="button"
										variant={selected === path ? 'secondary' : 'ghost'}
										size="sm"
										className={cn('mx-1 justify-start')}
										onClick={() => setSelected(path)}
									>
										<span className="truncate">{basename(path)}</span>
									</Button>
								))}
							</div>
						))
					)}
				</div>
			</ScrollArea>
			<div className="flex min-h-0 min-w-0 flex-col">
				{file.isError ? (
					<p className="p-4 text-[13px] text-destructive">Could not read file.</p>
				) : selected && file.isPending ? (
					<div className="flex flex-col gap-2 p-4">
						<Skeleton className="h-4 w-40" />
						<Skeleton className="h-24" />
					</div>
				) : selected && file.data ? (
					<>
						<div className="flex h-8 shrink-0 items-center border-b border-border px-3 font-mono text-[11px] text-muted-foreground">
							{selected}
						</div>
						<pre className="min-h-0 flex-1 overflow-auto p-4 font-mono text-[12px] leading-5">{file.data.contents}</pre>
					</>
				) : (
					<Empty className="h-full border-0">
						<EmptyHeader>
							<EmptyTitle>No file open</EmptyTitle>
							<EmptyDescription>Select a file from the tree.</EmptyDescription>
						</EmptyHeader>
					</Empty>
				)}
			</div>
		</div>
	);
}

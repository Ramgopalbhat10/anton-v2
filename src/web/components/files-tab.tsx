import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
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
		<div className="grid h-full min-h-0 grid-cols-[220px_1fr]">
			<div className="overflow-auto border-r border-border py-2">
				{listing.isError ? (
					<p className="p-3 text-sm text-destructive">VM unavailable</p>
				) : listing.isPending ? (
					<p className="p-3 text-sm text-muted-foreground">Reading workspace…</p>
				) : folders.length === 0 ? (
					<p className="p-3 text-sm text-muted-foreground">Workspace is empty.</p>
				) : (
					folders.map(([dir, paths]) => (
						<div key={dir} className="mb-2">
							<div className="px-3 py-1 text-xs text-muted-foreground">{dir === '/' ? 'workspace' : dir}</div>
							{paths.map((path) => (
								<button
									key={path}
									type="button"
									onClick={() => setSelected(path)}
									className={cn(
										'block w-full truncate px-3 py-1 text-left text-sm hover:bg-accent',
										selected === path && 'bg-accent',
									)}
								>
									{basename(path)}
								</button>
							))}
						</div>
					))
				)}
			</div>
			<div className="min-h-0 min-w-0 overflow-auto">
				{file.isError ? (
					<p className="p-4 text-sm text-destructive">Could not read file.</p>
				) : selected && file.isPending ? (
					<p className="p-4 text-sm text-muted-foreground">Opening {selected}…</p>
				) : selected && file.data ? (
					<div className="flex h-full min-h-0 flex-col">
						<div className="border-b border-border px-3 py-2 font-mono text-xs text-muted-foreground">{selected}</div>
						<pre className="min-h-0 flex-1 overflow-auto p-4 font-mono text-xs leading-5">{file.data.contents}</pre>
					</div>
				) : (
					<p className="p-4 text-sm text-muted-foreground">Select a file from the tree.</p>
				)}
			</div>
		</div>
	);
}

import { File } from '@pierre/diffs/react';
import { FileTree, useFileTree } from '@pierre/trees/react';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';

export function FilesTab({ sessionId }: { sessionId: string }) {
	const [selected, setSelected] = useState<string | null>(null);
	const listing = useQuery({
		queryKey: ['files', sessionId],
		queryFn: () => api.files(sessionId),
		refetchInterval: 5000,
	});
	const file = useQuery({
		queryKey: ['file', sessionId, selected],
		queryFn: () => api.file(sessionId, selected!),
		enabled: Boolean(selected),
	});

	const paths = listing.data?.paths ?? [];
	const tree = useFileTree({
		paths,
		onSelectionChange: (next) => {
			const first = next[0];
			if (first) setSelected(first);
		},
	});

	const contents = file.data?.contents ?? '';
	const fileName = selected ?? 'README.md';

	return (
		<div className="grid h-full grid-cols-[220px_1fr]">
			<div className="overflow-auto border-r border-border">
				{listing.isError ? (
					<p className="p-3 text-sm text-destructive">VM unavailable</p>
				) : (
					<FileTree model={tree.model} className="h-full" />
				)}
			</div>
			<div className="min-w-0 overflow-auto">
				{selected && contents ? (
					<File file={{ name: fileName, contents }} />
				) : (
					<p className="p-4 text-sm text-muted-foreground">Select a file from the tree.</p>
				)}
			</div>
		</div>
	);
}

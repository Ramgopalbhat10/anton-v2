import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { api } from '@/lib/api';

export function RepoPicker({
	open,
	onOpenChange,
	onPicked,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onPicked: (projectId: string) => void;
}) {
	const [query, setQuery] = useState('');
	const queryClient = useQueryClient();
	const repos = useQuery({
		queryKey: ['github-repos'],
		queryFn: api.repos,
		enabled: open,
	});
	const connect = useMutation({
		mutationFn: (fullName: string) => api.createProject(fullName),
		onSuccess: (project) => {
			localStorage.setItem('anton.projectId', project.id);
			void queryClient.invalidateQueries({ queryKey: ['sessions'] });
			onPicked(project.id);
			onOpenChange(false);
		},
	});
	const filtered = useMemo(() => {
		const items = repos.data?.repos ?? [];
		const needle = query.trim().toLowerCase();
		if (!needle) return items;
		return items.filter((repo) => repo.fullName.toLowerCase().includes(needle));
	}, [query, repos.data?.repos]);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Choose a repository</DialogTitle>
					<DialogDescription>Anton clones it into the workspace and opens pull requests there.</DialogDescription>
				</DialogHeader>
				<div className="px-4 py-3">
					<Input
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						placeholder="Filter repositories"
						aria-label="Filter repositories"
					/>
				</div>
				<ScrollArea className="h-72 border-t border-border">
					{repos.isPending ? <p className="px-4 py-3 text-[13px] text-muted-foreground">Loading repositories…</p> : null}
					{repos.isError ? (
						<p className="px-4 py-3 text-[13px] text-destructive">
							Could not load repositories. Reconnect GitHub if this account needs access again.
						</p>
					) : null}
					{repos.data && filtered.length === 0 ? (
						<p className="px-4 py-3 text-[13px] text-muted-foreground">No repositories with push access.</p>
					) : null}
					<ul>
						{filtered.map((repo) => (
							<li key={repo.fullName}>
								<Button
									variant="ghost"
									className="h-9 w-full justify-start rounded-none px-4"
									disabled={connect.isPending}
									onClick={() => connect.mutate(repo.fullName)}
								>
									<span className="truncate">{repo.fullName}</span>
								</Button>
							</li>
						))}
					</ul>
				</ScrollArea>
				{connect.isError ? <p className="px-4 py-3 text-[12px] text-destructive">Could not clone that repository.</p> : null}
			</DialogContent>
		</Dialog>
	);
}

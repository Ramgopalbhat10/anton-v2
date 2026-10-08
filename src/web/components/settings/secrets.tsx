import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ChevronRight, Folder, KeyRound } from 'lucide-react';
import { useState } from 'react';
import { storedVariables, toEnv, VariablesEditor } from '@/components/repo-settings';
import { Status } from '@/components/instrument';
import { Btn, Icon, Spinner } from '@/components/signal';
import { api, type SecretsView } from '@/lib/api';
import { Block, List, PageHeading, RowIcon, SaveState } from './parts';

function Shared({ view }: { view: SecretsView }) {
	const queryClient = useQueryClient();
	const [rows, setRows] = useState(() => storedVariables(view.shared));
	const save = useMutation({
		mutationFn: async () => api.saveSharedEnv(toEnv(rows)),
		onSuccess: (saved) => {
			setRows(storedVariables(saved.shared));
			queryClient.setQueryData(['secrets'], saved);
		},
	});
	const count = view.shared.length;
	return (
		<form
			onSubmit={(event) => {
				event.preventDefault();
				save.mutate();
			}}
		>
			<Block
				title="For every repository"
				icon={KeyRound}
				aside={<Status>{count === 1 ? '1 variable' : `${count} variables`}</Status>}
				help="Set in every sandbox, for the agent's commands, setup and the terminal. A repository's own variable of the same name wins."
				footer={
					<>
						<SaveState pending={save.isPending} success={save.isSuccess} error={save.error} saved="Saved. Sandboxes get them from their next start." />
						<Btn type="submit" size="sm" variant="primary" disabled={save.isPending}>
							{save.isPending ? 'Saving…' : 'Save changes'}
						</Btn>
					</>
				}
			>
				<VariablesEditor rows={rows} onChange={setRows} />
			</Block>
		</form>
	);
}

function RepoRow({ repo }: { repo: SecretsView['repos'][number] }) {
	return (
		<Link
			to="/settings/repos/$projectId"
			params={{ projectId: repo.projectId }}
			className="flex min-h-12 items-center gap-3 rounded-lg px-2.5 py-1.5 outline-none hover:bg-(--bg-hover) focus-visible:shadow-(--focus-ring)"
		>
			<RowIcon icon={Folder} />
			<div className="flex min-w-0 flex-1 flex-col gap-0.5">
				<div className="truncate text-[13px] font-medium">{repo.repo}</div>
				<div className="truncate font-mono text-[11px] text-(--text-tertiary)">{repo.names.join(' · ')}</div>
			</div>
			<Icon icon={ChevronRight} size={12} className="text-(--icon-disabled)" />
		</Link>
	);
}

export function SecretsPage() {
	const view = useQuery({ queryKey: ['secrets'], queryFn: api.secrets });
	const repos = view.data?.repos ?? [];
	return (
		<>
			<PageHeading title="Secrets">
				Environment variables for sandboxes, such as API keys for tests. Values are stored by Anton and never shown again; Git credentials are not
				needed here.
			</PageHeading>
			{view.data ? (
				<>
					<Shared view={view.data} />
					<Block title="Set by a repository" icon={Folder} help="Each repository's own variables, edited in its settings.">
						{repos.length ? (
							<List>
								{repos.map((repo) => (
									<RepoRow key={repo.projectId} repo={repo} />
								))}
							</List>
						) : (
							<p className="m-0 rounded-[10px] border border-dashed border-(--border-default) px-3 py-2.5 text-[12px] text-(--text-disabled)">No repository has variables of its own.</p>
						)}
					</Block>
				</>
			) : (
				<Spinner size={12} />
			)}
		</>
	);
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, SquareTerminal, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Status } from '@/components/instrument';
import { Btn, EmptyLine, IconBtn, Spinner } from '@/components/signal';
import { api, type Command } from '@/lib/api';
import { Block, FIELD, PageHeading, SaveState } from './parts';

function Commands({ saved }: { saved: Command[] }) {
	const queryClient = useQueryClient();
	const [rows, setRows] = useState(saved);
	const save = useMutation({
		mutationFn: () => api.saveCommands(rows.filter((row) => row.name.trim() || row.prompt.trim())),
		onSuccess: (result) => {
			setRows(result.commands);
			queryClient.setQueryData(['commands'], result);
		},
	});
	const dirty = JSON.stringify(rows) !== JSON.stringify(saved);
	const change = (index: number, patch: Partial<Command>) => setRows((current) => current.map((row, at) => (at === index ? { ...row, ...patch } : row)));
	return (
		<form
			onSubmit={(event) => {
				event.preventDefault();
				save.mutate();
			}}
		>
			<Block
				title="Saved prompts"
				icon={SquareTerminal}
				aside={<Status>{saved.length === 1 ? '1 command' : `${saved.length} commands`}</Status>}
				footer={
					<>
						<Btn size="sm" variant="ghost" icon={Plus} onClick={() => setRows((current) => [...current, { name: '', prompt: '' }])} className="mr-auto">
							Add a command
						</Btn>
						<SaveState pending={save.isPending} success={save.isSuccess} error={save.error} />
						{dirty || save.isPending ? (
							<Btn type="submit" size="sm" variant="primary" disabled={save.isPending}>
								{save.isPending ? 'Saving…' : 'Save commands'}
							</Btn>
						) : null}
					</>
				}
			>
				{rows.length === 0 ? (
					<EmptyLine className="px-0 py-1">No commands yet. Add one, then type / and its name in any message.</EmptyLine>
				) : null}
				{rows.map((row, index) => (
					<div key={index} className="flex items-start gap-2">
						<input
							value={row.name}
							onChange={(event) => change(index, { name: event.target.value })}
							placeholder="review"
							aria-label="Command name"
							className={`${FIELD} w-[120px] shrink-0 font-mono`}
						/>
						<textarea
							value={row.prompt}
							onChange={(event) => change(index, { prompt: event.target.value })}
							rows={2}
							placeholder="Review the changes on this branch for bugs and missing tests."
							aria-label="Prompt"
							className="min-w-0 flex-1 resize-y rounded-card border border-(--line) bg-(--bg-raised) px-2.5 py-1.5 text-body leading-[19px] text-(--text) outline-none placeholder:text-(--text-4) focus-visible:shadow-(--focus)"
						/>
						<IconBtn icon={Trash2} size="sm" label="Remove command" onClick={() => setRows((current) => current.filter((_, at) => at !== index))} />
					</div>
				))}
			</Block>
		</form>
	);
}

export function CommandsPage() {
	const commands = useQuery({ queryKey: ['commands'], queryFn: api.commands });
	return (
		<>
			<PageHeading
				title="Commands"
				info={
					<>
						Put <code>$ARGUMENTS</code> in a prompt to fill in what you type after the name, as in <code>/fix 142</code>. Type <code>@</code> in a task's
						message to point the agent at a file.
					</>
				}
			>
				Prompts you reuse: type <code>/</code> and the name to fill one in.
			</PageHeading>
			{commands.data ? <Commands saved={commands.data.commands} /> : <Spinner size={12} />}
		</>
	);
}

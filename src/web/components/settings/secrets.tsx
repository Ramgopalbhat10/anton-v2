import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ChevronRight, Folder, KeyRound, LockKeyhole, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { storedVariables, toEnv, VariablesEditor } from '@/components/repo-settings';
import { Status } from '@/components/instrument';
import { Btn, Icon, IconBtn, Spinner } from '@/components/signal';
import { api, type SealedSecret, type SecretsView } from '@/lib/api';
import { age } from '@/lib/format';
import { Block, FIELD, List, PageHeading, RowIcon, SaveState } from './parts';

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
	// The save button only shows once something here differs from what is stored.
	const dirty = JSON.stringify(rows) !== JSON.stringify(storedVariables(view.shared));
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
				help="Set in every sandbox."
				info="For the agent's commands, setup and the terminal. A repository's own variable of the same name wins."
				footer={
					dirty || save.isPending || save.isSuccess || save.isError ? (
						<>
							<SaveState pending={save.isPending} success={save.isSuccess} error={save.error} saved="Saved. Sandboxes get them from their next start." />
							{dirty ? (
								<Btn type="submit" size="sm" variant="primary" disabled={save.isPending}>
									{save.isPending ? 'Saving…' : 'Save changes'}
								</Btn>
							) : null}
						</>
					) : null
				}
			>
				<VariablesEditor rows={rows} onChange={setRows} />
			</Block>
		</form>
	);
}

const splitHosts = (text: string) => text.split(/[\s,]+/).filter(Boolean);

/** Adds a sealed secret, or changes one: a value or proxy left empty keeps what is stored. */
function SealedForm({ editing, onDone }: { editing: SealedSecret | null; onDone: () => void }) {
	const queryClient = useQueryClient();
	const [name, setName] = useState(editing?.name ?? '');
	const [value, setValue] = useState('');
	const [hosts, setHosts] = useState(editing?.hosts.join(', ') ?? '');
	const [proxy, setProxy] = useState('');
	const [proxyRemoved, setProxyRemoved] = useState(false);
	const [readsDirect, setReadsDirect] = useState(editing?.readsDirect ?? false);
	const hasProxy = Boolean(proxy.trim() || (editing?.proxy && !proxyRemoved));
	const save = useMutation({
		mutationFn: () =>
			api.saveSealedSecret(name.trim(), {
				value: value || null,
				hosts: splitHosts(hosts),
				proxy: proxy.trim() ? proxy.trim() : proxyRemoved ? '' : null,
				readsDirect: hasProxy && readsDirect,
			}),
		onSuccess: (saved) => {
			queryClient.setQueryData(['sealed-secrets'], saved);
			onDone();
		},
	});
	const label = 'text-small font-medium text-(--text-secondary)';
	return (
		<form
			className="flex flex-col gap-3 rounded-control border border-(--border-subtle) p-3"
			aria-label={editing ? `Change ${editing.name}` : 'Add a sealed secret'}
			onSubmit={(event) => {
				event.preventDefault();
				save.mutate();
			}}
		>
			<div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-x-4 gap-y-3">
				<label className="flex min-w-0 flex-col gap-1">
					<span className={label}>Name</span>
					<input value={name} disabled={Boolean(editing)} onChange={(event) => setName(event.target.value.toUpperCase())} placeholder="BROKER_API_KEY" spellCheck={false} className={`${FIELD} font-mono`} />
				</label>
				<label className="flex min-w-0 flex-col gap-1">
					<span className={label}>Value</span>
					<input type="password" autoComplete="off" value={value} onChange={(event) => setValue(event.target.value)} placeholder={editing ? 'Saved; type to replace' : 'Never shown again'} className={`${FIELD} font-mono`} />
				</label>
				<label className="flex min-w-0 flex-col gap-1">
					<span className={label}>Hosts it may be sent to</span>
					<input value={hosts} onChange={(event) => setHosts(event.target.value)} placeholder="api.example.com, *.example.com" spellCheck={false} className={`${FIELD} font-mono`} />
				</label>
				<div className="flex min-w-0 flex-col gap-1">
					<label htmlFor="sealed-proxy" className={label}>
						Proxy (optional)
					</label>
					<span className="flex min-w-0 items-center gap-2">
						<input
							id="sealed-proxy"
							type="password"
							autoComplete="off"
							value={proxy}
							onChange={(event) => setProxy(event.target.value)}
							placeholder={editing?.proxy && !proxyRemoved ? `${editing.proxy}; type to replace` : 'https://user:password@1-2-3-4.sslip.io'}
							className={`${FIELD} min-w-0 flex-1 font-mono`}
						/>
						{editing?.proxy && !proxyRemoved && !proxy ? (
							<Btn type="button" size="sm" variant="ghost" aria-label="Remove the proxy" onClick={() => setProxyRemoved(true)}>
								Remove
							</Btn>
						) : null}
					</span>
				</div>
			</div>
			{hasProxy ? (
				<label className="flex items-start gap-2 text-small text-(--text-secondary)">
					<input type="checkbox" checked={readsDirect} onChange={(event) => setReadsDirect(event.target.checked)} className="mt-0.5" />
					<span>
						Only send changes through the proxy. Reads (GET) go straight out, which is faster. Turn this on when the API asks for the fixed IP only on orders and other changes.
					</span>
				</label>
			) : null}
			<div className="flex flex-wrap items-center justify-end gap-2">
				<SaveState pending={save.isPending} success={false} error={save.error} />
				<Btn type="button" size="sm" variant="ghost" onClick={onDone}>
					Cancel
				</Btn>
				<Btn type="submit" size="sm" variant="primary" disabled={save.isPending || !name.trim() || !hosts.trim() || (!editing && !value)}>
					{save.isPending ? 'Saving…' : editing ? 'Save changes' : 'Add secret'}
				</Btn>
			</div>
		</form>
	);
}

function SealedRow({ secret, onEdit }: { secret: SealedSecret; onEdit: () => void }) {
	const queryClient = useQueryClient();
	const remove = useMutation({ mutationFn: () => api.deleteSealedSecret(secret.name), onSuccess: (saved) => queryClient.setQueryData(['sealed-secrets'], saved) });
	const from = secret.source.by === 'task' ? 'Kept by a task from an answer' : 'Set by you';
	return (
		<div className="flex min-h-12 items-center gap-3 rounded-tile px-2.5 py-1.5">
			<RowIcon icon={LockKeyhole} />
			<div className="flex min-w-0 flex-1 flex-col gap-0.5">
				<div className="truncate text-body font-medium">{secret.name}</div>
				<div className="truncate text-micro text-(--text-tertiary)">
					To {secret.hosts.join(', ')}
					{secret.proxy ? ` · ${secret.readsDirect ? 'changes ' : ''}through ${secret.proxy}` : ''} · {from} {age(secret.updatedAt)}
				</div>
			</div>
			{secret.source.by === 'you' ? <IconBtn icon={Pencil} size="sm" label={`Change ${secret.name}`} onClick={onEdit} /> : null}
			<IconBtn icon={Trash2} size="sm" label={`Delete ${secret.name}`} disabled={remove.isPending} onClick={() => remove.mutate()} />
		</div>
	);
}

/**
 * Secrets the agent can use but never read: it names one in http_request and Anton fills it in on this server,
 * only for the hosts it allows. None reaches a sandbox, a shell or the model (src/services/sealed-secrets.ts).
 */
function Sealed() {
	const view = useQuery({ queryKey: ['sealed-secrets'], queryFn: api.sealedSecrets });
	const [editing, setEditing] = useState<SealedSecret | 'new' | null>(null);
	const secrets = view.data?.secrets ?? [];
	return (
		<Block
			title="Sealed"
			icon={LockKeyhole}
			aside={<Status>{secrets.length === 1 ? '1 secret' : `${secrets.length} secrets`}</Status>}
			help="Used by the agent, never read by it."
			info="The agent writes {{secret:NAME}} (or {{totp:NAME}} for the current code of a TOTP secret) in an http_request, and Anton fills it in on this server as it sends it: only to the hosts you list, over https, through the proxy if you give one, with the value hidden in the answer. A token an answer holds can be kept here the same way. Values are stored encrypted."
		>
			<div className="flex flex-col gap-2">
				{editing ? <SealedForm key={editing === 'new' ? 'new' : editing.name} editing={editing === 'new' ? null : editing} onDone={() => setEditing(null)} /> : null}
				{secrets.length ? (
					<List>
						{secrets.map((secret) => (
							<SealedRow key={secret.name} secret={secret} onEdit={() => setEditing(secret)} />
						))}
					</List>
				) : null}
				{editing ? null : (
					<Btn type="button" size="sm" variant="ghost" icon={Plus} className="self-start" onClick={() => setEditing('new')}>
						Add a sealed secret
					</Btn>
				)}
			</div>
		</Block>
	);
}

function RepoRow({ repo }: { repo: SecretsView['repos'][number] }) {
	return (
		<Link
			to="/settings/repos/$projectId"
			params={{ projectId: repo.projectId }}
			className="flex min-h-12 items-center gap-3 rounded-tile px-2.5 py-1.5 outline-none hover:bg-(--bg-hover) focus-visible:shadow-(--focus-ring)"
		>
			<RowIcon icon={Folder} />
			<div className="flex min-w-0 flex-1 flex-col gap-0.5">
				<div className="truncate text-body font-medium">{repo.repo}</div>
				<div className="truncate text-micro text-(--text-tertiary)">{repo.names.join(' · ')}</div>
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
			<PageHeading title="Secrets" info="Values are stored by Anton and never shown again. Git credentials are not needed here.">
				Environment variables for sandboxes, such as API keys for tests.
			</PageHeading>
			{view.data ? (
				<>
					<Shared view={view.data} />
					<Sealed />
					<Block title="Set by a repository" icon={Folder} help="Edited in each repository's settings.">
						{repos.length ? (
							<List>
								{repos.map((repo) => (
									<RepoRow key={repo.projectId} repo={repo} />
								))}
							</List>
						) : (
							<p className="m-0 py-1 text-small text-(--text-tertiary)">No repository has variables of its own.</p>
						)}
					</Block>
				</>
			) : (
				<Spinner size={12} />
			)}
		</>
	);
}

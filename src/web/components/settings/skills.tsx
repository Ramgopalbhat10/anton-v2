import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Blocks, Download, Plus, Store, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { Badge, Btn, Icon, IconBtn, Spinner, Switch } from '@/components/signal';
import { api, type CatalogItem, type Plugin } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Block, FIELD, List, PageHeading } from './parts';

/** Catalog rows shown at once; searching narrows them. */
const SHOWN = 40;

const where = (plugin: Plugin) => [plugin.source.repo, plugin.source.path].filter(Boolean).join('/');

function usePlugins() {
	return useQuery({ queryKey: ['plugins'], queryFn: api.plugins });
}

/** Mutations that answer with the new plugin list put it straight into the cache. */
function usePluginMutation<T>(run: (input: T) => Promise<{ plugins: Plugin[] }>) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: run,
		onSuccess: (result) => {
			queryClient.setQueryData<{ plugins: Plugin[]; marketplaces: string[] }>(['plugins'], (current) => current && { ...current, plugins: result.plugins });
			void queryClient.invalidateQueries({ queryKey: ['catalog'] });
		},
	});
}

function PluginRow({ plugin }: { plugin: Plugin }) {
	const toggle = usePluginMutation((enabled: boolean) => api.setPluginEnabled(plugin.id, enabled));
	const remove = usePluginMutation(() => api.removePlugin(plugin.id));
	const [confirming, setConfirming] = useState(false);
	return (
		<div className="flex flex-col gap-1.5 rounded-md px-2.5 py-2">
			<div className="flex items-center gap-2.5">
				<Icon icon={Blocks} className="text-(--icon-secondary)" />
				<div className="flex min-w-0 flex-1 flex-col gap-0.5">
					<div className="flex items-center gap-2 text-[13px] font-medium">
						<span className="truncate">{plugin.name}</span>
						{plugin.marketplace ? <Badge>{plugin.marketplace}</Badge> : null}
					</div>
					<a
						href={`https://github.com/${plugin.source.repo}/tree/${plugin.sha}${plugin.source.path ? `/${plugin.source.path}` : ''}`}
						target="_blank"
						rel="noreferrer"
						className="truncate font-mono text-[11px] text-(--text-disabled) outline-none hover:underline"
					>
						{where(plugin)} @ {plugin.sha.slice(0, 7)}
					</a>
				</div>
				<Switch checked={plugin.enabled} disabled={toggle.isPending} onChange={(enabled) => toggle.mutate(enabled)} label={<span className="sr-only">Use {plugin.name}</span>} />
				{confirming ? (
					<Btn size="sm" variant="dangerGhost" disabled={remove.isPending} onBlur={() => setConfirming(false)} onClick={() => remove.mutate(undefined)}>
						{remove.isPending ? 'Removing…' : 'Click again to remove'}
					</Btn>
				) : (
					<IconBtn icon={Trash2} size="sm" label={`Remove ${plugin.name}`} onClick={() => setConfirming(true)} />
				)}
			</div>
			{plugin.description ? <p className="m-0 pl-6 text-[12px] leading-[18px] text-pretty text-(--text-tertiary)">{plugin.description}</p> : null}
			<div className="flex flex-wrap gap-1 pl-6" aria-label={`Skills in ${plugin.name}`}>
				{plugin.skills.map((skill) => (
					<span
						key={skill.name}
						title={skill.active ? skill.description : plugin.enabled ? 'Not used: an earlier plugin has a skill with this name' : 'Not used: this plugin is off'}
						className={cn(
							'inline-flex h-5 items-center rounded-md bg-(--bg-raised) px-1.5 font-mono text-[11px]',
							skill.active ? 'text-(--text-secondary)' : 'text-(--text-disabled) line-through',
						)}
					>
						/{skill.name}
					</span>
				))}
			</div>
			{plugin.mcpServers.length ? (
				<p className="m-0 pl-6 text-[12px] text-(--text-disabled)">
					Also declares MCP servers ({plugin.mcpServers.join(', ')}). Anton does not run them; add one under a repository’s MCP servers to use it.
				</p>
			) : null}
			{toggle.isError || remove.isError ? <p className="m-0 pl-6 text-[12px] text-(--danger-text)">{(toggle.error ?? remove.error)?.message}</p> : null}
		</div>
	);
}

function InstallByAddress() {
	const [address, setAddress] = useState('');
	const install = usePluginMutation((value: string) => api.installPlugin({ address: value }));
	return (
		<form
			className="flex flex-col gap-1.5"
			onSubmit={(event) => {
				event.preventDefault();
				if (address.trim()) install.mutate(address.trim(), { onSuccess: () => setAddress('') });
			}}
		>
			<div className="flex items-center gap-2">
				<input
					value={address}
					onChange={(event) => setAddress(event.target.value)}
					placeholder="owner/repo, owner/repo/skills/name, or a GitHub URL"
					aria-label="GitHub address"
					className={cn(FIELD, 'flex-1 font-mono')}
				/>
				<Btn type="submit" size="sm" variant="primary" icon={Download} disabled={install.isPending || !address.trim()}>
					{install.isPending ? 'Installing…' : 'Install'}
				</Btn>
			</div>
			{install.isError ? <p className="m-0 text-[12px] text-(--danger-text)">{install.error.message}</p> : null}
		</form>
	);
}

function CatalogRow({ marketplace, item }: { marketplace: string; item: CatalogItem }) {
	const install = usePluginMutation(() => api.installPlugin({ marketplace, name: item.name }));
	return (
		<div className="flex flex-col gap-1 rounded-md px-2.5 py-1.5">
			<div className="flex items-center gap-2.5">
				<div className="flex min-w-0 flex-1 flex-col gap-0.5">
					<div className="truncate text-[13px]">{item.name}</div>
					{item.description ? <div className="line-clamp-2 text-[12px] leading-[17px] text-(--text-tertiary)">{item.description}</div> : null}
				</div>
				{item.installed ? (
					<Badge tone="success">Installed</Badge>
				) : (
					<Btn size="sm" icon={Download} aria-label={`Install ${item.name}`} disabled={install.isPending} onClick={() => install.mutate(undefined)}>
						{install.isPending ? 'Installing…' : 'Install'}
					</Btn>
				)}
			</div>
			{install.isError ? <p className="m-0 text-[12px] text-(--danger-text)">{install.error.message}</p> : null}
		</div>
	);
}

function Catalog({ marketplace }: { marketplace: string }) {
	const [search, setSearch] = useState('');
	const entries = useQuery({ queryKey: ['catalog', marketplace], queryFn: () => api.catalog(marketplace), staleTime: 5 * 60_000 });
	const query = search.trim().toLowerCase();
	const matches = (entries.data?.entries ?? []).filter((item) => `${item.name} ${item.description}`.toLowerCase().includes(query));
	return (
		<div className="flex flex-col gap-2">
			<input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={`Search ${marketplace}`} aria-label="Search the marketplace" className={FIELD} />
			{entries.isPending ? <Spinner size={12} /> : null}
			{entries.isError ? <p className="m-0 text-[12px] text-(--danger-text)">Could not read {marketplace}: {entries.error.message}</p> : null}
			{entries.data ? (
				matches.length ? (
					<List>
						{matches.slice(0, SHOWN).map((item) => (
							<CatalogRow key={item.id} marketplace={marketplace} item={item} />
						))}
					</List>
				) : (
					<p className="m-0 text-[12px] text-(--text-tertiary)">Nothing matches.</p>
				)
			) : null}
			{matches.length > SHOWN ? <p className="m-0 text-[12px] text-(--text-disabled)">{matches.length - SHOWN} more; search to narrow them.</p> : null}
		</div>
	);
}

function Marketplaces({ saved }: { saved: string[] }) {
	const queryClient = useQueryClient();
	const [open, setOpen] = useState(saved[0] ?? '');
	const [adding, setAdding] = useState('');
	const save = useMutation({
		mutationFn: api.saveMarketplaces,
		onSuccess: (result) => {
			queryClient.setQueryData<{ plugins: Plugin[]; marketplaces: string[] }>(['plugins'], (current) => current && { ...current, marketplaces: result.marketplaces });
			if (!result.marketplaces.includes(open)) setOpen(result.marketplaces.at(-1) ?? '');
		},
	});
	const shown = saved.includes(open) ? open : (saved[0] ?? '');
	return (
		<div className="flex flex-col gap-3">
			<div className="flex flex-wrap items-center gap-1.5" role="tablist" aria-label="Marketplaces">
				{saved.map((marketplace) => (
					<span
						key={marketplace}
						className={cn('inline-flex h-7 items-center gap-1 rounded-lg pr-1 pl-2.5 text-[12px]', marketplace === shown ? 'bg-(--accent-bg) text-(--accent-text)' : 'bg-(--bg-surface) text-(--text-secondary)')}
					>
						<button type="button" role="tab" aria-selected={marketplace === shown} onClick={() => setOpen(marketplace)} className="inline-flex items-center gap-1.5 outline-none">
							<Icon icon={Store} size={12} />
							{marketplace}
						</button>
						<button
							type="button"
							aria-label={`Remove ${marketplace}`}
							onClick={() => save.mutate(saved.filter((item) => item !== marketplace))}
							className="inline-flex size-5 items-center justify-center rounded-md outline-none hover:bg-(--bg-hover)"
						>
							<Icon icon={X} size={11} />
						</button>
					</span>
				))}
				<form
					className="flex items-center gap-1.5"
					onSubmit={(event) => {
						event.preventDefault();
						if (!adding.trim()) return;
						save.mutate([...saved, adding.trim()], { onSuccess: () => setAdding('') });
						setOpen(adding.trim());
					}}
				>
					<input value={adding} onChange={(event) => setAdding(event.target.value)} placeholder="owner/repo" aria-label="Marketplace to add" className={cn(FIELD, 'h-7 w-[180px] font-mono')} />
					<Btn type="submit" size="sm" variant="ghost" icon={Plus} disabled={!adding.trim() || save.isPending}>
						Add
					</Btn>
				</form>
			</div>
			{save.isError ? <p className="m-0 text-[12px] text-(--danger-text)">{save.error.message}</p> : null}
			{shown ? <Catalog key={shown} marketplace={shown} /> : <p className="m-0 text-[12px] text-(--text-tertiary)">Add a marketplace to browse it.</p>}
		</div>
	);
}

export function SkillsPage() {
	const plugins = usePlugins();
	return (
		<>
			<PageHeading title="Skills">
				Instructions the agent loads when a task matches them, in the open Agent Skills format. A repository’s own <code>.agents/skills</code> and{' '}
				<code>.claude/skills</code> are always used. Install more below; every task gets them, and you can ask for one by typing <code>/</code> and its name.
			</PageHeading>
			{plugins.data ? (
				<>
					<Block title="Installed" help="Each plugin is saved as it was when installed. Install it again to update it.">
						{plugins.data.plugins.length ? (
							<List>
								{plugins.data.plugins.map((plugin) => (
									<PluginRow key={plugin.id} plugin={plugin} />
								))}
							</List>
						) : (
							<p className="m-0 text-[12px] text-(--text-tertiary)">Nothing installed yet.</p>
						)}
					</Block>
					<Block
						title="Install from GitHub"
						help="A repository, a folder of skills or a single skill. Plugins made for Claude Code, Devin, Codex or Cursor, and Agent Plugins, all work; Anton uses their skills."
					>
						<InstallByAddress />
					</Block>
					<Block title="Marketplaces" help="Repositories that list plugins, in Claude Code’s marketplace.json or Devin’s format.">
						<Marketplaces saved={plugins.data.marketplaces} />
					</Block>
				</>
			) : (
				<Spinner size={12} />
			)}
		</>
	);
}

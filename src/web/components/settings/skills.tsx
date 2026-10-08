import { keepPreviousData, useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { Blocks, Github, Plus, ScrollText, Search, Settings2, Star, Store, X } from 'lucide-react';
import { Popover as PopoverPrimitive } from 'radix-ui';
import { type ReactNode, useEffect, useState } from 'react';
import { Caption, Count, Segmented, SegmentedItem, Status } from '@/components/instrument';
import { Btn, EmptyState, Icon, IconBtn, Spinner, Switch } from '@/components/signal';
import { api, type CatalogItem, type GitHubSearch, type Plugin, type PluginPick } from '@/lib/api';
import { cn } from '@/lib/utils';
import { FIELD, PageHeading } from './parts';

/** Cards shown at once on Discover; "Show more" adds as many again. */
const PAGE = 24;
/** GitHub is searched once typing pauses this long. */
const SEARCH_DELAY_MS = 400;

export type SkillsTab = 'installed' | 'discover';
export type ViewSearch = { marketplace?: string; name?: string; address?: string; plugin?: string };

type PluginsView = { plugins: Plugin[]; marketplaces: string[] };

export function usePlugins() {
	return useQuery({ queryKey: ['plugins'], queryFn: api.plugins });
}

/** Mutations answer with the new plugin list, which goes straight into the cache. */
export function usePluginMutation<T>(run: (input: T) => Promise<{ plugins: Plugin[] }>) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: run,
		onSuccess: (result) => {
			queryClient.setQueryData<PluginsView>(['plugins'], (current) => current && { ...current, plugins: result.plugins });
			void queryClient.invalidateQueries({ queryKey: ['catalog'] });
			void queryClient.invalidateQueries({ queryKey: ['plugin-preview'] });
		},
	});
}

/** The detail page's search params for a pick. */
export const viewSearch = (pick: PluginPick): ViewSearch => ({ ...pick });

/** `owner/repo`, a deeper path or a GitHub URL, which can be opened as it is. */
export const looksLikeAddress = (text: string) => /^(https?:\/\/(www\.)?github\.com\/)?[\w.-]+\/[\w.-]+(\/\S*)?$/i.test(text.trim());

export const owner = (repo: string) => repo.split('/')[0] ?? repo;

/** A square tile with a plugin's or a skill's glyph. */
export function Glyph({ bundle, size = 'md' }: { bundle: boolean; size?: 'md' | 'lg' }) {
	return (
		<span
			className={cn(
				'inline-flex shrink-0 items-center justify-center border border-dashed border-(--border-strong) bg-(--well-bg)',
				bundle ? 'text-(--data-2)' : 'text-(--data-1)',
				size === 'lg' ? 'size-12 rounded-[12px]' : 'size-8 rounded-[9px]',
			)}
		>
			<Icon icon={bundle ? Blocks : ScrollText} size={size === 'lg' ? 20 : 15} />
		</span>
	);
}

/** One plugin or skill as a card; the whole card opens it, and `action` sits above that. */
function Card({
	open,
	bundle,
	title,
	caption,
	description,
	action,
	children,
}: {
	open: ViewSearch;
	bundle: boolean;
	title: string;
	caption: ReactNode;
	description: string;
	action?: ReactNode;
	children?: ReactNode;
}) {
	return (
		<div className="in-card group gap-2.5 p-3.5 transition-colors duration-(--duration-micro) hover:border-(--border-default)">
			<div className="flex items-start gap-3">
				<Glyph bundle={bundle} />
				<div className="flex min-w-0 flex-1 flex-col gap-0.5">
					<Link
						to="/settings/skills/view"
						search={open}
						className="truncate text-[13px] font-medium text-(--text-primary) outline-none after:absolute after:inset-0 after:rounded-[14px] focus-visible:after:shadow-(--focus-ring)"
					>
						{title}
					</Link>
					<div className="flex min-w-0 items-center gap-1.5 truncate text-[11px] text-(--text-disabled)">{caption}</div>
				</div>
				{action ? <div className="relative z-10 flex shrink-0 items-center">{action}</div> : null}
			</div>
			<p className={cn('m-0 line-clamp-2 min-h-9 text-[12px] leading-[18px] text-pretty', description ? 'text-(--text-tertiary)' : 'text-(--text-disabled)')}>
				{description || 'No description.'}
			</p>
			{children ? <div className="-mx-3.5 mt-auto border-t border-(--border-subtle) px-3.5 pt-2.5">{children}</div> : null}
		</div>
	);
}

function Grid({ children }: { children: ReactNode }) {
	return <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-3">{children}</div>;
}

function SkillChips({ plugin }: { plugin: Plugin }) {
	const shown = plugin.skills.slice(0, 4);
	return (
		<div className="flex flex-wrap gap-1" aria-label={`Skills in ${plugin.name}`}>
			{shown.map((skill) => (
				<span
					key={skill.name}
					title={skill.active ? skill.description : plugin.enabled ? 'Not used: an earlier plugin has a skill with this name' : 'Not used: this plugin is off'}
					className={cn(
						'inline-flex h-5 max-w-[160px] items-center truncate rounded-md border border-(--border-subtle) bg-(--well-bg) px-1.5 font-mono text-[11px]',
						skill.active ? 'text-(--text-secondary)' : 'text-(--text-disabled) line-through',
					)}
				>
					/{skill.name}
				</span>
			))}
			{plugin.skills.length > shown.length ? (
				<span className="inline-flex h-5 items-center px-1 text-[11px] text-(--text-disabled)">+{plugin.skills.length - shown.length}</span>
			) : null}
		</div>
	);
}

function InstalledCard({ plugin }: { plugin: Plugin }) {
	const toggle = usePluginMutation((enabled: boolean) => api.setPluginEnabled(plugin.id, enabled));
	return (
		<Card
			open={{ plugin: plugin.id }}
			bundle={plugin.skills.length !== 1}
			title={plugin.name}
			caption={
				plugin.marketplace ? (
					<>
						<Icon icon={Store} size={11} />
						<span className="truncate">{plugin.marketplace}</span>
					</>
				) : (
					<span className="truncate font-mono">{[plugin.source.repo, plugin.source.path].filter(Boolean).join('/')}</span>
				)
			}
			description={plugin.description}
			action={
				<Switch
					checked={plugin.enabled}
					disabled={toggle.isPending}
					onChange={(enabled) => toggle.mutate(enabled)}
					label={<span className="sr-only">Use {plugin.name}</span>}
				/>
			}
		>
			<SkillChips plugin={plugin} />
		</Card>
	);
}

function Installed({ plugins, query, onDiscover }: { plugins: Plugin[]; query: string; onDiscover: () => void }) {
	const needle = query.trim().toLowerCase();
	const shown = plugins.filter((plugin) =>
		[plugin.name, plugin.description, plugin.source.repo, ...plugin.skills.map((skill) => skill.name)].join(' ').toLowerCase().includes(needle),
	);
	if (!plugins.length) {
		return (
			<EmptyState icon={Blocks} title="No skills installed yet" body="Find plugins and skills in your marketplaces or anywhere on GitHub, look through them, then install.">
				<Btn size="sm" variant="primary" icon={Store} onClick={onDiscover}>
					Discover skills
				</Btn>
			</EmptyState>
		);
	}
	return (
		<div className="flex flex-col gap-3">
			{shown.length ? (
				<Grid>
					{shown.map((plugin) => (
						<InstalledCard key={plugin.id} plugin={plugin} />
					))}
				</Grid>
			) : (
				<p className="m-0 text-[12px] text-(--text-tertiary)">
					Nothing installed matches.{' '}
					<button type="button" onClick={onDiscover} className="text-(--accent-text) outline-none hover:underline">
						Search Discover instead
					</button>
				</p>
			)}
			<p className="m-0 rounded-[10px] border border-dashed border-(--border-default) px-3 py-2.5 text-[12px] leading-[18px] text-(--text-tertiary)">
				A repository’s own <code>.agents/skills</code> and <code>.claude/skills</code> are always used too, ahead of these. Type <code>/</code> and a skill’s name in a task to
				ask for it.
			</p>
		</div>
	);
}

function InstallButton({ pick, name }: { pick: PluginPick; name: string }) {
	const install = usePluginMutation(() => api.installPlugin(pick));
	if (install.isPending) return <Spinner size={14} />;
	return (
		<IconBtn
			icon={Plus}
			size="sm"
			variant="secondary"
			label={install.isError ? `Could not install: ${install.error.message}` : `Install ${name}`}
			className={install.isError ? 'text-(--danger-text)' : undefined}
			onClick={() => install.mutate(undefined)}
		/>
	);
}

function CatalogCard({ item, marketplace }: { item: CatalogItem; marketplace: string }) {
	const pick = { marketplace, name: item.name };
	const title = item.bundle ? item.name.slice(item.bundle.length + 1) : item.name;
	const count = item.skills?.length;
	return (
		<Card
			open={viewSearch(pick)}
			bundle={!item.bundle}
			title={title}
			caption={
				<>
					<Icon icon={Store} size={11} />
					<span className="truncate">{item.bundle ? `${item.bundle} · ${marketplace}` : marketplace}</span>
					{count && count > 1 ? <span className="shrink-0">· {count} skills</span> : null}
				</>
			}
			description={item.description}
			action={item.installed ? <Status tone="success">Installed</Status> : <InstallButton pick={pick} name={item.name} />}
		/>
	);
}

/** Marketplace repositories to add or remove. */
function ManageMarketplaces({ saved }: { saved: string[] }) {
	const queryClient = useQueryClient();
	const [adding, setAdding] = useState('');
	const save = useMutation({
		mutationFn: api.saveMarketplaces,
		onSuccess: (result) => queryClient.setQueryData<PluginsView>(['plugins'], (current) => current && { ...current, marketplaces: result.marketplaces }),
	});
	return (
		<PopoverPrimitive.Root>
			<PopoverPrimitive.Trigger asChild>
				<IconBtn icon={Settings2} size="sm" label="Manage marketplaces" />
			</PopoverPrimitive.Trigger>
			<PopoverPrimitive.Portal>
				<PopoverPrimitive.Content
					align="end"
					sideOffset={6}
					collisionPadding={12}
					className="in-pop z-50 flex w-[320px] flex-col gap-2 p-3 text-(--text-primary) outline-none"
				>
					<Caption>Marketplaces</Caption>
					<p className="m-0 text-[12px] leading-[17px] text-(--text-tertiary)">Repositories that list plugins, in Claude Code’s marketplace.json or Devin’s format.</p>
					<div className="flex flex-col gap-0.5">
						{saved.map((marketplace) => (
							<div key={marketplace} className="flex h-7 items-center gap-2 rounded-md pr-0.5 pl-2 hover:bg-(--bg-hover)">
								<Icon icon={Store} size={12} className="text-(--icon-tertiary)" />
								<span className="min-w-0 flex-1 truncate font-mono text-[12px]">{marketplace}</span>
								<IconBtn icon={X} size="xs" label={`Remove ${marketplace}`} onClick={() => save.mutate(saved.filter((item) => item !== marketplace))} />
							</div>
						))}
					</div>
					<form
						className="flex items-center gap-1.5"
						onSubmit={(event) => {
							event.preventDefault();
							if (adding.trim()) save.mutate([...saved, adding.trim()], { onSuccess: () => setAdding('') });
						}}
					>
						<input
							value={adding}
							onChange={(event) => setAdding(event.target.value)}
							placeholder="owner/repo"
							aria-label="Marketplace to add"
							className={cn(FIELD, 'h-7 flex-1 font-mono')}
						/>
						<Btn type="submit" size="sm" icon={Plus} disabled={!adding.trim() || save.isPending}>
							Add
						</Btn>
					</form>
					{save.isError ? <p className="m-0 text-[12px] text-(--danger-text)">{save.error.message}</p> : null}
				</PopoverPrimitive.Content>
			</PopoverPrimitive.Portal>
		</PopoverPrimitive.Root>
	);
}

function SourceChip({ label, on, onClick, icon }: { label: string; on: boolean; onClick: () => void; icon?: typeof Store }) {
	return (
		<button
			type="button"
			aria-pressed={on}
			onClick={onClick}
			className={cn(
				'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-3 text-[12px] outline-none focus-visible:shadow-(--focus-ring)',
				on
					? 'border-(--accent-border) bg-(--accent-bg-subtle) text-(--accent-text)'
					: 'border-(--border-subtle) bg-(--well-bg) text-(--text-secondary) hover:border-(--border-default) hover:text-(--text-primary)',
			)}
		>
			{icon ? <Icon icon={icon} size={12} /> : null}
			{label}
		</button>
	);
}

const SKELETONS = Array.from({ length: 6 }, (_, index) => index);

/** Every marketplace's catalog, read in parallel; one that fails says so on its own. */
function useCatalogs(marketplaces: string[]) {
	return useQueries({
		queries: marketplaces.map((marketplace) => ({
			queryKey: ['catalog', marketplace],
			queryFn: () => api.catalog(marketplace),
			staleTime: 5 * 60_000,
			retry: 1,
		})),
		combine: (results) => ({
			items: results.flatMap((result, index) => (result.data?.entries ?? []).map((item) => ({ item, marketplace: marketplaces[index] as string }))),
			pending: results.some((result) => result.isPending),
			failures: results.flatMap((result, index) => (result.isError ? [{ marketplace: marketplaces[index] as string, error: result.error, retry: result.refetch }] : [])),
		}),
	});
}

/** The value, once it has stopped changing for `delay`; empty until then. */
function useSettled(value: string, delay: number) {
	const [settled, setSettled] = useState('');
	useEffect(() => {
		const timer = setTimeout(() => setSettled(value), delay);
		return () => clearTimeout(timer);
	}, [value, delay]);
	return settled;
}

function GitHubResults({ query }: { query: string }) {
	const settled = useSettled(query.trim(), SEARCH_DELAY_MS);
	const search = useQuery({
		queryKey: ['github-skills', settled.toLowerCase()],
		queryFn: ({ signal }) => api.searchGitHub(settled, signal),
		enabled: settled.length >= 2,
		staleTime: 10 * 60_000,
		placeholderData: keepPreviousData,
	});
	const typing = query.trim() !== settled || search.isFetching;
	const result: GitHubSearch | undefined = search.data;
	const empty = result && !result.skills.length && !result.repos.length;
	return (
		<section className="flex flex-col gap-2.5" aria-label="On GitHub">
			<div className="flex items-center gap-2">
				<Icon icon={Github} size={13} className="text-(--icon-tertiary)" />
				<Caption>On GitHub</Caption>
				{typing ? <Spinner size={12} /> : null}
			</div>
			{search.isError ? <p className="m-0 text-[12px] text-(--danger-text)">{search.error.message}</p> : null}
			{result?.problems.map((problem) => (
				<p key={problem} className="m-0 text-[12px] text-(--warning-text)">
					{problem}
				</p>
			))}
			{result?.skills.length ? (
				<Grid>
					{result.skills.map((skill) => (
						<Card
							key={skill.address}
							open={{ address: skill.address }}
							bundle={false}
							title={skill.name}
							caption={<span className="truncate font-mono">{skill.address}</span>}
							description={skill.description}
							action={<InstallButton pick={{ address: skill.address }} name={skill.name} />}
						/>
					))}
				</Grid>
			) : null}
			{result?.repos.length ? (
				<div className="in-card gap-0.5 p-1" aria-label="Repositories">
					{result.repos.map((repo) => (
						<Link
							key={repo.address}
							to="/settings/skills/view"
							search={{ address: repo.address }}
							className="flex min-h-10 items-center gap-3 rounded-lg px-2.5 py-1.5 outline-none hover:bg-(--bg-hover) focus-visible:shadow-(--focus-ring)"
						>
							<Icon icon={Github} size={14} className="text-(--icon-tertiary)" />
							<div className="flex min-w-0 flex-1 flex-col">
								<span className="truncate font-mono text-[12px] text-(--text-primary)">{repo.address}</span>
								{repo.description ? <span className="truncate text-[12px] text-(--text-tertiary)">{repo.description}</span> : null}
							</div>
							<span className="in-num flex shrink-0 items-center gap-1 text-[11px] text-(--text-disabled)">
								<Icon icon={Star} size={11} />
								{repo.stars.toLocaleString()}
							</span>
						</Link>
					))}
				</div>
			) : null}
			{empty && !typing && !result.problems.length ? <p className="m-0 text-[12px] text-(--text-tertiary)">Nothing on GitHub matches “{settled}”.</p> : null}
		</section>
	);
}

function Discover({ marketplaces, query }: { marketplaces: string[]; query: string }) {
	const [source, setSource] = useState<string | null>(null);
	const [limit, setLimit] = useState(PAGE);
	const catalogs = useCatalogs(marketplaces);
	const needle = query.trim().toLowerCase();
	useEffect(() => setLimit(PAGE), [needle, source]);
	const shown = catalogs.items
		.filter(({ marketplace }) => !source || marketplace === source)
		// A bundle's own skills show on its page, or when searching.
		.filter(({ item }) => (needle ? `${item.name} ${item.description}`.toLowerCase().includes(needle) : !item.bundle));
	return (
		<div className="flex flex-col gap-5">
			{looksLikeAddress(query) ? (
				<Link
					to="/settings/skills/view"
					search={{ address: query.trim() }}
					className="flex items-center gap-3 rounded-[14px] border border-(--accent-border) bg-(--accent-bg-subtle) px-3.5 py-3 outline-none hover:bg-(--accent-bg-subtle-hover) focus-visible:shadow-(--focus-ring)"
				>
					<Icon icon={Github} size={16} className="text-(--accent-text)" />
					<div className="flex min-w-0 flex-1 flex-col">
						<span className="truncate text-[13px] font-medium text-(--text-primary)">Open {query.trim()}</span>
						<span className="text-[12px] text-(--text-tertiary)">Look through its skills and files before installing.</span>
					</div>
				</Link>
			) : null}
			<section className="flex flex-col gap-2.5" aria-label="From your marketplaces">
				<div className="flex items-center gap-1.5 overflow-x-auto">
					<SourceChip label="All" on={!source} onClick={() => setSource(null)} />
					{marketplaces.map((marketplace) => (
						<SourceChip key={marketplace} label={marketplace} icon={Store} on={source === marketplace} onClick={() => setSource(marketplace)} />
					))}
					<span className="flex-1" />
					<ManageMarketplaces saved={marketplaces} />
				</div>
				{catalogs.failures.map(({ marketplace, error, retry }) => (
					<div key={marketplace} className="flex items-center gap-2 rounded-lg bg-(--danger-bg) px-3 py-2 text-[12px] text-(--danger-text)">
						<span className="min-w-0 flex-1">
							Could not read {marketplace}: {error.message}
						</span>
						<Btn size="xs" variant="ghost" onClick={() => void retry()}>
							Try again
						</Btn>
					</div>
				))}
				{shown.length ? (
					<Grid>
						{shown.slice(0, limit).map(({ item, marketplace }) => (
							<CatalogCard key={`${marketplace}:${item.id}`} item={item} marketplace={marketplace} />
						))}
					</Grid>
				) : catalogs.pending ? (
					<Grid>
						{SKELETONS.map((index) => (
							<div key={index} className="in-card h-[118px] animate-pulse" />
						))}
					</Grid>
				) : (
					<p className="m-0 text-[12px] text-(--text-tertiary)">{needle ? 'Nothing in your marketplaces matches.' : 'Add a marketplace to browse it.'}</p>
				)}
				{shown.length > limit ? (
					<Btn size="sm" variant="ghost" className="self-center" onClick={() => setLimit((current) => current + PAGE)}>
						Show more ({shown.length - limit})
					</Btn>
				) : null}
			</section>
			{needle.length >= 2 && !looksLikeAddress(query) ? <GitHubResults query={query} /> : null}
		</div>
	);
}

export function SkillsPage() {
	const plugins = usePlugins();
	const search = useSearch({ strict: false }) as { tab?: SkillsTab; q?: string };
	const navigate = useNavigate();
	const [query, setQuery] = useState(search.q ?? '');
	const tab: SkillsTab = search.tab ?? (plugins.data && !plugins.data.plugins.length ? 'discover' : 'installed');
	const go = (next: { tab?: SkillsTab; q?: string }) =>
		void navigate({ to: '/settings/$section', params: { section: 'skills' }, search: { tab, q: query || undefined, ...next }, replace: true });
	return (
		<>
			<PageHeading title="Skills">
				Instructions the agent loads when a task needs them, in the open Agent Skills format. Plugins for Claude Code, Devin, Codex or Cursor work too; Anton uses their
				skills.
			</PageHeading>
			<div className="flex flex-wrap items-center gap-3">
				<Segmented label="Skills" className="shrink-0">
					<SegmentedItem on={tab === 'installed'} onClick={() => go({ tab: 'installed' })}>
						Installed
						{plugins.data ? <Count tone={tab === 'installed' ? 'accent' : 'neutral'}>{plugins.data.plugins.length}</Count> : null}
					</SegmentedItem>
					<SegmentedItem on={tab === 'discover'} onClick={() => go({ tab: 'discover' })}>
						Discover
					</SegmentedItem>
				</Segmented>
				<label className="relative flex min-w-[220px] flex-1 items-center">
					<Icon icon={Search} size={13} className="pointer-events-none absolute left-2.5 text-(--icon-tertiary)" />
					<input
						type="search"
						value={query}
						onChange={(event) => {
							setQuery(event.target.value);
							go({ q: event.target.value || undefined });
						}}
						placeholder={tab === 'installed' ? 'Search installed skills' : 'Search marketplaces and GitHub, or paste owner/repo'}
						aria-label="Search skills"
						className={cn(FIELD, 'w-full pl-8')}
					/>
				</label>
			</div>
			{plugins.data ? (
				tab === 'installed' ? (
					<Installed plugins={plugins.data.plugins} query={query} onDiscover={() => go({ tab: 'discover' })} />
				) : (
					<Discover marketplaces={plugins.data.marketplaces} query={query} />
				)
			) : plugins.isError ? (
				<p className="m-0 text-[12px] text-(--danger-text)">{plugins.error.message}</p>
			) : (
				<Spinner size={12} />
			)}
		</>
	);
}

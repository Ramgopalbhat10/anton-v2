import { useQuery } from '@tanstack/react-query';
import { Link, useCanGoBack, useNavigate, useRouter, useSearch } from '@tanstack/react-router';
import { ArrowLeft, ArrowUpRight, Download, FileText, RefreshCw, Trash2 } from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';
import { FileIcons } from '@/components/file-icons';
import { Branch, buildTree, FileView } from '@/components/file-view';
import { Markdown } from '@/components/markdown';
import { Badge, Btn, EmptyState, Icon, SectionLabel, Spinner, Switch } from '@/components/signal';
import { api, type PluginPick, type PluginPreview } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Glyph, owner, usePluginMutation, type ViewSearch } from './skills';

type DetailTab = 'overview' | 'skills' | 'files';

/** The pick the page's search params name, if they name one. */
export function pickOf(search: ViewSearch): PluginPick | null {
	if (search.plugin) return { plugin: search.plugin };
	if (search.address) return { address: search.address };
	if (search.marketplace && search.name) return { marketplace: search.marketplace, name: search.name };
	return null;
}

export function usePreview(pick: PluginPick | null) {
	return useQuery({
		queryKey: ['plugin-preview', pick],
		queryFn: () => api.previewPlugin(pick as PluginPick),
		enabled: Boolean(pick),
		staleTime: 5 * 60_000,
		retry: false,
	});
}

const githubUrl = (preview: PluginPreview, path = preview.source.path) => `https://github.com/${preview.source.repo}/tree/${preview.sha}${path ? `/${path}` : ''}`;

/** Paths relative to the plugin's folder, which the file tree shows. */
const within = (preview: PluginPreview, path: string) => (preview.source.path ? path.slice(preview.source.path.length + 1) : path);

/** Every folder above a path, so the tree opens to it. */
const foldersOf = (path: string) =>
	path
		.split('/')
		.slice(0, -1)
		.map((_, index, parts) => parts.slice(0, index + 1).join('/'));

function Actions({ preview }: { preview: PluginPreview }) {
	const install = usePluginMutation(() => api.installPlugin(preview.pick));
	const update = usePluginMutation(() => api.installPlugin({ plugin: preview.id }));
	const toggle = usePluginMutation((enabled: boolean) => api.setPluginEnabled(preview.id, enabled));
	const remove = usePluginMutation(() => api.removePlugin(preview.id));
	const navigate = useNavigate();
	const [confirming, setConfirming] = useState(false);
	const error = (install.error ?? update.error ?? toggle.error ?? remove.error)?.message;
	return (
		<div className="flex flex-col items-end gap-1.5">
			<div className="flex items-center gap-2">
				{preview.installed ? (
					<>
						<Switch
							checked={preview.installed.enabled}
							disabled={toggle.isPending}
							onChange={(enabled) => toggle.mutate(enabled)}
							label={<span className="text-[12px] text-(--text-secondary)">{preview.installed.enabled ? 'On' : 'Off'}</span>}
						/>
						{preview.update ? (
							<Btn size="sm" icon={RefreshCw} disabled={update.isPending} onClick={() => update.mutate(undefined)}>
								{update.isPending ? 'Updating…' : 'Update'}
							</Btn>
						) : null}
						{confirming ? (
							<Btn
								size="sm"
								variant="dangerGhost"
								disabled={remove.isPending}
								onBlur={() => setConfirming(false)}
								onClick={() => remove.mutate(undefined, { onSuccess: () => void navigate({ to: '/settings/$section', params: { section: 'skills' } }) })}
							>
								{remove.isPending ? 'Removing…' : 'Click again to remove'}
							</Btn>
						) : (
							<Btn size="sm" variant="ghost" icon={Trash2} onClick={() => setConfirming(true)}>
								Remove
							</Btn>
						)}
					</>
				) : (
					<Btn size="sm" variant="primary" icon={Download} disabled={install.isPending || !preview.skills.length} onClick={() => install.mutate(undefined)}>
						{install.isPending ? 'Installing…' : preview.skills.length > 1 ? `Install ${preview.skills.length} skills` : 'Install'}
					</Btn>
				)}
			</div>
			{error ? <p className="m-0 max-w-[320px] text-right text-[12px] text-(--danger-text)">{error}</p> : null}
		</div>
	);
}

function Facts({ preview }: { preview: PluginPreview }) {
	const licenses = [...new Set(preview.skills.map((skill) => skill.license).filter(Boolean))];
	const rows: Array<[string, ReactNode]> = [
		[
			'Source',
			<a href={githubUrl(preview)} target="_blank" rel="noreferrer" className="inline-flex min-w-0 items-center gap-1 font-mono outline-none hover:underline">
				<span className="truncate">{[preview.source.repo, preview.source.path].filter(Boolean).join('/')}</span>
				<Icon icon={ArrowUpRight} size={11} />
			</a>,
		],
		['Commit', <span className="font-mono">{preview.sha.slice(0, 7)}</span>],
		...(preview.marketplace ? [['Marketplace', preview.marketplace] as [string, ReactNode]] : []),
		['Skills', String(preview.skills.length)],
		['Files', `${preview.files.length.toLocaleString()}${preview.truncated ? '+' : ''}`],
		...(licenses.length ? [['License', licenses.join(', ')] as [string, ReactNode]] : []),
	];
	return (
		<aside className="flex flex-col gap-3 lg:w-[260px] lg:shrink-0">
			<div className="flex flex-col gap-2 rounded-xl border border-(--border-subtle) bg-(--bg-surface) p-3.5">
				<SectionLabel>Details</SectionLabel>
				{rows.map(([label, value]) => (
					<div key={label} className="flex items-baseline gap-3 text-[12px]">
						<span className="w-[84px] shrink-0 text-(--text-tertiary)">{label}</span>
						<span className="min-w-0 flex-1 truncate text-(--text-secondary)">{value}</span>
					</div>
				))}
			</div>
			{preview.mcpServers.length ? (
				<p className="m-0 rounded-xl bg-(--bg-surface) p-3 text-[12px] leading-[18px] text-(--text-tertiary)">
					Also declares MCP servers ({preview.mcpServers.join(', ')}). Anton does not run them; add one under a repository’s MCP servers to use it.
				</p>
			) : null}
			{preview.skipped.length ? (
				<div className="flex flex-col gap-1 rounded-xl bg-(--warning-bg) p-3 text-[12px] leading-[18px] text-(--warning-text)">
					<span className="font-medium">Left out when installed</span>
					{preview.skipped.map((note) => (
						<span key={note}>{note}</span>
					))}
				</div>
			) : null}
		</aside>
	);
}

function Overview({ preview }: { preview: PluginPreview }) {
	const readme = useQuery({
		// Text, so not under the 'plugin-file' key, where the Files tab keeps the same file's bytes.
		queryKey: ['plugin-readme', preview.source.repo, preview.sha, preview.readme],
		queryFn: async () => new TextDecoder().decode(await api.pluginFile(preview.source.repo, preview.sha, preview.readme as string)),
		enabled: Boolean(preview.readme),
		staleTime: Number.POSITIVE_INFINITY,
	});
	return (
		<div className="flex flex-col gap-4 lg:flex-row lg:items-start">
			<div className="min-w-0 flex-1 rounded-xl border border-(--border-subtle) bg-(--bg-surface) px-5 py-4">
				{!preview.readme ? (
					<p className="m-0 text-[13px] text-(--text-tertiary)">{preview.description || 'This has no README. Its skills and files are in the tabs above.'}</p>
				) : readme.isPending ? (
					<Spinner size={12} />
				) : readme.isError ? (
					<p className="m-0 text-[12px] text-(--danger-text)">{readme.error.message}</p>
				) : (
					<Markdown text={readme.data} />
				)}
			</div>
			<Facts preview={preview} />
		</div>
	);
}

function Skills({ preview, onView }: { preview: PluginPreview; onView: (path: string) => void }) {
	if (!preview.skills.length) {
		return <EmptyState icon={FileText} title="No skills here" body="No SKILL.md was found in this folder, so there is nothing to install. Its files are still in the Files tab." />;
	}
	return (
		<div className="flex flex-col gap-0.5 rounded-xl border border-(--border-subtle) bg-(--bg-surface) p-1">
			{preview.skills.map((skill) => (
				<div key={skill.folder || skill.name} className="flex items-start gap-3 rounded-lg px-3 py-2.5 hover:bg-(--bg-hover)">
					<Glyph bundle={false} />
					<div className="flex min-w-0 flex-1 flex-col gap-0.5">
						<span className="font-mono text-[13px] text-(--text-primary)">/{skill.name}</span>
						<p className="m-0 text-[12px] leading-[18px] text-pretty text-(--text-tertiary)">{skill.description || 'No description.'}</p>
						{skill.license ? <span className="text-[11px] text-(--text-disabled)">{skill.license}</span> : null}
					</div>
					<div className="flex shrink-0 items-center gap-1">
						<Btn size="xs" variant="ghost" onClick={() => onView(within(preview, skill.folder ? `${skill.folder}/SKILL.md` : 'SKILL.md'))}>
							View SKILL.md
						</Btn>
						{preview.skills.length > 1 && skill.folder ? <InstallOne preview={preview} folder={skill.folder} /> : null}
					</div>
				</div>
			))}
		</div>
	);
}

/** Installs one skill of a larger plugin on its own, by its folder's address. */
function InstallOne({ preview, folder }: { preview: PluginPreview; folder: string }) {
	const install = usePluginMutation(() => api.installPlugin({ address: `${preview.source.repo}/${folder}` }));
	return (
		<Btn
			size="xs"
			variant="ghost"
			icon={Download}
			disabled={install.isPending || install.isSuccess}
			title={install.isError ? install.error.message : 'Install only this skill'}
			onClick={() => install.mutate(undefined)}
		>
			{install.isPending ? 'Installing…' : install.isSuccess ? 'Installed' : install.isError ? 'Failed' : 'Only this'}
		</Btn>
	);
}

function Files({ preview, selected, onOpen }: { preview: PluginPreview; selected: string; onOpen: (path: string) => void }) {
	const paths = useMemo(() => preview.files.map((path) => within(preview, path)), [preview]);
	const tree = useMemo(() => buildTree(paths), [paths]);
	const [expanded, setExpanded] = useState(() => new Set(foldersOf(selected)));
	const toggle = (path: string) =>
		setExpanded((current) => {
			const next = new Set(current);
			if (!next.delete(path)) next.add(path);
			return next;
		});
	const full = preview.source.path ? `${preview.source.path}/${selected}` : selected;
	return (
		<FileIcons>
			<div className="flex h-[min(640px,70vh)] min-h-[360px] overflow-hidden rounded-xl border border-(--border-subtle)">
				<div className="flex w-[240px] shrink-0 flex-col overflow-y-auto border-r border-(--border-subtle) bg-(--bg-surface) p-1.5">
					<Branch node={tree} selected={selected} depth={0} expanded={expanded} onToggle={toggle} onOpen={onOpen} />
					{preview.truncated ? <p className="m-0 px-2 py-1.5 text-[11px] text-(--text-disabled)">Only the first {preview.files.length.toLocaleString()} files are listed.</p> : null}
				</div>
				<div className="flex min-w-0 flex-1 flex-col">
					<div className="flex h-8 shrink-0 items-center gap-2 border-b border-(--border-subtle) bg-(--bg-raised) px-3 text-[12px]">
						<span className="min-w-0 flex-1 truncate font-mono text-(--text-secondary)">{selected || 'No file'}</span>
						{selected ? (
							<a
								href={`https://github.com/${preview.source.repo}/blob/${preview.sha}/${full}`}
								target="_blank"
								rel="noreferrer"
								className="inline-flex items-center gap-1 text-(--text-tertiary) outline-none hover:text-(--text-primary)"
							>
								GitHub
								<Icon icon={ArrowUpRight} size={11} />
							</a>
						) : null}
					</div>
					{selected ? (
						<FileView
							key={full}
							path={full}
							queryKey={['plugin-file', preview.source.repo, preview.sha, full]}
							read={() => api.pluginFile(preview.source.repo, preview.sha, full)}
						/>
					) : (
						<EmptyState title="Pick a file" body="Choose a file on the left to read it." />
					)}
				</div>
			</div>
		</FileIcons>
	);
}

function TabButton({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
	return (
		<button
			type="button"
			role="tab"
			aria-selected={on}
			onClick={onClick}
			className={cn(
				'-mb-px inline-flex h-9 items-center gap-1.5 border-b-2 px-1 text-[13px] outline-none focus-visible:shadow-(--focus-ring)',
				on ? 'border-(--accent-base) text-(--text-primary)' : 'border-transparent text-(--text-tertiary) hover:text-(--text-secondary)',
			)}
		>
			{children}
		</button>
	);
}

function Count({ children }: { children: ReactNode }) {
	return <span className="text-[12px] text-(--text-disabled)">{children}</span>;
}

/** The first file worth reading: the README, or the first skill's instructions. */
function firstFile(preview: PluginPreview): string {
	const skill = preview.files.find((path) => path.endsWith('/SKILL.md') || path === 'SKILL.md');
	const path = preview.readme ?? skill ?? preview.files[0];
	return path ? within(preview, path) : '';
}

function Detail({ preview }: { preview: PluginPreview }) {
	const [tab, setTab] = useState<DetailTab>('overview');
	const [file, setFile] = useState(() => firstFile(preview));
	const by = owner(preview.source.repo);
	return (
		<div className="flex flex-col gap-5">
			<header className="flex flex-wrap items-start gap-4">
				<Glyph bundle={preview.skills.length !== 1} size="lg" />
				<div className="flex min-w-0 flex-1 flex-col gap-1">
					<div className="flex items-center gap-2">
						<h1 className="m-0 truncate text-[20px] leading-[26px] font-semibold tracking-[-0.017em]">{preview.name}</h1>
						{preview.installed ? <Badge tone="success">Installed</Badge> : null}
						{preview.update ? <Badge tone="accent">Update available</Badge> : null}
					</div>
					<div className="flex flex-wrap items-center gap-x-1.5 text-[12px] text-(--text-tertiary)">
						<span>by {by}</span>
						<span>·</span>
						<span>
							{preview.skills.length} {preview.skills.length === 1 ? 'skill' : 'skills'}
						</span>
						{preview.marketplace ? (
							<>
								<span>·</span>
								<span>from {preview.marketplace}</span>
							</>
						) : null}
						<span>·</span>
						<a href={githubUrl(preview)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-mono outline-none hover:text-(--text-primary)">
							{preview.sha.slice(0, 7)}
							<Icon icon={ArrowUpRight} size={11} />
						</a>
					</div>
					{preview.description ? <p className="m-0 mt-1 max-w-[72ch] text-[13px] leading-[19px] text-pretty text-(--text-secondary)">{preview.description}</p> : null}
				</div>
				<Actions preview={preview} />
			</header>
			<div role="tablist" aria-label="Plugin" className="flex gap-5 border-b border-(--border-subtle)">
				<TabButton on={tab === 'overview'} onClick={() => setTab('overview')}>
					Overview
				</TabButton>
				<TabButton on={tab === 'skills'} onClick={() => setTab('skills')}>
					Skills <Count>{preview.skills.length}</Count>
				</TabButton>
				<TabButton on={tab === 'files'} onClick={() => setTab('files')}>
					Files <Count>{preview.files.length.toLocaleString()}</Count>
				</TabButton>
			</div>
			{tab === 'overview' ? <Overview preview={preview} /> : null}
			{tab === 'skills' ? (
				<Skills
					preview={preview}
					onView={(path) => {
						setFile(path);
						setTab('files');
					}}
				/>
			) : null}
			{tab === 'files' ? <Files preview={preview} selected={file} onOpen={setFile} /> : null}
		</div>
	);
}

/** A plugin or skill, looked through before or after installing it: its README, skills and every file. */
export function SkillDetailPage() {
	const search = useSearch({ from: '/settings/skills/view' });
	const pick = pickOf(search);
	const preview = usePreview(pick);
	const router = useRouter();
	const canGoBack = useCanGoBack();
	const navigate = useNavigate();
	const back = () => (canGoBack ? router.history.back() : void navigate({ to: '/settings/$section', params: { section: 'skills' } }));
	return (
		<>
			<button
				type="button"
				onClick={back}
				className="inline-flex items-center gap-1.5 self-start text-[12px] text-(--text-tertiary) outline-none hover:text-(--text-primary) focus-visible:shadow-(--focus-ring)"
			>
				<Icon icon={ArrowLeft} size={12} />
				Skills
			</button>
			{!pick ? (
				<EmptyState title="Nothing to show" body="Pick a plugin or skill from the Skills page.">
					<Link to="/settings/$section" params={{ section: 'skills' }}>
						<Btn size="sm">Back to Skills</Btn>
					</Link>
				</EmptyState>
			) : preview.isPending ? (
				<div className="flex items-center gap-2 text-[12px] text-(--text-tertiary)">
					<Spinner size={12} />
					Reading from GitHub
				</div>
			) : preview.isError ? (
				<EmptyState title="Could not read this" body={preview.error.message}>
					<Btn size="sm" onClick={() => void preview.refetch()}>
						Try again
					</Btn>
				</EmptyState>
			) : (
				<Detail key={preview.data.sha} preview={preview.data} />
			)}
		</>
	);
}

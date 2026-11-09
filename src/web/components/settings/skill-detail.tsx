import { useQuery } from '@tanstack/react-query';
import { Link, useCanGoBack, useNavigate, useRouter, useSearch } from '@tanstack/react-router';
import { ArrowLeft, ArrowUpRight, Download, FileText, Info, PanelLeftOpen, RefreshCw, Trash2, X } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { DocumentMarkdown } from '@/components/document-markdown';
import { FileIcons } from '@/components/file-icons';
import { Branch, buildTree, FileView, IMAGE_TYPES, isMarkdown, MarkdownToggle } from '@/components/file-view';
import { type FileImages } from '@/components/markdown';
import { Card, Count, Status } from '@/components/instrument';
import { useStoredState } from '@/components/split-pane';
import { Btn, EmptyState, Icon, IconBtn, Spinner, Switch } from '@/components/signal';
import { ADDED_FILES, api, type PluginPick, type PluginPreview } from '@/lib/api';
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

/** The file on the Artifacts page a skill was installed from. */
function AddedFileLink({ path }: { path: string }) {
	return (
		<Link to="/artifacts/$taskId" params={{ taskId: ADDED_FILES }} search={{ path }} className="inline-flex min-w-0 items-center gap-1 outline-none hover:underline">
			<Icon icon={FileText} size={11} />
			<span className="truncate">{path} on Artifacts</span>
		</Link>
	);
}

/** Paths relative to the plugin's folder, which the file tree shows. */
const within = (preview: PluginPreview, path: string) => (preview.source.path ? path.slice(preview.source.path.length + 1) : path);

/** Every folder above a path, so the tree opens to it. */
const foldersOf = (path: string) =>
	path
		.split('/')
		.slice(0, -1)
		.map((_, index, parts) => parts.slice(0, index + 1).join('/'));

const dirname = (path: string) => {
	const at = path.lastIndexOf('/');
	return at < 0 ? '' : path.slice(0, at);
};

/** The plugin-relative path an image src points at, resolved against the file showing it; null when it leaves the plugin. */
function imagePath(base: string, src: string): string | null {
	let clean = src;
	try {
		clean = decodeURIComponent(clean);
	} catch {
		// A malformed escape stays literal.
	}
	clean = (clean.split(/[?#]/)[0] ?? '').trim();
	if (!clean) return null;
	const parts = (clean.startsWith('/') ? clean.slice(1) : [dirname(base), clean].filter(Boolean).join('/')).split('/');
	const out: string[] = [];
	for (const part of parts) {
		if (!part || part === '.') continue;
		if (part === '..') {
			if (!out.pop()) return null;
			continue;
		}
		out.push(part);
	}
	return out.length ? out.join('/') : null;
}

/** One image file of the plugin, fetched on demand and shown from a blob URL. */
function PluginImage({ repo, sha, path, alt, className }: { repo: string; sha: string; path: string; alt?: string; className?: string }) {
	const type = IMAGE_TYPES[path.split('.').pop()?.toLowerCase() ?? ''];
	const file = useQuery({
		// The same key the Files tab reads the file under, so an opened image is already cached.
		queryKey: ['plugin-file', repo, sha, path],
		queryFn: () => api.pluginFile(repo, sha, path),
		enabled: Boolean(type),
		staleTime: Number.POSITIVE_INFINITY,
		retry: false,
	});
	const [url, setUrl] = useState('');
	useEffect(() => {
		if (!file.data || !type) return;
		const objectUrl = URL.createObjectURL(new Blob([new Uint8Array(file.data)], { type }));
		setUrl(objectUrl);
		return () => URL.revokeObjectURL(objectUrl);
	}, [file.data, type]);
	if (!type) return null;
	if (file.isError) return <span className="text-[12px] text-(--text-tertiary)">{alt || path.split('/').pop()}</span>;
	if (!url) return null;
	return <img src={url} alt={alt ?? ''} loading="lazy" className={className} />;
}

/**
 * How a plugin file's images draw: a relative src resolves against the file's
 * folder inside the plugin and is fetched like any other file; a remote src
 * (a README's badges) draws directly. A plugin image opens its file on click.
 */
function usePluginImages(preview: PluginPreview, file: string, onOpen?: (path: string) => void): FileImages {
	return useMemo(() => {
		const listed = new Set(preview.files.map((path) => within(preview, path)));
		const repoPath = (path: string) => (preview.source.path ? `${preview.source.path}/${path}` : path);
		const render = (src: string, alt: string | undefined, inLink: boolean): ReactNode | null => {
			const clean = src.trim();
			if (/^https?:\/\//i.test(clean)) return <img src={clean} alt={alt ?? ''} loading="lazy" className="sg-md-image" />;
			const path = imagePath(file, clean);
			if (!path || !listed.has(path) || !IMAGE_TYPES[path.split('.').pop()?.toLowerCase() ?? '']) return null;
			const picture = (
				<PluginImage
					repo={preview.source.repo}
					sha={preview.sha}
					path={repoPath(path)}
					alt={alt}
					className={inLink || !onOpen ? 'sg-md-image' : undefined}
				/>
			);
			if (inLink || !onOpen) return picture;
			return (
				<button type="button" className="sg-output-image" title={`Open ${path.split('/').pop()}`} onClick={() => onOpen(path)}>
					{picture}
				</button>
			);
		};
		return { render };
	}, [preview, file, onOpen]);
}

function Actions({ preview }: { preview: PluginPreview }) {
	const install = usePluginMutation(() => api.installPlugin(preview.pick));
	const update = usePluginMutation(() => api.installPlugin({ plugin: preview.id }));
	const toggle = usePluginMutation((enabled: boolean) => api.setPluginEnabled(preview.id, enabled));
	const remove = usePluginMutation(() => api.removePlugin(preview.id));
	const navigate = useNavigate();
	const [confirming, setConfirming] = useState(false);
	const error = (install.error ?? update.error ?? toggle.error ?? remove.error)?.message;
	return (
		<div className="flex min-w-0 flex-col items-start gap-1.5 @min-[700px]/settings:items-end">
			<div className="flex flex-wrap items-center gap-2">
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
		preview.added
			? ['Source', <AddedFileLink path={preview.added} />]
			: [
					'Source',
					<a href={githubUrl(preview)} target="_blank" rel="noreferrer" className="inline-flex min-w-0 items-center gap-1 outline-none hover:underline">
						<span className="truncate">{[preview.source.repo, preview.source.path].filter(Boolean).join('/')}</span>
						<Icon icon={ArrowUpRight} size={11} />
					</a>,
				],
		...(preview.added ? [] : [['Commit', <span className="font-sans">{preview.sha.slice(0, 7)}</span>] as [string, ReactNode]]),
		...(preview.marketplace ? [['Marketplace', preview.marketplace] as [string, ReactNode]] : []),
		['Skills', String(preview.skills.length)],
		['Files', `${preview.files.length.toLocaleString()}${preview.truncated ? '+' : ''}`],
		...(licenses.length ? [['License', licenses.join(', ')] as [string, ReactNode]] : []),
	];
	return (
		<aside aria-label="Plugin details" className="flex min-w-0 flex-col gap-3 @min-[800px]/settings:sticky @min-[800px]/settings:top-12 @min-[800px]/settings:max-h-[calc(100dvh-108px)] @min-[800px]/settings:w-[260px] @min-[800px]/settings:shrink-0 @min-[800px]/settings:overflow-y-auto">
			<Card icon={Info} title="Details">
				<dl className="m-0 flex flex-col px-4 pb-2">
					{rows.map(([label, value]) => (
						<div key={label} className="flex min-h-9 items-center gap-3 border-t border-(--border-subtle) text-[12px]">
							<dt className="in-caption w-[84px] shrink-0">{label}</dt>
							<dd className="m-0 flex min-w-0 flex-1 justify-end truncate text-(--text-secondary)">{value}</dd>
						</div>
					))}
				</dl>
			</Card>
			{preview.mcpServers.length ? (
				<p className="m-0 rounded-[8px] bg-(--bg-inset) p-3 text-[12px] leading-[18px] text-(--text-tertiary)">
					Also declares MCP servers ({preview.mcpServers.join(', ')}). Anton does not run them; add one in Settings › Connectors to use it.
				</p>
			) : null}
			{preview.skipped.length ? (
				<div className="flex flex-col gap-1 rounded-[6px] border border-(--border-subtle) bg-(--warning-bg) p-3 text-[12px] leading-[18px] text-(--warning-text)">
					<span className="font-medium">Left out when installed</span>
					{preview.skipped.map((note) => (
						<span key={note}>{note}</span>
					))}
				</div>
			) : null}
		</aside>
	);
}

function Overview({ preview, onOpenFile }: { preview: PluginPreview; onOpenFile: (path: string) => void }) {
	// Added skills use SKILL.md as their overview; repository skills without a
	// README should show that root document too, not just repeat the description.
	const documentPath = preview.readme ?? preview.files.find((path) => within(preview, path) === 'SKILL.md') ?? null;
	const readme = useQuery({
		// Text, so not under the 'plugin-file' key, where the Files tab keeps the same file's bytes.
		queryKey: ['plugin-readme', preview.source.repo, preview.sha, documentPath],
		queryFn: async () => new TextDecoder().decode(await api.pluginFile(preview.source.repo, preview.sha, documentPath as string)),
		enabled: Boolean(documentPath),
		staleTime: Number.POSITIVE_INFINITY,
	});
	const images = usePluginImages(preview, documentPath ? within(preview, documentPath) : '', onOpenFile);
	return (
		<div className="flex flex-col gap-4 @min-[800px]/settings:flex-row @min-[800px]/settings:items-start">
			<div className="in-card min-w-0 flex-1 px-5 py-4">
				{!documentPath ? (
					<p className="m-0 text-[13px] text-(--text-tertiary)">{preview.description || 'This has no README. Its skills and files are in the tabs above.'}</p>
				) : readme.isPending ? (
					<Spinner size={12} />
				) : readme.isError ? (
					<p className="m-0 text-[12px] text-(--danger-text)">{readme.error.message}</p>
				) : (
					<DocumentMarkdown text={readme.data} images={images} />
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
		<div className="in-card p-1">
			{preview.skills.map((skill) => (
				<div key={skill.folder || skill.name} className="flex items-start gap-3 rounded-[6px] px-3 py-3 not-first:rounded-t-none not-first:border-t not-first:border-(--border-subtle) hover:bg-(--bg-hover)">
					<Glyph bundle={false} />
					<div className="flex min-w-0 flex-1 flex-col gap-0.5">
						<span className="text-[13px] text-(--text-primary)">/{skill.name}</span>
						<p className="m-0 line-clamp-3 max-w-[90ch] text-[12px] leading-[18px] text-pretty text-(--text-tertiary)" title={skill.description}>
							{skill.description || 'No description.'}
						</p>
						{skill.license ? <span className="in-num truncate text-[10.5px] text-(--text-disabled)">{skill.license}</span> : null}
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
	const [treeHidden, setTreeHidden] = useStoredState('anton.plugin.tree-hidden', false);
	const images = usePluginImages(preview, selected, onOpen);
	const [sourceShown, setSourceShown] = useState(() => new Set<string>());
	return (
		<FileIcons>
			<div className="in-card h-[min(640px,70vh)] min-h-[360px] flex-row overflow-hidden">
				{treeHidden ? null : (
					<div className="flex w-[40%] max-w-[240px] shrink-0 flex-col overflow-hidden border-r border-(--border-subtle)">
						<div className="flex h-9 shrink-0 items-center gap-1 border-b border-(--border-subtle) px-1.5">
							<span className="in-caption flex-1">Files</span>
							<IconBtn icon={X} size="xs" label="Hide the file tree" aria-pressed onClick={() => setTreeHidden(true)} />
						</div>
						<div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-1.5">
							<Branch node={tree} selected={selected} depth={0} expanded={expanded} onToggle={toggle} onOpen={onOpen} />
							{preview.truncated ? <p className="m-0 px-2 py-1.5 text-[11px] text-(--text-disabled)">Only the first {preview.files.length.toLocaleString()} files are listed.</p> : null}
						</div>
					</div>
				)}
				<div className="flex min-w-0 flex-1 flex-col">
					<div data-plugin-file-header className="flex min-h-9 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-(--border-subtle) px-3 py-1 text-[12px]">
						{treeHidden ? (
							<>
								<IconBtn icon={PanelLeftOpen} size="xs" label="Show the file tree" aria-pressed={false} onClick={() => setTreeHidden(false)} className="-ml-1.5 shrink-0" />
								<span aria-hidden className="h-4 w-px shrink-0 bg-(--border-subtle)" />
							</>
						) : null}
						<span title={selected} className="in-num min-w-0 flex-1 basis-[60px] truncate text-[11.5px] text-(--text-secondary)">{selected || 'No file'}</span>
						{selected && isMarkdown(selected) ? (
							<MarkdownToggle
								preview={!sourceShown.has(selected)}
								className="shrink-0"
								onChange={(showPreview) => setSourceShown((current) => {
									const next = new Set(current);
									if (showPreview) next.delete(selected);
									else next.add(selected);
									return next;
								})}
							/>
						) : null}
						{selected && !preview.added ? (
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
							preview={!sourceShown.has(selected)}
							images={images}
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
				'-mb-px inline-flex h-9 items-center gap-1.5 border-b-2 px-0 text-[13px] @min-[260px]/settings:px-1 outline-none focus-visible:shadow-(--focus-ring)',
				on ? 'border-(--accent-base) text-(--text-primary)' : 'border-transparent text-(--text-tertiary) hover:text-(--text-secondary)',
			)}
		>
			{children}
		</button>
	);
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
	const openFile = useCallback((path: string) => {
		setFile(path);
		setTab('files');
	}, []);
	const by = owner(preview.source.repo);
	return (
		<div className="flex flex-col gap-5">
			<header className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-x-4 gap-y-3 @min-[700px]/settings:grid-cols-[auto_minmax(0,1fr)_auto]">
				<Glyph bundle={preview.skills.length !== 1} size="lg" />
				<div className="flex min-w-0 flex-1 flex-col gap-1">
					<div className="flex flex-wrap items-center gap-2">
						<h1 className="m-0 min-w-0 break-words text-[20px] leading-[26px] font-semibold tracking-[-0.017em]">{preview.name}</h1>
						{preview.installed ? <Status tone="success">Installed</Status> : null}
						{preview.update ? <Status tone="accent" pulse>Update available</Status> : null}
					</div>
					<div className="flex flex-wrap items-center gap-x-1.5 text-[12px] text-(--text-tertiary)">
						{preview.added ? <span>Added by you</span> : <span>by {by}</span>}
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
						{preview.added ? (
							<AddedFileLink path={preview.added} />
						) : (
							<a href={githubUrl(preview)} target="_blank" rel="noreferrer" className="in-num inline-flex items-center gap-1 outline-none hover:text-(--text-primary)">
								{preview.sha.slice(0, 7)}
								<Icon icon={ArrowUpRight} size={11} />
							</a>
						)}
					</div>
				</div>
				<div className="col-span-2 @min-[700px]/settings:col-span-1"><Actions preview={preview} /></div>
				{preview.description ? <p className="col-span-full m-0 text-[13px] leading-[19px] text-pretty text-(--text-secondary) @min-[700px]/settings:col-start-2">{preview.description}</p> : null}
			</header>
			<div role="tablist" aria-label="Plugin" className="sticky-veil sticky top-0 z-20 flex gap-1 border-b border-(--border-subtle) @min-[260px]/settings:gap-5">
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
			{tab === 'overview' ? <Overview preview={preview} onOpenFile={openFile} /> : null}
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
					Reading…
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

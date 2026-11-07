import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Cloud, FileStack, Paperclip, Plug, Plus, Search, Server, Settings2, TriangleAlert } from 'lucide-react';
import { useRef, useState } from 'react';
import type { Attachments } from '@/components/attachments';
import { GMAIL, MarkTile, useComposioMark } from '@/components/brand-marks';
import { Icon, IconBtn, Menu, MenuContent, MenuGroup, MenuItem, MenuLabel, MenuSeparator, MenuSub, MenuSubContent, MenuSubTrigger, MenuTrigger } from '@/components/signal';
import { api, type Artifact, outputUrl, type RunOn } from '@/lib/api';
import { categoryInfo, categoryOf } from '@/lib/artifacts';
import { catalogEntryFor, composioEntryFor } from '@/lib/connector-catalog';
import { type ConnectorItem, connectorItems, setConnectorOn } from '@/lib/connectors';
import { age } from '@/lib/format';
import { cn } from '@/lib/utils';

/** A switch drawn inside a menu row, which toggles as the row is picked. */
function RowSwitch({ on }: { on: boolean }) {
	return (
		<span aria-hidden className={cn('relative inline-flex h-4 w-7 shrink-0 rounded-full transition-colors duration-(--duration-micro)', on ? 'bg-(--accent-base)' : 'bg-(--neutral-600)')}>
			<span className={cn('absolute top-0.5 size-3 rounded-full bg-white transition-transform duration-(--duration-micro)', on ? 'translate-x-3.5' : 'translate-x-0.5')} />
		</span>
	);
}

function ConnectorRow({ item, onPick }: { item: ConnectorItem; onPick: (item: ConnectorItem) => void }) {
	const composio = item.kind === 'composio' ? item.account : undefined;
	const composioUrl = composio ? composio.appUrl || composioEntryFor(composio.toolkit)?.url || '' : '';
	const url = item.kind === 'mcp' ? item.server.url : composioUrl;
	const composioMark = useComposioMark(composio?.logo || undefined, url, composio?.name ?? '');
	const mark = item.kind === 'mailbox' ? GMAIL : composioMark;
	const waiting = item.state === 'needs-sign-in';
	// A server from the catalog goes by its product's name; one added by address, by the name it was given.
	const entry = item.kind === 'mcp' ? catalogEntryFor(item.server.url) : undefined;
	const name = entry?.id === item.name ? entry.name : item.name;
	return (
		<MenuItem
			role={waiting ? 'menuitem' : 'menuitemcheckbox'}
			aria-checked={waiting ? undefined : item.state === 'on'}
			title={waiting ? `${item.name} needs you to sign in again` : undefined}
			// A switch keeps the menu open, so several can be flipped in a row.
			onSelect={(event) => {
				if (!waiting) event.preventDefault();
				onPick(item);
			}}
			hint={waiting ? <Icon icon={TriangleAlert} size={13} className="text-(--warning-text)" /> : <RowSwitch on={item.state === 'on'} />}
		>
			<span className="flex min-w-0 items-center gap-2">
				<MarkTile mark={mark} size={18} className="rounded-[6px]" />
				<span className={cn('truncate', item.kind === 'mcp' && name === item.name && 'font-mono text-[12.5px]')}>{name}</span>
			</span>
		</MenuItem>
	);
}

/** Where a task's commands run, chosen per task; `locked` says why it cannot change now. */
export type RunChoice = { value: RunOn; onChange: (next: RunOn) => void; locked?: string | null; note?: string | null };

const PROVIDER_NAMES: Record<string, string> = { modal: 'Modal', docker: 'Docker', local: 'a folder' };

function RunOnMenu({ run }: { run: RunChoice }) {
	const runners = useQuery({ queryKey: ['runners'], queryFn: api.runners, staleTime: 5 * 60_000 });
	// Only where this server is a place of its own: a server whose sandbox is a local folder already runs everything here.
	if (!runners.data?.host) return null;
	const sandbox = PROVIDER_NAMES[runners.data.sandbox] ?? runners.data.sandbox;
	const pick = (next: RunOn) => {
		if (next !== run.value && !run.locked) run.onChange(next);
	};
	return (
		<MenuSub>
			<MenuSubTrigger icon={run.value === 'host' ? Server : Cloud} hint={run.value === 'host' ? 'This server' : 'Sandbox'}>
				Run on
			</MenuSubTrigger>
			<MenuSubContent className="w-[260px]">
				<MenuItem role="menuitemradio" aria-checked={run.value === 'sandbox'} checked={run.value === 'sandbox'} icon={Cloud} disabled={Boolean(run.locked)} onSelect={() => pick('sandbox')}>
					Sandbox <span className="text-(--text-tertiary)">· {sandbox}</span>
				</MenuItem>
				<MenuItem role="menuitemradio" aria-checked={run.value === 'host'} checked={run.value === 'host'} icon={Server} disabled={Boolean(run.locked)} onSelect={() => pick('host')}>
					This server
				</MenuItem>
				<MenuSeparator />
				<p className="m-0 px-2 pt-0.5 pb-1 text-[11px] leading-[15px] text-pretty text-(--text-tertiary)">
					{run.locked ??
						run.note ??
						"This server runs the task's commands in a folder on the machine Anton runs on, from its address. It is not isolated from that machine, so keep it for tasks you trust."}
				</p>
			</MenuSubContent>
		</MenuSub>
	);
}

/** The most each group lists; a search finds the rest, and the Artifacts page has them all. */
const ARTIFACTS_SHOWN = 30;

const matchesQuery = (artifact: Artifact, query: string) => `${artifact.title} ${artifact.path} ${artifact.task.title}`.toLowerCase().includes(query);

/** Files you added, then what the agent made, newest first, each narrowed by the search. */
function forContext(artifacts: Artifact[], query: string) {
	const needle = query.trim().toLowerCase();
	const found = needle ? artifacts.filter((item) => matchesQuery(item, needle)) : artifacts;
	return { added: found.filter((item) => item.added).slice(0, ARTIFACTS_SHOWN), made: found.filter((item) => !item.added).slice(0, ARTIFACTS_SHOWN) };
}

const sizeText = (bytes: number) => (bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

/** One file: its kind's icon, its name, and where it came from (or how big it is, for one you added). */
function ArtifactRow({ artifact, added, onAdd }: { artifact: Artifact; added: boolean; onAdd: (artifact: Artifact) => void }) {
	const info = categoryInfo(categoryOf(artifact.path));
	const detail = artifact.added ? sizeText(artifact.size) : artifact.task.title;
	return (
		<MenuItem
			checked={added}
			className="h-auto! items-start py-1.5"
			// Stays open, so several can be added in a row.
			onSelect={(event) => {
				event.preventDefault();
				onAdd(artifact);
			}}
		>
			<span className="flex min-w-0 items-start gap-2">
				<Icon icon={info.icon} size={14} className={cn('mt-0.5 shrink-0', info.tone)} />
				<span className="flex min-w-0 flex-col gap-0.5">
					<span className="truncate text-[13px] leading-[17px]">{artifact.title}</span>
					<span className="truncate text-[11px] leading-[14px] text-(--text-tertiary)">
						{detail} · {age(new Date(artifact.mtimeMs).toISOString())}
					</span>
				</span>
			</span>
		</MenuItem>
	);
}

/** Attaches a file from the Artifacts page to the message, as if it were picked from disk. */
function ArtifactsMenu({ attachments }: { attachments: Attachments }) {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState('');
	const [problem, setProblem] = useState<string | null>(null);
	const [added, setAdded] = useState<Set<string>>(new Set());
	const artifacts = useQuery({ queryKey: ['artifacts'], queryFn: api.artifacts, enabled: open, staleTime: 30_000 });
	const all = artifacts.data?.artifacts ?? [];
	const groups = forContext(all, query);
	const keyOf = (artifact: Artifact) => `${artifact.sessionId}\n${artifact.path}`;
	const add = async (artifact: Artifact) => {
		setProblem(null);
		try {
			const response = await fetch(outputUrl(artifact.sessionId, artifact.path));
			if (!response.ok) throw new Error(`${artifact.title} could not be read`);
			const blob = await response.blob();
			const name = artifact.path.split('/').pop() || artifact.title;
			await attachments.attach([new File([blob], name, { type: blob.type })]);
			setAdded((current) => new Set(current).add(keyOf(artifact)));
		} catch (error) {
			setProblem(error instanceof Error ? error.message : String(error));
		}
	};
	const note = (text: string) => <p className="m-0 px-2 py-1.5 text-[12px] leading-[16px] text-pretty text-(--text-tertiary)">{text}</p>;
	return (
		<MenuSub
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
				if (!next) setQuery('');
			}}
		>
			<MenuSubTrigger icon={FileStack} disabled={attachments.full}>
				From Artifacts
			</MenuSubTrigger>
			<MenuSubContent className="max-h-[min(420px,var(--radix-dropdown-menu-content-available-height))] w-[320px] gap-0 overflow-hidden p-0">
				{all.length > 8 ? (
					<div className="flex items-center gap-2 border-b border-(--border-subtle) px-3 py-2">
						<Icon icon={Search} size={13} className="shrink-0 text-(--icon-tertiary)" />
						<input
							value={query}
							onChange={(event) => setQuery(event.target.value)}
							// The menu's own keys (typeahead, arrows, Escape) stay out of the field.
							onKeyDown={(event) => {
								if (event.key !== 'ArrowDown' && event.key !== 'Escape') event.stopPropagation();
							}}
							placeholder="Search files"
							aria-label="Search artifacts"
							className="min-w-0 flex-1 border-0 bg-transparent p-0 text-[13px] text-(--text-primary) outline-none placeholder:text-(--text-disabled)"
						/>
					</div>
				) : null}
				<div className="min-h-0 flex-1 overflow-y-auto p-1.5">
					{artifacts.isPending ? note('Loading…') : null}
					{artifacts.isSuccess && !all.length ? note("Nothing yet. Add files on the Artifacts page, such as a skill's SKILL.md.") : null}
					{artifacts.isSuccess && all.length > 0 && !groups.added.length && !groups.made.length ? note(`No file matches "${query.trim()}".`) : null}
					{groups.added.length ? (
						<MenuGroup>
							<MenuLabel>Added by you</MenuLabel>
							{groups.added.map((artifact) => (
								<ArtifactRow key={keyOf(artifact)} artifact={artifact} added={added.has(keyOf(artifact))} onAdd={(item) => void add(item)} />
							))}
						</MenuGroup>
					) : null}
					{groups.added.length && groups.made.length ? <MenuSeparator /> : null}
					{groups.made.length ? (
						<MenuGroup>
							<MenuLabel>From tasks</MenuLabel>
							{groups.made.map((artifact) => (
								<ArtifactRow key={keyOf(artifact)} artifact={artifact} added={added.has(keyOf(artifact))} onAdd={(item) => void add(item)} />
							))}
						</MenuGroup>
					) : null}
				</div>
				{problem ? <p className="m-0 border-t border-(--border-subtle) px-3 py-1.5 text-[11px] leading-[15px] text-(--danger-text)">{problem}</p> : null}
			</MenuSubContent>
		</MenuSub>
	);
}

/**
 * The composer's + menu: attach files, and turn connectors on or off, as Claude's composer does. A connector's
 * switch is one state for every task, read by the agent as it calls a tool: its tools load only when a task uses
 * them, so a connector that is on costs no context until then and flipping one never changes the cached prompt.
 */
export function ComposerPlus({ attachments, label = 'Attach files', side = 'top', run }: { attachments: Attachments; label?: string; side?: 'top' | 'bottom'; run?: RunChoice }) {
	const picker = useRef<HTMLInputElement>(null);
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const connectors = useQuery({ queryKey: ['connectors'], queryFn: api.connectors, staleTime: 30_000 });
	const items = connectorItems(connectors.data);
	const [problem, setProblem] = useState<string | null>(null);
	const waiting = items.filter((item) => item.state === 'needs-sign-in').length;
	const on = items.filter((item) => item.state === 'on').length;
	const open = (search: { c?: string }) => void navigate({ to: '/settings/connectors/view', search });
	const pick = (item: ConnectorItem) => {
		if (item.state === 'needs-sign-in') return open({ c: item.key });
		setProblem(null);
		setConnectorOn(queryClient, item, item.state !== 'on').catch((error: unknown) => setProblem(error instanceof Error ? error.message : String(error)));
	};
	return (
		<>
			<input
				ref={picker}
				type="file"
				multiple
				hidden
				onChange={(event) => {
					void attachments.attach([...(event.target.files ?? [])]);
					event.target.value = '';
				}}
			/>
			<Menu>
				<MenuTrigger asChild>
					<IconBtn icon={Plus} size="sm" label="Add files and connectors" />
				</MenuTrigger>
				<MenuContent align="start" side={side} className="min-w-[220px]">
					<MenuItem icon={Paperclip} disabled={attachments.full} onSelect={() => picker.current?.click()}>
						{label}
					</MenuItem>
					<ArtifactsMenu attachments={attachments} />
					{run ? <RunOnMenu run={run} /> : null}
					<MenuSub>
						<MenuSubTrigger
							icon={Plug}
							hint={
								waiting ? (
									<span className="inline-flex items-center gap-1 text-(--warning-text)">
										<Icon icon={TriangleAlert} size={12} />
										{waiting}
									</span>
								) : on ? (
									`${on} on`
								) : undefined
							}
						>
							Connectors
						</MenuSubTrigger>
						<MenuSubContent className="w-[260px]">
							<MenuItem icon={Plus} onSelect={() => void navigate({ to: '/settings/$section', params: { section: 'connectors' } })}>
								Add connector
							</MenuItem>
							<MenuItem icon={Settings2} onSelect={() => void navigate({ to: '/settings/$section', params: { section: 'connectors' } })}>
								Manage connectors
							</MenuItem>
							{items.length ? <MenuSeparator /> : null}
							{items.map((item) => (
								<ConnectorRow key={item.key} item={item} onPick={pick} />
							))}
							<MenuSeparator />
							<p className="m-0 px-2 pt-0.5 pb-1 text-[11px] leading-[15px] text-pretty text-(--text-tertiary)">
								{problem ?? 'On for every task. Tools load only when a task uses them, so nothing is spent until then.'}
							</p>
						</MenuSubContent>
					</MenuSub>
				</MenuContent>
			</Menu>
		</>
	);
}

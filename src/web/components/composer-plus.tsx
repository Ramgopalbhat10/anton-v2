import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Paperclip, Plug, Plus, Settings2, TriangleAlert } from 'lucide-react';
import { useRef, useState } from 'react';
import type { Attachments } from '@/components/attachments';
import { GMAIL, MarkTile, useServerMark } from '@/components/brand-marks';
import { Icon, IconBtn, Menu, MenuContent, MenuItem, MenuSeparator, MenuSub, MenuSubContent, MenuSubTrigger, MenuTrigger } from '@/components/signal';
import { api } from '@/lib/api';
import { catalogEntryFor } from '@/lib/connector-catalog';
import { type ConnectorItem, connectorItems, setConnectorOn } from '@/lib/connectors';
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
	const serverMark = useServerMark(item.kind === 'mcp' ? item.server.url : '');
	const mark = item.kind === 'mailbox' ? GMAIL : serverMark;
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
				<MarkTile mark={mark} size={18} className="rounded-[5px]" />
				<span className={cn('truncate', item.kind === 'mcp' && name === item.name && 'font-mono text-[12.5px]')}>{name}</span>
			</span>
		</MenuItem>
	);
}

/**
 * The composer's + menu: attach files, and turn connectors on or off, as Claude's composer does. A connector's
 * switch is one state for every task, read by the agent as it calls a tool: its tools load only when a task uses
 * them, so a connector that is on costs no context until then and flipping one never changes the cached prompt.
 */
export function ComposerPlus({ attachments, label = 'Attach files', side = 'top' }: { attachments: Attachments; label?: string; side?: 'top' | 'bottom' }) {
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

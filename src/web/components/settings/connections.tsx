import { useQuery } from '@tanstack/react-query';
import type { LucideIcon } from 'lucide-react';
import { Box, Brain, Database, GitBranch, Globe, HardDrive, Link, RotateCw, Split } from 'lucide-react';
import { Badge, Btn, Icon, Spinner } from '@/components/signal';
import { api, type Connection } from '@/lib/api';
import { List, PageHeading } from './parts';

const ICONS: Record<string, LucideIcon> = { git: GitBranch, sandbox: Box, store: HardDrive, models: Brain, decisions: Split, web: Globe, database: Database };

const STATE = {
	ok: { tone: 'success', label: 'Connected' },
	set: { tone: 'accent', label: 'Set up' },
	off: { tone: 'neutral', label: 'Not set up' },
	failing: { tone: 'danger', label: 'Failing' },
} as const;

function Row({ connection }: { connection: Connection }) {
	const state = STATE[connection.state];
	return (
		<div className="flex min-h-14 items-center gap-3 rounded-lg px-2.5 py-2">
			<Icon icon={ICONS[connection.id] ?? Link} className="text-(--icon-secondary)" />
			<div className="flex min-w-0 flex-1 flex-col gap-0.5">
				<div className="flex items-center gap-2 text-[13px] font-medium">
					{connection.name}
					<span className="font-mono text-[11px] font-normal text-(--text-disabled)">{connection.provider}</span>
				</div>
				<div className="text-[12px] text-pretty break-words text-(--text-tertiary)">{connection.detail}</div>
			</div>
			<Badge tone={state.tone}>{state.label}</Badge>
		</div>
	);
}

/** Each service behind Anton's ports, checked live when the page opens. */
export function ConnectionsPage() {
	const connections = useQuery({ queryKey: ['connections'], queryFn: api.connections, staleTime: 30_000 });
	return (
		<>
			<PageHeading
				title="Connections"
				actions={
					<Btn size="sm" icon={RotateCw} disabled={connections.isFetching} onClick={() => void connections.refetch()}>
						{connections.isFetching ? 'Checking…' : 'Check again'}
					</Btn>
				}
			>
				Anton needs a code host, somewhere to run sandboxes, object storage and a model gateway. Each is set by environment variables on the server
				and checked here when this page opens.
			</PageHeading>
			{connections.isPending ? (
				<Spinner size={12} />
			) : connections.isError ? (
				<p className="m-0 text-[12px] text-(--danger-text)">{connections.error.message}</p>
			) : (
				<List>
					{connections.data.connections.map((connection) => (
						<Row key={connection.id} connection={connection} />
					))}
				</List>
			)}
		</>
	);
}

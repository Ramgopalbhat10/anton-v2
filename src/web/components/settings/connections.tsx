import { useQuery } from '@tanstack/react-query';
import type { LucideIcon } from 'lucide-react';
import { Box, Brain, Database, GitBranch, Globe, HardDrive, Link, RotateCw, Split } from 'lucide-react';
import { Card, CardSection, Figure, type Part, SplitBar, Status } from '@/components/instrument';
import { Btn, Spinner } from '@/components/signal';
import { api, type Connection } from '@/lib/api';
import { PageHeading } from './parts';

const ICONS: Record<string, LucideIcon> = { git: GitBranch, sandbox: Box, store: HardDrive, models: Brain, decisions: Split, web: Globe, database: Database };

const STATE = {
	ok: { tone: 'success', label: 'Connected' },
	set: { tone: 'accent', label: 'Set up' },
	off: { tone: 'neutral', label: 'Not set up' },
	failing: { tone: 'danger', label: 'Failing' },
} as const;

const TONE = { ok: 'success', set: 'accent', off: 'neutral', failing: 'danger' } as const;

function Tile({ connection }: { connection: Connection }) {
	const state = STATE[connection.state];
	return (
		<Card
			as="div"
			icon={ICONS[connection.id] ?? Link}
			title={connection.name}
			sub={<span className="font-mono text-[11px]">{connection.provider}</span>}
			status={<Status tone={TONE[connection.state]}>{state.label}</Status>}
			label={connection.name}
		>
			<div className="px-4 pt-0.5 pb-4 pl-[50px] text-[12px] leading-[18px] text-pretty break-words text-(--text-tertiary)">{connection.detail}</div>
		</Card>
	);
}

/** Each service behind Anton's ports, checked live when the page opens. */
export function ConnectionsPage() {
	const connections = useQuery({ queryKey: ['connections'], queryFn: api.connections, staleTime: 30_000 });
	const list = connections.data?.connections ?? [];
	const parts: Part[] = (['ok', 'set', 'failing', 'off'] as const).map((key) => ({
		key,
		label: STATE[key].label,
		value: list.filter((connection) => connection.state === key).length,
		color: { ok: 'var(--success-base)', set: 'var(--accent-base)', failing: 'var(--danger-base)', off: 'var(--neutral-600)' }[key],
	}));
	const failing = parts[2].value;
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
				<>
					<Card icon={Link} title="Health" sub="checked just now" status={failing ? <Status tone="danger">{failing} failing</Status> : <Status tone="success">All working</Status>}>
						<CardSection ruled={false} className="pt-1">
							<Figure value={`${parts[0].value + parts[1].value}/${list.length}`} unit="connected" />
							<SplitBar label="Connections by state" parts={parts} legend />
						</CardSection>
					</Card>
					<div className="grid gap-3 sm:grid-cols-2">
						{list.map((connection) => (
							<Tile key={connection.id} connection={connection} />
						))}
					</div>
				</>
			)}
		</>
	);
}

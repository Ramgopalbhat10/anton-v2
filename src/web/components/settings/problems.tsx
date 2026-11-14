import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowUpRight, ChevronDown, RotateCw, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { Card, CardFooter, CardSection, SplitBar, Status } from '@/components/instrument';
import { Btn, EmptyLine, Icon, Spinner } from '@/components/signal';
import { api, SAFETY_NET_MS } from '@/lib/api';
import { age } from '@/lib/format';
import { cn } from '@/lib/utils';
import { PageHeading } from './parts';

const PROBLEMS_SHOWN = 50;

type LogEntry = Awaited<ReturnType<typeof api.logs>>['logs'][number];

/** One problem on one line: what went wrong, how often and when, with the raw detail a click away. */
function ProblemRow({ entry, count, first, last }: { entry: LogEntry; count: number; first: string; last: boolean }) {
	const [open, setOpen] = useState(false);
	return (
		<div className="relative flex items-start gap-3 py-1.5 pl-1">
			{/* A rail through the dots, so the list reads as a timeline. */}
			{last ? null : <span className="absolute top-[22px] bottom-[-8px] left-[7px] w-px bg-(--line)" />}
			<span
				className="relative mt-[9px] size-[7px] shrink-0 rounded-full ring-4 ring-(--bg-surface)"
				style={{ background: entry.level === 'error' ? 'var(--bad)' : 'var(--warn)' }}
			/>
			<div className="flex min-w-0 flex-1 flex-col">
				<div className="flex min-h-[26px] items-center gap-2">
					<button
						type="button"
						disabled={!entry.detail}
						aria-expanded={entry.detail ? open : undefined}
						onClick={() => setOpen((value) => !value)}
						className="group -mx-1.5 flex min-w-0 flex-1 items-center gap-2 rounded-control px-1.5 py-0.5 text-left outline-none enabled:cursor-pointer enabled:hover:bg-(--bg-hover) focus-visible:shadow-(--focus)"
					>
						<span className="shrink-0 text-body font-medium text-(--text)">{entry.message}</span>
						{count > 1 ? (
							<span className="in-num shrink-0 rounded-control bg-(--bg-hover) px-1.5 py-px text-micro text-(--text-2)" title={`${count} times, first ${age(first)} ago`}>
								×{count}
							</span>
						) : null}
						{entry.detail && !open ? <span className="min-w-0 flex-1 truncate text-micro text-(--text-3)">{entry.detail}</span> : <span className="flex-1" />}
						{entry.detail ? <Icon icon={ChevronDown} size={12} className={cn('shrink-0 text-(--text-3) transition-transform', open && 'rotate-180')} /> : null}
					</button>
					<span className="in-num w-[64px] shrink-0 text-right text-micro text-(--text-4)">{count > 1 ? `${age(entry.at)} – ${age(first)}` : age(entry.at)}</span>
					{entry.sessionId ? (
						<Link
							to="/agents/$sessionId"
							params={{ sessionId: entry.sessionId }}
							search={{ app: 'code' }}
							title="Open the task"
							aria-label="Open the task"
							className="grid size-6 shrink-0 place-items-center rounded-control text-(--text-3) outline-none hover:bg-(--bg-hover) hover:text-(--text) focus-visible:shadow-(--focus)"
						>
							<Icon icon={ArrowUpRight} size={13} />
						</Link>
					) : (
						<span className="size-6 shrink-0" />
					)}
				</div>
				{entry.detail && open ? (
					<div className="mt-1 mb-1 rounded-control bg-(--bg-app) px-2.5 py-2 font-mono text-micro leading-[16px] break-all whitespace-pre-wrap text-(--text-2) select-text">{entry.detail}</div>
				) : null}
			</div>
		</div>
	);
}

function Problems() {
	const logs = useQuery({ queryKey: ['logs'], queryFn: api.logs, refetchInterval: SAFETY_NET_MS });
	if (logs.isPending) return <Spinner size={12} />;
	if (logs.isError) return <p className="m-0 text-small text-(--bad)">{logs.error.message}</p>;
	const recent = logs.data.logs.slice(0, PROBLEMS_SHOWN);
	const errors = recent.filter((entry) => entry.level === 'error').length;
	// The same problem again and again (a pull request that cannot be read, checked each minute) is one row with a count.
	const groups = new Map<string, { entry: (typeof recent)[number]; count: number; first: string }>();
	for (const entry of recent) {
		const key = [entry.level, entry.message, entry.detail ?? '', entry.sessionId ?? ''].join('\u0000');
		const group = groups.get(key);
		if (group) {
			group.count += 1;
			group.first = entry.at;
		} else groups.set(key, { entry, count: 1, first: entry.at });
	}
	const shown = [...groups.values()];
	return (
		<Card
			icon={TriangleAlert}
			title="Since Anton started"
			sub={`newest first · up to ${PROBLEMS_SHOWN}`}
			status={errors ? <Status tone="danger">{errors} errors</Status> : recent.length ? <Status tone="warning">{recent.length} warnings</Status> : <Status tone="success">Clear</Status>}
			footer={
				<CardFooter caption="The server log has everything">
					<Btn size="sm" icon={RotateCw} disabled={logs.isFetching} onClick={() => void logs.refetch()}>
						Refresh
					</Btn>
				</CardFooter>
			}
		>
			{shown.length ? (
				<CardSection ruled={false} className="pt-1">
					<SplitBar
						label="Problems by level"
						parts={[
							{ key: 'error', label: 'Errors', value: errors, color: 'var(--bad)' },
							{ key: 'warn', label: 'Warnings', value: recent.length - errors, color: 'var(--warn)' },
						]}
					/>
				</CardSection>
			) : null}
			<CardSection ruled={shown.length > 0} className="gap-0 py-1">
				{shown.length === 0 ? <EmptyLine className="px-0 py-2">Nothing has gone wrong since Anton started.</EmptyLine> : null}
				{shown.map(({ entry, count, first }, index) => (
					<ProblemRow key={`${entry.at}-${index}`} entry={entry} count={count} first={first} last={index === shown.length - 1} />
				))}
			</CardSection>
		</Card>
	);
}

export function ProblemsPage() {
	return (
		<>
			<PageHeading
				title="Recent problems"
				info="Sandbox setup, checkpoints, automations, pull request follow-ups and failed replies. Kept until Anton restarts; the server log has everything."
			>
				Warnings and errors from work that runs on its own.
			</PageHeading>
			<Problems />
		</>
	);
}

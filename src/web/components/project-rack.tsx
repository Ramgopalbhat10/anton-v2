import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowUpRight, Server } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { DETAIL } from '@/components/illustrations';
import { Caption, Card, CardFooter, CardSection } from '@/components/instrument';
import { SpaceMark } from '@/components/project-sidebar';
import { Btn, Icon } from '@/components/signal';
import { FollowUp, PER_BAY, RackArrows, type RackBay, type RackLook, RackStats, RackWell, type RackWellHandle } from '@/components/task-rack';
import { NextSteps, useOpenThread } from '@/components/thread-card';
import { Glyph, glyphKind, KIND_LABEL, KINDS, STATE_COLOR } from '@/components/thread-glyph';
import { api, branchLabel, repoShort, type Session, type Space } from '@/lib/api';
import { age, dollars, tokens } from '@/lib/format';
import { stateOf, threadActiveAt, threadLine } from '@/lib/spaces';
import { cn } from '@/lib/utils';

/* Projects in the rack: each project a bay, its threads the blades, lit as the
   glyphs are (cyan works, amber waits on you, green is ready, grey is done).
   Pointing at a blade draws the thread out with its card: what it asks or last
   said, a line to send it, its next steps and the way into it. */

const threadLook = (thread: Session): RackLook => {
	const kind = glyphKind(thread);
	return {
		color: kind === 'resolved' ? 'var(--neutral-600)' : STATE_COLOR[kind],
		live: kind === 'working',
		alert: kind === 'waiting' || kind === 'failed',
		label: `${thread.title}, ${KIND_LABEL[kind]}`,
	};
};

/** A bay's blades: open threads first in the order states are listed, then the latest done ones. */
export function bayThreads(threads: Session[]): Session[] {
	const rank = (thread: Session) => KINDS.indexOf(glyphKind(thread));
	return [...threads].sort((a, b) => rank(a) - rank(b) || threadActiveAt(b).localeCompare(threadActiveAt(a))).slice(0, PER_BAY);
}

/** A bay's light: amber while a thread waits on you, cyan while one works, dark when quiet. */
function bayLed(threads: Session[]): string {
	if (threads.some((thread) => ['waiting', 'failed'].includes(glyphKind(thread)))) return 'var(--warning-base)';
	if (threads.some((thread) => stateOf(thread) === 'working')) return 'var(--cyan-300)';
	return DETAIL;
}

/** A thread's card in the rack: its state, what it asks or last said, a line to send it, and its next steps. */
function ThreadDetails({ thread }: { thread: Session }) {
	const queryClient = useQueryClient();
	const openThread = useOpenThread();
	const [prompt, setPrompt] = useState('');
	const kind = glyphKind(thread);
	const state = stateOf(thread);
	const send = useMutation({
		mutationFn: (text: string) => api.nudgeThread(thread.spaceId ?? '', thread.id, text),
		onSuccess: () => {
			setPrompt('');
			void queryClient.invalidateQueries({ queryKey: ['sessions'] });
		},
	});
	const line = threadLine(thread);
	const heading = kind === 'waiting' ? 'Asks you' : kind === 'failed' ? 'Stopped on' : state === 'queued' ? 'Brief' : thread.lastReply ? 'Latest' : 'Input';
	const model = thread.model.split('/').pop() ?? thread.model;
	const stats: Array<[string, ReactNode]> = [
		['spent', dollars(thread.usage.cost)],
		['tokens', tokens(thread.usage.inputTokens + thread.usage.outputTokens)],
		['model', model],
	];
	return (
		<>
			<div className="flex flex-col gap-1.5 px-3.5 pt-3 pb-3">
				<div className="flex items-center gap-1.5">
					<Glyph kind={kind} size={12} />
					<span className={cn('in-caption', kind === 'waiting' ? 'text-(--warning-text)' : kind === 'failed' ? 'text-(--danger-text)' : kind === 'working' ? 'text-(--accent-text)' : 'text-(--text-secondary)')}>
						{KIND_LABEL[kind]}
					</span>
					<span className="in-caption ml-auto">started {age(thread.createdAt)} ago</span>
				</div>
				<div className="truncate text-[13px] text-(--text-primary)" title={thread.title}>
					{thread.title}
				</div>
				{line ? (
					<div
						className={cn(
							'flex flex-col gap-1 rounded-[9px] border px-2.5 py-2',
							kind === 'waiting' ? 'border-(--warning-border) bg-(--warning-bg)' : kind === 'failed' ? 'border-(--danger-border) bg-(--danger-bg)' : 'border-(--border-subtle) bg-(--well-bg)',
						)}
					>
						<div className="flex items-center gap-1.5">
							<span className="in-caption">{heading}</span>
							<span className="in-caption ml-auto tracking-normal normal-case">{age(threadActiveAt(thread))} ago</span>
						</div>
						<p className={cn('m-0 line-clamp-3 text-[12.5px] leading-[18px] text-pretty', kind === 'waiting' ? 'text-(--warning-text)' : kind === 'failed' ? 'text-(--danger-text)' : 'text-(--text-primary)')}>{line}</p>
					</div>
				) : null}
				<div className="truncate font-mono text-[11px] text-(--text-tertiary)">
					{repoShort(thread)} · {branchLabel(thread)}
				</div>
			</div>
			<RackStats stats={stats} />
			<form
				className="flex flex-col gap-2 border-t border-(--border-subtle) p-2.5"
				onSubmit={(event) => {
					event.preventDefault();
					if (prompt.trim()) send.mutate(prompt.trim());
				}}
			>
				<FollowUp value={prompt} onChange={setPrompt} label={`Send a follow-up to ${thread.title}`} submitLabel="Send to this thread" disabled={send.isPending} />
				{send.isError ? <span className="text-[12px] text-(--danger-text)">{send.error.message}</span> : null}
				<div className="flex items-center gap-1.5">
					<NextSteps thread={thread} size="xs" />
					<Btn size="sm" variant="primary" className="ml-auto" onClick={() => openThread(thread)}>
						Open thread
						<Icon icon={ArrowUpRight} size={14} />
					</Btn>
				</div>
			</form>
		</>
	);
}

/** A project's name plate under its bay: its mark and name, then what is open and what needs you. */
function Plate({ space, threads, shown }: { space: Space; threads: Session[]; shown: number }) {
	const open = threads.filter((thread) => stateOf(thread) !== 'resolved').length;
	const needs = threads.filter((thread) => stateOf(thread) === 'waiting').length;
	return (
		<Link
			to="/projects/$spaceId"
			params={{ spaceId: space.id }}
			className="flex max-w-full min-w-0 flex-col items-center gap-0.5 rounded-[9px] border border-transparent px-2.5 py-1 outline-none hover:border-(--border-default) hover:bg-(--bg-hover) focus-visible:shadow-(--focus-ring)"
		>
			<span className="flex max-w-full min-w-0 items-center gap-1.5">
				<SpaceMark space={space} size={16} />
				<span className="truncate text-[12.5px] text-(--text-primary)">{space.name}</span>
			</span>
			<span className="in-caption whitespace-nowrap">
				{open} open
				{needs ? <span className="text-(--warning-text)"> · {needs} need{needs === 1 ? 's' : ''} you</span> : null}
				{threads.length > shown ? ` · +${threads.length - shown}` : ''}
			</span>
		</Link>
	);
}

const LEGEND: Array<{ kind: 'working' | 'waiting' | 'review' | 'queued' | 'resolved'; label: string }> = [
	{ kind: 'working', label: 'Working' },
	{ kind: 'waiting', label: 'Needs you' },
	{ kind: 'review', label: 'Ready' },
	{ kind: 'queued', label: 'Queued' },
	{ kind: 'resolved', label: 'Done' },
];

function Legend() {
	return (
		<span className="flex flex-wrap items-center gap-x-3.5 gap-y-1">
			{LEGEND.map((item) => (
				<span key={item.kind} className="flex items-center gap-1.5">
					<Glyph kind={item.kind} size={11} />
					<Caption>{item.label}</Caption>
				</span>
			))}
		</span>
	);
}

/**
 * Every project as a bay in one rack, its threads as the blades: the whole
 * of Projects at a glance, and any thread a point away.
 */
export function ProjectRack({ spaces, threads }: { spaces: Space[]; threads: Session[] }) {
	const openThread = useOpenThread();
	const [scroll, setScroll] = useState<RackWellHandle | null>(null);
	const bays: Array<RackBay<Session>> = spaces.map((space) => {
		const own = threads.filter((thread) => thread.spaceId === space.id);
		const items = bayThreads(own);
		return {
			key: space.id,
			items,
			sweep: own.some((thread) => stateOf(thread) === 'working'),
			led: bayLed(own),
			plate: <Plate space={space} threads={own} shown={items.length} />,
		};
	});
	return (
		<Card
			icon={Server}
			title="Rack"
			sub="each project a bay, its threads the blades"
			status={
				<div className="flex items-center gap-1">
					<RackArrows state={scroll} newer="Scroll back" older="Scroll on" />
				</div>
			}
			footer={<CardFooter caption={<Legend />} />}
		>
			<CardSection ruled={false} className="pt-1">
				<RackWell
					bays={bays}
					look={threadLook}
					details={(thread) => <ThreadDetails thread={thread} />}
					detailsLabel={(thread) => thread.title}
					onChoose={(thread) => openThread(thread)}
					label={`${spaces.length} projects as bays, their threads as blades`}
					onScrollState={setScroll}
				/>
			</CardSection>
		</Card>
	);
}

/** One project's bay, for its Overview: its threads as blades, drawn out on a point. */
export function ProjectBay({ space, threads }: { space: Space; threads: Session[] }) {
	const openThread = useOpenThread();
	return (
		<RackWell
			bays={[{ key: space.id, items: bayThreads(threads), sweep: threads.some((thread) => stateOf(thread) === 'working'), led: bayLed(threads) }]}
			look={threadLook}
			details={(thread) => <ThreadDetails thread={thread} />}
			detailsLabel={(thread) => thread.title}
			onChoose={(thread) => openThread(thread)}
			label={`${space.name}'s threads as blades in its bay`}
		/>
	);
}

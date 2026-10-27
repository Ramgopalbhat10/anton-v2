import { CircleAlert, ClipboardList } from 'lucide-react';
import { HoverCard } from 'radix-ui';
import { type ReactNode, useState } from 'react';
import { Pips } from '@/components/instrument';
import { Icon } from '@/components/signal';
import { PrStatus } from '@/components/pr-status';
import { TaskStatusIcon } from '@/components/task-status';
import { branchLabel, isChat, type Session } from '@/lib/api';
import { age, dollars, tokens } from '@/lib/format';
import { activeAt, modelName, taskNote, type Tone } from '@/lib/task-view';
import { cn } from '@/lib/utils';

export const TONE: Record<Tone, string> = {
	accent: 'text-(--accent-text)',
	success: 'text-(--success-text)',
	warning: 'text-(--warning-text)',
	danger: 'text-(--danger-text)',
	muted: 'text-(--text-tertiary)',
};

const CHECKS = { passed: 'checks pass', failed: 'checks failing', pending: 'checks running' } as const;
const CHECK_TONE = { passed: 'success', failed: 'danger', pending: 'warning' } as const;

/** A fact as a spec-sheet row: what it is on the left, its value on the right. */
function Fact({ label, children, mono }: { label: string; children: ReactNode; mono?: boolean }) {
	return (
		<div className="flex min-h-7 items-center gap-3 border-t border-(--border-subtle) text-[12px] first:border-t-0">
			<span className="shrink-0 text-(--text-tertiary)">{label}</span>
			<span className={cn('flex min-w-0 flex-1 justify-end truncate text-right text-(--text-secondary)', mono && 'in-num text-[11.5px]')}>{children}</span>
		</div>
	);
}

const ago = (iso: string) => (age(iso) === 'now' ? 'just now' : `${age(iso)} ago`);

/** Everything worth knowing about a task at a glance: its numbers first, then where it lives. */
function Peek({ session }: { session: Session }) {
	const note = taskNote(session);
	const { inputTokens, outputTokens, cost } = session.usage;
	const used = inputTokens + outputTokens;
	const pr = session.pullRequest;
	const stats = [
		{ label: 'Spend', value: used > 0 ? dollars(cost) : '—' },
		{ label: 'Tokens', value: used > 0 ? tokens(used) : '—', title: used > 0 ? `${inputTokens.toLocaleString()} in, ${outputTokens.toLocaleString()} out` : undefined },
		{ label: 'Active', value: ago(activeAt(session)) },
	];
	return (
		<div className="flex flex-col gap-2.5">
			<div className="flex items-start gap-2">
				<span className="mt-[3px] inline-flex shrink-0">
					<TaskStatusIcon session={session} size={13} />
				</span>
				<div className="flex min-w-0 flex-1 flex-col gap-0.5">
					<div className="line-clamp-2 text-[13px] leading-[18px] font-medium text-(--text-primary)">{session.title}</div>
					{note && !note.pullRequest ? <div className={cn('text-[12px]', TONE[note.tone])}>{note.text}</div> : null}
				</div>
			</div>
			{session.errorMessage ? (
				<div className="flex gap-1.5 rounded-lg bg-(--danger-bg) px-2.5 py-2 text-[12px] leading-[17px] text-(--danger-text)">
					<Icon icon={CircleAlert} size={13} className="mt-0.5" />
					<span className="line-clamp-4 min-w-0">{session.errorMessage}</span>
				</div>
			) : null}
			{session.planMode ? (
				<div className="flex items-center gap-1.5 text-[12px] text-(--warning-text)">
					<Icon icon={ClipboardList} size={13} />
					Plan mode: changes nothing until you approve its plan
				</div>
			) : null}
			<dl aria-label="Numbers" className="in-well m-0 grid grid-cols-3 divide-x divide-(--border-subtle)">
				{stats.map((stat) => (
					<div key={stat.label} title={stat.title} className="flex min-w-0 flex-col gap-0.5 px-2.5 py-2">
						<dt className="in-caption">{stat.label}</dt>
						<dd className="in-num m-0 truncate text-[12.5px] text-(--text-primary)">{stat.value}</dd>
					</div>
				))}
			</dl>
			<div className="flex flex-col">
				<Fact label="Repository">{isChat(session) ? 'None, a chat' : session.repo}</Fact>
				<Fact label={isChat(session) ? 'Sandbox' : 'Branch'} mono>
					{branchLabel(session)}
				</Fact>
				<Fact label="Model" mono>
					{modelName(session.model)}
				</Fact>
				<Fact label="Started" mono>
					{ago(session.createdAt)}
				</Fact>
				{session.prUrl ? (
					<Fact label="Pull request">
						<span className="inline-flex items-center gap-1.5">
							{pr?.runs.length ? <Pips items={pr.runs.map((run) => ({ tone: CHECK_TONE[run.status], title: run.name }))} label={pr.checks ? CHECKS[pr.checks] : 'Checks'} /> : null}
							<PrStatus thread={session} link full className="outline-none hover:underline focus-visible:shadow-(--focus-ring)" />
						</span>
					</Fact>
				) : null}
			</div>
		</div>
	);
}

/** A card beside a sidebar row once the pointer rests on it; never while the row's menu is open. */
export function TaskPeek({ session, disabled, children }: { session: Session; disabled: boolean; children: ReactNode }) {
	const [open, setOpen] = useState(false);
	return (
		<HoverCard.Root open={open && !disabled} onOpenChange={setOpen} openDelay={450} closeDelay={80}>
			<HoverCard.Trigger asChild>{children}</HoverCard.Trigger>
			<HoverCard.Portal>
				<HoverCard.Content
					side="right"
					align="start"
					sideOffset={12}
					collisionPadding={12}
					className="in-pop z-50 w-[300px] p-3 outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0"
				>
					<Peek session={session} />
				</HoverCard.Content>
			</HoverCard.Portal>
		</HoverCard.Root>
	);
}

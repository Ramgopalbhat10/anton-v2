import { ArrowUpRight, CircleAlert, ClipboardList } from 'lucide-react';
import { HoverCard } from 'radix-ui';
import { type ReactNode, useState } from 'react';
import { Icon } from '@/components/signal';
import { TaskStatusIcon } from '@/components/task-status';
import { branchLabel, type Session } from '@/lib/api';
import { age, dollars, tokens } from '@/lib/format';
import { activeAt, modelName, prNumber, taskNote, type Tone } from '@/lib/task-view';
import { cn } from '@/lib/utils';

export const TONE: Record<Tone, string> = {
	accent: 'text-(--accent-text)',
	success: 'text-(--success-text)',
	warning: 'text-(--warning-text)',
	danger: 'text-(--danger-text)',
	muted: 'text-(--text-tertiary)',
};

const PR_STATE = { open: 'Open', draft: 'Draft', merged: 'Merged', closed: 'Closed' } as const;
const CHECKS = { passed: 'checks pass', failed: 'checks failing', pending: 'checks running' } as const;

function Fact({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="flex items-baseline gap-3 text-[12px]">
			<span className="w-[72px] shrink-0 text-(--text-tertiary)">{label}</span>
			<span className="min-w-0 flex-1 truncate text-(--text-secondary)">{children}</span>
		</div>
	);
}

/** Everything worth knowing about a task at a glance. */
function Peek({ session }: { session: Session }) {
	const note = taskNote(session);
	const { inputTokens, outputTokens, cost } = session.usage;
	const pr = session.pullRequest;
	return (
		<div className="flex flex-col gap-2.5">
			<div className="flex items-start gap-2">
				<span className="mt-[3px] inline-flex shrink-0">
					<TaskStatusIcon session={session} size={13} />
				</span>
				<div className="flex min-w-0 flex-1 flex-col gap-0.5">
					<div className="line-clamp-2 text-[13px] leading-[18px] font-medium text-(--text-primary)">{session.title}</div>
					{note ? <div className={cn('text-[12px]', TONE[note.tone])}>{note.text}</div> : null}
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
			<div className="flex flex-col gap-1 border-t border-(--border-subtle) pt-2.5">
				<Fact label="Repository">{session.repo}</Fact>
				<Fact label="Branch">
					<span className="font-mono text-[11px]">{branchLabel(session)}</span>
				</Fact>
				<Fact label="Model">{modelName(session.model)}</Fact>
				<Fact label="Started">{age(session.createdAt) === 'now' ? 'just now' : `${age(session.createdAt)} ago`}</Fact>
				<Fact label="Last active">{age(activeAt(session)) === 'now' ? 'just now' : `${age(activeAt(session))} ago`}</Fact>
				<Fact label="Spend">{inputTokens + outputTokens > 0 ? `${dollars(cost)} · ${tokens(inputTokens + outputTokens)} tokens` : 'Nothing yet'}</Fact>
				{session.prUrl ? (
					<Fact label="Pull request">
						<a
							href={session.prUrl}
							target="_blank"
							rel="noreferrer"
							className="inline-flex max-w-full items-center gap-1 text-(--text-primary) outline-none hover:underline focus-visible:shadow-(--focus-ring)"
						>
							<span className="truncate">
								#{prNumber(session) ?? '?'}
								{pr ? ` · ${PR_STATE[pr.state]}` : ''}
								{pr?.checks ? `, ${CHECKS[pr.checks]}` : ''}
							</span>
							<Icon icon={ArrowUpRight} size={11} />
						</a>
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

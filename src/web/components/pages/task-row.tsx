import { Link } from '@tanstack/react-router';
import { Github, MessageSquare } from '@/lib/icons';
import { Icon } from '@/components/kit/signal';
import { TaskStatusIcon } from '@/components/marks/task-status';
import { PrStatus } from '@/components/marks/pr-status';
import { isChat, repoShort, type Session } from '@/lib/api';
import { age, dollars } from '@/lib/format';
import { cn } from '@/lib/utils';

/** The right-hand facts are fixed-width and tabular so the columns line up; `active` is the list's keyboard cursor, not a task state. */
export function TaskRow({ session, modelName, active = false }: { session: Session; modelName: (model: string) => string; active?: boolean }) {
	const chat = isChat(session);
	return (
		<Link
			to="/agents/$sessionId"
			params={{ sessionId: session.id }}
			search={{ app: 'code' }}
			data-active={active || undefined}
			title={session.status === 'error' ? (session.errorMessage ?? undefined) : undefined}
			className={cn(
				'group/row flex h-9 min-w-0 items-center gap-2.5 pr-4 pl-5 outline-none transition-colors duration-(--t-fast)',
				active ? 'bg-(--bg-active)' : 'hover:bg-(--bg-hover) focus-visible:shadow-(--focus-inset)',
			)}
		>
			<TaskStatusIcon session={session} size={14} />
			<span className="min-w-0 flex-1 truncate text-body text-(--text)">{session.title}</span>
			<PrStatus thread={session} />
			<span className="hidden w-[104px] shrink-0 items-center gap-1.5 text-small text-(--text-3) md:inline-flex">
				<Icon icon={chat ? MessageSquare : Github} size={12} className="shrink-0 text-(--text-4)" />
				<span className="truncate">{repoShort(session)}</span>
			</span>
			<span className="hidden w-[120px] shrink-0 truncate text-small text-(--text-3) lg:inline">{session.model ? modelName(session.model) : null}</span>
			<span className="in-num hidden w-[64px] shrink-0 text-right text-small text-(--text-3) sm:inline">{session.usage.cost ? dollars(session.usage.cost) : null}</span>
			<span className="in-num w-11 shrink-0 text-right text-small text-(--text-3)" title={new Date(session.createdAt).toLocaleString()}>
				{age(session.createdAt)}
			</span>
		</Link>
	);
}

import { Link } from '@tanstack/react-router';
import { GitBranch, Github, type LucideIcon, MessageSquare } from 'lucide-react';
import type { ReactNode } from 'react';
import { Pips } from '@/components/instrument';
import { ModelLogo } from '@/components/model-picker';
import { Icon } from '@/components/signal';
import { isLive, liveLabel, TaskStatusIcon } from '@/components/task-status';
import { PrStatus } from '@/components/pr-status';
import { branchLabel, isChat, type Session } from '@/lib/api';
import { age, dollars, tokens } from '@/lib/format';
import { cn } from '@/lib/utils';

/** Tokens a task's replies used, in and out. */
export const used = (session: Session) => session.usage.inputTokens + session.usage.outputTokens;

/** A fact on the row's second line: an icon and a few words. */
function Fact({ icon, mono, title, children }: { icon?: LucideIcon; mono?: boolean; title?: string; children: ReactNode }) {
	return (
		<span title={title} className={cn('inline-flex min-w-0 shrink items-center gap-1 text-[11.5px] text-(--text-tertiary)', mono && 'font-mono text-[11px]')}>
			{icon ? <Icon icon={icon} size={12} className="text-(--icon-tertiary)" /> : null}
			<span className="truncate">{children}</span>
		</span>
	);
}

/**
 * A task on two lines: its state's glyph, title and pull request (coloured
 * by its state), how long ago; then where it works, its model, a failure,
 * and what it cost. The glyph says the state, so no word repeats it.
 */
export function TaskRow({ session, modelName }: { session: Session; modelName: (model: string) => string }) {
	const runs = session.pullRequest?.runs ?? [];
	const tokensUsed = used(session);
	const chat = isChat(session);
	const live = isLive(session) && !session.working;
	return (
		<Link
			to="/agents/$sessionId"
			params={{ sessionId: session.id }}
			search={{ app: 'code' }}
			className="flex min-w-0 flex-col gap-0.5 rounded-[10px] px-2.5 py-2 outline-none hover:bg-(--bg-hover) focus-visible:shadow-(--focus-ring)"
		>
			<div className="flex min-w-0 items-center gap-2">
				<TaskStatusIcon session={session} size={14} />
				<span className="min-w-0 truncate text-[13px] leading-[18px] font-medium text-(--text-primary)">{session.title}</span>
				<PrStatus thread={session} />
				{runs.length ? (
					<Pips label={`${runs.length} checks`} items={runs.map((run) => ({ tone: run.status === 'passed' ? 'success' : run.status === 'failed' ? 'danger' : 'neutral', title: run.name }))} />
				) : null}
				<span className="flex-1" />
				{live ? <span title={`Sandbox ${liveLabel(session).toLowerCase()}`} aria-label="Sandbox on" className="in-pulse size-1.5 shrink-0 rounded-full bg-(--accent-base)" /> : null}
				<span className="in-num shrink-0 text-[11px] text-(--text-disabled)" title={new Date(session.createdAt).toLocaleString()}>
					{age(session.createdAt)}
				</span>
			</div>
			<div className="flex min-w-0 items-center gap-3 pl-[22px]">
				<Fact icon={chat ? MessageSquare : Github} title={chat ? undefined : session.repo}>
					{chat ? 'Chat' : session.repo}
				</Fact>
				{!chat || session.workspace ? (
					<Fact icon={GitBranch} mono>
						{branchLabel(session)}
					</Fact>
				) : null}
				{session.model ? (
					<span className="inline-flex min-w-0 shrink items-center gap-1 text-[11.5px] text-(--text-tertiary)" title={session.model}>
						<ModelLogo model={session.model} size={13} />
						<span className="truncate">{modelName(session.model)}</span>
					</span>
				) : null}
				{session.status === 'error' && session.errorMessage ? (
					<span className="min-w-0 flex-1 truncate text-[11.5px] text-(--danger-text)" title={session.errorMessage}>
						{session.errorMessage}
					</span>
				) : (
					<span className="flex-1" />
				)}
				<span className="in-num flex shrink-0 items-center gap-1.5 text-[11px] text-(--text-tertiary)">
					{tokensUsed ? (
						<>
							<span className="text-(--text-secondary)">{dollars(session.usage.cost)}</span>
							<span className="text-(--text-disabled)">·</span>
							<span>{tokens(tokensUsed)} tok</span>
						</>
					) : (
						'—'
					)}
				</span>
			</div>
		</Link>
	);
}

import { Glyph, glyphKind, KIND_LABEL } from '@/components/thread-glyph';
import type { Session } from '@/lib/api';

/** Whether a task's sandbox is up: starting, idle or busy with the agent. */
export const isLive = (session: Session) => session.working || session.status === 'running' || session.status === 'starting';

/** What a live task's sandbox is doing, in a word; Idle is a task's state, not its sandbox's, so an idle sandbox is Running. */
export function liveLabel(session: Session): string {
	if (session.status === 'starting') return 'Starting';
	return session.working ? 'Working' : 'Running';
}

/**
 * Where the task stands as one mark: the same glyph and the same states (Needs you, Working, Idle, Done…) a
 * project shows its threads with, so a task reads the same in the sidebar, the task list and its project.
 * Whether its sandbox runs is said apart, by the list it is in.
 */
export function TaskStatusIcon({ session, size = 14 }: { session: Session; size?: number }) {
	const kind = glyphKind(session);
	return <Glyph kind={kind} size={size} title={KIND_LABEL[kind]} />;
}

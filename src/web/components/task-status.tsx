import { CircleAlert, CircleCheck, CircleDot, MessageCircleQuestion } from 'lucide-react';
import { Icon, Spinner } from '@/components/signal';
import type { Session } from '@/lib/api';

/** Whether a task's sandbox is up: starting, idle or busy with the agent. */
export const isLive = (session: Session) => session.working || session.status === 'running' || session.status === 'starting';

/** What a live task is doing, in a word. */
export function liveLabel(session: Session): string {
	if (session.status === 'starting') return 'Starting';
	return session.working ? 'Working' : 'Idle';
}

/** Spins only while something is happening; a live but idle sandbox gets a still dot. */
export function TaskStatusIcon({ session, size = 14 }: { session: Session; size?: number }) {
	if (session.working || session.status === 'starting') return <Spinner size={size} />;
	if (session.status === 'error') return <Icon icon={CircleAlert} size={size} className="text-(--danger-text)" />;
	if (session.asking) return <Icon icon={MessageCircleQuestion} size={size} className="text-(--warning-text)" />;
	if (session.status === 'running') return <Icon icon={CircleDot} size={size} className="text-(--accent-text)" />;
	return <Icon icon={CircleCheck} size={size} className="text-(--success-text)" />;
}

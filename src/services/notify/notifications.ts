import { randomUUID } from 'node:crypto';
import { announce } from '../../core/changes.ts';
import type { SessionRecord } from '../../core/types.ts';
import { listApprovals } from '../../db/mail-approvals.ts';
import { deleteNotificationsOf, insertNotification, listNotificationRecords, type NotificationRecord, setNotificationsRead } from '../../db/notifications.ts';
import { getSessionRecord } from '../../db/sessions.ts';
import { listToolApprovals } from '../../db/tool-approvals.ts';
import { logProblem } from '../../core/log.ts';

/** Rows are keyed by what they stand for (a task's last reply, its sandbox, its pull request), so a newer one replaces the older. */

export const NOTIFICATION_KINDS = [
	'question',
	'plan',
	'approval',
	'replied',
	'done',
	'merged',
	'failed',
	'checks-failed',
	'budget',
	'sandbox-ready',
	'sandbox-stopped',
	'sandbox-failed',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export type NotificationCategory = 'needs-you' | 'replies' | 'done' | 'failures' | 'sandboxes';

export const CATEGORY_OF: Record<NotificationKind, NotificationCategory> = {
	question: 'needs-you',
	plan: 'needs-you',
	approval: 'needs-you',
	replied: 'replies',
	done: 'done',
	merged: 'done',
	failed: 'failures',
	'checks-failed': 'failures',
	budget: 'failures',
	'sandbox-ready': 'sandboxes',
	'sandbox-stopped': 'sandboxes',
	'sandbox-failed': 'failures',
};

export type NotificationView = {
	id: string;
	kind: NotificationKind;
	category: NotificationCategory;
	sessionId: string | null;
	spaceId: string | null;
	title: string;
	body: string;
	url: string;
	createdAt: string;
	read: boolean;
};

const KEEP = 300;
const SHOWN = 200;
const MAX_BODY = 240;

const clip = (text: string, max = MAX_BODY) => {
	const flat = text.replace(/\s+/g, ' ').trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

const taskUrl = (task: Pick<SessionRecord, 'id' | 'spaceId'>) => (task.spaceId ? `/projects/${task.spaceId}/threads/${task.id}` : `/agents/${task.id}`);

const isKind = (kind: string): kind is NotificationKind => (NOTIFICATION_KINDS as readonly string[]).includes(kind);

function view(record: NotificationRecord): NotificationView | null {
	if (!isKind(record.kind)) return null;
	return {
		id: record.id,
		kind: record.kind,
		category: CATEGORY_OF[record.kind],
		sessionId: record.sessionId,
		spaceId: record.spaceId,
		title: record.title,
		body: record.body,
		url: record.url,
		createdAt: record.createdAt,
		read: record.readAt !== null,
	};
}

export async function notificationsView(): Promise<{ notifications: NotificationView[]; unread: Record<NotificationCategory, number> }> {
	const notifications = (await listNotificationRecords(SHOWN)).flatMap((record) => view(record) ?? []);
	const unread: Record<NotificationCategory, number> = { 'needs-you': 0, replies: 0, done: 0, failures: 0, sandboxes: 0 };
	for (const notification of notifications) if (!notification.read) unread[notification.category] += 1;
	return { notifications, unread };
}

/** Replaces the row with the same key. Never throws. */
export async function notifyTask(task: SessionRecord, slot: 'reply' | 'sandbox' | 'pr' | 'budget', kind: NotificationKind, body: string): Promise<void> {
	try {
		await insertNotification(
			{
				id: `ntf_${randomUUID()}`,
				key: `${slot}:${task.id}`,
				kind,
				sessionId: task.id,
				spaceId: task.spaceId ?? null,
				title: clip(task.title || 'Untitled task', 120),
				body: clip(body),
				url: taskUrl(task),
				createdAt: new Date().toISOString(),
			},
			KEEP,
		);
		announce({ kind: 'notifications' });
	} catch (error) {
		logProblem('warn', 'Could not add a notification', error, task.id);
	}
}

async function notifyId(id: string, slot: 'reply' | 'sandbox' | 'pr' | 'budget', kind: NotificationKind, body: string): Promise<void> {
	const task = await getSessionRecord(id).catch(() => null);
	if (task) await notifyTask(task, slot, kind, body);
}

export async function markNotifications(which: { ids?: string[]; sessionId?: string; all?: boolean }, read: boolean): Promise<void> {
	const changed = await setNotificationsRead(which, read ? new Date().toISOString() : null);
	if (changed > 0) announce({ kind: 'notifications' });
}

export async function forgetNotificationsOf(sessionId: string): Promise<void> {
	if ((await deleteNotificationsOf(sessionId).catch(() => 0)) > 0) announce({ kind: 'notifications' });
}

async function waitingApproval(id: string): Promise<string | null> {
	const [tools, mail] = await Promise.all([listToolApprovals(id).catch(() => []), listApprovals(id).catch(() => [])]);
	const tool = tools.find((approval) => approval.state === 'pending');
	if (tool) return `Wants to run ${tool.tool} on ${tool.connector.replace(/^composio:/, '')}. Run it or turn it down.`;
	const email = mail.find((approval) => approval.state === 'pending');
	if (email) return `Wants to send an email${email.draft.to.length ? ` to ${email.draft.to.join(', ')}` : ''}. Send it or turn it down.`;
	return null;
}

export async function replyOutcome(task: SessionRecord, reply: string | null): Promise<{ kind: NotificationKind; body: string } | null> {
	if (task.failed) return { kind: 'failed', body: `Failed: ${task.errorMessage ?? 'the task stopped with an error.'}` };
	if (task.asking) return { kind: 'question', body: task.asking };
	const approval = await waitingApproval(task.id);
	if (approval) return { kind: 'approval', body: approval };
	if (task.planMode && task.plan) return { kind: 'plan', body: 'Plan ready. Approve it or ask for changes.' };
	if (task.resolvedAt) return { kind: 'done', body: !reply ? 'Done.' : /^done\b/i.test(reply) ? reply : `Done: ${reply}` };
	if (!reply) return null;
	return { kind: 'replied', body: reply };
}

/** Runs once the reply has settled and been judged done or not. Never throws. */
export async function replyNotification(id: string, reply: string | null): Promise<void> {
	try {
		const task = await getSessionRecord(id);
		const outcome = task && (await replyOutcome(task, reply));
		if (task && outcome) await notifyTask(task, 'reply', outcome.kind, outcome.body);
	} catch (error) {
		logProblem('warn', 'Could not add a notification', error, id);
	}
}

type SettledEvent = { type: string; instanceId?: string; agentName?: string; outcome?: string; error?: unknown };

const errorText = (error: unknown) =>
	error && typeof error === 'object' && 'message' in error && typeof error.message === 'string' ? error.message : typeof error === 'string' ? error : null;

export function notifyFailedReply(event: SettledEvent): void {
	if (event.type !== 'submission_settled' || event.outcome !== 'failed' || !event.instanceId) return;
	if (event.agentName && !/^coder$/i.test(event.agentName)) return;
	void notifyId(event.instanceId, 'reply', 'failed', `Failed: ${errorText(event.error) ?? 'the reply stopped with an error.'}`);
}

/** Only for a sandbox made and set up for the task, not resumed; not for a task on this server. */
export function notifySandboxReady(task: SessionRecord, ms: number): void {
	if (task.runOn === 'host') return;
	void notifyTask(task, 'sandbox', 'sandbox-ready', `Sandbox created and set up in ${seconds(ms)}.`);
}

export function notifySandboxFailed(task: SessionRecord, error: unknown): void {
	if (task.runOn === 'host') return;
	void notifyTask(task, 'sandbox', 'sandbox-failed', `Sandbox could not start: ${errorText(error) ?? 'setup failed.'}`);
}

/** Without idle minutes, it stopped because its pull request merged or closed. */
export function notifySandboxStopped(id: string, idleMinutes: number | null): void {
	const why = idleMinutes === null ? 'Sandbox stopped: the task is done.' : `Sandbox stopped after ${idleMinutes} idle ${idleMinutes === 1 ? 'minute' : 'minutes'}.`;
	void notifyId(id, 'sandbox', 'sandbox-stopped', `${why} Files are saved; it starts again when needed.`);
}

const prName = (url: string) => {
	const number = /\/pull\/(\d+)/.exec(url)?.[1];
	return number ? `Pull request #${number}` : 'The pull request';
};

export function notifyPullRequest(task: SessionRecord, before: SessionRecord['pullRequest'], after: NonNullable<SessionRecord['pullRequest']>): void {
	if (!task.prUrl) return;
	const name = prName(task.prUrl);
	if (after.state === 'merged' && before?.state !== 'merged') return void notifyTask(task, 'pr', 'merged', `${name} merged. The task is done.`);
	if (after.checks === 'failed' && before?.checks !== 'failed') {
		const failing = after.runs.filter((run) => run.status === 'failed').map((run) => run.name);
		void notifyTask(task, 'pr', 'checks-failed', `Checks failed on ${name.charAt(0).toLowerCase()}${name.slice(1)}${failing.length ? `: ${failing.slice(0, 3).join(', ')}${failing.length > 3 ? ` and ${failing.length - 3} more` : ''}` : '.'}`);
	}
}

export function notifyBudgetStop(id: string, reason: string): void {
	void notifyId(id, 'budget', 'budget', `Stopped: ${reason}`);
}

const seconds = (ms: number) => (ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`);

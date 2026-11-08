import { randomUUID } from 'node:crypto';
import { announce } from '../core/changes.ts';
import type { SessionRecord } from '../core/types.ts';
import { listApprovals } from '../db/mail-approvals.ts';
import { deleteNotificationsOf, insertNotification, listNotificationRecords, type NotificationRecord, setNotificationsRead } from '../db/notifications.ts';
import { getSessionRecord } from '../db/sessions.ts';
import { listToolApprovals } from '../db/tool-approvals.ts';
import { logProblem } from './log.ts';

/**
 * The Notifications dialog: the moments in a task worth a look, not every
 * step it takes. A task's reply ends in one row (it asks you something, wants
 * a plan or a call approved, answered, finished the work, or failed), its
 * sandbox in another (made, stopped once idle, or failed to start) and its
 * pull request in a third (checks failed, merged). Each is keyed by what it
 * stands for, so a newer one replaces the older and a busy task never fills
 * the list: the row for its last reply says how that reply ended.
 */

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

/** The filters the dialog offers; each kind falls under one. */
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

/** How many rows are kept, and how many the dialog is sent. */
const KEEP = 300;
const SHOWN = 200;
const MAX_BODY = 240;

const clip = (text: string, max = MAX_BODY) => {
	const flat = text.replace(/\s+/g, ' ').trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** Where a row opens its task: a project's thread inside its project, as a pushed notification does. */
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

/** The newest rows, and how many are unread in each category. */
export async function notificationsView(): Promise<{ notifications: NotificationView[]; unread: Record<NotificationCategory, number> }> {
	const notifications = (await listNotificationRecords(SHOWN)).flatMap((record) => view(record) ?? []);
	const unread: Record<NotificationCategory, number> = { 'needs-you': 0, replies: 0, done: 0, failures: 0, sandboxes: 0 };
	for (const notification of notifications) if (!notification.read) unread[notification.category] += 1;
	return { notifications, unread };
}

/**
 * Adds a row about a task, replacing the one with the same key. `slot`
 * names what it stands for in the task: its last reply, its sandbox, its
 * pull request or its spending. Never throws.
 */
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

/** Same as `notifyTask`, for a task known by id; a task that is gone gets none. */
async function notifyId(id: string, slot: 'reply' | 'sandbox' | 'pr' | 'budget', kind: NotificationKind, body: string): Promise<void> {
	const task = await getSessionRecord(id).catch(() => null);
	if (task) await notifyTask(task, slot, kind, body);
}

export async function markNotifications(which: { ids?: string[]; sessionId?: string; all?: boolean }, read: boolean): Promise<void> {
	const changed = await setNotificationsRead(which, read ? new Date().toISOString() : null);
	if (changed > 0) announce({ kind: 'notifications' });
}

/** A deleted task's rows would open nothing. */
export async function forgetNotificationsOf(sessionId: string): Promise<void> {
	if ((await deleteNotificationsOf(sessionId).catch(() => 0)) > 0) announce({ kind: 'notifications' });
}

/** A call or an email the agent asked to make that still waits on Run or Send. */
async function waitingApproval(id: string): Promise<string | null> {
	const [tools, mail] = await Promise.all([listToolApprovals(id).catch(() => []), listApprovals(id).catch(() => [])]);
	const tool = tools.find((approval) => approval.state === 'pending');
	if (tool) return `Wants to run ${tool.tool} on ${tool.connector.replace(/^composio:/, '')}. Run it or turn it down.`;
	const email = mail.find((approval) => approval.state === 'pending');
	if (email) return `Wants to send an email${email.draft.to.length ? ` to ${email.draft.to.join(', ')}` : ''}. Send it or turn it down.`;
	return null;
}

/** How a reply ended, as one row: what it waits on from you first, then whether it finished the work, then what it said. */
export async function replyOutcome(task: SessionRecord, reply: string | null): Promise<{ kind: NotificationKind; body: string } | null> {
	if (task.failed) return { kind: 'failed', body: `Failed: ${task.errorMessage ?? 'the task stopped with an error.'}` };
	if (task.asking) return { kind: 'question', body: task.asking };
	const approval = await waitingApproval(task.id);
	if (approval) return { kind: 'approval', body: approval };
	if (task.planMode && task.plan) return { kind: 'plan', body: 'Plan ready. Approve it or ask for changes.' };
	if (task.resolvedAt) return { kind: 'done', body: reply ? `Done: ${reply}` : 'Done.' };
	if (!reply) return null;
	return { kind: 'replied', body: reply };
}

/** At the end of a task's reply, once it has settled and been judged done or not. Never throws. */
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

/** A coding agent's reply that failed, from the runtime's events. Runs in the event observer. */
export function notifyFailedReply(event: SettledEvent): void {
	if (event.type !== 'submission_settled' || event.outcome !== 'failed' || !event.instanceId) return;
	if (event.agentName && !/^coder$/i.test(event.agentName)) return;
	void notifyId(event.instanceId, 'reply', 'failed', `Failed: ${errorText(event.error) ?? 'the reply stopped with an error.'}`);
}

/** A task's sandbox made and set up for it, rather than resumed or still running. Not for a task on this server. */
export function notifySandboxReady(task: SessionRecord, ms: number): void {
	if (task.runOn === 'host') return;
	void notifyTask(task, 'sandbox', 'sandbox-ready', `Sandbox created and set up in ${seconds(ms)}.`);
}

export function notifySandboxFailed(task: SessionRecord, error: unknown): void {
	if (task.runOn === 'host') return;
	void notifyTask(task, 'sandbox', 'sandbox-failed', `Sandbox could not start: ${errorText(error) ?? 'setup failed.'}`);
}

/** Torn down after its idle minutes, its files saved first; a sandbox you stopped yourself needs no word. */
export function notifySandboxStopped(id: string, idleMinutes: number): void {
	void notifyId(id, 'sandbox', 'sandbox-stopped', `Sandbox stopped after ${idleMinutes} idle ${idleMinutes === 1 ? 'minute' : 'minutes'}. Files are saved; it starts again when needed.`);
}

const prName = (url: string) => {
	const number = /\/pull\/(\d+)/.exec(url)?.[1];
	return number ? `Pull request #${number}` : 'The pull request';
};

/** A pull request's checks turning red, or it merging: the two moments in its life worth a look. */
export function notifyPullRequest(task: SessionRecord, before: SessionRecord['pullRequest'], after: NonNullable<SessionRecord['pullRequest']>): void {
	if (!task.prUrl) return;
	const name = prName(task.prUrl);
	if (after.state === 'merged' && before?.state !== 'merged') return void notifyTask(task, 'pr', 'merged', `${name} merged. The task is done.`);
	if (after.checks === 'failed' && before?.checks !== 'failed') {
		const failing = after.runs.filter((run) => run.status === 'failed').map((run) => run.name);
		void notifyTask(task, 'pr', 'checks-failed', `Checks failed on ${name.charAt(0).toLowerCase()}${name.slice(1)}${failing.length ? `: ${failing.slice(0, 3).join(', ')}${failing.length > 3 ? ` and ${failing.length - 3} more` : ''}` : '.'}`);
	}
}

/** A reply stopped for going over a spending cap. */
export function notifyBudgetStop(id: string, reason: string): void {
	void notifyId(id, 'budget', 'budget', `Stopped: ${reason}`);
}

const seconds = (ms: number) => (ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`);

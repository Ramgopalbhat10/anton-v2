import { json, post } from './http';

export type ToolApproval = {
	id: string;
	connector: string;
	tool: string;
	args: Record<string, unknown>;
	state: 'pending' | 'running' | 'done' | 'declined' | 'failed';
	result: string | null;
	error: string | null;
	createdAt: string;
	decidedAt: string | null;
};
export type MailApproval = {
	id: string;
	connector: string;
	draftId: string;
	to: string[];
	cc: string[];
	bcc: string[];
	subject: string;
	body: string;
	state: 'pending' | 'sending' | 'sent' | 'declined' | 'changed';
	decidedAt: string | null;
};

export type PushDevice = { id: string; name: string; addedAt: string; lastSentAt: string | null; lastError: string | null };
/** `publicKey` is empty when the server cannot send notifications. */
export type PushView = { publicKey: string; devices: PushDevice[]; finished: boolean };
export type PushSubscriptionJson = { endpoint: string; keys: { p256dh: string; auth: string } };

export type NotificationKind =
	| 'question'
	| 'plan'
	| 'approval'
	| 'replied'
	| 'done'
	| 'merged'
	| 'failed'
	| 'checks-failed'
	| 'budget'
	| 'sandbox-ready'
	| 'sandbox-stopped'
	| 'sandbox-failed';
export type NotificationCategory = 'needs-you' | 'replies' | 'done' | 'failures' | 'sandboxes';
export type AppNotification = {
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
export type NotificationsView = { notifications: AppNotification[]; unread: Record<NotificationCategory, number> };

export const notifyApi = {
	push: () => json<PushView>('/api/push'),
	notifications: () => json<NotificationsView>('/api/notifications'),
	/** Marks rows read, or unread with `read: false`: the ones named, a task's, or all. */
	readNotifications: (which: { ids?: string[]; sessionId?: string; all?: boolean; read?: boolean }) => post<NotificationsView>('/api/notifications/read', which),
	addPushDevice: (subscription: PushSubscriptionJson & { name: string }) => post<PushView>('/api/push/devices', subscription),
	removePushDevice: (id: string) => json<PushView>(`/api/push/devices/${encodeURIComponent(id)}`, { method: 'DELETE' }),
	testPush: (device?: string) => post<{ sent: number }>('/api/push/test', device ? { device } : {}),
	savePushOptions: (options: { finished: boolean }) => json<PushView>('/api/push/options', { method: 'PUT', body: JSON.stringify(options) }),
	mailApprovals: (sessionId: string) => json<{ approvals: MailApproval[] }>(`/api/sessions/${sessionId}/mail`),
	decideMail: (sessionId: string, approval: string, send: boolean) => post<MailApproval>(`/api/sessions/${sessionId}/mail/${approval}`, { send }),
	toolApprovals: (sessionId: string) => json<{ approvals: ToolApproval[] }>(`/api/sessions/${sessionId}/tool-approvals`),
	decideToolApproval: (sessionId: string, approval: string, run: boolean) => post<ToolApproval>(`/api/sessions/${sessionId}/tool-approvals/${approval}`, { run }),
};

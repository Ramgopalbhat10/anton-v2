import { createHash } from 'node:crypto';
import { config } from '../config.ts';
import type { PushKeys, PushTarget } from '../core/ports.ts';
import { NotFoundError } from '../core/errors.ts';
import type { Session } from '../core/types.ts';
import { getSessionRecord } from '../db/sessions.ts';
import { getSetting, setSetting } from '../db/settings.ts';
import { getProviders } from '../providers/index.ts';
import { logProblem } from './log.ts';
import { getSession } from './sessions.ts';

/**
 * Notifications that reach you with no Anton tab open: a phone with Anton on
 * its home screen, or a browser in the background. Each device you turn them
 * on for is kept with its push subscription; when a task needs you, fails,
 * or (if you ask) finishes, every device hears of it, unless an Anton window
 * is in front of you right now, where the page already shows it.
 */

type Device = PushTarget & { name: string; addedAt: string; lastSentAt: string | null; lastError: string | null };
type PushState = { devices: Device[]; finished: boolean };

const STATE_KEY = 'push';
const KEYS_KEY = 'push-keys';
const EMPTY: PushState = { devices: [], finished: false };

export type PushDevice = { id: string; name: string; addedAt: string; lastSentAt: string | null; lastError: string | null };
export type PushView = { publicKey: string; devices: PushDevice[]; finished: boolean };

export type NoticeKind = 'needs-you' | 'plan' | 'failed' | 'finished' | 'test';
/** What the device's service worker shows; `url` opens when the notification is tapped. */
export type Notice = { kind: NoticeKind; title: string; body: string; url: string; tag: string };

/** A device is named in the page by a short hash of its endpoint, which is a credential of sorts and stays on the server. */
export const deviceId = (endpoint: string) => createHash('sha256').update(endpoint).digest('base64url').slice(0, 16);

const MAX_BODY = 180;
const clip = (text: string, max = MAX_BODY) => {
	const flat = text.replace(/\s+/g, ' ').trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

async function state(): Promise<PushState> {
	return { ...EMPTY, ...(await getSetting<Partial<PushState>>(STATE_KEY, EMPTY)) };
}

/** Made once and kept, as each subscription is tied to the public key it was made with. */
async function keys(): Promise<PushKeys | null> {
	const sender = getProviders().push;
	if (!sender) return null;
	const saved = await getSetting<PushKeys | null>(KEYS_KEY, null);
	if (saved) return saved;
	const made = sender.generateKeys();
	await setSetting(KEYS_KEY, made);
	return made;
}

const shown = (device: Device): PushDevice => ({ id: deviceId(device.endpoint), name: device.name, addedAt: device.addedAt, lastSentAt: device.lastSentAt, lastError: device.lastError });

/** The key a browser subscribes with, the devices that get notifications, and what they get. Empty `publicKey` when push is unavailable. */
export async function pushView(): Promise<PushView> {
	const current = await state();
	return { publicKey: (await keys())?.publicKey ?? '', devices: current.devices.map(shown), finished: current.finished };
}

/**
 * Keeps a device's subscription, replacing the one it had. A browser makes a
 * new one when its old one expires; that one `replaces` the old and keeps its name.
 */
export async function addDevice(target: PushTarget, name: string, replaces?: string): Promise<PushView> {
	const current = await state();
	const previous = current.devices.find((device) => device.endpoint === (replaces ?? target.endpoint));
	const kept = current.devices.filter((device) => device.endpoint !== target.endpoint && device.endpoint !== replaces);
	const device: Device = {
		endpoint: target.endpoint,
		keys: target.keys,
		name: clip(name || previous?.name || 'This device', 60),
		addedAt: previous?.addedAt ?? new Date().toISOString(),
		lastSentAt: previous?.lastSentAt ?? null,
		lastError: null,
	};
	await setSetting(STATE_KEY, { ...current, devices: [...kept, device] });
	return pushView();
}

export async function removeDevice(id: string): Promise<PushView> {
	const current = await state();
	await setSetting(STATE_KEY, { ...current, devices: current.devices.filter((device) => deviceId(device.endpoint) !== id) });
	return pushView();
}

export async function setPushOptions(options: { finished: boolean }): Promise<PushView> {
	await setSetting(STATE_KEY, { ...(await state()), finished: options.finished });
	return pushView();
}

/** When an Anton window was last in front of you; pages say so while they are visible and focused. */
let presentAt = 0;
/** How long a page's word that it is in front of you holds; pages repeat it well within this. */
export const PRESENCE_MS = 75_000;

export function notePresence(present: boolean, now = Date.now()): void {
	presentAt = present ? now : 0;
}

export const someoneLooking = (now = Date.now()) => now - presentAt < PRESENCE_MS;

/** Sends a notice to every device (or one); forgets devices whose subscription is gone. Returns how many took it. */
export async function notifyDevices(notice: Notice, only?: string): Promise<number> {
	const sender = getProviders().push;
	const auth = await keys();
	const current = await state();
	const targets = current.devices.filter((device) => !only || deviceId(device.endpoint) === only);
	if (!sender || !auth || targets.length === 0) return 0;
	const urgent = notice.kind !== 'finished';
	const message = {
		payload: JSON.stringify(notice),
		ttlSeconds: urgent ? 24 * 60 * 60 : 60 * 60,
		urgency: urgent ? ('high' as const) : ('normal' as const),
		// A newer notice for the same task replaces one a sleeping phone has not picked up yet.
		topic: notice.tag.replace(/[^A-Za-z0-9_-]/g, '').slice(-32),
	};
	const results = await Promise.all(
		targets.map(async (device) => {
			try {
				const result = await sender.send(device, message, { keys: auth, subject: config.pushContact });
				return { device, ...result };
			} catch (error) {
				return { device, ok: false, gone: false, status: 0, detail: error instanceof Error ? error.message : String(error) };
			}
		}),
	);
	const at = new Date().toISOString();
	const outcome = new Map(results.map((result) => [result.device.endpoint, result]));
	// Read again, as a device may have been added while the messages were out.
	const latest = await state();
	await setSetting(STATE_KEY, {
		...latest,
		devices: latest.devices.flatMap((device) => {
			const result = outcome.get(device.endpoint);
			if (!result) return [device];
			if (result.gone) return [];
			return [{ ...device, lastSentAt: result.ok ? at : device.lastSentAt, lastError: result.ok ? null : clip(`${result.status || 'No answer'} ${result.detail}`, 200) }];
		}),
	});
	for (const result of results) {
		if (!result.ok && !result.gone) logProblem('warn', `Could not send a notification to ${result.device.name}`, `${result.status} ${result.detail}`);
	}
	return results.filter((result) => result.ok).length;
}

export async function sendTest(id?: string): Promise<{ sent: number }> {
	if (id && !(await state()).devices.some((device) => deviceId(device.endpoint) === id)) throw new NotFoundError('Device not found');
	const sent = await notifyDevices({ kind: 'test', title: 'Anton', body: 'Notifications are on. Tasks that need you will show up here.', url: '/', tag: 'anton-test' }, id);
	return { sent };
}

/** Where tapping a task's notification goes: a project's thread opens inside its project. */
export const taskUrl = (session: Pick<Session, 'id' | 'spaceId'>) => (session.spaceId ? `/projects/${session.spaceId}/threads/${session.id}` : `/agents/${session.id}`);

/** What a task's notice says at the end of a reply, or null when there is nothing to tell. */
export function noticeFor(session: Session, reply: string | null, finished: boolean): Notice | null {
	const base = { title: clip(session.title, 80), url: taskUrl(session), tag: `anton-${session.id}` };
	if (session.status === 'error') return { ...base, kind: 'failed', body: clip(`Failed: ${session.errorMessage ?? 'the task stopped with an error.'}`) };
	if (session.asking) return { ...base, kind: 'needs-you', body: clip(session.asking) };
	if (session.planMode && session.plan) return { ...base, kind: 'plan', body: 'Plan ready. Approve it or ask for changes.' };
	if (!finished) return null;
	return { ...base, kind: 'finished', body: clip(reply ? `Finished: ${reply}` : 'Finished.') };
}

async function sendFor(id: string, make: (session: Session, finished: boolean) => Notice | null): Promise<void> {
	if (someoneLooking()) return;
	const current = await state();
	if (current.devices.length === 0) return;
	const session = await getSession(id);
	const notice = make(session, current.finished);
	if (notice) await notifyDevices(notice);
}

/** At the end of a task's reply: tells your devices when it waits on you, failed, or finished. Never throws. */
export async function replyNotice(id: string, reply: string | null): Promise<void> {
	await sendFor(id, (session, finished) => noticeFor(session, reply, finished)).catch((error: unknown) => logProblem('warn', 'Could not send a notification', error, id));
}

type SettledEvent = { type: string; instanceId?: string; agentName?: string; outcome?: string; error?: unknown };

const errorText = (error: unknown) =>
	error && typeof error === 'object' && 'message' in error && typeof error.message === 'string' ? error.message : typeof error === 'string' ? error : null;

/** A coding agent's reply that failed, from the runtime's events: its devices hear of it. Runs in the event observer. */
export function recordFailedReply(event: SettledEvent): void {
	if (event.type !== 'submission_settled' || event.outcome !== 'failed' || !event.instanceId) return;
	if (event.agentName && !/^coder$/i.test(event.agentName)) return;
	const id = event.instanceId;
	const detail = errorText(event.error);
	void (async () => {
		if (!(await getSessionRecord(id))) return;
		await sendFor(id, (session) => ({
			kind: 'failed',
			title: clip(session.title, 80),
			body: clip(`Failed: ${detail ?? 'the reply stopped with an error.'}`),
			url: taskUrl(session),
			tag: `anton-${session.id}`,
		}));
	})().catch((error: unknown) => logProblem('warn', 'Could not send a notification', error, id));
}

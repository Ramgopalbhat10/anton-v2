import assert from 'node:assert/strict';
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, verify } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';
import type { PushMessage, PushSender, PushTarget } from '../src/core/ports.ts';
import type { Providers } from '../src/providers/index.ts';

const dir = mkdtempSync(path.join(os.tmpdir(), 'anton-push-'));
process.env.ANTON_DATA_DIR = dir;
after(() => rmSync(dir, { recursive: true, force: true }));

const { encrypt, vapidToken, webPushSender } = await import('../src/providers/webpush/sender.ts');
const { setProviders } = await import('../src/providers/index.ts');
const { upsertProject } = await import('../src/db/projects.ts');
const { insertSession, updateSession } = await import('../src/db/sessions.ts');
const { setSetting } = await import('../src/db/settings.ts');
const push = await import('../src/services/push.ts');

/** A browser's side of a subscription: its key pair and auth secret. */
function browser(endpoint = `https://push.example/${randomBytes(6).toString('hex')}`) {
	const ecdh = createECDH('prime256v1');
	ecdh.generateKeys();
	const auth = randomBytes(16);
	const target: PushTarget = { endpoint, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } };
	return { ecdh, auth, target };
}

/** Decrypts as the browser does (RFC 8291), from the body alone and the browser's own keys. */
function decrypt(body: Buffer, receiver: ReturnType<typeof browser>): string {
	const salt = body.subarray(0, 16);
	const idLength = body[20]!;
	const sender = body.subarray(21, 21 + idLength);
	const sealed = body.subarray(21 + idLength);
	const shared = receiver.ecdh.computeSecret(sender);
	const info = Buffer.concat([Buffer.from('WebPush: info\0'), receiver.ecdh.getPublicKey(), sender]);
	const ikm = Buffer.from(hkdfSync('sha256', shared, receiver.auth, info, 32));
	const key = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
	const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
	const decipher = createDecipheriv('aes-128-gcm', key, nonce);
	decipher.setAuthTag(sealed.subarray(-16));
	const padded = Buffer.concat([decipher.update(sealed.subarray(0, -16)), decipher.final()]);
	assert.equal(padded[padded.length - 1], 2, 'one record, ending with the last-record delimiter');
	return padded.subarray(0, -1).toString();
}

test('a message is encrypted so only the subscribed browser reads it', () => {
	const receiver = browser();
	const body = encrypt(receiver.target, Buffer.from('{"title":"Anton"}'));
	assert.equal(body.readUInt32BE(16), 4096);
	assert.equal(decrypt(body, receiver), '{"title":"Anton"}');
	assert.throws(() => decrypt(body, browser()));
});

test('the VAPID token is an ES256 JWT for the push service, signed with the kept key pair', () => {
	const keys = webPushSender().generateKeys();
	assert.equal(Buffer.from(keys.publicKey, 'base64url').length, 65);
	const token = vapidToken('https://push.example', keys, 'mailto:me@example.com', Date.UTC(2026, 9, 14));
	const [header, claims, signature] = token.split('.');
	assert.deepEqual(JSON.parse(Buffer.from(header!, 'base64url').toString()), { typ: 'JWT', alg: 'ES256' });
	assert.deepEqual(JSON.parse(Buffer.from(claims!, 'base64url').toString()), { aud: 'https://push.example', exp: Date.UTC(2026, 9, 14) / 1000 + 12 * 3600, sub: 'mailto:me@example.com' });
	const point = Buffer.from(keys.publicKey, 'base64url');
	const publicKey = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33).toString('base64url') }, format: 'jwk' });
	assert.ok(verify('sha256', Buffer.from(`${header}.${claims}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature!, 'base64url')));
});

const sent: Array<{ endpoint: string; message: PushMessage }> = [];
let gone = new Set<string>();
const fakeSender: PushSender = {
	generateKeys: () => webPushSender().generateKeys(),
	send: async (target, message) => {
		sent.push({ endpoint: target.endpoint, message });
		return gone.has(target.endpoint) ? { ok: false, gone: true, status: 410, detail: 'expired' } : { ok: true, gone: false, status: 201, detail: '' };
	},
};
setProviders({ sandbox: { running: async () => new Set<string>() }, push: fakeSender } as unknown as Providers);

const project = await upsertProject('acme/demo', 'main');
await insertSession({ id: 'task-1', projectId: project.id, title: 'Fix the login page', model: 'x', reasoning: null, branch: 'b', baseBranch: 'main', baseSha: 'abc', planMode: false });

beforeEach(async () => {
	sent.length = 0;
	gone = new Set();
	push.notePresence(false);
	await setSetting('push', { devices: [], finished: false });
	await updateSession('task-1', { asking: null, plan: null });
});

test('devices are kept by endpoint, listed by a hash of it, and removed by that id', async () => {
	const phone = browser('https://push.example/phone');
	const view = await push.addDevice(phone.target, 'iPhone');
	assert.equal(view.publicKey.length > 80, true);
	assert.deepEqual(
		view.devices.map((device) => [device.id, device.name]),
		[[push.deviceId('https://push.example/phone'), 'iPhone']],
	);
	assert.ok(!JSON.stringify(view).includes('push.example'), 'endpoints stay on the server');
	// A renewed subscription takes the old one's place and name.
	const renewed = browser('https://push.example/phone-2');
	const after = await push.addDevice(renewed.target, '', 'https://push.example/phone');
	assert.deepEqual(after.devices.map((device) => device.name), ['iPhone']);
	assert.equal((await push.removeDevice(push.deviceId('https://push.example/phone-2'))).devices.length, 0);
});

test('a reply that asks something reaches every device, saying what it asks and where to answer', async () => {
	await push.addDevice(browser('https://push.example/a').target, 'iPhone');
	await push.addDevice(browser('https://push.example/b').target, 'Chrome on Mac');
	await updateSession('task-1', { asking: 'Should the session last 30 days or 7?' });
	await push.replyNotice('task-1', 'Should the session last 30 days or 7?');
	assert.equal(sent.length, 2);
	const notice = JSON.parse(sent[0]!.message.payload);
	assert.deepEqual(notice, { kind: 'needs-you', title: 'Fix the login page', body: 'Should the session last 30 days or 7?', url: '/agents/task-1', tag: 'anton-task-1' });
	assert.equal(sent[0]!.message.urgency, 'high');
	assert.equal(sent[0]!.message.topic, 'anton-task-1');
});

test('a finished reply is sent only when asked for, and nothing while an Anton window is in front of you', async () => {
	await push.addDevice(browser().target, 'iPhone');
	await push.replyNotice('task-1', 'Done: the login page keeps you signed in.');
	assert.equal(sent.length, 0);
	await push.setPushOptions({ finished: true });
	await push.replyNotice('task-1', 'Done: the login page keeps you signed in.');
	assert.equal(JSON.parse(sent[0]!.message.payload).body, 'Finished: Done: the login page keeps you signed in.');
	assert.equal(sent[0]!.message.urgency, 'normal');
	push.notePresence(true);
	await updateSession('task-1', { asking: 'Which one?' });
	await push.replyNotice('task-1', 'Which one?');
	assert.equal(sent.length, 1);
});

test('a plan waiting for approval says so, and a project thread opens in its project', () => {
	const base = { id: 't', title: 'Plan it', status: 'stopped', asking: null, planMode: true, plan: '1. Do it', errorMessage: null } as const;
	assert.deepEqual(push.noticeFor({ ...base, spaceId: 'space_1' } as never, null, false), {
		kind: 'plan',
		title: 'Plan it',
		body: 'Plan ready. Approve it or ask for changes.',
		url: '/projects/space_1/threads/t',
		tag: 'anton-t',
	});
	assert.equal(push.noticeFor({ ...base, plan: null, spaceId: null } as never, null, false), null);
});

test('a failed reply is pushed from the runtime event, and a device the push service no longer knows is forgotten', async () => {
	await push.addDevice(browser('https://push.example/old').target, 'Old phone');
	await push.addDevice(browser('https://push.example/new').target, 'New phone');
	gone = new Set(['https://push.example/old']);
	push.recordFailedReply({ type: 'submission_settled', outcome: 'failed', instanceId: 'task-1', agentName: 'coder', error: { message: 'Model overloaded' } });
	push.recordFailedReply({ type: 'submission_settled', outcome: 'failed', instanceId: 'task-1', agentName: 'reviewer' });
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(sent.length, 2);
	assert.equal(JSON.parse(sent[0]!.message.payload).body, 'Failed: Model overloaded');
	assert.deepEqual((await push.pushView()).devices.map((device) => device.name), ['New phone']);
});

test('a test goes to one device, and says when there is none', async () => {
	const view = await push.addDevice(browser().target, 'iPhone');
	assert.deepEqual(await push.sendTest(view.devices[0]!.id), { sent: 1 });
	assert.equal(JSON.parse(sent[0]!.message.payload).kind, 'test');
	await assert.rejects(push.sendTest('nope'), /Device not found/);
});

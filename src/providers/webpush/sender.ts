import { createCipheriv, createECDH, createPrivateKey, generateKeyPairSync, hkdfSync, randomBytes, sign } from 'node:crypto';
import type { PushKeys, PushMessage, PushSender, PushTarget } from '../../core/ports.ts';

/**
 * Web Push with no library: the message is encrypted for the browser's keys
 * (RFC 8291, `aes128gcm` from RFC 8188) and the request is signed with Anton's
 * own key pair (VAPID, RFC 8292), so any browser's push service accepts it.
 */

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
const fromB64url = (text: string) => Buffer.from(text, 'base64url');

/** A push message's body is at most 4096 bytes after encryption; the header and tag take 103 of them. */
export const MAX_PAYLOAD = 3993;
/** A push service that does not answer must not hold up the reply that triggered it. */
const TIMEOUT_MS = 15_000;
/** Push services take a token for at most 24 hours. */
const TOKEN_SECONDS = 12 * 60 * 60;

function oneTimeKey() {
	const ecdh = createECDH('prime256v1');
	ecdh.generateKeys();
	return ecdh;
}

/** Encrypts `plaintext` for one browser: the request body, with the salt and Anton's one-time public key in its header. */
export function encrypt(target: PushTarget, plaintext: Uint8Array, salt = randomBytes(16), ecdh = oneTimeKey()): Buffer {
	if (plaintext.length > MAX_PAYLOAD) throw new Error(`A push message holds at most ${MAX_PAYLOAD} bytes`);
	const receiver = fromB64url(target.keys.p256dh);
	const authSecret = fromB64url(target.keys.auth);
	const sender = ecdh.getPublicKey();
	const shared = ecdh.computeSecret(receiver);
	const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), receiver, sender]);
	const ikm = Buffer.from(hkdfSync('sha256', shared, authSecret, keyInfo, 32));
	const key = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
	const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
	const cipher = createCipheriv('aes-128-gcm', key, nonce);
	// One record, so it ends with the last-record delimiter and needs no padding.
	const sealed = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
	const recordSize = Buffer.alloc(4);
	recordSize.writeUInt32BE(4096);
	return Buffer.concat([salt, recordSize, Buffer.from([sender.length]), sender, sealed]);
}

/** The VAPID token for one push service's origin, signed with Anton's private key. */
export function vapidToken(audience: string, keys: PushKeys, subject: string, now = Date.now()): string {
	const point = fromB64url(keys.publicKey);
	const key = createPrivateKey({
		key: { kty: 'EC', crv: 'P-256', d: keys.privateKey, x: b64url(point.subarray(1, 33)), y: b64url(point.subarray(33, 65)) },
		format: 'jwk',
	});
	const header = b64url(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
	const claims = b64url(Buffer.from(JSON.stringify({ aud: audience, exp: Math.floor(now / 1000) + TOKEN_SECONDS, sub: subject })));
	const signature = sign('sha256', Buffer.from(`${header}.${claims}`), { key, dsaEncoding: 'ieee-p1363' });
	return `${header}.${claims}.${b64url(signature)}`;
}

export function webPushSender(): PushSender {
	return {
		generateKeys() {
			const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
			const priv = privateKey.export({ format: 'jwk' });
			const pub = publicKey.export({ format: 'jwk' });
			if (!priv.d || !pub.x || !pub.y) throw new Error('Could not make a push key pair');
			return { publicKey: b64url(Buffer.concat([Buffer.from([4]), fromB64url(pub.x), fromB64url(pub.y)])), privateKey: priv.d };
		},
		async send(target: PushTarget, message: PushMessage, auth: { keys: PushKeys; subject: string }) {
			const body = encrypt(target, Buffer.from(message.payload));
			const token = vapidToken(new URL(target.endpoint).origin, auth.keys, auth.subject);
			const response = await fetch(target.endpoint, {
				method: 'POST',
				signal: AbortSignal.timeout(TIMEOUT_MS),
				headers: {
					Authorization: `vapid t=${token}, k=${auth.keys.publicKey}`,
					'Content-Encoding': 'aes128gcm',
					'Content-Type': 'application/octet-stream',
					TTL: String(message.ttlSeconds),
					Urgency: message.urgency,
					...(message.topic ? { Topic: message.topic } : {}),
				},
				body,
			});
			const detail = response.ok ? '' : (await response.text().catch(() => '')).slice(0, 300);
			// 404 and 410 mean the browser unsubscribed or the subscription expired.
			return { ok: response.ok, gone: response.status === 404 || response.status === 410, status: response.status, detail };
		},
	};
}

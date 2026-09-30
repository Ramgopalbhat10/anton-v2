import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { env } from './env.ts';

const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;

function aesKey(keyMaterial: string): Buffer {
	return createHash('sha256').update(keyMaterial).digest();
}

export function encryptToken(plaintext: string, keyMaterial = env.tokenEncryptionKey): string {
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', aesKey(keyMaterial), iv);
	const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
	const tag = cipher.getAuthTag();
	return Buffer.concat([iv, tag, ciphertext]).toString('base64url');
}

export function decryptToken(payload: string, keyMaterial = env.tokenEncryptionKey): string {
	const buf = Buffer.from(payload, 'base64url');
	if (buf.length < 12 + 16 + 1) throw new Error('Token payload is invalid');
	const iv = buf.subarray(0, 12);
	const tag = buf.subarray(12, 28);
	const ciphertext = buf.subarray(28);
	const decipher = createDecipheriv('aes-256-gcm', aesKey(keyMaterial), iv);
	decipher.setAuthTag(tag);
	return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

function sign(value: string, secret: string): string {
	return createHmac('sha256', secret).update(value).digest('base64url');
}

export function sealState(nonce: string, secret = env.sessionSecret): string {
	return sign(nonce, secret);
}

export function stateMatches(state: string, nonce: string, secret = env.sessionSecret): boolean {
	const expected = sealState(nonce, secret);
	const left = Buffer.from(state);
	const right = Buffer.from(expected);
	if (left.length !== right.length) return false;
	return timingSafeEqual(left, right);
}

export function sealSession(userId: string, now = Date.now(), secret = env.sessionSecret): string {
	const payload = Buffer.from(JSON.stringify({ uid: userId, exp: now + SESSION_TTL_MS })).toString('base64url');
	return `${payload}.${sign(payload, secret)}`;
}

export function openSession(token: string, now = Date.now(), secret = env.sessionSecret): string | null {
	const [payload, mac] = token.split('.');
	if (!payload || !mac || token.split('.').length !== 2) return null;
	const expected = sign(payload, secret);
	const left = Buffer.from(mac);
	const right = Buffer.from(expected);
	if (left.length !== right.length || !timingSafeEqual(left, right)) return null;
	try {
		const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { uid?: string; exp?: number };
		if (!parsed.uid || typeof parsed.exp !== 'number' || parsed.exp <= now) return null;
		return parsed.uid;
	} catch {
		return null;
	}
}

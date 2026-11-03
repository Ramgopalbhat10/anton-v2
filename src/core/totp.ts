import { createHmac } from 'node:crypto';

/**
 * Time-based one-time passwords (RFC 6238), as an authenticator app shows them:
 * HMAC-SHA1 over 30-second steps, six digits. The secret is the base32 text the
 * app was set up with (spaces and case ignored).
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Bytes(text: string): Buffer {
	const clean = text.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase();
	if (!clean || /[^A-Z2-7]/.test(clean)) throw new Error('A TOTP secret is base32: letters A to Z and digits 2 to 7');
	let bits = 0;
	let value = 0;
	const out: number[] = [];
	for (const char of clean) {
		value = (value << 5) | ALPHABET.indexOf(char);
		bits += 5;
		if (bits >= 8) {
			out.push((value >>> (bits - 8)) & 0xff);
			bits -= 8;
		}
	}
	return Buffer.from(out);
}

/** The code for `at` (milliseconds since the epoch). */
export function totp(secret: string | Buffer, at = Date.now(), { digits = 6, stepSeconds = 30 } = {}): string {
	const key = typeof secret === 'string' ? base32Bytes(secret) : secret;
	const counter = Buffer.alloc(8);
	counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / stepSeconds)));
	const hash = createHmac('sha1', key).update(counter).digest();
	const offset = hash[hash.length - 1]! & 0x0f;
	const code = (hash.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
	return String(code).padStart(digits, '0');
}

/** Milliseconds until the current code changes. */
export const totpRemainingMs = (at = Date.now(), stepSeconds = 30) => stepSeconds * 1000 - (at % (stepSeconds * 1000));

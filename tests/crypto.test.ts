import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decryptToken, encryptToken, openSession, sealSession, sealState, stateMatches } from '../src/lib/crypto.ts';

const key = 'test-token-key';
const secret = 'test-session-secret';

test('encryptToken round-trips and does not store the plaintext', () => {
	const token = 'gho_example_access_token';
	const stored = encryptToken(token, key);
	assert.equal(stored.includes(token), false);
	assert.equal(decryptToken(stored, key), token);
});

test('decryptToken rejects a different key and a tampered payload', () => {
	const stored = encryptToken('gho_secret', key);
	assert.throws(() => decryptToken(stored, 'other-key'));
	const tampered = `${stored.slice(0, -2)}aa`;
	assert.throws(() => decryptToken(tampered, key));
});

test('stateMatches accepts the sealed nonce and rejects a different nonce', () => {
	const nonce = 'nonce-1';
	const state = sealState(nonce, secret);
	assert.equal(stateMatches(state, nonce, secret), true);
	assert.equal(stateMatches(state, 'nonce-2', secret), false);
	assert.equal(stateMatches(`${state}ff`, nonce, secret), false);
	assert.notEqual(sealState('nonce-1', secret), sealState('nonce-2', secret));
});

test('sealSession returns the user id until the cookie expires or the secret changes', () => {
	const now = Date.parse('2026-09-30T00:00:00.000Z');
	const sealed = sealSession('gh_42', now, secret);
	assert.equal(openSession(sealed, now + 1000, secret), 'gh_42');
	assert.equal(openSession(sealed, now + 15 * 24 * 60 * 60 * 1000, secret), null);
	assert.equal(openSession(sealed, now, 'other-secret'), null);
	assert.equal(openSession(`${sealed}x`, now, secret), null);
});

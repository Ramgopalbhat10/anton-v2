import { describe, expect, it } from 'vitest';
import { errorMessage } from '@/lib/api';

const cloudflare524 = '<!DOCTYPE html>\n<!--[if lt IE 7]> <html class="no-js ie6 oldie" lang="en-US"> <![endif]-->\n<html><head><title>mrgb.in | 524: A timeout occurred</title></head><body>…</body></html>';

describe('errorMessage', () => {
	it("gives Anton's own error as it is", () => {
		expect(errorMessage(409, 'Conflict', JSON.stringify({ error: 'This thread is resolved. Reopen it to delete it.' }))).toBe('This thread is resolved. Reopen it to delete it.');
	});

	it("never shows a proxy's HTML page: a timeout says Anton may still finish", () => {
		const message = errorMessage(524, '', cloudflare524);
		expect(message).toBe('Anton took too long to answer (524). It may still finish; check again in a moment.');
		expect(errorMessage(500, 'Internal Server Error', '<html><body>Oops</body></html>')).toBe('Request failed (500 Internal Server Error).');
	});

	it('keeps plain text short', () => {
		expect(errorMessage(400, 'Bad Request', 'Missing title')).toBe('Missing title');
		expect(errorMessage(400, '', 'x'.repeat(1000))).toHaveLength(301);
		expect(errorMessage(404, 'Not Found', '')).toBe('Request failed (404 Not Found).');
	});
});

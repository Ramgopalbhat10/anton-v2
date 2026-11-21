import { afterEach, describe, expect, it, vi } from 'vitest';
import { storedOutputs } from '@/lib/api/outputs';
import { staleFor } from '@/lib/live-updates';

afterEach(() => vi.unstubAllGlobals());

describe("a project's threads' files", () => {
	it('are read in one request, each thread getting its own list', async () => {
		const asked: string[] = [];
		vi.stubGlobal('fetch', async (url: string) => {
			asked.push(url);
			return new Response(JSON.stringify({ outputs: { a: [{ path: 'x.md', size: 1, mtimeMs: 1 }], b: [] } }), { headers: { 'content-type': 'application/json' } });
		});
		const [a, b, c, again] = await Promise.all([storedOutputs('a'), storedOutputs('b'), storedOutputs('c'), storedOutputs('a')]);
		expect(asked).toEqual(['/api/outputs?ids=a,b,c']);
		expect(a.outputs.map((output) => output.path)).toEqual(['x.md']);
		expect(again).toEqual(a);
		expect(b.outputs).toEqual([]);
		expect(c.outputs).toEqual([]);
	});

	it('fail together when the read fails, so each query can retry', async () => {
		vi.stubGlobal('fetch', async () => new Response('{}', { status: 500 }));
		const results = await Promise.allSettled([storedOutputs('a'), storedOutputs('b')]);
		expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected']);
	});

	it('are read again when that thread writes or removes a file', () => {
		expect(staleFor({ kind: 'task', id: 't1', what: 'files' })).toContainEqual(['stored-outputs', 't1']);
		expect(staleFor({ kind: 'task', id: 't1', what: 'state' })).toContainEqual(['stored-outputs', 't1']);
	});
});

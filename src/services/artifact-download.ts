import { Readable } from 'node:stream';
import * as v from 'valibot';
import { InvalidInputError, NotFoundError } from '../core/errors.ts';
import { zipStream } from '../core/zip.ts';
import { listArtifacts } from './artifacts.ts';
import { readOutputFile } from './files.ts';

const SELECTION = v.pipe(v.array(v.object({
	sessionId: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
	path: v.pipe(v.string(), v.minLength(1), v.maxLength(500)),
})), v.minLength(1), v.maxLength(1000));

/** Only gallery entries can be exported. Numbered folders preserve duplicate names and paths. */
export async function downloadArtifacts(raw: unknown): Promise<ReadableStream<Uint8Array>> {
	const parsed = v.safeParse(SELECTION, raw);
	if (!parsed.success) throw new InvalidInputError('Select between 1 and 1,000 artifacts to download.');
	const key = (item: { sessionId: string; path: string }) => JSON.stringify([item.sessionId, item.path]);
	const known = new Map((await listArtifacts()).map((item) => [key(item), item]));
	const unique = [...new Map(parsed.output.map((item) => [key(item), item])).values()];
	const entries = unique.map((item, index) => {
		if (!known.has(key(item))) throw new NotFoundError('An artifact is no longer available. Refresh the gallery and try again.');
		// Keep archive paths portable and incapable of escaping their numbered folder.
		const name = item.path.split('/').map((part) => part.replace(/[\\:\x00-\x1f<>"|?*]/g, '_').replace(/^\.+$|[. ]+$/g, '_')).filter(Boolean).join('/');
		return {
			name: `${index + 1}/${name}`,
			read: async () => {
				const bytes = await readOutputFile(item.sessionId, item.path);
				if (!bytes) throw new NotFoundError(`Artifact no longer available: ${item.path}`);
				return bytes;
			},
		};
	});
	return Readable.toWeb(zipStream(entries), {
		strategy: { highWaterMark: 64 * 1024, size: (chunk: Uint8Array) => chunk.byteLength },
	}) as ReadableStream<Uint8Array>;
}

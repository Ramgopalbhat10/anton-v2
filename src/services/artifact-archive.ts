import { zipSync } from 'fflate';
import { InvalidInputError, NotFoundError } from '../core/errors.ts';
import { listArtifacts } from './artifacts.ts';
import { readOutputFile } from './files.ts';

/** Bound transient memory on both server and browser; the gallery never fetches these bytes. */
export const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
const keyOf = (item: { sessionId: string; path: string }) => JSON.stringify([item.sessionId, item.path]);
const safePart = (part: string) => part.replace(/[\\:\x00-\x1f<>"|?*]/g, '-').replace(/[. ]+$/, '') || 'file';

/** All or nothing: report missing files before returning a download, never silently omit them. */
export async function artifactArchive(items: { sessionId: string; path: string }[]): Promise<Uint8Array> {
	if (!items.length || items.length > 500) throw new InvalidInputError('Select between 1 and 500 artifacts per ZIP.');
	const listed = new Map((await listArtifacts()).map((item) => [keyOf(item), item]));
	const selected = [...new Map(items.map((item) => [keyOf(item), item])).values()].map((item) => {
		const artifact = listed.get(keyOf(item));
		if (!artifact) throw new NotFoundError(`Artifact no longer available: ${item.path}. Refresh and select again.`);
		return artifact;
	});
	const tooLarge = () => new InvalidInputError('ZIP downloads are limited to 50 MB of files. Select fewer artifacts.');
	if (selected.reduce((sum, item) => sum + item.size, 0) > MAX_ARCHIVE_BYTES) throw tooLarge();
	const entries: Record<string, Uint8Array> = Object.create(null);
	const sessions = new Map<string, number>();
	let total = 0;
	for (const item of selected) {
		const bytes = await readOutputFile(item.sessionId, item.path);
		if (!bytes) throw new NotFoundError(`File no longer available: ${item.path}. Refresh and select again.`);
		total += bytes.byteLength;
		if (total > MAX_ARCHIVE_BYTES) throw tooLarge();
		if (!sessions.has(item.sessionId)) sessions.set(item.sessionId, sessions.size + 1);
		// Numbered task folders keep equal paths from different tasks distinct. Sanitize ZIP paths for extraction.
		const folder = `${sessions.get(item.sessionId)}-${safePart(item.sessionId)}`;
		const path = item.path.split('/').map(safePart).join('/');
		let name = `${folder}/${path}`;
		let suffix = 1;
		while (name in entries) name = `${folder}/${path} (${suffix++})`;
		entries[name] = bytes;
	}
	// Stored entries avoid CPU-heavy compression and still give one portable ZIP.
	return zipSync(entries, { level: 0 });
}

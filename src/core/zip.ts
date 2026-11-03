import { Readable } from 'node:stream';
import { ZipFile } from 'yazl';

/** Reads one entry at a time; the archive itself is never held in memory. */
export function zipStream(entries: { name: string; read: () => Promise<Uint8Array> }[]): Readable {
	const zip = new ZipFile();
	const output = zip.outputStream as Readable;
	let closed = false;
	let source: Readable | null = null;
	zip.on('error', (error: Error) => output.destroy(error));
	output.once('close', () => {
		closed = true;
		source?.destroy();
	});
	for (const entry of entries) {
		zip.addReadStreamLazy(entry.name, (callback) => {
			if (closed) return;
			void entry.read().then((bytes) => {
				if (closed) return;
				source = Readable.from([bytes]);
				callback(null, source);
			}, (error: Error) => zip.emit('error', error));
		});
	}
	zip.end();
	return output;
}

/** One entry of a tar archive. `content` is kept only for regular files within the size limit. */
export type TarEntry = {
	path: string;
	kind: 'file' | 'directory' | 'symlink' | 'other';
	size: number;
	content: Uint8Array | null;
	/** Where a symlink points. */
	target: string | null;
};

const BLOCK = 512;

function field(header: Buffer, start: number, length: number): string {
	const raw = header.subarray(start, start + length);
	const end = raw.indexOf(0);
	return raw.subarray(0, end === -1 ? length : end).toString('utf8');
}

/** A size field: octal text, or base-256 when the high bit is set. */
function number(header: Buffer, start: number, length: number): number {
	if (header[start] & 0x80) return header.subarray(start + 1, start + length).reduce((total, byte) => total * 256 + byte, 0);
	return Number.parseInt(field(header, start, length).trim() || '0', 8);
}

/** pax extended header records: `<length> <key>=<value>\n`. */
function paxRecords(data: Buffer): Record<string, string> {
	const records: Record<string, string> = {};
	let offset = 0;
	while (offset < data.length) {
		const space = data.indexOf(0x20, offset);
		const length = Number.parseInt(data.subarray(offset, space).toString('utf8'), 10);
		if (space === -1 || !length) break;
		const record = data.subarray(space + 1, offset + length - 1).toString('utf8');
		const equals = record.indexOf('=');
		records[record.slice(0, equals)] = record.slice(equals + 1);
		offset += length;
	}
	return records;
}

/** Reads exact byte counts from a stream of chunks. */
function byteReader(source: AsyncIterable<Uint8Array>) {
	const chunks = source[Symbol.asyncIterator]();
	let buffered = Buffer.alloc(0);
	async function fill(count: number): Promise<boolean> {
		if (buffered.length >= count) return true;
		const parts = [buffered];
		let have = buffered.length;
		while (have < count) {
			const next = await chunks.next();
			if (next.done) break;
			parts.push(Buffer.from(next.value));
			have += next.value.length;
		}
		buffered = Buffer.concat(parts);
		return have >= count;
	}
	return {
		async read(count: number): Promise<Buffer | null> {
			if (!(await fill(count))) return null;
			const out = buffered.subarray(0, count);
			buffered = buffered.subarray(count);
			return out;
		},
		async skip(count: number): Promise<void> {
			for (let left = count; left > 0; ) {
				if (!(await fill(1))) return;
				const step = Math.min(left, buffered.length);
				buffered = buffered.subarray(step);
				left -= step;
			}
		},
	};
}

const KINDS: Record<string, TarEntry['kind']> = { '0': 'file', '\0': 'file', '7': 'file', '5': 'directory', '2': 'symlink' };

/**
 * The entries of an uncompressed tar stream (ustar, pax and GNU long names),
 * read as they arrive. Files larger than `maxFileBytes` are listed without
 * their content, so a huge file never sits in memory.
 */
export async function* readTar(source: AsyncIterable<Uint8Array>, maxFileBytes: number): AsyncGenerator<TarEntry> {
	const reader = byteReader(source);
	let pax: Record<string, string> = {};
	let longName: string | null = null;
	for (;;) {
		const header = await reader.read(BLOCK);
		if (!header || header.every((byte) => byte === 0)) return;
		const type = String.fromCharCode(header[156]);
		let size = number(header, 124, 12);
		if (type === 'x' || type === 'g' || type === 'L') {
			const data = await reader.read(Math.ceil(size / BLOCK) * BLOCK);
			if (!data) return;
			if (type === 'x') pax = paxRecords(data.subarray(0, size));
			if (type === 'L') longName = data.subarray(0, size).toString('utf8').replace(/\0+$/, '');
			continue;
		}
		const prefix = field(header, 345, 155);
		const name = field(header, 0, 100);
		const path = pax.path ?? longName ?? (prefix ? `${prefix}/${name}` : name);
		if (pax.size) size = Number(pax.size);
		const kind = KINDS[type] ?? 'other';
		const target = kind === 'symlink' ? (pax.linkpath ?? field(header, 157, 100)) : null;
		pax = {};
		longName = null;
		const padded = Math.ceil(size / BLOCK) * BLOCK;
		let content: Uint8Array | null = null;
		if (kind === 'file' && size <= maxFileBytes) {
			const data = await reader.read(padded);
			if (!data) return;
			content = data.subarray(0, size);
		} else {
			await reader.skip(padded);
		}
		yield { path, kind, size, content, target };
	}
}

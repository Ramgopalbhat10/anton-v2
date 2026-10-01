import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ObjectStore } from '../../core/ports.ts';

/** Objects as files under a folder. For development and tests. */
export function diskStore(dir: string): ObjectStore {
	const fileFor = (key: string) => path.join(dir, ...key.split('/'));

	async function walk(folder: string): Promise<string[]> {
		const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
		const nested = await Promise.all(
			entries.map((entry) => {
				const full = path.join(folder, entry.name);
				return entry.isDirectory() ? walk(full) : Promise.resolve([full]);
			}),
		);
		return nested.flat();
	}

	return {
		name: 'disk',
		async put(key, body) {
			const file = fileFor(key);
			await mkdir(path.dirname(file), { recursive: true });
			await writeFile(file, body);
		},
		get: (key) => readFile(fileFor(key)).then((buffer) => new Uint8Array(buffer), () => null),
		has: (key) => stat(fileFor(key)).then(() => true, () => false),
		async list(prefix) {
			const files = await walk(fileFor(prefix));
			return Promise.all(
				files.map(async (file) => ({
					key: path.relative(dir, file).split(path.sep).join('/'),
					size: (await stat(file)).size,
				})),
			);
		},
	};
}

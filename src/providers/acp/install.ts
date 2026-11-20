// Host-side CLI bootstrap helpers: fetch a vendor's release archive and unpack
// it under the data dir so sign-in and model listing work on a bare server.
// The Modal image recipes do the same download inside the container; this is
// the host-side twin and shares the release resolution (agent.release.latest).

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { AcpRelease } from './runtime.ts';

const execFileAsync = promisify(execFile);

/**
 * GET a release archive to `dest`. Archives are tens of MB at most, so buffering
 * is fine and keeps the checksum simple. Verifies sha256/sha512 when the release
 * carries one — the same digest the container image build checks.
 */
export async function downloadArchive(release: AcpRelease, dest: string): Promise<void> {
	const res = await fetch(release.url, { signal: AbortSignal.timeout(300_000) });
	if (!res.ok) throw new Error(`download failed (HTTP ${res.status})`);
	await writeFile(dest, Buffer.from(await res.arrayBuffer()));
	const want = release.sha512 ?? release.sha256;
	if (!want) return;
	const algo = release.sha512 ? 'sha512' : 'sha256';
	const got = createHash(algo).update(await readFile(dest)).digest('hex');
	if (got !== want.toLowerCase()) {
		await rm(dest, { force: true });
		throw new Error(`${algo} mismatch: expected ${want.slice(0, 12)}…, got ${got.slice(0, 12)}…`);
	}
}

/** `tar -xzf` exists on every linux server; the vendor tarballs are plain .tar.gz. */
export async function untar(archive: string, dest: string): Promise<void> {
	await execFileAsync('tar', ['-xzf', archive, '-C', dest]);
}

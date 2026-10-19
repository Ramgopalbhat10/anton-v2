import { readdir, readFile, writeFile } from 'node:fs/promises';

/**
 * Fixes a Flue runtime bug that fails a reply when the agent starts its
 * sandbox partway through it. Run after every install (`postinstall`).
 *
 * Before a task has a sandbox, Anton mounts the repo's `.agents/skills`
 * itself (read from the snapshot); with one, Flue finds them in the clone.
 * When `start_workspace` brings the sandbox up mid-reply, Flue checks the
 * skills it finds there against the skills of the reply's FIRST render, the
 * read-only one, instead of the current render's, and throws "Skill name …
 * appears in both agent definition and workspace discovery". The render
 * after the swap merges its own skills with what was found anyway, so the
 * swap's discovery (and the rediscovery after compaction, which is
 * rebaselined from the current render right after) need no definition
 * skills at all. Through @flue/runtime 2.3.0; drop this once Flue fixes it.
 */

const DIST = new URL('../node_modules/@flue/runtime/dist/', import.meta.url);
const FIXES: Array<[string, string]> = [
	['discoverSessionContext(nextEnv, definition.skills)', 'discoverSessionContext(nextEnv)'],
	['discoverSessionContext(currentEnv, definition.skills)', 'discoverSessionContext(currentEnv)'],
];

export async function patchFlue(dist: URL = DIST): Promise<'patched' | 'already' | 'not-found'> {
	const files = (await readdir(dist).catch(() => [])).filter((name) => name.endsWith('.mjs'));
	for (const name of files) {
		const file = new URL(name, dist);
		const source = await readFile(file, 'utf8');
		if (!source.includes('swapDiscovery:')) continue;
		let patched = source;
		for (const [broken, fixed] of FIXES) patched = patched.replaceAll(broken, fixed);
		if (patched !== source) {
			await writeFile(file, patched);
			return 'patched';
		}
		return FIXES.every(([, fixed]) => source.includes(fixed)) ? 'already' : 'not-found';
	}
	return 'not-found';
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const result = await patchFlue();
	// A Flue that changed shape is reported, never a failed install.
	if (result === 'not-found') console.warn('[patch-flue] Did not find the environment swap to patch in @flue/runtime; check whether Flue still needs it.');
	else console.log(`[patch-flue] @flue/runtime ${result === 'patched' ? 'patched' : 'already patched'}.`);
}

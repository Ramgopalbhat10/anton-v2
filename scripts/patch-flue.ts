import { readdir, readFile, writeFile } from 'node:fs/promises';

/**
 * Fixes Flue runtime bugs Anton runs into. Run after every install
 * (`postinstall`). Through @flue/runtime 2.3.0; drop each once Flue fixes it.
 *
 * Skills on a sandbox started mid-reply. Before a task has a sandbox, Anton
 * mounts the repo's `.agents/skills` itself (read from the snapshot); with
 * one, Flue finds them in the clone. When `start_workspace` brings the
 * sandbox up mid-reply, Flue checks the skills it finds there against the
 * skills of the reply's FIRST render, the read-only one, instead of the
 * current render's, and throws "Skill name … appears in both agent
 * definition and workspace discovery". The render after the swap merges its
 * own skills with what was found anyway, so the swap's discovery (and the
 * rediscovery after compaction, which is rebaselined from the current render
 * right after) need no definition skills at all.
 *
 * A subagent's compaction. A task session copies its parent's compaction,
 * a reserve worked out for the parent's model. A subagent on a model of its
 * own (Settings › General) then compacts at its window less that reserve: a
 * 400k ceiling on an 872k model reserves 472k, so a subagent on a 500k model
 * compacted at 28k tokens, again and again. One on its own model takes the
 * runtime's default for that model instead.
 *
 * Waiting on a busy database. Litestream writes to and checkpoints flue.db
 * alongside Anton (`npm run start:backup`). Flue opens it without a busy
 * timeout, so a write that meets Litestream's lock failed at once with
 * "database is locked", failing the subagent or reply that made it. It now
 * waits up to five seconds, as Litestream asks of the apps it backs up.
 */

type Patch = { name: string; dir: string; marker: string; fixes: Array<[string, string]> };

const PATCHES: Patch[] = [
	{
		name: 'skills on a sandbox started mid-reply',
		dir: '',
		marker: 'swapDiscovery:',
		fixes: [
			['discoverSessionContext(nextEnv, definition.skills)', 'discoverSessionContext(nextEnv)'],
			['discoverSessionContext(currentEnv, definition.skills)', 'discoverSessionContext(currentEnv)'],
		],
	},
	{
		name: "a subagent's compaction",
		dir: '',
		marker: 'async createTaskSession(',
		fixes: [['compaction: this.config.compaction\n', 'compaction: taskAgent?.model !== void 0 ? void 0 : this.config.compaction\n']],
	},
	{
		name: 'waiting on a busy database',
		dir: 'node/',
		marker: 'function openDatabase(',
		fixes: [['db.exec("PRAGMA journal_mode=WAL");', 'db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");']],
	},
];

type Result = 'patched' | 'already' | 'not-found';

async function applyPatch(dist: URL, patch: Patch): Promise<Result> {
	const dir = new URL(patch.dir, dist);
	const files = (await readdir(dir).catch(() => [])).filter((name) => name.endsWith('.mjs'));
	for (const name of files) {
		const file = new URL(name, dir);
		const source = await readFile(file, 'utf8');
		if (!source.includes(patch.marker)) continue;
		let patched = source;
		for (const [broken, fixed] of patch.fixes) patched = patched.replaceAll(broken, fixed);
		if (patched !== source) {
			await writeFile(file, patched);
			return 'patched';
		}
		return patch.fixes.every(([, fixed]) => source.includes(fixed)) ? 'already' : 'not-found';
	}
	return 'not-found';
}

/** Each patch's result, by name. */
export async function patchFlueEach(dist: URL = DIST): Promise<Record<string, Result>> {
	const results: Record<string, Result> = {};
	for (const patch of PATCHES) results[patch.name] = await applyPatch(dist, patch);
	return results;
}

const DIST = new URL('../node_modules/@flue/runtime/dist/', import.meta.url);

/** Not found when any patch was not found, patched when any was applied, else already. */
export async function patchFlue(dist: URL = DIST): Promise<Result> {
	const results = Object.values(await patchFlueEach(dist));
	return results.includes('not-found') ? 'not-found' : results.includes('patched') ? 'patched' : 'already';
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const results = await patchFlueEach();
	// A Flue that changed shape is reported, never a failed install.
	for (const [name, result] of Object.entries(results)) {
		if (result === 'not-found') console.warn(`[patch-flue] Did not find where to patch ${name} in @flue/runtime; check whether Flue still needs it.`);
		else console.log(`[patch-flue] @flue/runtime ${result === 'patched' ? 'patched' : 'already patched'}: ${name}.`);
	}
}

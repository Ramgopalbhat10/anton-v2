import { writeMachineFile } from '../../core/machine-fs.ts';
import type { Machine } from '../../core/ports.ts';
import { quote, text } from '../../core/shell.ts';
import { getProviders } from '../../providers/index.ts';

export type Download = { key: string; target: string; size?: number };

/** Long enough for a slow sandbox to start every transfer, short enough that a link seen in the machine soon stops working. */
const LINK_SECONDS = 10 * 60;
const PARALLEL = 8;

/** curl's config syntax: a double-quoted string, in which a backslash escapes. */
const configString = (value: string) => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n')}"`;

/** The bytes never pass through this server, whose link to the sandbox can be slow. The links go on stdin, not the command line. */
async function fetchInMachine(machine: Machine, files: Download[]): Promise<Set<string>> {
	const store = getProviders().store;
	if (!store.signedUrl) return new Set();
	const links = await Promise.all(files.map((file) => store.signedUrl!(file.key, LINK_SECONDS)));
	const config = files.map((file, i) => `url = ${configString(links[i])}\noutput = ${configString(file.target)}\n`).join('');
	const command = [
		'command -v curl >/dev/null || exit 0',
		`curl --parallel --parallel-max ${PARALLEL} --create-dirs --fail --silent --connect-timeout 5 --max-time 300 --retry 2 -w '%{response_code}\\t%{size_download}\\t%{filename_effective}\\n' -K - || true`,
	].join('\n');
	const result = await machine.exec(command, { stdin: new TextEncoder().encode(config), timeoutMs: 6 * 60_000 }).catch(() => null);
	if (!result) return new Set();
	const expected = new Map(files.map((file) => [file.target, file.size]));
	const done = new Set<string>();
	for (const line of text(result.stdout).split('\n')) {
		const [code, size, target] = line.split('\t');
		if (code !== '200' || !target || !expected.has(target)) continue;
		const want = expected.get(target);
		if (want === undefined || Number(size) === want) done.add(target);
	}
	return done;
}

async function copyThrough(machine: Machine, files: Download[]): Promise<string[]> {
	const store = getProviders().store;
	const missing: string[] = [];
	const queue = [...files];
	const worker = async () => {
		for (let file = queue.shift(); file; file = queue.shift()) {
			const bytes = await store.get(file.key);
			if (!bytes) {
				missing.push(file.target);
				continue;
			}
			await writeMachineFile(machine, file.target, bytes);
		}
	};
	await Promise.all(Array.from({ length: Math.min(PARALLEL, files.length) }, worker));
	return missing;
}

/** Whatever the machine did not get whole (no curl, no route to the store, a failed transfer) is copied through this server. Returns the targets not in the store. */
export async function downloadInto(machine: Machine, files: Download[]): Promise<string[]> {
	if (!files.length) return [];
	const done = await fetchInMachine(machine, files);
	const rest = files.filter((file) => !done.has(file.target));
	if (!rest.length) return [];
	const folders = [...new Set(rest.map((file) => file.target.slice(0, file.target.lastIndexOf('/'))))].filter(Boolean);
	if (folders.length) await machine.exec(`mkdir -p ${folders.map(quote).join(' ')}`);
	return copyThrough(machine, rest);
}

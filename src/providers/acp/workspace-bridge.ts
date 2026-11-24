// ACP client capabilities served from the task's sandbox. The agent runs jailed
// in its own container, so its native file reads, writes and shell commands go
// to Anton instead (`fs/*`, `terminal/*`), and Anton runs them as its own
// read, write and bash tools: the same tool steps, permissions and sandbox as
// any other model's calls. The credential stays in the jail.

import type { RuntimeToolOutput } from '../../core/ports.ts';

type RunTool = (name: string, args: Record<string, unknown>) => Promise<RuntimeToolOutput>;

/** What `initialize` offers when the bridge serves it; listing models still offers nothing. */
export const SERVED_CAPABILITIES = { fs: { readTextFile: true, writeTextFile: true }, terminal: true };

/** Anton's `read` ends a page short of the file's end with this line; the next page starts at the offset it names. */
const MORE = /^\(lines \d+-\d+ of \d+; read on with offset (\d+)\)$/;
/** Anton's `read` cuts a very long line and says so; a partial file must never be handed back as the file. */
const CUT = /… \(line cut at \d+ characters\)$/;
/** A read that starts past the file's end; ACP gets no lines rather than an error. */
const PAST_END = /^\(the file has \d+ lines; offset \d+ is past its end\)$/;
/** The most lines one `read` call returns. */
const PAGE = 2000;
/** Flue's `bash` ends a failed command's output with this line. */
const EXIT = /\n\nCommand exited with code (\d+)$/;
/** A file past this many pages is refused rather than read for minutes. */
const MAX_CHUNKS = 50;

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
const textOf = (output: RuntimeToolOutput) =>
	output.content.map((part) => (part.type === 'text' ? part.text : '')).join('');

type Terminal = { done: Promise<{ output: string; exitCode: number }>; result: { output: string; exitCode: number } | null; limit: number | null };

export class WorkspaceBridge {
	private readonly run: RunTool;
	private readonly has: (name: string) => boolean;
	private readonly jail: string;
	private readonly terminals = new Map<string, Terminal>();
	private terminalSeq = 0;

	/** `jail` is the agent's own cwd; paths under it are the task's repo, relative to its root. */
	constructor(run: RunTool, has: (name: string) => boolean, jail: string) {
		this.run = run;
		this.has = has;
		this.jail = jail.replace(/\/+$/, '');
	}

	/** Handles one fs/ or terminal/ request; undefined means the method is not the bridge's. */
	handle(method: string, params: unknown): Promise<unknown> | undefined {
		const p = (params ?? {}) as Record<string, unknown>;
		switch (method) {
			case 'fs/read_text_file':
				return this.read(String(p.path ?? ''), num(p.line), num(p.limit));
			case 'fs/write_text_file':
				return this.write(String(p.path ?? ''), String(p.content ?? ''));
			case 'terminal/create':
				return this.create(p);
			case 'terminal/output':
				return this.output(String(p.terminalId ?? ''));
			case 'terminal/wait_for_exit':
				return this.waitForExit(String(p.terminalId ?? ''));
			case 'terminal/kill':
				// A running tool step cannot be stopped from here; its own timeout ends it.
				return Promise.resolve(null);
			case 'terminal/release':
				this.terminals.delete(String(p.terminalId ?? ''));
				return Promise.resolve(null);
			default:
				return undefined;
		}
	}

	/** The agent's `/work/src/a.ts` is the repo's `src/a.ts`; anything else passes through as the sandbox's own path. */
	path(path: string): string {
		if (path === this.jail) return '.';
		return path.startsWith(`${this.jail}/`) ? path.slice(this.jail.length + 1) : path;
	}

	private need(tool: string): void {
		if (!this.has(tool)) throw new Error(`There is no workspace yet, so ${tool} is unavailable. Call Anton's start_workspace tool first.`);
	}

	private async call(tool: string, args: Record<string, unknown>): Promise<string> {
		this.need(tool);
		const output = await this.run(tool, args);
		const text = textOf(output);
		if (output.isError) throw new Error(text || `${tool} failed`);
		return text;
	}

	/**
	 * ACP wants the file's own text. Anton's `read` numbers each line (`12\tconst a = 1;`) for the model, so the numbers
	 * come off here: handed back with them, Devin's edit tool matched none of its edits, and the one it applied wrote
	 * every line back with its number in front.
	 */
	private async read(path: string, line: number | null, limit: number | null): Promise<{ content: string }> {
		const target = this.path(path);
		const lines: string[] = [];
		let start = line && line > 1 ? Math.floor(line) : 1;
		for (let page = 0; page < MAX_CHUNKS; page++) {
			const want = limit ? Math.min(PAGE, limit - lines.length) : PAGE;
			const text = await this.call('read', { path: target, ...(start > 1 ? { offset: start } : {}), limit: want });
			const { body, next } = unnumber(text, start, path);
			lines.push(...body);
			if (next === null || (limit && lines.length >= limit)) return { content: lines.join('\n') };
			start = next;
		}
		throw new Error(`${path} is too large to read whole`);
	}

	private async write(path: string, content: string): Promise<null> {
		await this.call('write', { path: this.path(path), content });
		return null;
	}

	private create(p: Record<string, unknown>): Promise<{ terminalId: string }> {
		this.need('bash');
		const args = Array.isArray(p.args) ? p.args.map(String) : [];
		const env = Array.isArray(p.env) ? (p.env as { name?: string; value?: string }[]) : [];
		const exports = env.filter((e) => e.name && /^[A-Za-z_][A-Za-z0-9_]*$/.test(e.name)).map((e) => `export ${e.name}=${quote(String(e.value ?? ''))}; `);
		const dir = typeof p.cwd === 'string' && p.cwd ? this.path(p.cwd) : '.';
		const cwd = dir === '.' ? '' : `cd ${quote(dir)} && `;
		// Colour codes are noise the agent pays for on every later call; its own env can still turn colour back on.
		const command = `export NO_COLOR=1 FORCE_COLOR=0; ${exports.join('')}${cwd}${[String(p.command ?? ''), ...args.map(quote)].join(' ')}`;
		const id = `term-${++this.terminalSeq}`;
		const terminal: Terminal = { done: Promise.resolve({ output: '', exitCode: 0 }), result: null, limit: num(p.outputByteLimit) };
		terminal.done = this.run('bash', { command }).then(
			(output) => {
				const text = textOf(output);
				const exit = EXIT.exec(text);
				const body = exit ? text.slice(0, exit.index) : text;
				const result = { output: body === '(no output)' ? '' : body, exitCode: exit ? Number(exit[1]) : output.isError ? 1 : 0 };
				terminal.result = result;
				return result;
			},
			(error: unknown) => {
				const result = { output: error instanceof Error ? error.message : String(error), exitCode: 1 };
				terminal.result = result;
				return result;
			},
		);
		this.terminals.set(id, terminal);
		return Promise.resolve({ terminalId: id });
	}

	private terminal(id: string): Terminal {
		const terminal = this.terminals.get(id);
		if (!terminal) throw new Error(`Unknown terminal: ${id}`);
		return terminal;
	}

	private async output(id: string): Promise<unknown> {
		const terminal = this.terminal(id);
		const result = terminal.result;
		const full = result?.output ?? '';
		const output = terminal.limit !== null && Buffer.byteLength(full) > terminal.limit ? Buffer.from(full).subarray(-terminal.limit).toString() : full;
		return { output, truncated: output !== full, exitStatus: result ? { exitCode: result.exitCode, signal: null } : null };
	}

	private async waitForExit(id: string): Promise<unknown> {
		const result = await this.terminal(id).done;
		return { exitCode: result.exitCode, signal: null };
	}
}

/**
 * One page of Anton's `read` as the file's own lines, and where the next page starts (null at the end). Anything that
 * is not numbered from `start` (a missing file, a folder, a binary) is the read's answer, so it fails the request.
 */
function unnumber(text: string, start: number, path: string): { body: string[]; next: number | null } {
	if (PAST_END.test(text)) return { body: [], next: null };
	const rows = text.split('\n');
	const more = rows.length > 1 ? MORE.exec(rows.at(-1) ?? '') : null;
	if (more) rows.pop();
	const body = rows.map((row, index) => {
		const prefix = `${start + index}\t`;
		if (!row.startsWith(prefix)) throw new Error(text.trim() || `${path} could not be read`);
		const content = row.slice(prefix.length);
		if (CUT.test(content)) throw new Error(`${path} has a line too long to read whole`);
		return content;
	});
	return { body, next: more ? Number(more[1]) : null };
}

const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

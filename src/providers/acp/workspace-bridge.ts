// ACP client capabilities served from the task's sandbox. The agent runs jailed
// in its own container, so its native file reads, writes and shell commands go
// to Anton instead (`fs/*`, `terminal/*`), and Anton runs them as its own
// read, write and bash tools: the same tool steps, permissions and sandbox as
// any other model's calls. The credential stays in the jail.

import type { RuntimeToolOutput } from '../../core/ports.ts';

type RunTool = (name: string, args: Record<string, unknown>) => Promise<RuntimeToolOutput>;

/** What `initialize` offers when the bridge serves it; listing models still offers nothing. */
export const SERVED_CAPABILITIES = { fs: { readTextFile: true, writeTextFile: true }, terminal: true };

/** Flue's `read` appends this when it stops short of the end; the next chunk starts at `offset`. */
const MORE = /\n\n\[Showing lines \d+-\d+ of \d+\. Use offset=(\d+) to continue\.\]$/;
/** Flue's `read` could not return one whole line; a partial file must never be handed back as the file. */
const LINE_TOO_LONG = /\n\n\[Line \d+ exceeds the \d+-byte read limit/;
/** Flue's `bash` ends a failed command's output with this line. */
const EXIT = /\n\nCommand exited with code (\d+)$/;
/** 2000 lines a chunk: a file past this many chunks is refused rather than read for minutes. */
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

	private async read(path: string, line: number | null, limit: number | null): Promise<{ content: string }> {
		const target = this.path(path);
		const chunks: string[] = [];
		let offset = line ?? undefined;
		for (let i = 0; i < MAX_CHUNKS; i++) {
			const text = await this.call('read', { path: target, ...(offset ? { offset } : {}), ...(limit ? { limit } : {}) });
			if (LINE_TOO_LONG.test(text)) throw new Error(`${path} has a line too long to read whole`);
			const more = MORE.exec(text);
			if (!more) return { content: [...chunks, text].join('\n') };
			chunks.push(text.slice(0, more.index));
			// A limited read takes what one call returns, as a model's read would.
			if (limit) return { content: chunks.join('\n') };
			offset = Number(more[1]);
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
		const command = `${exports.join('')}${cwd}${[String(p.command ?? ''), ...args.map(quote)].join(' ')}`;
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

const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

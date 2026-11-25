// ACP client capabilities served from the task's sandbox. The agent runs jailed
// in its own container, so its native file reads, writes and shell commands go
// to Anton instead (`fs/*`, `terminal/*`), and Anton runs them as its own
// read, write and bash tools: the same tool steps, permissions and sandbox as
// any other model's calls. The credential stays in the jail.

import { randomBytes } from 'node:crypto';
import type { RuntimeToolOutput } from '../../core/ports.ts';

type RunTool = (name: string, args: Record<string, unknown>) => Promise<RuntimeToolOutput>;
/** The user's words waiting for the agent, as a note it reads with a command's output; null when there are none. */
type TakeSteer = () => string | null;

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

/**
 * Each terminal runs detached in the sandbox, its output and exit code in files under here. A bash step waits for it a
 * while and returns its output when it ends in time, as one step, like any command; one still running after that (a dev
 * server the agent started in the foreground, a long suite) keeps running while the step returns, so it never holds the
 * agent's next command behind it, and `terminal/output`, `wait_for_exit` and `kill` each act on it in a step of their own.
 * Run as one plain bash step, a dev server once held every later command for the 3 minutes a command gets, then died.
 */
export const TERMINAL_DIR = '/tmp/anton-acp';
/** The first step's wait: in a 20-task benchmark the commands that named no timeout took 18 s at most. */
const FIRST_WAIT_S = 30;
/** Each later `wait_for_exit` step, short enough that a `kill` queued behind it lands within this. */
const WAIT_S = 60;
/** How often `terminal/output` on a running command reads it again; between reads the agent gets what the last showed. */
const POLL_MS = 3_000;
/** The last line a step prints for a command still running. */
export const STILL_RUNNING = '[anton] The command is still running.';
/** The most of a running command's output one step shows: its end. */
const RUNNING_TAIL_BYTES = 8_000;

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
const textOf = (output: RuntimeToolOutput) =>
	output.content.map((part) => (part.type === 'text' ? part.text : '')).join('');

type Exit = { output: string; exitCode: number };
type Terminal = {
	dir: string;
	/** The agent's command, as the steps for it show it. */
	label: string;
	limit: number | null;
	/** Steps for this terminal run one at a time, in order. */
	chain: Promise<void>;
	/** A step is running for it. */
	busy: boolean;
	result: Exit | null;
	/** What the command has written so far, while it runs. */
	partial: string;
	polledAt: number;
	killed: boolean;
};

/** Each step's first line is a comment naming the agent's command, which is the line the thread shows for a bash step. */
const labelOf = (command: string) => {
	const line = command.split('\n')[0]!.replace(/^export NO_COLOR=1 FORCE_COLOR=0; /, '');
	return line.length > 200 ? `${line.slice(0, 199)}…` : line;
};

/** Waits up to `seconds` for the command's exit code; prints its whole output and exits with its code, or prints its end and says it still runs. */
const waitPart = (seconds: number) =>
	[
		`__n=0; while [ ! -e "$__d/code" ] && [ "$__n" -lt ${seconds * 10} ]; do sleep 0.1; __n=$((__n + 1)); done`,
		`if [ -e "$__d/code" ]; then cat "$__d/out" 2>/dev/null; exit "$(cat "$__d/code")"; fi`,
		`tail -c ${RUNNING_TAIL_BYTES} "$__d/out" 2>/dev/null; printf '\n%s\n' ${quote(STILL_RUNNING)}`,
	].join('\n');

/** Starts the command in a session of its own (so a stop reaches every process it started) and waits for it a while. */
export function startScript(command: string, dir: string, seconds = FIRST_WAIT_S): string {
	return [
		`# ${labelOf(command)}`,
		`__d=${quote(dir)}; mkdir -p "$__d"`,
		`__c=${quote(command)}`,
		'__s=; command -v setsid >/dev/null 2>&1 && __s=setsid',
		`$__s bash -c 'bash -c "$1" > "$2/out" 2>&1 < /dev/null; echo $? > "$2/code.part"; mv "$2/code.part" "$2/code"' anton "$__c" "$__d" > /dev/null 2>&1 < /dev/null &`,
		'echo $! > "$__d/pid"',
		waitPart(seconds),
	].join('\n');
}

export function waitScript(label: string, dir: string, seconds = WAIT_S): string {
	return [seconds ? `# waiting for: ${label}` : `# output so far: ${label}`, `__d=${quote(dir)}`, waitPart(seconds)].join('\n');
}

/** Stops the command's whole process group (TERM, then KILL), then reads how it ended; a group stopped before it could write its code ends with 143. */
export function killScript(label: string, dir: string): string {
	const gone = '! kill -0 "$__p" 2>/dev/null';
	return [
		`# stopping: ${label}`,
		`__d=${quote(dir)}; __p=$(cat "$__d/pid" 2>/dev/null)`,
		'if [ -n "$__p" ] && [ ! -e "$__d/code" ]; then',
		'  kill -TERM -- "-$__p" 2>/dev/null || kill -TERM "$__p" 2>/dev/null',
		`  __n=0; while [ ! -e "$__d/code" ] && [ "$__n" -lt 50 ] && ! (${gone}); do sleep 0.1; __n=$((__n + 1)); done`,
		`  if ! (${gone}); then kill -KILL -- "-$__p" 2>/dev/null || kill -KILL "$__p" 2>/dev/null; sleep 0.2; fi`,
		'  [ -e "$__d/code" ] || echo 143 > "$__d/code"',
		'fi',
		waitPart(1),
	].join('\n');
}

export class WorkspaceBridge {
	private readonly run: RunTool;
	private readonly has: (name: string) => boolean;
	private readonly jail: string;
	private readonly takeSteer: TakeSteer;
	private readonly terminals = new Map<string, Terminal>();
	private terminalSeq = 0;

	/** `jail` is the agent's own cwd; paths under it are the task's repo, relative to its root. */
	constructor(run: RunTool, has: (name: string) => boolean, jail: string, takeSteer: TakeSteer = () => null) {
		this.run = run;
		this.has = has;
		this.jail = jail.replace(/\/+$/, '');
		this.takeSteer = takeSteer;
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
				return this.kill(String(p.terminalId ?? ''));
			case 'terminal/release':
				// A server the agent started stays up, as one started with `nohup … &` does.
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
		const terminal: Terminal = {
			dir: `${TERMINAL_DIR}/${randomBytes(8).toString('hex')}`,
			label: labelOf(command),
			limit: num(p.outputByteLimit),
			chain: Promise.resolve(),
			busy: false,
			result: null,
			partial: '',
			polledAt: 0,
			killed: false,
		};
		this.terminals.set(id, terminal);
		this.step(terminal, startScript(command, terminal.dir), FIRST_WAIT_S);
		return Promise.resolve({ terminalId: id });
	}

	/** Queues one bash step for the terminal; it records the exit, or what the command has written while it still runs. */
	private step(terminal: Terminal, script: string, seconds: number): Promise<void> {
		const run = async () => {
			terminal.busy = true;
			try {
				const output = await this.run('bash', { command: script, timeout: seconds + 30 });
				const text = textOf(output);
				const at = text.lastIndexOf(STILL_RUNNING);
				if (at >= 0 && !output.isError) {
					terminal.partial = (text.slice(0, at) + text.slice(at + STILL_RUNNING.length)).replace(/\n+$/, '').replace(/^\n+/, '');
					terminal.polledAt = Date.now();
					return;
				}
				const exit = EXIT.exec(text);
				const body = exit ? text.slice(0, exit.index) : text;
				terminal.result = { output: body === '(no output)' ? '' : body, exitCode: exit ? Number(exit[1]) : output.isError ? 1 : 0 };
			} catch (error) {
				terminal.result = { output: error instanceof Error ? error.message : String(error), exitCode: 1 };
			} finally {
				terminal.busy = false;
			}
		};
		terminal.chain = terminal.chain.then(run, run);
		return terminal.chain;
	}

	private terminal(id: string): Terminal {
		const terminal = this.terminals.get(id);
		if (!terminal) throw new Error(`Unknown terminal: ${id}`);
		return terminal;
	}

	/** A running command's output so far, read again at most every few seconds; a step already running for it is not waited on. */
	private async output(id: string): Promise<unknown> {
		const terminal = this.terminal(id);
		if (!terminal.result && !terminal.busy && Date.now() - terminal.polledAt >= POLL_MS) await this.step(terminal, waitScript(terminal.label, terminal.dir, 0), 0);
		const result = terminal.result;
		const full = result?.output ?? terminal.partial;
		let output = terminal.limit !== null && Buffer.byteLength(full) > terminal.limit ? Buffer.from(full).subarray(-terminal.limit).toString() : full;
		const truncated = output !== full;
		// What the user wrote while the agent worked rides with the output it reads next, where it reads it at once.
		await Promise.resolve();
		const note = this.takeSteer();
		if (note) output = output ? `${output}\n\n${note}` : note;
		return { output, truncated, exitStatus: result ? { exitCode: result.exitCode, signal: null } : null };
	}

	private async waitForExit(id: string): Promise<unknown> {
		const terminal = this.terminal(id);
		await terminal.chain;
		while (!terminal.result) {
			if (!this.terminals.has(id)) throw new Error(`Unknown terminal: ${id}`);
			await this.step(terminal, waitScript(terminal.label, terminal.dir), WAIT_S);
		}
		return { exitCode: terminal.result.exitCode, signal: null };
	}

	/** Stops the command and everything it started, after any step already queued for it. */
	private async kill(id: string): Promise<null> {
		const terminal = this.terminal(id);
		if (terminal.result || terminal.killed) return null;
		terminal.killed = true;
		await this.step(terminal, killScript(terminal.label, terminal.dir), 10);
		return null;
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

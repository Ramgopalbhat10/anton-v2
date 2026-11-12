import { randomBytes } from 'node:crypto';
import { Type } from '@earendil-works/pi-ai';
import type { Sandbox } from '@flue/runtime';
import { quote } from '../core/shell.ts';
import type { Tool } from './sandbox-tools.ts';

/**
 * How long the agent's command runs when it names no timeout of its own. In a 20-task benchmark run the 422
 * commands that named none took 18 s at most, and every command past a minute named its own (120 s to 30 min),
 * so three minutes cuts no honest command and stops a watch-mode runner or a prompt for input in good time.
 */
export const COMMAND_TIMEOUT_MS = 3 * 60_000;
/** Where a command's whole output is kept in the machine, so the agent can read what its result leaves out. */
export const OUTPUT_DIR = '/tmp/anton-out';
/**
 * A result up to this comes back whole; a longer one as its start and end. In that run 38 of 901 results were
 * past 16KB (about 124K tokens beyond it, each sent again with every later step), and half of those were whole
 * source files or diffs printed with cat or git show, which `read` pages anyway.
 */
export const INLINE_BYTES = 16 * 1024;
/** Of a longer one, the start: a compiler's first error and the command's own first lines. */
export const HEAD_BYTES = 6 * 1024;
/** And the end, the larger part: test runners print their failures and summary last, and npm its error after them. */
export const TAIL_BYTES = INLINE_BYTES - HEAD_BYTES;
/** Outputs each machine keeps, the oldest dropped first. Only those cut are kept at all. */
export const KEEP_OUTPUTS = 30;
/** How long a stopped command's processes get to end after their TERM before they are killed. */
const KILL_GRACE_S = 5;
/** The machine's own limit, past the command's: the script still prints what the command wrote once it stops it. */
const BACKSTOP_MS = 30_000;

const BashParams = Type.Object({
	command: Type.String({ description: 'Bash command to execute' }),
	timeout: Type.Optional(Type.Number({ description: 'Timeout in seconds' })),
});

const DESCRIPTION =
	'Execute a bash command. Returns stdout and stderr together, in the order they were written. ' +
	`Output past ${INLINE_BYTES / 1024}KB comes back as its start and end, and the whole is saved to a file the result names. ` +
	`Without a timeout (in seconds), a command stops after ${COMMAND_TIMEOUT_MS / 60_000} minutes.`;

type Run = { file: string; nonce: string };

/**
 * The command as the machine runs it: in a subshell of the login shell, as before, with its output (stdout and
 * stderr, in the order written) going to a file, and stopped by the script itself at its time limit, so what it
 * wrote is still there to show. The subshell has a process group of its own (`set -m`; job control is off inside
 * it, so its pipelines and background jobs stay in that group), which the stop and a TERM to the script take
 * down whole. The script then prints the file whole up to the limit, else its start and end, and a last line with
 * the exit code, whether it was stopped, and the file's size and lines. Plain bash and coreutils.
 */
export function shellScript(command: string, seconds: number, run: Run, dir = OUTPUT_DIR): string {
	const out = quote(run.file);
	const stop = quote(`${run.file}.stop`);
	return [
		`__anton_cmd=${quote(command)}`,
		`if ! { mkdir -p ${quote(dir)} && : > ${out}; } 2>/dev/null; then eval "$__anton_cmd"; exit; fi`,
		'set -m 2>/dev/null',
		`( set +m; eval "$__anton_cmd" ) > ${out} 2>&1 &`,
		'__anton_pid=$!',
		`( sleep ${seconds}; : > ${stop}; kill -TERM -- -$__anton_pid; sleep ${KILL_GRACE_S}; kill -KILL -- -$__anton_pid ) > /dev/null 2>&1 &`,
		'__anton_watch=$!',
		"trap 'kill -TERM -- -$__anton_pid 2>/dev/null' TERM INT HUP",
		'wait $__anton_pid; __anton_code=$?',
		'kill -- -$__anton_watch 2>/dev/null',
		'set +m',
		'__anton_stopped=0',
		`if [ -e ${stop} ]; then __anton_stopped=1; __anton_code=124; rm -f ${stop}; fi`,
		`__anton_bytes=$(wc -c < ${out}); __anton_lines=$(wc -l < ${out})`,
		`if [ "$__anton_bytes" -le ${INLINE_BYTES} ]; then cat ${out}; else head -c ${HEAD_BYTES + 1} ${out}; printf '\\n%s\\n' ${run.nonce}; tail -c ${TAIL_BYTES + 1} ${out}; fi`,
		`printf '\\n%s %s %s %s %s\\n' ${run.nonce} "$__anton_code" "$__anton_stopped" "$__anton_bytes" "$__anton_lines"`,
		// A whole result needs no file; one a process left behind still writes to is emptied before it goes, so it frees its space.
		`if [ "$__anton_bytes" -le ${INLINE_BYTES} ]; then : > ${out}; rm -f ${out}; fi`,
		`( cd ${quote(dir)} && ls -1t | grep '\\.log$' | tail -n +${KEEP_OUTPUTS + 1} | while read -r old; do : > "$old"; rm -f "$old"; done ) 2>/dev/null`,
		'exit $__anton_code',
	].join('\n');
}

type Ending = { code: number; stopped: boolean; bytes: number; lines: number };

/** What the script printed: the output as it shows, and its last line, or null when the script never got to print one. */
export function parseRun(stdout: string, nonce: string): { shown: string; ending: Ending | null } {
	const at = stdout.lastIndexOf(`\n${nonce} `);
	if (at < 0) return { shown: stdout, ending: null };
	const [code, stopped, bytes, lines] = stdout.slice(at + nonce.length + 2).trim().split(/\s+/).map(Number);
	return { shown: stdout.slice(0, at), ending: { code, stopped: stopped === 1, bytes, lines } };
}

const count = (text: string, char: string) => text.split(char).length - 1;

function size(bytes: number): string {
	if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
	return `${(bytes / 1024).toFixed(1)} KB`;
}

/**
 * The start and end of a long output, cut at line ends, with a line between them saying how much is left out and
 * where the whole is. Each part comes a byte longer than it is shown, so a line that ends exactly at the cut is kept.
 * A part with no line end at all (one very long line) is cut where it is.
 */
export function startAndEnd(head: string, tail: string, bytes: number, lines: number, file: string | null): string {
	const end = head.lastIndexOf('\n');
	const start = tail.indexOf('\n');
	const shownHead = end >= 0 ? head.slice(0, end) : head;
	const shownTail = start >= 0 ? tail.slice(start + 1) : tail;
	const headLines = end >= 0 ? count(shownHead, '\n') + 1 : 0;
	const left = Math.max(0, lines - headLines - count(shownTail, '\n'));
	const leftBytes = Math.max(0, bytes - Buffer.byteLength(shownHead) - (end >= 0 ? 1 : 0) - Buffer.byteLength(shownTail));
	const where = file ? ` The whole output is in ${file}; grep or read it for the rest.` : '';
	return `${shownHead}\n[${left.toLocaleString('en-US')} lines (${size(leftBytes)}) cut here.${where}]\n${shownTail}`;
}

/** Output that never reached the file (the script was stopped, or could not make it), cut the same way in memory. */
export function cutInMemory(output: string): string {
	const bytes = Buffer.from(output);
	if (bytes.length <= INLINE_BYTES) return output;
	const head = bytes.subarray(0, HEAD_BYTES + 1).toString('utf8');
	const tail = bytes.subarray(bytes.length - TAIL_BYTES - 1).toString('utf8');
	return startAndEnd(head, tail, bytes.length, count(output, '\n'), null);
}

/** The line a stopped command's result ends with: what happened, and what to do about it. */
export function stoppedNote(seconds: number, named: boolean): string {
	if (named) return `[anton] Command timed out after ${seconds} seconds.`;
	return (
		`[anton] Stopped after ${COMMAND_TIMEOUT_MS / 60_000} minutes, the time a command gets when it names no timeout. ` +
		'For a command that needs longer, pass timeout (in seconds), or start it with run_in_background (if you have it) and go on working.'
	);
}

type ExecResult = Awaited<ReturnType<Sandbox['exec']>>;

/** The tool's result from what the script printed, in the shape Flue's `bash` gave: the exit code on a line of its own unless 0. */
export function shellResult(command: string, result: ExecResult, run: Run, seconds: number, named: boolean) {
	const { shown, ending } = parseRun(result.stdout, run.nonce);
	const exitCode = ending?.code ?? result.exitCode;
	const cut = Boolean(ending && ending.bytes > INLINE_BYTES);
	let body = shown;
	if (ending && cut) {
		const split = shown.indexOf(`\n${run.nonce}\n`);
		body = split < 0 ? shown : startAndEnd(shown.slice(0, split), shown.slice(split + run.nonce.length + 2), ending.bytes, ending.lines, run.file);
	} else if (!ending) body = cutInMemory(shown);
	// Without its last line the script was stopped by the machine's own limit, which is past the command's.
	const stopped = ending ? ending.stopped : exitCode === 124;
	const note = stopped ? stoppedNote(seconds, named) + (ending ? '' : ` What it wrote is in ${run.file}.`) : '';
	// Without the output's own last line end, a note or the reply clock follows it on the next line.
	body = body.replace(/\n$/, '');
	const output = (body + (note ? `\n${note}` : '') + (result.stderr ? `\n${result.stderr}` : '')).trim();
	return {
		content: [{ type: 'text' as const, text: exitCode === 0 ? output || '(no output)' : `${output || '(no output)'}\n\nCommand exited with code ${exitCode}` }],
		details: { command, exitCode, ...(cut || !ending ? { output: run.file } : {}) },
	};
}

export type ShellToolOptions = {
	/** Where outputs are kept in the machine (tests use a folder of their own). */
	dir?: string;
	/** A fresh name for each run. */
	id?: () => string;
};

const freshId = () => randomBytes(6).toString('hex');

/**
 * The agent's `bash`, with the name and parameters Flue's has and the models know. Flue's kept the last 2,000 lines
 * or 50KB of a command's output, which cut the first compiler error or failing test, and was up to 12,000 tokens
 * sent again with every later step; at its timeout it gave no output at all. This one keeps the start and the end
 * of a long output, with the whole in a file in the machine, in one round trip (`shellScript`). Only this tool's
 * commands are run so: every other `exec` of the sandbox and the machine is as it was. The sandbox hides secrets
 * in what comes back and adds the reply clock and job notices to it, as for every command.
 */
export function createShellTool(sandbox: Sandbox, options: ShellToolOptions = {}): Tool {
	const dir = options.dir ?? OUTPUT_DIR;
	const id = options.id ?? freshId;
	return {
		name: 'bash',
		label: 'Run Command',
		description: DESCRIPTION,
		parameters: BashParams,
		async execute(_toolCallId, params, signal) {
			signal?.throwIfAborted();
			const input = params as { command: string; timeout?: number };
			const named = typeof input.timeout === 'number' && Number.isFinite(input.timeout) && input.timeout > 0;
			const seconds = named ? Math.max(1, Math.ceil(input.timeout!)) : COMMAND_TIMEOUT_MS / 1000;
			const name = id();
			const run = { file: `${dir}/${name}.log`, nonce: `__anton_${name}_${freshId()}__` };
			const result = await sandbox.exec(shellScript(input.command, seconds, run, dir), { timeoutMs: (seconds + KILL_GRACE_S) * 1000 + BACKSTOP_MS, signal });
			return shellResult(input.command, result, run, seconds, named);
		},
	};
}

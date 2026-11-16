import { defineTool, useTool } from '@flue/runtime';
import * as v from 'valibot';
import { runScript, type ScriptScope, scriptFromFile, scriptToolDescription } from '../../../services/sandbox/code-mode.ts';
import { noteScriptCalls, type ScriptCall, shortInput } from '../../../services/tasks/script-runs.ts';
import { noteStep } from '../../../services/tasks/subagent-runs.ts';

/**
 * Code mode: one program that calls many tools, with only its result coming back; on in Settings > General.
 * Each call the program makes is kept for the thread and, in a subagent, shown on its step in the Agents panel.
 */
export function useRunScript(id: string, scope: ScriptScope) {
	useTool(
		defineTool({
			name: 'run_script',
			description: scriptToolDescription(id, scope),
			input: v.object({
				code: v.optional(v.pipe(v.string(), v.minLength(1), v.description('The body of an async JavaScript function'))),
				file: v.optional(v.pipe(v.string(), v.minLength(1), v.description('Instead of code: a program saved in the workspace, such as ../skills/<name>/scripts/x.js'))),
				args: v.optional(v.pipe(v.record(v.string(), v.unknown()), v.description('With file: values the program reads as the global `args`'))),
			}),
			run: async ({ data, signal, toolCallId }) => {
				if (!data.code === !data.file) return { output: 'Pass either code or file, not both.' };
				let code: string;
				try {
					code = data.file ? await scriptFromFile(id, data.file, data.args) : (data.code as string);
				} catch (error) {
					return { output: `The program failed. ${error instanceof Error ? error.message : String(error)}` };
				}
				const onCalls = (calls: ScriptCall[]) => {
					void noteScriptCalls(id, toolCallId, calls).catch(() => undefined);
					const decisions = calls.filter((call) => call.tool === 'decide').length;
					const actions = calls.map((call) => ({ what: `${call.tool} ${shortInput(call.input)}`.trim(), p: null, failed: call.state === 'failed' }));
					void noteStep(id, toolCallId, { outcome: null, actions, decisions, cost: 0, script: true }).catch(() => undefined);
				};
				return { output: await runScript(id, code, { ...scope, signal, onCalls }) };
			},
		}),
	);
}

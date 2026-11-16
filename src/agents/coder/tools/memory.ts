import { defineTool, useTool } from '@flue/runtime';
import * as v from 'valibot';
import type { ThreadProject } from '../../../services/tasks/agent-runner.ts';
import { remember } from '../../../services/projects/memory.ts';
import { TODOS_INPUT, updateTodos } from '../../../services/replies/todos.ts';
import { runReport, subagentRuns } from '../../../services/tasks/subagent-runs.ts';

export function useRemember(id: string, project: ThreadProject | null, chat: boolean) {
	const note = v.pipe(v.string(), v.minLength(1), v.description('One line'));
	if (chat) {
		if (!project) return;
		useTool(
			defineTool({
				name: 'remember',
				description: 'Save one short, lasting note to the project memory, which its coordinator and every thread read: a decision, a preference, a pitfall. Nothing secret.',
				input: v.object({ note }),
				run: async ({ data }) => ({ output: await remember(id, data.note, 'project') }),
			}),
		);
		return;
	}
	if (!project) {
		useTool(
			defineTool({
				name: 'remember',
				description:
					'Save one short, lasting fact about this repository for future tasks: how to run or test it, a convention, a gotcha you hit. ' +
					'Not details of this task, and nothing secret.',
				input: v.object({ note }),
				run: async ({ data }) => ({ output: await remember(id, data.note) }),
			}),
		);
		return;
	}
	useTool(
		defineTool({
			name: 'remember',
			description:
				'Save one short, lasting note for later work. scope "repo" is a fact about this repository (how to run or test it, a convention, a gotcha); ' +
				'scope "project" is a decision, preference or pitfall for the whole project, which its coordinator and every thread read. Nothing secret.',
			input: v.object({ note, scope: v.optional(v.picklist(['repo', 'project']), 'repo') }),
			run: async ({ data }) => ({ output: await remember(id, data.note, data.scope) }),
		}),
	);
}

export function useAgentRuns(id: string) {
	useTool(
		defineTool({
			name: 'agent_runs',
			description:
				"What this task's subagents did or are doing, newest first: each one's brief, state, time, latest steps and its answer or how it ended. " +
				'Read it when the user asks what a subagent did or why something took long, or after one was stopped or failed, instead of guessing.',
			input: v.object({ count: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(10)), 3) }),
			run: async ({ data }) => {
				const runs = (await subagentRuns(id)).slice(0, data.count);
				return { output: runs.length ? runs.map((run) => runReport(run)).join('\n\n') : 'No subagent has run in this task.' };
			},
		}),
	);
}

/** Written whole once, then updated by item number: resending every item to tick one off cost output tokens that stayed in the conversation. */
export function useTodos(id: string) {
	useTool(
		defineTool({
			name: 'update_todos',
			description:
				'Your todo list for the work in hand. Write it whole with todos as you start, and again only to reword, reorder, add or drop items or for new work: it replaces the list before. ' +
				'For status updates send only changes, the items that changed by number. Keep one item in_progress at a time.',
			input: TODOS_INPUT,
			run: async ({ data, toolCallId }) => ({ output: await updateTodos(id, data, toolCallId) }),
		}),
	);
}

import { defineTool, useTool } from '@flue/runtime';
import * as v from 'valibot';
import { notePlan } from '../../../services/replies/asks.ts';

export function useProposePlan(id: string) {
	useTool(
		defineTool({
			name: 'propose_plan',
			description: 'Show the user your plan for approval. Call it once the plan is ready, then stop and wait.',
			input: v.object({
				plan: v.pipe(v.string(), v.minLength(1), v.description('The plan in markdown: what will change, where, and how it will be checked')),
			}),
			async run({ data }) {
				notePlan(id, data.plan);
				return { output: 'The user sees the plan with an Approve button. Stop here; they will approve it or ask for changes.', terminate: true };
			},
		}),
	);
}

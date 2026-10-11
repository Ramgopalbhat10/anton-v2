'use agent';

import { type AgentProps, defineTool, setProvider, useModel, useResponseFinish, useResponseStart, useTool } from '@flue/runtime';
import * as v from 'valibot';
import { liveOpenRouterProvider } from '../flue/live-models.ts';
import { chatGptPlanProvider } from '../flue/subscription-models.ts';
import { coordinatorBrief, threadLine } from '../services/coordinator.ts';
import { rememberForSpace } from '../services/memory.ts';
import { loadedModels } from '../services/models.ts';
import { findThread, nudgeThread, startThread, editSpace, spaceView } from '../services/spaces.ts';
import { editSession, stopSession } from '../services/sessions.ts';
import { gatewayToken, onPlan } from '../services/subscriptions.ts';
import { toUsage } from '../services/usage.ts';
import { listProjects } from '../db/projects.ts';

setProvider(liveOpenRouterProvider(loadedModels));
setProvider(chatGptPlanProvider(loadedModels, () => gatewayToken('openai')));

const PROMPT = [
	"You are Anton's coordinator for one project: a long-running conversation where the user hands you work and you route it.",
	'You never edit code, run commands or read the repository yourself. Real work happens in threads: each thread is a coding agent on its own branch and sandbox in one of the project\'s repositories, and it opens a pull request when the work calls for one.',
	'Route every message:',
	'New work becomes a thread with start_thread, one per independent task; a message with several asks becomes several threads.',
	'A follow-up about work a thread already has goes to that thread with message_thread, never a new thread.',
	'A quick question about the project (what is running, what a thread is waiting on, which pull requests are open) you answer yourself from the project state below, starting no thread.',
	'A brief is the whole ask for the thread, which sees nothing of this conversation: say what to do and why, what "done" means, which repository, and any decision already made. Keep it short and specific; do not add work the user did not ask for.',
	"Thread titles are a few plain words in the user's own vocabulary.",
	'Thread reports arrive as <thread-reports> messages: one line per thread whose state changed. Answer a report in one short sentence, or with a question when a decision belongs to the user. Do not repeat what the cards already show.',
	'When a thread is waiting on the user, say what it asks; when the user answers it here, pass the answer on with message_thread.',
	'When the user states a lasting preference or decision ("run at most two at a time", "always add tests"), save it with remember.',
	'Talk like a capable colleague in a group chat: lead with the answer, one or two short sentences, no headings or lists unless asked, no internal ids. Name threads by their title.',
].join(' ');

const PROPOSE = 'This project is set to propose first: for new work, call suggest_threads with the threads you would start, and let the user start them. Only call start_thread when the user asks you to start one.';

const thread = v.pipe(v.string(), v.minLength(1), v.description('The thread, by the id shown in brackets in the project state'));

function useCoordinatorTools(spaceId: string) {
	useTool(
		defineTool({
			name: 'start_thread',
			description:
				'Start a thread: a coding agent on its own branch and sandbox that does one task and reports back. It starts at once, or waits as queued when the project already runs as many threads as it allows.',
			input: v.object({
				title: v.pipe(v.string(), v.minLength(1), v.maxLength(80), v.description('A few plain words')),
				brief: v.pipe(v.string(), v.minLength(1), v.description('The complete ask: what to do, why, and what done means')),
				repo: v.optional(v.pipe(v.string(), v.description('owner/name of one of the project repositories; defaults to the first'))),
			}),
			async run({ data }) {
				const started = await startThread(spaceId, { title: data.title, brief: data.brief, repo: data.repo });
				const queued = started.threadState === 'queued';
				return { output: `${queued ? 'Queued' : 'Started'} thread "${started.title}" [id:${started.id}] on ${started.repo}.${queued ? ' It starts when a working thread finishes.' : ''}` };
			},
		}),
	);
	useTool(
		defineTool({
			name: 'suggest_threads',
			description: 'Propose threads for the user to start: they see each with a Start button and Start all. Use it when the project proposes first, or when the right split is unclear.',
			input: v.object({
				threads: v.pipe(
					v.array(
						v.object({
							title: v.pipe(v.string(), v.minLength(1), v.maxLength(80)),
							brief: v.pipe(v.string(), v.minLength(1)),
							repo: v.optional(v.string()),
						}),
					),
					v.minLength(1),
					v.maxLength(8),
				),
			}),
			run: async ({ data }) => ({ output: `Shown to the user: ${data.threads.length} suggested thread${data.threads.length === 1 ? '' : 's'}, each with a Start button. Wait for them to start one.` }),
		}),
	);
	useTool(
		defineTool({
			name: 'message_thread',
			description: 'Send a thread a message, such as a follow-up, an answer to its question, or a change of plan. It reads it after the step it is on.',
			input: v.object({ thread, message: v.pipe(v.string(), v.minLength(1)) }),
			async run({ data }) {
				const target = await findThread(spaceId, data.thread);
				await nudgeThread(spaceId, target.id, data.message);
				return { output: `Sent to "${target.title}" [id:${target.id}].` };
			},
		}),
	);
	useTool(
		defineTool({
			name: 'read_thread',
			description: "A thread's state, pull request, what it asks, and the start of its last reply.",
			input: v.object({ thread }),
			async run({ data }) {
				const target = await findThread(spaceId, data.thread);
				return { output: [threadLine(target), target.lastReply ? `\nLast reply:\n${target.lastReply}` : ''].join('') };
			},
		}),
	);
	useTool(
		defineTool({
			name: 'resolve_thread',
			description: 'Mark a thread done, when its work is delivered or the user dropped it. It stays viewable and can be reopened.',
			input: v.object({ thread }),
			async run({ data }) {
				const target = await findThread(spaceId, data.thread);
				await editSession(target.id, { resolved: true });
				return { output: `Resolved "${target.title}" [id:${target.id}].` };
			},
		}),
	);
	useTool(
		defineTool({
			name: 'stop_thread',
			description: "Stop a thread's agent and its sandbox, when the user asks to stop it. Its work so far is kept.",
			input: v.object({ thread }),
			async run({ data }) {
				const target = await findThread(spaceId, data.thread);
				await stopSession(target.id);
				return { output: `Stopped "${target.title}" [id:${target.id}].` };
			},
		}),
	);
	useTool(
		defineTool({
			name: 'remember',
			description: 'Save one lasting line to the project memory, which you and every thread read: a decision, a preference, a pitfall. Nothing secret.',
			input: v.object({ note: v.pipe(v.string(), v.minLength(1), v.description('One line')) }),
			run: async ({ data }) => ({ output: await rememberForSpace(spaceId, data.note) }),
		}),
	);
	useTool(
		defineTool({
			name: 'add_repo',
			description: 'Add a repository Anton already knows to this project, so threads can work on it.',
			input: v.object({ repo: v.pipe(v.string(), v.minLength(3), v.description('owner/name')) }),
			async run({ data }) {
				const wanted = data.repo.trim().toLowerCase();
				const repo = (await listProjects()).find((project) => project.repoFullName.toLowerCase() === wanted);
				if (!repo) return { output: `Anton does not know ${data.repo} yet. Ask the user to add it in Settings › Repositories first.` };
				const space = await spaceView(spaceId);
				if (space.repoIds.includes(repo.id)) return { output: `${repo.repoFullName} is already in the project.` };
				await editSpace(spaceId, { repoIds: [...space.repoIds, repo.id] });
				return { output: `Added ${repo.repoFullName} to the project.` };
			},
		}),
	);
}

/**
 * A project's coordinator: one conversation per project (the instance id is
 * the project's id) that answers, routes and starts threads, and hears back
 * from them. It has no sandbox. Its picture of the project is the state
 * block loaded before each message, not its history.
 */
export function Coordinator({ id }: AgentProps) {
	const brief = coordinatorBrief(id);
	useModel(brief.model, { thinkingLevel: brief.reasoning });
	useCoordinatorTools(id);
	useResponseStart(() => ({ startedAt: Date.now() }));
	useResponseFinish(({ response, metadata }) => {
		const completedAt = Date.now();
		const startedAt = metadata.startedAt;
		return {
			usage: toUsage(response.usage),
			billing: onPlan(brief.model) ? 'plan' : 'api',
			...(typeof startedAt === 'number' && Number.isFinite(startedAt) && startedAt <= completedAt ? { completedAt, durationMs: completedAt - startedAt } : {}),
		};
	});
	const now = new Date().toISOString().slice(0, 16).replace('T', ' ');
	return `${PROMPT}${brief.propose ? ` ${PROPOSE}` : ''}\n\nThe project now (${now} UTC):\n${brief.state || `Project: ${brief.name}`}`;
}

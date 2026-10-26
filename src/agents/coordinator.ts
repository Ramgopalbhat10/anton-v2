'use agent';

import { type AgentProps, defineTool, setProvider, useAgentStart, useDelivery, useModel, usePersistentState, useResponseFinish, useResponseStart, useTool } from '@flue/runtime';
import * as v from 'valibot';
import { liveOpenRouterProvider, liveVercelProvider } from '../flue/live-models.ts';
import { claudeCodeProvider, cursorProvider } from '../flue/claude-code-models.ts';
import { openCodeGoProvider } from '../flue/opencode-go-models.ts';
import { chatGptPlanProvider } from '../flue/subscription-models.ts';
import { compactionFor } from '../services/context-usage.ts';
import { fullResultTool } from '../services/tool-results.ts';
import { coordinatorBrief, threadActivity, threadLine } from '../services/coordinator.ts';
import { rememberForSpace } from '../services/memory.ts';
import { loadedModels } from '../services/models.ts';
import { findThread, nudgeThread, startThread, editSpace, spaceView } from '../services/spaces.ts';
import { editSession, routedModels, stopSession } from '../services/sessions.ts';
import { readSpaceFileForAgent } from '../services/space-files.ts';
import { filesForThread, projectAttachment } from '../services/attachments.ts';
import { withAttachments } from '../core/attachments.ts';
import { gatewayKey, gatewayKeyOf, gatewayToken, onPlan, planKey, planRuntime, runtimeFor, runtimeHooks } from '../services/subscriptions.ts';
import { toUsage } from '../services/usage.ts';
import { listProjects } from '../db/projects.ts';

setProvider(liveOpenRouterProvider(loadedModels, gatewayKey, routedModels));
setProvider(liveVercelProvider(loadedModels, () => gatewayKeyOf('vercel'), routedModels));
setProvider(chatGptPlanProvider(loadedModels, () => gatewayToken('openai')));
setProvider(claudeCodeProvider(loadedModels, () => runtimeFor('claude-code'), runtimeHooks('claude-code')));
setProvider(openCodeGoProvider(loadedModels, () => planKey('opencode-go')));
setProvider(cursorProvider(loadedModels, () => planRuntime('cursor'), runtimeHooks('cursor')));

const PROMPT = [
	"You are Anton's coordinator for one project: a long-running conversation where the user hands you work and you route it.",
	'You never edit code, run commands or read the repository yourself. Real work happens in threads: each thread is a coding agent on its own branch and sandbox in one of the project\'s repositories, and it opens a pull request when the work calls for one.',
	'A thread can also work with no repository, as every thread does in a project without one: it answers, researches on the web and in a browser, and runs code or makes files in a scratch sandbox, with no branch or pull request.',
	'Route every message:',
	'New work becomes a thread with start_thread, one per independent task. Split a message into several threads only when its asks have separate results that need nothing from each other; when the answer combines its parts (how another project does something and how this one could, two codebases compared, research and the plan it informs), it is one thread with the whole question. Start several independent threads in the same step, one start_thread call each.',
	'A follow-up about work a thread already has goes to that thread with message_thread, never a new thread. A follow-up that bears on several threads goes to the one best placed to answer, with what the others found (from read_thread) in the message, not to each of them.',
	'A quick question about the project (what is running, what a thread is waiting on, which pull requests are open) you answer yourself from the project state, starting no thread.',
	'A brief is the whole ask for the thread, which sees nothing of this conversation: say what to do and why, what "done" means, which repository, and any decision already made. Keep it short and specific; do not add work the user did not ask for.',
	"Thread titles are a few plain words in the user's own vocabulary.",
	'Thread reports arrive as <thread-reports> messages: one line per thread whose state changed. Answer a report in one short sentence, or with a question when a decision belongs to the user. Do not repeat what the thread rows already show. A line with started="routine" is a thread one of the project\'s routines started on its own, not you: note it in a few words; it reports again when its state changes. A line with started="you" is a thread the user started themselves, its text the brief they gave it: the feed already shows it as a live row, so end your turn with no text at all (no acknowledgement, no restating what it does) unless it bears on other work (it duplicates or overlaps another thread, say), and then say that in one sentence; it reports again when its state changes.',
	'When a thread is waiting on the user, say what it asks; when the user answers it here, pass the answer on with message_thread.',
	"When the user asks how a thread is going, read_thread it and say what it is doing now; a thread works its messages in turn, so one stuck on a step for many minutes cannot answer one. Say so, and offer to stop it or start it again.",
	'Files and images the user attaches are saved in the project Library and arrive after their message as <attachment> blocks (an image is also shown to you, a document comes with its text). A thread sees nothing of this conversation, so whenever its work involves an attached file (a reference image, a spec, a spreadsheet), pass the file names in files with start_thread or message_thread: the thread then gets each one with its brief, an image as a picture.',
	'When the user states a lasting preference or decision ("run at most two at a time", "always add tests"), save it with remember.',
	'Talk like a capable colleague in a group chat: lead with the answer, one or two short sentences, no headings or lists unless asked, no internal ids in your words. Name a thread by linking its title to its id from the project state, as [Fix the login page](#thread-1a2b3c4d): it shows as a chip the user can open. A thread you start shows as a row of its own, so it needs no link in the same reply. Link a file a thread saved (its reply names it as ../outputs/<path>) by the thread\'s id and that path, as [diagram.png](#thread-1a2b3c4d/outputs/diagram.png): it shows as a card that opens the file.',
].join(' ');

const PROPOSE = 'This project is set to propose first: for new work, call suggest_threads with the threads you would start, and let the user start them. Only call start_thread when the user asks you to start one.';

const thread = v.pipe(v.string(), v.minLength(1), v.description('The thread, by the id shown in brackets in the project state'));
const files = v.optional(
	v.pipe(
		v.array(v.string()),
		v.maxLength(10),
		v.description('Project Library files the thread needs, by name, such as images or documents the user attached: they go with the message, an image as a picture the thread sees'),
	),
);

/**
 * The message with the project files it needs attached, as the composer
 * attaches them: those listed, those it names, or else what the user attached
 * to the message being answered (`answering`).
 */
async function withFiles(spaceId: string, message: string, listed: string[] = [], answering = ''): Promise<string> {
	const names = await filesForThread(spaceId, message, listed, answering);
	if (!names.length) return message;
	return withAttachments(message, await Promise.all(names.map((name) => projectAttachment(spaceId, name))), 'project');
}

function useCoordinatorTools(spaceId: string) {
	// The message this reply answers: its attached files go to a thread the coordinator starts or messages without naming any.
	const delivery = useDelivery();
	const answering = delivery.kind === 'user' ? delivery.body : '';
	useTool(
		defineTool({
			name: 'start_thread',
			description:
				'Start a thread: a coding agent on its own branch and sandbox that does one task and reports back. It starts at once, or waits as queued when the project already runs as many threads as it allows.',
			input: v.object({
				title: v.pipe(v.string(), v.minLength(1), v.maxLength(80), v.description('A few plain words')),
				brief: v.pipe(v.string(), v.minLength(1), v.description('The complete ask: what to do, why, and what done means')),
				repo: v.optional(v.pipe(v.string(), v.description('owner/name of one of the project repositories, or "none" for a thread with no repository; defaults to the first, or none when the project has no repositories'))),
				files,
			}),
			async run({ data }) {
				const started = await startThread(spaceId, { title: data.title, brief: await withFiles(spaceId, data.brief, data.files, answering), repo: data.repo });
				const queued = started.threadState === 'queued';
				return { output: `${queued ? 'Queued' : 'Started'} thread "${started.title}" [id:${started.id}] ${started.repo ? `on ${started.repo}` : 'with no repository'}.${queued ? ' It starts when a working thread finishes.' : ''}` };
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
			input: v.object({ thread, message: v.pipe(v.string(), v.minLength(1)), files }),
			async run({ data }) {
				const target = await findThread(spaceId, data.thread);
				await nudgeThread(spaceId, target.id, await withFiles(spaceId, data.message, data.files, answering));
				return { output: `Sent to "${target.title}" [id:${target.id}].` };
			},
		}),
	);
	useTool(
		defineTool({
			name: 'read_thread',
			description: "A thread's state, pull request, what it asks, what it is doing now and for how long (with its subagents' latest steps), and the start of its last reply.",
			input: v.object({ thread }),
			async run({ data }) {
				const target = await findThread(spaceId, data.thread);
				const activity = await threadActivity(target.id);
				return { output: [threadLine(target), activity ? `\n${activity}` : '', target.lastReply ? `\nLast reply:\n${target.lastReply}` : ''].join('') };
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
			name: 'read_project_file',
			description:
				"Read a file from the project's Library as text, such as one the user attached: PDFs, Word, PowerPoint, Excel and OpenDocument files are converted. Without a path, lists the files.",
			input: v.object({
				path: v.optional(v.pipe(v.string(), v.description('File name as listed'))),
				offset: v.optional(v.pipe(v.number(), v.description('Character to start from, for the next part of a long file'))),
			}),
			run: async ({ data }) => ({ output: await readSpaceFileForAgent(spaceId, data.path, data.offset) }),
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
 * from them. It has no sandbox. Its picture of the project is the latest
 * state block in its conversation (`useProjectState`), not its history.
 */
export function Coordinator({ id }: AgentProps) {
	const brief = coordinatorBrief(id);
	useModel(brief.model, { thinkingLevel: brief.reasoning, compaction: compactionFor(brief.model) });
	useCoordinatorTools(id);
	useTool(fullResultTool(id));
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
	useProjectState(id);
	return `${PROMPT}${brief.propose ? ` ${PROPOSE}` : ''} ${STATE_NOTE}`;
}

const STATE_NOTE =
	'The project as it stands (its threads, their states and ids, its repositories) arrives as a <signal type="project-state"> block after a message whenever it has changed: the latest one is the project now.';
/** The state goes again after this many messages even unchanged, so compaction never leaves the coordinator without it. */
const STATE_EVERY = 10;

/**
 * Puts the project's state in the conversation, after each message it has changed for, rather than in the
 * instructions: instructions that changed with every thread's state missed the prompt cache on every message.
 */
function useProjectState(id: string) {
	const [, setShown] = usePersistentState<{ body: string; since: number } | null>('project-state', null);
	useAgentStart(({ append }) => {
		const brief = coordinatorBrief(id);
		const body = `The project now (${new Date().toISOString().slice(0, 10)}):\n${brief.state || `Project: ${brief.name}`}`;
		setShown((shown) => {
			if (shown?.body === body && shown.since < STATE_EVERY) return { body, since: shown.since + 1 };
			append({ kind: 'signal', type: 'project-state', body });
			return { body, since: 1 };
		});
	});
}

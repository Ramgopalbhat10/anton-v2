'use agent';

import { type AgentProps, defineTool, useAgentStart, useDelivery, useModel, usePersistentState, useResponseFinish, useResponseStart, useTool } from '@flue/runtime';
import * as v from 'valibot';
import { STATE_SIGNAL } from '../services/context/context-prune.ts';
import { agentCompaction } from '../services/context/context-usage.ts';
import { fullResultTool } from '../services/context/tool-results.ts';
import { coordinatorBrief, threadActivity, threadLine } from '../services/projects/coordinator.ts';
import { rememberForSpace } from '../services/projects/memory.ts';
import { findThread, nudgeThread, startThread, editSpace, spaceView } from '../services/projects/spaces.ts';
import { assertHostHandoff, coordinatorTodo, createTodo, messageTodoThread, startTodoThread, claimHostHandoff, type TodoHandoffs } from '../services/projects/todos.ts';
import { editSession, stopSession } from '../services/tasks/sessions.ts';
import { readSpaceFileForAgent } from '../services/projects/space-files.ts';
import { filesForThread, projectAttachment } from '../services/artifacts/attachments.ts';
import { splitAttachments, withAttachments } from '../core/attachments.ts';
import { quotedFrom, threadBrief } from '../core/briefs.ts';
import { todoHandoffId, todoThreadFiles } from '../core/space-todos.ts';
import { onPlan } from '../services/models/subscriptions.ts';
import { toUsage } from '../services/models/usage.ts';
import { listProjects } from '../db/projects.ts';
// Registers the model providers before this agent resolves a model.
import './providers.ts';

const PROMPT = [
	"You are Anton's coordinator for one project: a long-running conversation where the user hands you work and you route it.",
	'You never edit code, run commands or read the repository yourself. Real work happens in threads: each thread is a coding agent on its own branch and sandbox in one of the project\'s repositories, and it opens a pull request when the work calls for one.',
	'A thread can also work with no repository, as every thread does in a project without one: it answers, researches on the web and in a browser, and runs code or makes files in a scratch sandbox, with no branch or pull request.',
	'Route every message:',
	'New work becomes a thread with start_thread, one per independent task. Split a message into several threads only when its asks have separate results that need nothing from each other; when the answer combines its parts (how another project does something and how this one could, two codebases compared, research and the plan it informs), it is one thread with the whole question. Start several independent threads in the same step, one start_thread call each.',
	'A follow-up about work a thread already has goes to that thread with message_thread, never a new thread. A follow-up that bears on several threads goes to the one best placed to answer, with what the others found (from read_thread) in the message, not to each of them.',
	'A quick question about the project (what is running, what a thread is waiting on, which pull requests are open) you answer yourself from the project state, starting no thread.',
	"A thread sees nothing of this conversation. Its request is the user's own words, copied exactly from their message (only the part for that thread when the message holds several tasks); Anton checks the copy. When the user approved work you proposed, copy your proposal's words and set approved.",
	"A thread opens one pull request at a time. When the user asks for several pull requests, or for a change too big for one, start a thread for each: each quotes the same ask as its request and names its share in part. When a part builds on another's change, start it once that one's pull request is merged, so its branch starts from it.",
	"Put only what the thread cannot see in context: the repository's files or area, a decision made here, what an earlier thread found. Never add checks the user did not name (more viewports, devices, flows, error paths, regression sweeps, reports): the thread checks its own work as the change needs. A one-line bug report gets no context or a line of it.",
	"Thread titles are a few plain words in the user's own vocabulary.",
	'Thread reports arrive as <thread-reports> messages: one line per thread whose state changed. Answer a report in one short sentence that names each thread it covers by linking its title (as below), or with a question when a decision belongs to the user: the feed shows a report only as that thread\'s chip in your words, so say what changed rather than its state alone. A line with started="routine" is a thread one of the project\'s routines started on its own, not you: note it in a few words; it reports again when its state changes. A line with started="you" is a thread the user started themselves, its text the brief they gave it: the feed already shows it as a live row, so end your turn with no text at all (no acknowledgement, no restating what it does) unless it bears on other work (it duplicates or overlaps another thread, say), and then say that in one sentence; it reports again when its state changes.',
	'When a thread is waiting on the user, say what it asks; when the user answers it here, pass the answer on with message_thread.',
	"When the user asks how a thread is going, read_thread it and say what it is doing now; a thread works its messages in turn, so one stuck on a step for many minutes cannot answer one. Say so, and offer to stop it or start it again.",
	'Files and images the user attaches are saved in the project Library and arrive after their message as <attachment> blocks (an image is also shown to you, a document comes with its text). A thread sees nothing of this conversation, so whenever its work involves an attached file (a reference image, a spec, a spreadsheet), pass the file names in files with start_thread or message_thread: the thread then gets each one with its brief, an image as a picture.',
	'A message "Start the project to-do [todo:…]" is the user starting that to-do from the board: start its thread(s) right away (even when the project is set to propose first) with start_thread, or route it to an existing thread with message_thread, passing its todo_id either way. When you split a to-do over several threads, pass each one in files only the to-do files its part needs; a thread you pass no files gets all of them. To save work for later without starting it, use create_todo.',
	'A to-do the user tagged with repositories (its handoff and its line in the project state name them) has its threads only in those, one or more per repository; a thread you give no repo goes to the first one tagged.',
	'If several board handoffs arrive together, use the matching todo_id and words from that handoff on each call. Do not combine different to-dos into one thread.',
	'A to-do with its own main thread model must start with start_thread, not message_thread; its new threads automatically use that model. Ordinary follow-up messages to its running threads need no todo_id.',
	'When the user states a lasting preference or decision ("run at most two at a time", "always add tests"), save it with remember.',
	'Talk like a capable colleague in a group chat: lead with the answer, one or two short sentences, no headings or lists unless asked, no internal ids in your words. Name a thread by linking its title to its id from the project state, as [Fix the login page](#thread-1a2b3c4d): it shows as a chip the user can open. A thread you start shows as a row of its own, so it needs no link in the same reply. Link a file a thread saved (its reply names it as ../outputs/<path>) by the thread\'s id and that path, as [diagram.png](#thread-1a2b3c4d/outputs/diagram.png): it shows as a card that opens the file.',
].join(' ');

const PROPOSE = 'This project is set to propose first: for new work, call suggest_threads with the threads you would start, and let the user start them. Only call start_thread when the user asks you to start one, or starts a project to-do.';

const thread = v.pipe(v.string(), v.minLength(1), v.description('The thread, by the id shown in brackets in the project state'));
const todoId = v.optional(v.pipe(v.string(), v.description('The project to-do this works on, by the id shown as [todo:…] in the project state')));
const threadActionResult = (text: string, resolvedTodoId?: string) => ({ output: resolvedTodoId ? { output: text, todoId: resolvedTodoId } : text });
const files = v.optional(
	v.pipe(
		v.array(v.string()),
		v.maxLength(10),
		v.description('Project Library files the thread needs, by name, such as images or documents the user attached: they go with the message, an image as a picture the thread sees'),
	),
);

async function withFiles(spaceId: string, message: string, listed: string[] = [], answering = ''): Promise<string> {
	const names = await filesForThread(spaceId, message, listed, answering);
	if (!names.length) return message;
	return withAttachments(message, await Promise.all(names.map((name) => projectAttachment(spaceId, name))), 'project');
}


function useCoordinatorTools(spaceId: string, answering: string, handoffs: () => TodoHandoffs) {
	useTool(
		defineTool({
			name: 'start_thread',
			description:
				'Start a thread: a coding agent on its own branch and sandbox that does one task and reports back. It starts at once, or waits as queued when the project already runs as many threads as it allows.',
			input: v.object({
				title: v.pipe(v.string(), v.minLength(1), v.maxLength(80), v.description('A few plain words')),
				request: v.pipe(v.string(), v.minLength(1), v.description("The user's words for this task, copied exactly from their message; join parts you leave out with …")),
				context: v.optional(v.pipe(v.string(), v.description('Only what the thread cannot see: files, area, decisions made here, earlier findings. No checks or work the user did not ask for'))),
				approved: v.optional(v.pipe(v.boolean(), v.description('true when the request copies your own proposal that the user approved, not their message'))),
				part: v.optional(
					v.pipe(v.string(), v.description('When one ask is split over several threads (several pull requests), the part this thread does, in a sentence: its share of the request, no checks')),
				),
				repo: v.optional(v.pipe(v.string(), v.description('owner/name of one of the project repositories, or "none" for a thread with no repository; defaults to the first, or none when the project has no repositories'))),
				todo_id: todoId,
				files,
			}),
			async run({ data }) {
				const linked = await coordinatorTodo(spaceId, handoffs(), data.todo_id);
				const source = linked?.text ?? answering;
				const said = splitAttachments(source).text;
				const isHandoff = linked?.text !== undefined;
				if (said.trim() && (isHandoff || !data.approved) && !quotedFrom(data.request, said))
					throw new Error(
						isHandoff
							? "request is not the user's words for this to-do: copy it from the handoff with the matching todo_id, and put what you add in context."
							: "request is not the user's words: copy it exactly from their message (only the part for this thread, joining left-out parts with …), and put what you add in context. If the user approved your own proposal, set approved.",
					);
				const brief = threadBrief(data.request, data.context, data.part);
				// Its card shows as soon as it has a slot; the brief reaches it behind this answer.
				const todo = linked?.todo ?? null;
				assertHostHandoff(linked);
				const input = { title: data.title, brief: await withFiles(spaceId, brief, todoThreadFiles(todo, data.files), source), repo: data.repo };
				const started = todo ? (await startTodoThread(todo, input)).thread : await startThread(spaceId, input, { wait: false });
				const queued = started.threadState === 'queued';
				return threadActionResult(
					`${queued ? 'Queued' : 'Started'} thread "${started.title}" [id:${started.id}] ${started.repo ? `on ${started.repo}` : 'with no repository'}.${queued ? ' It starts when a working thread finishes.' : ''}`,
					todo?.id,
				);
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
			input: v.object({ thread, message: v.pipe(v.string(), v.minLength(1)), todo_id: todoId, files }),
			async run({ data }) {
				const target = await findThread(spaceId, data.thread);
				const linked = await coordinatorTodo(spaceId, handoffs(), data.todo_id);
				const todo = linked?.todo ?? null;
				assertHostHandoff(linked);
				const message = await withFiles(spaceId, data.message, todoThreadFiles(todo, data.files), linked?.text ?? answering);
				if (todo) await messageTodoThread(todo, target.id, message);
				else await nudgeThread(spaceId, target.id, message);
				return threadActionResult(`Sent to "${target.title}" [id:${target.id}].`, todo?.id);
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
			name: 'create_todo',
			description: 'Add a to-do to the project board for later, without starting it.',
			input: v.object({ title: v.pipe(v.string(), v.minLength(1), v.maxLength(200)), description: v.optional(v.pipe(v.string(), v.description('What done looks like, in the user’s words where you have them'))) }),
			async run({ data }) {
				const todo = await createTodo(spaceId, { ...data, createdBy: 'coordinator' });
				return { output: `Added to-do "${todo.title}".` };
			},
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

/** One conversation per project (the instance id is the project's id). Its picture of the project is the latest state block, not its history. */
export function Coordinator({ id }: AgentProps) {
	const brief = coordinatorBrief(id);
	const delivery = useDelivery();
	const answering = delivery.kind === 'user' ? delivery.body : '';
	const handoffs = useProjectState(id, delivery);
	useModel(brief.model, { thinkingLevel: brief.reasoning, compaction: agentCompaction(brief.model) });
	useCoordinatorTools(id, answering, handoffs);
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
	return `${PROMPT}${brief.propose ? ` ${PROPOSE}` : ''} ${STATE_NOTE}`;
}

const STATE_NOTE =
	'The project as it stands (its threads, their states and ids, its repositories) arrives as a <signal type="project-state"> block after a message whenever it has changed: the latest one is the project now.';
/** The state goes again after this many messages even unchanged, so compaction never leaves the coordinator without it. */
const STATE_EVERY = 10;

/** In the conversation, not the instructions: instructions that changed with every thread's state missed the prompt cache. */
function useProjectState(id: string, delivery: ReturnType<typeof useDelivery>): () => TodoHandoffs {
	const [, setShown] = usePersistentState<{ body: string; since: number } | null>('project-state', null);
	const [handoffs, setHandoffs] = usePersistentState<TodoHandoffs>('todo-handoffs', { entries: [], latestIsHandoff: false });
	const handoffId = delivery.kind === 'user' ? todoHandoffId(delivery.body) : null;
	let activeHandoffs = handoffs;
	let startsResponse = false;
	useResponseStart(() => {
		startsResponse = true;
	});
	useAgentStart(({ append }) => {
		// Reset on the first delivery, not a join or a replay whose delivery hook was already committed.
		const text = handoffId && delivery.kind === 'user' ? splitAttachments(delivery.body).text : '';
		const host = handoffId && delivery.kind === 'user' ? claimHostHandoff(delivery.body, handoffId) : undefined;
		setHandoffs((current) => {
			const entries = startsResponse ? [] : current.entries;
			// Flue can call the tools from this render before rendering again with the saved state.
			activeHandoffs = {
				entries: handoffId ? [...entries.filter(({ id }) => id !== handoffId), { id: handoffId, text, ...(host ? { host } : {}) }] : entries,
				latestIsHandoff: Boolean(handoffId),
			};
			return activeHandoffs;
		});
		const brief = coordinatorBrief(id);
		const body = `The project now (${new Date().toISOString().slice(0, 10)}):\n${brief.state || `Project: ${brief.name}`}`;
		setShown((shown) => {
			if (shown?.body === body && shown.since < STATE_EVERY) return { body, since: shown.since + 1 };
			append({ kind: 'signal', type: STATE_SIGNAL, body });
			return { body, since: 1 };
		});
	});
	return () => activeHandoffs;
}

import { Hono } from 'hono';
import * as v from 'valibot';
import { InvalidInputError } from '../core/errors.ts';
import { MAX_UPLOAD_BYTES } from '../services/artifacts/files.ts';
import { listThreads } from '../services/tasks/sessions.ts';
import { createSpace, editSpace, MAX_INSTRUCTIONS, MAX_SPACE_MEMORY, nudgeThread, removeSpace, spaceUsage, spacesView, spaceView, startThread } from '../services/projects/spaces.ts';
import { createTodo, editTodo, listTodos, MAX_TODO_DESCRIPTION, MAX_TODO_TITLE, removeTodo, startTodo } from '../services/projects/todos.ts';
import { threadStarted } from '../services/projects/thread-reports.ts';
import { listSpaceFiles, readSpaceFile, removeSpaceFile, uploadSpaceFile } from '../services/projects/space-files.ts';
import { attachToProject } from '../services/artifacts/attachments.ts';
import { REASONING, AGENT_MODEL, body, contentType, bytes } from './shared.ts';

const app = new Hono();

const SPACE_FIELDS = {
	name: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(80))),
	icon: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(40), v.regex(/^[a-z0-9-]+(:[a-z0-9-]+)?$/, 'Pick an icon from the list')))),
	goal: v.optional(v.pipe(v.string(), v.maxLength(300))),
	instructions: v.optional(v.pipe(v.string(), v.maxLength(MAX_INSTRUCTIONS))),
	autonomy: v.optional(v.picklist(['start', 'propose'])),
	maxParallel: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(10))),
};
app.get('/api/spaces', async (c) => c.json({ spaces: await spacesView() }));
app.post('/api/spaces', async (c) => {
	const input = await body(
		c,
		v.object({ ...SPACE_FIELDS, name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(80)), repoIds: v.optional(v.pipe(v.array(v.string()), v.maxLength(20)), []) }),
	);
	return c.json(await createSpace(input));
});
app.get('/api/spaces/:id', async (c) => c.json(await spaceView(c.req.param('id'))));
app.patch('/api/spaces/:id', async (c) => {
	const change = await body(
		c,
		v.object({
			...SPACE_FIELDS,
			memory: v.optional(v.pipe(v.string(), v.maxLength(MAX_SPACE_MEMORY))),
			coordinatorModel: v.optional(v.nullable(v.pipe(v.string(), v.minLength(1)))),
			coordinatorReasoning: v.optional(v.nullable(REASONING)),
			threadModel: v.optional(v.nullable(v.pipe(v.string(), v.minLength(1)))),
			threadReasoning: v.optional(v.nullable(REASONING)),
			agentModels: v.optional(v.object({ explorer: AGENT_MODEL, tester: AGENT_MODEL, browser: AGENT_MODEL, computer: AGENT_MODEL, reviewer: AGENT_MODEL })),
			state: v.optional(v.picklist(['active', 'paused', 'archived'])),
			repoIds: v.optional(v.pipe(v.array(v.string()), v.maxLength(20))),
		}),
	);
	return c.json(await editSpace(c.req.param('id'), change));
});
app.delete('/api/spaces/:id', async (c) => {
	await removeSpace(c.req.param('id'));
	return c.json({ ok: true });
});
app.get('/api/spaces/:id/threads', async (c) => {
	const space = await spaceView(c.req.param('id'));
	return c.json({ threads: await listThreads(space.id) });
});
app.post('/api/spaces/:id/threads', async (c) => {
	const input = await body(
		c,
		v.object({
			// Chosen by the page, so it can open the thread while it is made.
			id: v.optional(v.pipe(v.string(), v.uuid())),
			title: v.optional(v.pipe(v.string(), v.maxLength(200)), ''),
			brief: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(40_000)),
			projectId: v.optional(v.nullable(v.string())),
			repo: v.optional(v.string()),
			model: v.optional(v.string()),
			reasoning: v.optional(REASONING),
			planMode: v.optional(v.boolean()),
		}),
	);
	// Answered once the thread has its slot; its brief reaches it behind the answer.
	const thread = await startThread(c.req.param('id'), input, { wait: false });
	await threadStarted(thread.id, { by: 'you', brief: input.brief });
	return c.json(thread);
});
app.post('/api/spaces/:id/threads/:threadId/nudge', async (c) => {
	const { text } = await body(c, v.object({ text: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(20_000)) }));
	return c.json(await nudgeThread(c.req.param('id'), c.req.param('threadId'), text));
});
app.get('/api/spaces/:id/usage', async (c) => c.json(await spaceUsage(c.req.param('id'))));

app.get('/api/spaces/:id/files', async (c) => c.json({ files: await listSpaceFiles(c.req.param('id')) }));
app.get('/api/spaces/:id/file', async (c) => {
	const path = c.req.query('path') ?? '';
	return bytes(c, await readSpaceFile(c.req.param('id'), path), contentType(path));
});
app.post('/api/spaces/:id/files', async (c) => {
	const name = c.req.query('name') ?? '';
	if (!name) throw new InvalidInputError('Name the file');
	if (Number(c.req.header('content-length') ?? 0) > MAX_UPLOAD_BYTES) throw new InvalidInputError('Files up to 20 MB can be added to the Library.');
	return c.json(await uploadSpaceFile(c.req.param('id'), name, new Uint8Array(await c.req.arrayBuffer()), c.req.header('content-type') || undefined));
});
app.post('/api/spaces/:id/attachments', async (c) => {
	const name = c.req.query('name') ?? '';
	if (!name) throw new InvalidInputError('Name the file');
	if (Number(c.req.header('content-length') ?? 0) > MAX_UPLOAD_BYTES) throw new InvalidInputError('Files up to 20 MB can be attached.');
	return c.json(await attachToProject(c.req.param('id'), name, new Uint8Array(await c.req.arrayBuffer()), c.req.header('content-type') || undefined));
});
app.delete('/api/spaces/:id/file', async (c) => {
	await removeSpaceFile(c.req.param('id'), c.req.query('path') ?? '');
	return c.json({ ok: true });
});

const TODO_TITLE = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(MAX_TODO_TITLE));
const TODO_DESCRIPTION = v.pipe(v.string(), v.maxLength(MAX_TODO_DESCRIPTION));

app.get('/api/spaces/:id/todos', async (c) => c.json({ todos: await listTodos(c.req.param('id')) }));
app.post('/api/spaces/:id/todos', async (c) => {
	const input = await body(c, v.object({ title: TODO_TITLE, description: v.optional(TODO_DESCRIPTION) }));
	return c.json(await createTodo(c.req.param('id'), input));
});
app.patch('/api/spaces/:id/todos/:todoId', async (c) => {
	const change = await body(c, v.object({ title: v.optional(TODO_TITLE), description: v.optional(TODO_DESCRIPTION), status: v.optional(v.picklist(['open', 'done'])) }));
	return c.json(await editTodo(c.req.param('id'), c.req.param('todoId'), change));
});
app.delete('/api/spaces/:id/todos/:todoId', async (c) => {
	await removeTodo(c.req.param('id'), c.req.param('todoId'));
	return c.json({ ok: true });
});
app.post('/api/spaces/:id/todos/:todoId/start', async (c) => {
	const { target } = await body(c, v.object({ target: v.picklist(['thread', 'coordinator']) }));
	return c.json(await startTodo(c.req.param('id'), c.req.param('todoId'), target));
});

export const spaceRoutes = app;

import { Hono } from 'hono';
import * as v from 'valibot';
import { projectFiles } from '../services/artifacts/files.ts';
import { addableRepos, addProject, branches, MAX_CHECK_COMMAND, projects, rebuildPreparedImage, removeProject, updateSettings } from '../services/projects/projects.ts';
import { releaseSpare, wakeSpare } from '../services/sandbox/spares.ts';
import { MAX_MEMORY, saveMemory } from '../services/projects/memory.ts';
import { ENV, body } from './shared.ts';

const app = new Hono();

app.post('/api/projects/:id/wake', async (c) => {
	const input = await body(c, v.object({ taskId: v.pipe(v.string(), v.uuid()), branch: v.optional(v.pipe(v.string(), v.maxLength(255))) }));
	return c.json(await wakeSpare({ projectId: c.req.param('id'), ...input }));
});
app.delete('/api/drafts/:taskId/wake', (c) => {
	releaseSpare(c.req.param('taskId'));
	return c.json({ released: true });
});
app.post('/api/projects/:id/prepared-image/rebuild', async (c) => c.json(await rebuildPreparedImage(c.req.param('id'))));

app.get('/api/projects', async (c) => c.json({ projects: await projects() }));
app.get('/api/repos', async (c) => c.json({ repos: await addableRepos() }));
app.post('/api/projects', async (c) => {
	const { repo } = await body(c, v.object({ repo: v.pipe(v.string(), v.trim(), v.minLength(3)) }));
	return c.json(await addProject(repo));
});
app.delete('/api/projects/:id', async (c) => {
	await removeProject(c.req.param('id'));
	return c.json({ ok: true });
});
app.put('/api/projects/:id/memory', async (c) => {
	const { memory } = await body(c, v.object({ memory: v.pipe(v.string(), v.maxLength(MAX_MEMORY)) }));
	await saveMemory(c.req.param('id'), memory);
	return c.json({ memory: memory.trim() });
});
app.put('/api/projects/:id/settings', async (c) => {
	const change = await body(
		c,
		v.object({
			env: ENV,
			setupScript: v.pipe(v.string(), v.maxLength(20_000)),
			checkCommand: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(MAX_CHECK_COMMAND))),
			previewPorts: v.pipe(
				v.array(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(65_535))),
				v.maxLength(8),
				v.check((ports) => new Set(ports).size === ports.length, 'List each preview port once'),
			),
			baseImage: v.nullable(v.pipe(v.string(), v.maxLength(300))),
			fullVm: v.optional(v.boolean()),
			followUps: v.optional(v.boolean()),
			reviewOthers: v.optional(v.boolean()),
		}),
	);
	return c.json(await updateSettings(c.req.param('id'), change));
});

app.get('/api/projects/:id/branches', async (c) => c.json({ branches: await branches(c.req.param('id')) }));
app.get('/api/projects/:id/files', async (c) => c.json({ paths: await projectFiles(c.req.param('id'), c.req.query('branch')) }));

export const projectRoutes = app;

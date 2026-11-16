import { Hono } from 'hono';
import * as v from 'valibot';
import { InvalidInputError } from '../core/errors.ts';
import { artifactArchive } from '../services/artifacts/artifact-archive.ts';
import { listArtifacts } from '../services/artifacts/artifacts.ts';
import { ADDED_FILES, addFile } from '../services/artifacts/added-files.ts';
import { MAX_UPLOAD_BYTES } from '../services/artifacts/files.ts';
import { installAddedSkill, pluginsView } from '../services/settings/plugins.ts';
import { body } from './shared.ts';

/** The Artifacts page: everything the agent made, downloads as one ZIP, and files you add there. */
const app = new Hono();

// Everything the agent made in every task, for the Artifacts page.
app.get('/api/artifacts', async (c) => c.json({ artifacts: await listArtifacts() }));
// A single, bounded ZIP rather than many downloads (which browsers may block).
app.post('/api/artifacts/download', async (c) => {
	const { items } = await body(c, v.object({ items: v.pipe(v.array(v.object({
		sessionId: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
		path: v.pipe(v.string(), v.minLength(1), v.maxLength(1000)),
	})), v.minLength(1), v.maxLength(500)) }));
	return c.body(new Uint8Array(await artifactArchive(items)), 200, {
		'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="artifacts.zip"', 'Cache-Control': 'no-store',
	});
});
// A file you add on the Artifacts page: the body is the file, its name in the query. It is read and deleted as the
// Library of src/services/artifacts/added-files.ts's holder, through the Library routes in sessions.ts.
app.post('/api/artifacts', async (c) => {
	const name = c.req.query('name') ?? '';
	if (!name) throw new InvalidInputError('Name the file');
	if (Number(c.req.header('content-length') ?? 0) > MAX_UPLOAD_BYTES) throw new InvalidInputError('Files up to 20 MB can be added.');
	const body = new Uint8Array(await c.req.arrayBuffer());
	return c.json({ path: await addFile(name, body, c.req.header('content-type') || undefined), sessionId: ADDED_FILES });
});
// A file you added, installed as a skill: its front matter names it, whatever the file is called.
app.post('/api/artifacts/skill', async (c) => {
	const { path } = await body(c, v.object({ path: v.pipe(v.string(), v.minLength(1), v.maxLength(500)) }));
	await installAddedSkill(path);
	return c.json({ plugins: await pluginsView() });
});

export const artifactRoutes = app;

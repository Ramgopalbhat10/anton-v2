import { Hono } from 'hono';
import * as v from 'valibot';
import { catalog, installPlugin, marketplaces, pluginFile, pluginsView, previewPlugin, removePlugin, searchGitHub, setEnabled, setMarketplaces } from '../services/settings/plugins.ts';
import { valid, body, bytes } from './shared.ts';

/** Plugins and skills: installed plugins, marketplaces and their catalogs, and the GitHub skill search. */
const app = new Hono();

app.get('/api/plugins', async (c) => c.json({ plugins: await pluginsView(), marketplaces: await marketplaces() }));
app.put('/api/settings/marketplaces', async (c) => {
	const input = await body(c, v.object({ marketplaces: v.pipe(v.array(v.pipe(v.string(), v.trim(), v.minLength(1))), v.maxLength(20)) }));
	return c.json({ marketplaces: await setMarketplaces(input.marketplaces) });
});
app.get('/api/marketplaces/catalog', async (c) => c.json({ entries: await catalog(c.req.query('repo') ?? '', c.req.query('bundle')) }));
const PLUGIN_PICK = v.union([
	v.object({ marketplace: v.pipe(v.string(), v.minLength(1)), name: v.pipe(v.string(), v.minLength(1)) }),
	v.object({ address: v.pipe(v.string(), v.trim(), v.minLength(1)) }),
	v.object({ plugin: v.pipe(v.string(), v.minLength(1)) }),
]);
app.post('/api/plugins', async (c) => {
	await installPlugin(await body(c, PLUGIN_PICK));
	return c.json({ plugins: await pluginsView() });
});
app.get('/api/plugins/preview', async (c) => c.json(await previewPlugin(valid(PLUGIN_PICK, c.req.query()))));
app.get('/api/plugins/file', async (c) => bytes(c, await pluginFile(c.req.query('repo') ?? '', c.req.query('sha') ?? '', c.req.query('path') ?? '')));
app.get('/api/skills/search', async (c) => c.json(await searchGitHub(c.req.query('q') ?? '')));
app.patch('/api/plugins/:id', async (c) => {
	const { enabled } = await body(c, v.object({ enabled: v.boolean() }));
	await setEnabled(c.req.param('id'), enabled);
	return c.json({ plugins: await pluginsView() });
});
app.delete('/api/plugins/:id', async (c) => {
	await removePlugin(c.req.param('id'));
	return c.json({ plugins: await pluginsView() });
});

export const pluginRoutes = app;

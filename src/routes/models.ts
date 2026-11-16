import { Hono } from 'hono';
import * as v from 'valibot';
import { config } from '../config.ts';
import { InvalidInputError } from '../core/errors.ts';
import { listModels, modelEndpoints, pinnedModels, setPinnedModels } from '../services/models/models.ts';
import { imageModels, imagesAvailable } from '../services/artifacts/images.ts';
import { defaultModel } from '../services/models/general.ts';
import { beginLogin, cancelLogin, connectKey, disconnect, finishLogin, importLogin, refreshSubscriptionModels, setSubscriptionOptions, subscriptionsView } from '../services/models/subscriptions.ts';
import { body } from './shared.ts';

/** The model catalog, pinned models, image models, and the plans in Settings › Subscriptions. */
const app = new Hono();

app.get('/api/models', async (c) => c.json({ models: await listModels(), default: await defaultModel(), pinned: await pinnedModels() }));
// The providers a gateway can send one model's calls to, for a task's route; empty for a model on a plan.
app.get('/api/models/endpoints', async (c) => {
	const model = c.req.query('model') ?? '';
	if (!model) throw new InvalidInputError('Name a model.');
	return c.json({ endpoints: await modelEndpoints(model) });
});
// What generate_image can draw with, for Settings › General; empty without an OpenRouter key.
app.get('/api/image-models', async (c) => c.json({ models: await imageModels(), default: config.imageModel, available: imagesAvailable() }));
app.put('/api/models/pinned', async (c) => {
	const { pinned } = await body(c, v.object({ pinned: v.pipe(v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(200))), v.maxLength(100)) }));
	return c.json({ pinned: await setPinnedModels(pinned) });
});

// Plans you already pay for, signed in to with the vendor's own flow; see services/models/subscriptions.ts.
app.get('/api/subscriptions', async (c) => c.json({ subscriptions: await subscriptionsView() }));
app.put('/api/subscriptions/:id', async (c) => {
	const options = await body(c, v.object({ enabled: v.boolean(), countAtApiPrices: v.boolean() }));
	return c.json(await setSubscriptionOptions(c.req.param('id'), options));
});
app.delete('/api/subscriptions/:id', async (c) => c.json(await disconnect(c.req.param('id'))));
app.post('/api/subscriptions/:id/login', async (c) => c.json(await beginLogin(c.req.param('id'))));
app.delete('/api/subscriptions/:id/login', async (c) => c.json(await cancelLogin(c.req.param('id'))));
app.post('/api/subscriptions/:id/login/complete', async (c) => {
	const { callbackUrl } = await body(c, v.object({ callbackUrl: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(4000)) }));
	return c.json(await finishLogin(c.req.param('id'), callbackUrl));
});
app.post('/api/subscriptions/:id/import', async (c) => {
	const { credential } = await body(c, v.object({ credential: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(50_000)) }));
	return c.json(await importLogin(c.req.param('id'), credential));
});
// Plans used with a key from the vendor's dashboard (OpenCode Go, Cursor), and OpenRouter's key: the key is checked with the vendor before it is kept.
app.put('/api/subscriptions/:id/key', async (c) => {
	const { key } = await body(c, v.object({ key: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(2000)) }));
	return c.json(await connectKey(c.req.param('id'), key));
});
app.post('/api/subscriptions/:id/models/refresh', async (c) => c.json(await refreshSubscriptionModels(c.req.param('id'))));

export const modelRoutes = app;

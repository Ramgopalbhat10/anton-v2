import { Hono } from 'hono';
import * as v from 'valibot';
import { markNotifications, notificationsView } from '../services/notify/notifications.ts';
import { addDevice, notePresence, pushView, removeDevice, sendTest, setPushOptions } from '../services/notify/push.ts';
import { body } from './shared.ts';

const app = new Hono();

const KEY = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]+={0,2}$/, 'Keys are base64url'), v.maxLength(200));
app.get('/api/push', async (c) => c.json(await pushView()));
app.post('/api/push/devices', async (c) => {
	const input = await body(
		c,
		v.object({
			endpoint: v.pipe(v.string(), v.url(), v.startsWith('https://', 'Push endpoints use https'), v.maxLength(2000)),
			keys: v.object({ p256dh: KEY, auth: KEY }),
			name: v.optional(v.pipe(v.string(), v.maxLength(100)), ''),
			/** The endpoint a renewed subscription takes over from, keeping its name. */
			replaces: v.optional(v.pipe(v.string(), v.maxLength(2000))),
		}),
	);
	return c.json(await addDevice({ endpoint: input.endpoint, keys: input.keys }, input.name, input.replaces));
});
app.delete('/api/push/devices/:id', async (c) => c.json(await removeDevice(c.req.param('id'))));
app.post('/api/push/test', async (c) => c.json(await sendTest((await body(c, v.object({ device: v.optional(v.string()) }))).device)));
app.put('/api/push/options', async (c) => c.json(await setPushOptions(await body(c, v.object({ finished: v.boolean() })))));
app.get('/api/notifications', async (c) => c.json(await notificationsView()));
app.post('/api/notifications/read', async (c) => {
	const input = await body(
		c,
		v.object({
			ids: v.optional(v.pipe(v.array(v.pipe(v.string(), v.maxLength(100))), v.maxLength(500))),
			sessionId: v.optional(v.pipe(v.string(), v.maxLength(100))),
			all: v.optional(v.boolean()),
			read: v.optional(v.boolean(), true),
		}),
	);
	await markNotifications({ ids: input.ids, sessionId: input.sessionId, all: input.all }, input.read);
	return c.json(await notificationsView());
});
app.post('/api/push/presence', async (c) => {
	notePresence((await body(c, v.object({ present: v.boolean() }))).present);
	return c.json({ ok: true });
});

export const notifyRoutes = app;

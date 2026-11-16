import { Hono } from 'hono';
import * as v from 'valibot';
import { FREQUENCIES } from '../core/schedule.ts';
import { addAutomation, automations, editAutomation, removeAutomation, runAutomation, setAutomationEnabled, spaceAutomations } from '../services/automations/automations.ts';
import { REASONING, body } from './shared.ts';

/** Automations: routines on a repository or a project, run on a schedule or by new issues. */
const app = new Hono();

/** When a routine runs; fields left out take their defaults, and `scheduleProblem` checks the whole. */
const SCHEDULE = v.object({
	frequency: v.picklist(FREQUENCIES),
	time: v.optional(v.pipe(v.string(), v.regex(/^\d{2}:\d{2}$/))),
	everyHours: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(12))),
	days: v.optional(v.pipe(v.array(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(6))), v.maxLength(7))),
	dayOfMonth: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(28))),
	cron: v.optional(v.pipe(v.string(), v.maxLength(200))),
	timeZone: v.optional(v.pipe(v.string(), v.maxLength(64))),
});
app.get('/api/projects/:id/automations', async (c) => c.json({ automations: await automations(c.req.param('id')) }));
app.post('/api/projects/:id/automations', async (c) => {
	const input = await body(
		c,
		v.object({
			kind: v.picklist(['issues', 'schedule']),
			label: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(50)))),
			schedule: v.optional(v.nullable(SCHEDULE)),
			prompt: v.pipe(v.string(), v.maxLength(20_000)),
			model: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(200)))),
			reasoning: v.optional(v.nullable(REASONING)),
			planFirst: v.optional(v.boolean()),
			gate: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(200)))),
			spaceId: v.optional(v.nullable(v.string())),
		}),
	);
	return c.json(await addAutomation(c.req.param('id'), input));
});
app.patch('/api/automations/:id', async (c) => {
	const { enabled } = await body(c, v.object({ enabled: v.boolean() }));
	return c.json(await setAutomationEnabled(c.req.param('id'), enabled));
});
app.put('/api/automations/:id', async (c) => {
	const input = await body(
		c,
		v.object({
			projectId: v.optional(v.nullable(v.string())),
			kind: v.picklist(['issues', 'schedule']),
			label: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(50)))),
			schedule: v.optional(v.nullable(SCHEDULE)),
			prompt: v.pipe(v.string(), v.maxLength(20_000)),
			model: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(200)))),
			reasoning: v.optional(v.nullable(REASONING)),
			planFirst: v.optional(v.boolean()),
			gate: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(200)))),
		}),
	);
	return c.json(await editAutomation(c.req.param('id'), input));
});
app.post('/api/automations/:id/run', async (c) => c.json(await runAutomation(c.req.param('id'), { force: true })));
app.delete('/api/automations/:id', async (c) => {
	await removeAutomation(c.req.param('id'));
	return c.json({ ok: true });
});

app.get('/api/spaces/:id/automations', async (c) => c.json({ automations: await spaceAutomations(c.req.param('id')) }));
app.post('/api/spaces/:id/automations', async (c) => {
	const { projectId, ...input } = await body(
		c,
		v.object({
			projectId: v.nullable(v.string()),
			kind: v.picklist(['issues', 'schedule']),
			label: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(50)))),
			schedule: v.optional(v.nullable(SCHEDULE)),
			prompt: v.pipe(v.string(), v.maxLength(20_000)),
			model: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(200)))),
			reasoning: v.optional(v.nullable(REASONING)),
			planFirst: v.optional(v.boolean()),
			gate: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(200)))),
		}),
	);
	return c.json(await addAutomation(projectId || null, { ...input, spaceId: c.req.param('id') }));
});

export const automationRoutes = app;

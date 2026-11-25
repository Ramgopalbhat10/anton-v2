import { Hono } from 'hono';
import * as v from 'valibot';
import { config } from '../config.ts';
import { getProviders } from '../providers/index.ts';
import { deleteSealedSecret, saveSealedSecret, sealedSecretsView } from '../services/secrets/sealed-secrets.ts';
import { profileName } from '../services/settings/profile.ts';
import { REGIONS, sandboxSettings, setSandboxSettings } from '../services/sandbox/sandbox-settings.ts';
import { backgroundDefaults, COMPACT_AT, DEFAULT_CLAUDE_CODE_COMPACT_AT, DEFAULT_COMPACT_AT, type GeneralSettings, generalSettings, setGeneralSettings, VISUAL_REPLIES } from '../services/models/general.ts';
import { guardrails, secretsView, setGuardrails, setSharedEnv } from '../services/secrets/secrets.ts';
import { commands, setCommands } from '../services/settings/commands.ts';
import { usageView } from '../services/models/usage.ts';
import { budget, setLimits } from '../services/models/budget.ts';
import { cleanUpStorage, storageView } from '../services/settings/storage.ts';
import { setAcpIsolation } from '../services/settings/acp.ts';
import { computeView, stopAllSandboxes } from '../services/tasks/compute.ts';
import { connections } from '../services/settings/connections.ts';
import { clearSlot, saveSlot, setupView, testSlot } from '../services/settings/setup.ts';
import { REASONING, AGENT_MODEL, ENV, body } from './shared.ts';

const app = new Hono();

app.get('/api/budget', async (c) => c.json(await budget(c.req.query('session') || undefined)));
app.get('/api/usage', async (c) => c.json(await usageView()));
const cap = v.nullable(v.pipe(v.number(), v.minValue(0), v.maxValue(100_000)));
app.put('/api/settings/limits', async (c) => {
	const next = await body(c, v.object({ dailyUsd: cap, taskUsd: cap }));
	await setLimits(next);
	return c.json(await budget());
});
app.get('/api/settings/commands', async (c) => c.json({ commands: await commands() }));
app.put('/api/settings/commands', async (c) => {
	const input = await body(
		c,
		v.object({
			commands: v.pipe(
				v.array(v.object({ name: v.pipe(v.string(), v.maxLength(40)), prompt: v.pipe(v.string(), v.maxLength(20_000)) })),
				v.maxLength(100),
			),
		}),
	);
	return c.json({ commands: await setCommands(input.commands) });
});
const sandboxView = async () => ({ settings: await sandboxSettings(), defaultBaseImage: config.modal.baseImage, provider: getProviders().sandbox.name });
app.get('/api/settings/sandbox', async (c) => c.json(await sandboxView()));
app.put('/api/settings/sandbox', async (c) => {
	const domain = v.pipe(v.string(), v.trim(), v.toLowerCase(), v.regex(/^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$/, 'Allowed domains look like registry.npmjs.org or *.example.com'));
	const next = await body(
		c,
		v.object({
			cpu: v.pipe(v.number(), v.minValue(0.25), v.maxValue(64)),
			memoryMiB: v.pipe(v.number(), v.integer(), v.minValue(512), v.maxValue(262_144)),
			idleMinutes: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(24 * 60)),
			lifetimeHours: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(24)),
			region: v.nullable(v.picklist(REGIONS)),
			allowedDomains: v.pipe(v.array(domain), v.maxLength(100)),
			baseImage: v.nullable(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(300))),
			warmImageDays: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(90)),
		}),
	);
	await setSandboxSettings(next);
	return c.json(await sandboxView());
});
// ACP runtimes (Devin today): where the jailed agent container runs. Only runtimes that offer a choice answer.
const acpAgent = (id: string) => getProviders().runtimes?.find((runtime) => runtime.id === id && runtime.isolation);
app.get('/api/settings/acp/:agent', async (c) => {
	const runtime = acpAgent(c.req.param('agent'));
	if (!runtime?.isolation) return c.json({ error: 'Not found' }, 404);
	return c.json({ isolation: await runtime.isolation() });
});
app.put('/api/settings/acp/:agent', async (c) => {
	const runtime = acpAgent(c.req.param('agent'));
	if (!runtime?.isolation) return c.json({ error: 'Not found' }, 404);
	const next = await body(c, v.object({ isolation: v.picklist(['sidecar', 'sandbox']) }));
	await setAcpIsolation(runtime.id, next.isolation);
	return c.json({ isolation: next.isolation });
});
const generalView = async (settings: GeneralSettings) => ({ ...settings, titleModelDefault: config.titleModel });
app.get('/api/settings/general', async (c) => c.json(await generalView(await generalSettings())));
const BACKGROUND_MODEL = v.optional(v.nullable(v.pipe(v.string(), v.minLength(1))), null);
app.put('/api/settings/general', async (c) => {
	const next = await body(
		c,
		v.object({
			model: v.nullable(v.pipe(v.string(), v.minLength(1))),
			reasoning: v.nullable(REASONING),
			planMode: v.boolean(),
			reviewPullRequests: v.boolean(),
			fixLowFindings: v.optional(v.boolean(), false),
			codeMode: v.boolean(),
			visualReplies: v.optional(v.picklist(VISUAL_REPLIES), 'some'),
			pageNetwork: v.optional(v.boolean(), true),
			imageModel: v.optional(v.nullable(v.pipe(v.string(), v.minLength(1))), null),
			titleModel: v.optional(v.nullable(v.pipe(v.string(), v.minLength(1))), null),
			compactAt: v.optional(v.nullable(v.picklist(COMPACT_AT)), DEFAULT_COMPACT_AT),
			claudeCodeCompactAt: v.optional(v.nullable(v.picklist(COMPACT_AT)), DEFAULT_CLAUDE_CODE_COMPACT_AT),
			agentModels: v.object({ explorer: AGENT_MODEL, tester: AGENT_MODEL, browser: v.optional(AGENT_MODEL, null), computer: v.optional(AGENT_MODEL, null), reviewer: AGENT_MODEL }),
			backgroundModels: v.optional(
				v.object({ webDigest: BACKGROUND_MODEL, vision: BACKGROUND_MODEL, compaction: BACKGROUND_MODEL }),
				{ webDigest: null, vision: null, compaction: null },
			),
			backgroundReasoning: v.optional(
				v.object({ webDigest: v.optional(v.nullable(REASONING), null), vision: v.optional(v.nullable(REASONING), null), compaction: v.optional(v.nullable(REASONING), null) }),
				{ webDigest: null, vision: null, compaction: null },
			),
		}),
	);
	return c.json(await generalView(await setGeneralSettings(next)));
});
app.get('/api/settings/background-models', (c) => c.json({ defaults: backgroundDefaults() }));

app.get('/api/settings/guardrails', async (c) => c.json(await guardrails()));
app.put('/api/settings/guardrails', async (c) => c.json(await setGuardrails(await body(c, v.object({ hideSecrets: v.boolean() })))));

app.get('/api/secrets', async (c) => c.json(await secretsView()));
app.put('/api/secrets/shared', async (c) => {
	const { env } = await body(c, v.object({ env: ENV }));
	return c.json(await setSharedEnv(env));
});
// Sealed secrets: the agent can name them in http_request but never read them.
app.get('/api/secrets/sealed', async (c) => c.json({ secrets: await sealedSecretsView() }));
app.put('/api/secrets/sealed/:name', async (c) => {
	const input = await body(
		c,
		v.object({
			value: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(16_384)))),
			hosts: v.pipe(v.array(v.pipe(v.string(), v.maxLength(253))), v.maxLength(20)),
			proxy: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(2_000)))),
			readsDirect: v.optional(v.nullable(v.boolean())),
		}),
	);
	return c.json({ secrets: await saveSealedSecret({ name: c.req.param('name'), ...input }) });
});
app.delete('/api/secrets/sealed/:name', async (c) => c.json({ secrets: await deleteSealedSecret(c.req.param('name')) }));

app.get('/api/connections', async (c) => c.json({ connections: await connections() }));
// Secrets come back as their last four characters only.
const setupInput = v.object({
	provider: v.pipe(v.string(), v.minLength(1), v.maxLength(40)),
	values: v.optional(v.record(v.pipe(v.string(), v.regex(/^[A-Z][A-Z0-9_]{1,63}$/)), v.pipe(v.string(), v.maxLength(4000))), {}),
});
app.get('/api/setup', async (c) => c.json(await setupView()));
app.post('/api/setup/:slot/test', async (c) => {
	const { provider, values } = await body(c, setupInput);
	return c.json(await testSlot(c.req.param('slot'), provider, values));
});
app.put('/api/setup/:slot', async (c) => {
	const { provider, values } = await body(c, setupInput);
	return c.json(await saveSlot(c.req.param('slot'), provider, values));
});
app.delete('/api/setup/:slot', async (c) => {
	await clearSlot(c.req.param('slot'), c.req.query('provider') ?? '');
	return c.json({ ok: true });
});
app.get('/api/compute', async (c) => c.json(await computeView()));
app.post('/api/compute/stop-all', async (c) => c.json(await stopAllSandboxes()));

app.get('/api/storage', async (c) => c.json(await storageView()));
app.post('/api/storage/cleanup', async (c) => c.json(await cleanUpStorage()));

app.get('/api/profile', async (c) => c.json({ name: await profileName() }));

export const settingsRoutes = app;

// This process runs on Anton's server, never in a task's sandbox. The key arrives
// through private stdin, not argv, an environment variable, or a temporary file.
import { streamDevin } from '@oh-my-pi/pi-ai/providers/devin';
import { fetchDevinModels } from '@oh-my-pi/pi-catalog/discovery/devin';
import { buildModel } from '@oh-my-pi/pi-catalog/build';

const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
let key = '';
const safe = (error) => String(error instanceof Error ? error.message : error)
	.replaceAll(key || '\0', '[redacted]')
	.replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[redacted token]');

try {
	const request = JSON.parse(await Bun.stdin.text());
	key = request.key;
	if (typeof key !== 'string' || !key) throw new Error('Devin needs a personal access token.');
	if (request.action === 'models') {
		const models = await fetchDevinModels({ apiKey: key, timeoutMs: 30_000 });
		if (!models) throw new Error('Devin could not authenticate or list models. Check your PAT and try again.');
		// Keep this prototype deliberately small, rather than offering hundreds of
		// untested Fusion combinations. Preserve preference even if discovery is unordered.
		send({ type: 'models', models: ['swe-2-flash', 'swe-2'].flatMap((id) => models.filter((model) => model.id === id)) });
	} else if (request.action === 'stream') {
		if (!['swe-2-flash', 'swe-2'].includes(request.model.id)) throw new Error('This prototype supports SWE-2 Flash and SWE-2 only.');
		const model = buildModel({ ...request.model, api: 'devin-agent', provider: 'devin', compat: { supportsParallelToolCalls: true } });
		const context = {
			...request.context,
			systemPrompt: request.context.systemPrompt ? [request.context.systemPrompt] : [],
			messages: request.context.messages.map((message) => message.role === 'assistant' && message.provider === 'devin'
				? { ...message, api: 'devin-agent' } : message),
		};
		const stream = streamDevin(model, context, { ...request.options, apiKey: key });
		for await (const event of stream) send({ type: 'event', event });
	} else throw new Error('Unknown Devin worker request.');
	send({ type: 'complete' });
} catch (error) {
	send({ type: 'failure', message: safe(error) });
	process.exitCode = 1;
}

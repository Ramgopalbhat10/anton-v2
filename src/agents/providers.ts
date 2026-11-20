import { setProvider } from '@flue/runtime';
import { claudeCodeProvider, cursorProvider, runtimeProvider } from '../flue/claude-code-models.ts';
import { liveOpenRouterProvider, liveVercelProvider } from '../flue/live-models.ts';
import { openCodeGoProvider } from '../flue/opencode-go-models.ts';
import { withPruning } from '../flue/pruned-models.ts';
import { chatGptPlanProvider } from '../flue/subscription-models.ts';
import { loadedModels } from '../services/models/models.ts';
import { routedModels } from '../services/tasks/sessions.ts';
import { gatewayKey, gatewayKeyOf, gatewayToken, planKey, planRuntime, runtimeFor, runtimeHooks } from '../services/models/subscriptions.ts';

// Registered once at load; each agent imports this file for its side effect. No `'use agent'`: it defines no agent.

// Any model in OpenRouter's live list resolves, not only those pi knew when it was published.
setProvider(withPruning(liveOpenRouterProvider(loadedModels, gatewayKey, routedModels)));
setProvider(withPruning(liveVercelProvider(loadedModels, () => gatewayKeyOf('vercel'), routedModels)));
setProvider(withPruning(chatGptPlanProvider(loadedModels, () => gatewayToken('openai'))));
setProvider(claudeCodeProvider(loadedModels, () => runtimeFor('claude-code'), runtimeHooks('claude-code')));
setProvider(withPruning(openCodeGoProvider(loadedModels, () => planKey('opencode-go'))));
setProvider(cursorProvider(loadedModels, () => planRuntime('cursor'), runtimeHooks('cursor')));
setProvider(
	runtimeProvider(
		{ gateway: 'devin', name: 'Devin (Devin CLI)', program: 'Devin CLI', plan: 'Devin', turnUsage: true },
		loadedModels,
		() => planRuntime('devin'),
		runtimeHooks('devin'),
	),
);
setProvider(
	runtimeProvider(
		{ gateway: 'antigravity', name: 'Antigravity (Antigravity CLI)', program: 'Antigravity CLI', plan: 'Google Antigravity', turnUsage: true },
		loadedModels,
		() => planRuntime('antigravity'),
		runtimeHooks('antigravity'),
	),
);

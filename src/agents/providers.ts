import { setProvider } from '@flue/runtime';
import { claudeCodeProvider, cursorProvider } from '../flue/claude-code-models.ts';
import { liveOpenRouterProvider, liveVercelProvider } from '../flue/live-models.ts';
import { openCodeGoProvider } from '../flue/opencode-go-models.ts';
import { withPruning } from '../flue/pruned-models.ts';
import { chatGptPlanProvider } from '../flue/subscription-models.ts';
import { loadedModels } from '../services/models/models.ts';
import { routedModels } from '../services/tasks/sessions.ts';
import { gatewayKey, gatewayKeyOf, gatewayToken, planKey, planRuntime, runtimeFor, runtimeHooks } from '../services/models/subscriptions.ts';

/**
 * The model providers every agent resolves through, registered once at module
 * load. Each agent imports this file for its side effect (`import './providers.ts'`),
 * so the registrations run before any agent calls a model. No `'use agent'` here:
 * this module defines no agent.
 */

// Any model in OpenRouter's live list resolves, not only those pi knew when it was published.
// Calls through the gateways and ChatGPT and OpenCode plans send old tool results cleared once a conversation grows (withPruning).
// A task's route (one provider first, or a sort) is part of the specifier its agent resolves; see src/core/model-route.ts.
setProvider(withPruning(liveOpenRouterProvider(loadedModels, gatewayKey, routedModels)));
// Every model in Vercel AI Gateway's live list, with the key pasted in Settings › Subscriptions.
setProvider(withPruning(liveVercelProvider(loadedModels, () => gatewayKeyOf('vercel'), routedModels)));
// Models on a signed-in ChatGPT plan, each call with a fresh token from Settings › Subscriptions.
setProvider(withPruning(chatGptPlanProvider(loadedModels, () => gatewayToken('openai'))));
// Models on a Claude plan, run by Claude Code on this server with Anton's tools; see docs/claude-code-subscription.md.
setProvider(claudeCodeProvider(loadedModels, () => runtimeFor('claude-code'), runtimeHooks('claude-code')));
// Models on an OpenCode Go plan and on a Cursor plan, with the key pasted in Settings › Subscriptions.
setProvider(withPruning(openCodeGoProvider(loadedModels, () => planKey('opencode-go'))));
setProvider(cursorProvider(loadedModels, () => planRuntime('cursor'), runtimeHooks('cursor')));

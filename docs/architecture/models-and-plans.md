# Models and plans

Linked from [AGENTS.md](../../AGENTS.md).

- `src/services/subscriptions.ts` — plans signed in from Settings › Subscriptions: keeps and renews each sign-in, adds the plan's models, counts use (`planUsage`).
- Claude plans run Claude Code on the server, signed in through its own `auth login` (`docs/claude-code-subscription.md`). Anton never holds that token and never passes Claude Code an API key or `CLAUDE_CODE_OAUTH_TOKEN`. Key plans keep their key in settings, never in a machine.
- Gateways: OpenRouter (pasted key, else `OPENROUTER_API_KEY`) and Vercel AI Gateway (`gateways` in `src/providers/index.ts`). A task's route (`src/core/model-route.ts`) is `<model>#via=<slug>` or `#sort=<sort>`; usage counts it under the plain model.
- Variants: `<model>[1m]`, `<model>[fast]` and both are models of their own (`src/core/model-variants.ts`); fast on ChatGPT sends `service_tier: "priority"`.
- A reply failing on a non-default model offers Retry on the default (`isPlanRefusal`, `switchToFallbackModel`). Nothing switches by itself, since another model may bill another account.
- Background models (`backgroundModels` in `src/services/general.ts`): web digests, screen reading, compaction summaries; digests and screen reading must be OpenRouter models. Each keeps the effort picked with it (`backgroundReasoning`), sent as OpenRouter's `reasoning.effort` for digests and screen reading and as the compaction summary's reasoning (a Flue patch in `scripts/patch-flue.ts`).
- `src/services/decisions.ts` — the decision model (yes/no and choices with probabilities, a fraction of a cent). Everything that uses it must behave as before without it.

import path from 'node:path';

const read = (name: string, fallback = ''): string => process.env[name]?.trim() || fallback;
/** Anton's own files: both databases, local machines and disk storage. */
const dataDir = path.resolve(read('ANTON_DATA_DIR', 'data'));

/** Every setting Anton reads from the environment, in one place. */
export const config = {
	/** Model for new tasks, as `<gateway>/<model id>`. */
	model: read('ANTON_MODEL', 'openrouter/~deepseek/deepseek-flash-latest'),
	dataDir,
	databaseUrl: read('TURSO_DATABASE_URL', `file:${path.join(dataDir, 'anton.db')}`),
	databaseToken: read('TURSO_AUTH_TOKEN'),
	/** Which provider backs each port; see src/providers/index.ts. */
	sandbox: read('ANTON_SANDBOX', process.env.MODAL_TOKEN_ID ? 'modal' : 'local'),
	store: read('ANTON_STORE', process.env.TIGRIS_SECRET_ACCESS_KEY ? 's3' : 'disk'),
	modal: {
		app: read('ANTON_MODAL_APP', 'anton'),
		baseImage: read('ANTON_BASE_IMAGE', 'node:22-bookworm'),
	},
	/** Defaults for Settings › Sandboxes until it is saved. */
	sandboxDefaults: {
		idleMinutes: Number(read('ANTON_IDLE_MINUTES', '5')),
		cpu: Number(read('ANTON_SANDBOX_CPU', '1')),
		memoryMiB: Number(read('ANTON_SANDBOX_MEMORY_MIB', '2048')),
	},
	s3: {
		endpoint: read('TIGRIS_ENDPOINT', 'https://t3.storage.dev'),
		bucket: read('TIGRIS_BUCKET'),
		accessKeyId: read('TIGRIS_ACCESS_KEY_ID'),
		secretAccessKey: read('TIGRIS_SECRET_ACCESS_KEY'),
		region: read('TIGRIS_REGION', 'auto'),
	},
	github: {
		token: read('ANTON_GITHUB_TOKEN'),
		apiUrl: read('ANTON_GITHUB_API_URL', 'https://api.github.com'),
	},
	openrouter: {
		apiUrl: read('ANTON_OPENROUTER_API_URL', 'https://openrouter.ai/api/v1'),
		/** Used while no key is pasted in Settings › Subscriptions; see providers/openrouter/key.ts. */
		apiKey: read('OPENROUTER_API_KEY'),
		/** How long the model list is cached before it is fetched again. */
		ttlMs: 60 * 60_000,
	},
	/** Vercel AI Gateway, a second gateway billed per token; off until a key is pasted in Settings › Subscriptions or set here. */
	vercel: {
		apiUrl: read('ANTON_VERCEL_API_URL', 'https://ai-gateway.vercel.sh'),
		apiKey: read('AI_GATEWAY_API_KEY'),
		ttlMs: 60 * 60_000,
	},
	/**
	 * The System One decision model (TypeSafe's Jev) that decides which pull request
	 * comments and pushes need an agent, and that run_script programs can ask. `off` turns it off.
	 */
	decisionModel: read('ANTON_DECISION_MODEL', '~typesafe/jev-latest'),
	/** Parallel's search MCP server gives every task web_search and web_fetch; free without a key. `off` turns it off. */
	web: {
		mcpUrl: read('ANTON_WEB_MCP_URL', 'https://search.parallel.ai/mcp'),
		/** Optional, for higher rate limits. */
		apiKey: read('PARALLEL_API_KEY'),
	},
	/** Your own Google OAuth client, for Gmail in Settings › Connectors; the client pasted there is used instead when there is one. */
	google: {
		clientId: read('GOOGLE_CLIENT_ID'),
		clientSecret: read('GOOGLE_CLIENT_SECRET'),
	},
	/** Kernel's hosted browsers, for the Browser panel; without a key the panel says how to set one. */
	kernel: {
		apiUrl: read('ANTON_KERNEL_API_URL', 'https://api.onkernel.com'),
		apiKey: read('KERNEL_API_KEY'),
	},
	/**
	 * Claude Code, which runs tasks on a Claude plan (Settings › Subscriptions). Its sign-in lives in its own
	 * config directory under the data directory; `path` runs your own `claude` instead of the one the SDK bundles.
	 */
	claudeCode: {
		configDir: path.join(dataDir, 'claude-code'),
		path: read('ANTON_CLAUDE_CODE_PATH'),
		/** At most this many Claude Code conversations stay open; the longest idle closes first. */
		maxOpen: Number(read('ANTON_CLAUDE_CODE_MAX_OPEN', '3')),
	},
	defaultRepo: read('ANTON_DEFAULT_REPO'),
	/** Who push services can reach about Anton's notifications (the VAPID subject): a `mailto:` or `https:` address. */
	pushContact: read('ANTON_PUSH_CONTACT', 'mailto:anton@example.com'),
	/**
	 * The OpenRouter model the computer tool sees the screen with when neither the computer subagent's own model
	 * (Settings › General) nor the task's is an OpenRouter model that reads images: it finds what to click and
	 * says what the screen shows.
	 */
	visionModel: read('ANTON_VISION_MODEL', 'openrouter/anthropic/claude-haiku-5.5'),
	/** The fast OpenRouter model that names tasks: a few words from the first message, in place of the message itself. */
	titleModel: read('ANTON_TITLE_MODEL', 'openrouter/anthropic/claude-haiku-5.5'),
	/**
	 * The OpenRouter image model generate_image draws with when Settings › General names none and the task's own
	 * model is not one: GPT Image 2.5's speed tier, which edits images and leaves backgrounds transparent.
	 */
	imageModel: read('ANTON_IMAGE_MODEL', 'openrouter/openai/gpt-image-2.5-flare'),
	/** The browser the agent's screenshot tool drives, installed in sandboxes on first use. */
	browserPackage: 'playwright@1.56.1',
	/** Default for Settings › Images: prepared repo images older than this are rebuilt on the next task. */
	warmImageDays: Number(read('ANTON_WARM_IMAGE_DAYS', '7')),
};

import path from 'node:path';
import { asToolProfileSetting } from './core/tool-profile.ts';
import { loadSavedEnv } from './saved-env.ts';

const read = (name: string, fallback = ''): string => process.env[name]?.trim() || fallback;
const dataDir = path.resolve(read('ANTON_DATA_DIR', 'data'));
// Values saved in Settings › Connections (data/anton.env) go over the environment before any setting is read.
loadSavedEnv(dataDir);

export const config = {
	/** Model for new tasks, as `<gateway>/<model id>`. */
	model: read('ANTON_MODEL', 'openrouter/~deepseek/deepseek-flash-latest'),
	dataDir,
	databaseUrl: read('TURSO_DATABASE_URL', `file:${path.join(dataDir, 'anton.db')}`),
	databaseToken: read('TURSO_AUTH_TOKEN'),
	sandbox: read('ANTON_SANDBOX', process.env.MODAL_TOKEN_ID ? 'modal' : 'local'),
	/** `1` reads and writes whole files in a Modal sandbox through Modal's file API instead of a login shell. Untried on a real sandbox. */
	sandboxFileApi: read('ANTON_SANDBOX_FILE_API') === '1',
	dockerNetwork: read('ANTON_DOCKER_NETWORK') || undefined,
	store: read('ANTON_STORE', process.env.TIGRIS_SECRET_ACCESS_KEY ? 's3' : 'disk'),
	modal: {
		app: read('ANTON_MODAL_APP', 'anton'),
		baseImage: read('ANTON_BASE_IMAGE', 'node:22-bookworm'),
	},
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
	/** Read as it is used, so a token saved in Settings › Connections applies without a restart. */
	github: {
		get token() {
			return read('ANTON_GITHUB_TOKEN');
		},
		get apiUrl() {
			return read('ANTON_GITHUB_API_URL', 'https://api.github.com');
		},
		/** The secret of a GitHub webhook pointed at `/api/github/webhook`; without it the route is off and Anton polls. */
		webhookSecret: read('ANTON_GITHUB_WEBHOOK_SECRET'),
	},
	openrouter: {
		apiUrl: read('ANTON_OPENROUTER_API_URL', 'https://openrouter.ai/api/v1'),
		/** Used while no key is pasted in Settings › Subscriptions. */
		apiKey: read('OPENROUTER_API_KEY'),
		ttlMs: 60 * 60_000,
	},
	vercel: {
		apiUrl: read('ANTON_VERCEL_API_URL', 'https://ai-gateway.vercel.sh'),
		apiKey: read('AI_GATEWAY_API_KEY'),
		ttlMs: 60 * 60_000,
	},
	/** The decision model for pull request comments and pushes, and for run_script programs; `off` turns it off. */
	get decisionModel() {
		return read('ANTON_DECISION_MODEL', '~typesafe/jev-latest');
	},
	/** Parallel's search MCP server (web_search, web_fetch); free without a key. `off` turns it off. */
	web: {
		get mcpUrl() {
			return read('ANTON_WEB_MCP_URL', 'https://search.parallel.ai/mcp');
		},
		get apiKey() {
			return read('PARALLEL_API_KEY');
		},
	},
	google: {
		clientId: read('GOOGLE_CLIENT_ID'),
		clientSecret: read('GOOGLE_CLIENT_SECRET'),
	},
	composio: {
		apiUrl: read('ANTON_COMPOSIO_API_URL', 'https://backend.composio.dev/api/v3.1'),
		apiKey: read('COMPOSIO_API_KEY'),
	},
	kernel: {
		apiUrl: read('ANTON_KERNEL_API_URL', 'https://api.onkernel.com'),
		apiKey: read('KERNEL_API_KEY'),
	},
	/** Claude Code's sign-in lives in its own config directory under the data directory; `path` runs your own `claude`. */
	claudeCode: {
		configDir: path.join(dataDir, 'claude-code'),
		path: read('ANTON_CLAUDE_CODE_PATH'),
		maxOpen: Number(read('ANTON_CLAUDE_CODE_MAX_OPEN', '3')),
	},
	/** ACP agent runtimes (Devin, Antigravity) run jailed in Modal containers of this app. */
	acp: {
		app: read('ANTON_ACP_APP', 'anton-acp'),
	},
	defaultRepo: read('ANTON_DEFAULT_REPO'),
	/** The VAPID subject: a `mailto:` or `https:` address. */
	pushContact: read('ANTON_PUSH_CONTACT', 'mailto:anton@example.com'),
	/** What the computer tool sees the screen with when neither the computer subagent's model nor the task's reads images. */
	visionModel: read('ANTON_VISION_MODEL', 'openrouter/anthropic/claude-haiku-5.5'),
	titleModel: read('ANTON_TITLE_MODEL', 'openrouter/anthropic/claude-haiku-5.5'),
	/** Reads long web results for the agent; `off` cuts them instead. Gemini Flash Lite answers in 2-3 s; Haiku took 5-7 s and at times answered nothing. */
	webDigestModel: read('ANTON_WEB_DIGEST_MODEL', 'openrouter/google/gemini-3.1-flash-lite'),
	/** Checks a change against its request at a reply's end when Anton cannot call the task's own model (a plan, an ACP agent); `off` sends the agent back to check itself. */
	replyCheckModel: read('ANTON_REPLY_CHECK_MODEL', 'openrouter/anthropic/claude-haiku-5.5'),
	/** generate_image's model when Settings › General names none and the task's model cannot draw. */
	imageModel: read('ANTON_IMAGE_MODEL', 'openrouter/openai/gpt-image-2.5-flare'),
	/** Flue's default of 1 hour cuts off long features mid-work. */
	replyTimeoutMs: Math.max(1, Number(read('ANTON_REPLY_TIMEOUT_HOURS', '4')) || 4) * 3_600_000,
	/** `auto` gives OpenAI's models `apply_patch` and the rest `edit` and `write`; `patch` or `edit` gives every model that one. */
	toolProfile: asToolProfileSetting(read('ANTON_TOOL_PROFILE', 'auto')),
	browserPackage: 'playwright@1.63.0',
	warmImageDays: Number(read('ANTON_WARM_IMAGE_DAYS', '7')),
	/** A repository task's sandbox starts as its agent starts a reply, not when the agent asks for it. `0` turns it off. */
	prewarmSandbox: read('ANTON_PREWARM_SANDBOX', '1') !== '0',
	/** The decision model first tells a question from work, and a question starts no sandbox. `always` prewarms every repository task. */
	prewarmByIntent: read('ANTON_PREWARM_SANDBOX', '1') !== 'always',
	/** Build a repo's prepared image in the background. `0` leaves repos to start without one until asked. */
	prepareImages: read('ANTON_PREPARE_IMAGES', '1') !== '0',
	/** Start a sandbox while a task is typed and a minute before a routine runs. `0` leaves the start to `prewarmSandbox`. */
	wakeSandbox: read('ANTON_WAKE_SANDBOX', '1') !== '0',
	/** How long a sandbox woken for a draft waits for its task after the composer last asked, before it is stopped. */
	spareWaitMs: Number(read('ANTON_SPARE_WAIT_SECONDS', '120')) * 1000,
};

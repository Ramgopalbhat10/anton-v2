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
		idleMinutes: Number(read('ANTON_IDLE_MINUTES', '15')),
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
		apiKey: read('OPENROUTER_API_KEY'),
		/** How long the model list is cached before it is fetched again. */
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
	defaultRepo: read('ANTON_DEFAULT_REPO'),
	/** The browser the agent's screenshot tool drives, installed in sandboxes on first use. */
	browserPackage: 'playwright@1.56.1',
	/** Default for Settings › Images: prepared repo images older than this are rebuilt on the next task. */
	warmImageDays: Number(read('ANTON_WARM_IMAGE_DAYS', '7')),
	hasOpenRouter: () => Boolean(process.env.OPENROUTER_API_KEY),
};

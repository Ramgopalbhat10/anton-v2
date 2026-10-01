import path from 'node:path';
import { DEFAULT_MODEL } from './lib/models.ts';

const read = (name: string, fallback = ''): string => process.env[name]?.trim() || fallback;

/** Every setting Anton reads from the environment, in one place. */
export const config = {
	model: read('ANTON_MODEL', DEFAULT_MODEL),
	dataDir: path.resolve(read('ANTON_DATA_DIR', 'data')),
	databaseUrl: read('TURSO_DATABASE_URL', 'file:./data/anton.db'),
	databaseToken: read('TURSO_AUTH_TOKEN'),
	/** Which provider backs each port; see src/providers/index.ts. */
	sandbox: read('ANTON_SANDBOX', process.env.MODAL_TOKEN_ID ? 'modal' : 'local'),
	store: read('ANTON_STORE', process.env.TIGRIS_SECRET_ACCESS_KEY ? 's3' : 'disk'),
	modal: {
		app: read('ANTON_MODAL_APP', 'anton'),
		baseImage: read('ANTON_BASE_IMAGE', 'node:22-bookworm'),
		idleTimeoutMs: Number(read('ANTON_IDLE_MINUTES', '15')) * 60_000,
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
	defaultRepo: read('ANTON_DEFAULT_REPO'),
	/** Warm repo images older than this are rebuilt on the next task. */
	warmImageMaxAgeMs: Number(read('ANTON_WARM_IMAGE_DAYS', '7')) * 86_400_000,
	hasOpenRouter: () => Boolean(process.env.OPENROUTER_API_KEY),
};

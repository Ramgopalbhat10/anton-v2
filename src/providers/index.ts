import path from 'node:path';
import { config } from '../config.ts';
import type {
	AccountSignIn,
	AgentRuntime,
	AppsConnector,
	BrowserHost,
	DecisionModel,
	GatewayAccount,
	GitHost,
	ImageModel,
	KeyPlan,
	Mailbox,
	ModelCatalog,
	ObjectStore,
	PushSender,
	SandboxProvider,
	SubscriptionProvider,
	TextModel,
	VisionModel,
} from '../core/ports.ts';
import { getSetting } from '../db/settings.ts';
import { acpIsolationKey, acpRuntime, type AcpIsolation } from './acp/runtime.ts';
import { devinAgent } from './acp/devin.ts';
import { modalAcpHost } from './acp/modal.ts';
import { chatGptSubscription } from './chatgpt/subscription.ts';
import { claudeCodeRuntime } from './claude-code/runtime.ts';
import { composioApps } from './composio/index.ts';
import { composioKeySlot } from './composio/key.ts';
import { cursorPlan } from './cursor/plan.ts';
import { diskStore } from './disk/store.ts';
import { githubHost } from './github/host.ts';
import { gmailMailbox } from './google/gmail.ts';
import { googleSignIn } from './google/sign-in.ts';
import { kernelBrowsers } from './kernel/browsers.ts';
import { dockerSandboxProvider } from './docker/sandbox.ts';
import { localSandboxProvider } from './local/sandbox.ts';
import { modalSandboxProvider } from './modal/sandbox.ts';
import { openRouterAccount } from './openrouter/account.ts';
import { openRouterCatalog } from './openrouter/catalog.ts';
import { openRouterDecisions } from './openrouter/decisions.ts';
import { openRouterImages } from './openrouter/images.ts';
import { openRouterKey } from './openrouter/key.ts';
import { openRouterText } from './openrouter/text.ts';
import { openRouterVision } from './openrouter/vision.ts';
import { openCodeGoPlan } from './opencode-go/plan.ts';
import type { KeySlot } from './key-slot.ts';
import { vercelAccount } from './vercel/account.ts';
import { vercelCatalog } from './vercel/catalog.ts';
import { vercelKeySlot } from './vercel/key.ts';
import { s3Store } from './s3/store.ts';
import { webPushSender } from './webpush/sender.ts';

/** Add a provider by adding one entry; choose it with ANTON_SANDBOX / ANTON_STORE. */
const sandboxes: Record<string, () => SandboxProvider> = {
	modal: () => modalSandboxProvider({ ...config.modal, browserPackage: config.browserPackage, fileApi: config.sandboxFileApi }),
	local: () => localSandboxProvider(config.dataDir),
	docker: () => dockerSandboxProvider({ baseImage: config.modal.baseImage, network: config.dockerNetwork }),
};

const stores: Record<string, () => ObjectStore> = {
	s3: () => s3Store(config.s3),
	disk: () => diskStore(path.join(config.dataDir, 'objects')),
};

function pick<T>(kind: string, table: Record<string, () => T>, name: string): T {
	const make = table[name];
	if (!make) throw new Error(`Unknown ${kind} provider "${name}". Options: ${Object.keys(table).join(', ')}`);
	return make();
}

export type Gateway = { account: GatewayAccount; models: ModelCatalog; key: KeySlot };

/**
 * Null ports degrade rather than fail: `decisions` without an OpenRouter key or with ANTON_DECISION_MODEL=off; `browsers`
 * without KERNEL_API_KEY; `vision`, `images` and `text` without an OpenRouter key. `push` and `apps` are absent in tests.
 */
export type Providers = {
	sandbox: SandboxProvider;
	/** Null when `sandbox` already runs on this server. */
	host?: SandboxProvider | null;
	store: ObjectStore;
	git: GitHost;
	models: ModelCatalog;
	gatewayAccount?: GatewayAccount | null;
	gateways?: Gateway[];
	decisions?: DecisionModel | null;
	subscriptions?: SubscriptionProvider[];
	runtimes?: AgentRuntime[];
	keyPlans?: KeyPlan[];
	browsers?: BrowserHost | null;
	vision?: VisionModel | null;
	images?: ImageModel | null;
	text?: TextModel | null;
	push?: PushSender | null;
	accounts?: AccountSignIn[];
	mailboxes?: Mailbox[];
	apps?: AppsConnector | null;
};

let providers: Providers | undefined;
/** Whether `providers` is the real set, which a setting saved in Settings › Connections may rebuild; tests' fakes are left alone. */
let real = false;
let decisionModel: DecisionModel | null = null;

const makeDecisions = (): DecisionModel | null =>
	config.decisionModel !== 'off' ? openRouterDecisions({ apiUrl: config.openrouter.apiUrl, apiKey: openRouterKey, model: config.decisionModel }) : null;

/** The decision, vision, image and text models call OpenRouter with the key in use at the time, so they exist only while there is one. */
function production(): Providers {
	const { apiUrl, ttlMs } = config.openrouter;
	decisionModel = makeDecisions();
	const vision = openRouterVision({ apiUrl, apiKey: openRouterKey });
	const images = openRouterImages({ apiUrl, apiKey: openRouterKey, ttlMs });
	const text = openRouterText({ apiUrl, apiKey: openRouterKey });
	return {
		sandbox: pick('sandbox', sandboxes, config.sandbox),
		host: config.sandbox === 'local' ? null : localSandboxProvider(config.dataDir),
		store: pick('store', stores, config.store),
		git: githubHost(config.github),
		models: openRouterCatalog({ apiUrl, ttlMs, apiKey: openRouterKey }),
		gatewayAccount: openRouterAccount({ apiUrl }),
		gateways: [
			{
				account: vercelAccount({ apiUrl: config.vercel.apiUrl }),
				models: vercelCatalog({ apiUrl: config.vercel.apiUrl, ttlMs: config.vercel.ttlMs, apiKey: vercelKeySlot.get }),
				key: vercelKeySlot,
			},
		],
		get decisions() {
			return openRouterKey() ? decisionModel : null;
		},
		subscriptions: [chatGptSubscription()],
		runtimes: [
			claudeCodeRuntime({ configDir: config.claudeCode.configDir, executable: config.claudeCode.path || undefined }),
			// ACP agents need Modal for their jailed containers; without its token there is nowhere to run them.
			...(process.env.MODAL_TOKEN_ID
				? [
						acpRuntime(devinAgent, modalAcpHost(devinAgent, config.acp.app, { isolation: () => getSetting<AcpIsolation>(acpIsolationKey(devinAgent.id), 'sidecar') })),
					]
				: []),
		],
		keyPlans: [openCodeGoPlan(), cursorPlan({ dir: path.join(config.dataDir, 'cursor') })],
		browsers: config.kernel.apiKey ? kernelBrowsers(config.kernel) : null,
		get vision() {
			return openRouterKey() ? vision : null;
		},
		get images() {
			return openRouterKey() ? images : null;
		},
		get text() {
			return openRouterKey() ? text : null;
		},
		push: webPushSender(),
		accounts: [googleSignIn()],
		mailboxes: [gmailMailbox()],
		apps: composioApps({ key: composioKeySlot }),
	};
}

export function getProviders(): Providers {
	if (!providers) {
		providers = production();
		real = true;
	}
	return providers;
}

/** Only the code host (its token) and the decision model are rebuilt when saved; the rest wait for a restart. */
export function refreshLiveProviders(): void {
	if (!providers || !real) return;
	providers.git = githubHost(config.github);
	decisionModel = makeDecisions();
}

export function setProviders(next: Providers): void {
	providers = next;
	real = false;
}

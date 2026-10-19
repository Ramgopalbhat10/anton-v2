import path from 'node:path';
import { config } from '../config.ts';
import type {
	AccountSignIn,
	AgentRuntime,
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
import { chatGptSubscription } from './chatgpt/subscription.ts';
import { claudeCodeRuntime } from './claude-code/runtime.ts';
import { cursorPlan } from './cursor/plan.ts';
import { diskStore } from './disk/store.ts';
import { githubHost } from './github/host.ts';
import { gmailMailbox } from './google/gmail.ts';
import { googleSignIn } from './google/sign-in.ts';
import { kernelBrowsers } from './kernel/browsers.ts';
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
import { s3Store } from './s3/store.ts';
import { webPushSender } from './webpush/sender.ts';

/** Add a provider by adding one entry; choose it with ANTON_SANDBOX / ANTON_STORE. */
const sandboxes: Record<string, () => SandboxProvider> = {
	modal: () => modalSandboxProvider({ ...config.modal, browserPackage: config.browserPackage }),
	local: () => localSandboxProvider(config.dataDir),
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

/**
 * `gatewayAccount` is OpenRouter's, whose key is pasted in Settings › Subscriptions (else OPENROUTER_API_KEY); without the port the catalog is offered as it is.
 * `decisions` is null without an OpenRouter key or with ANTON_DECISION_MODEL=off; everything works without it, as it did before.
 * `subscriptions` are the plans you can sign in to in Settings › Subscriptions; add one by adding an entry.
 * `runtimes` are plans run by the vendor's own agent program (Claude Code), signed in to through that program.
 * `keyPlans` are plans used with a key from the vendor's dashboard (OpenCode Go, Cursor), pasted in Settings › Subscriptions.
 * `browsers` is null without a KERNEL_API_KEY; the Browser panel then says how to set one.
 * `vision` is null without an OpenRouter key; the computer tool then says it cannot see the screen.
 * `images` is null without an OpenRouter key; the agent then has no generate_image tool.
 * `text` is null without an OpenRouter key; tasks are then named by the start of their first message.
 * `push` sends notifications to phones and closed browsers; without it (tests) nothing is sent.
 * `accounts` are accounts the agent's tools reach (Google), connected in Settings › Connectors on your own OAuth client; `mailboxes` (Gmail) use them.
 */
export type Providers = {
	sandbox: SandboxProvider;
	store: ObjectStore;
	git: GitHost;
	models: ModelCatalog;
	gatewayAccount?: GatewayAccount | null;
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
};

let providers: Providers | undefined;

/** The decision, vision, image and text models call OpenRouter with the key in use at the time, so they exist only while there is one. */
function production(): Providers {
	const { apiUrl, ttlMs } = config.openrouter;
	const decisions = config.decisionModel !== 'off' ? openRouterDecisions({ apiUrl, apiKey: openRouterKey, model: config.decisionModel }) : null;
	const vision = openRouterVision({ apiUrl, apiKey: openRouterKey });
	const images = openRouterImages({ apiUrl, apiKey: openRouterKey, ttlMs });
	const text = openRouterText({ apiUrl, apiKey: openRouterKey });
	return {
		sandbox: pick('sandbox', sandboxes, config.sandbox),
		store: pick('store', stores, config.store),
		git: githubHost(config.github),
		models: openRouterCatalog({ apiUrl, ttlMs, apiKey: openRouterKey }),
		gatewayAccount: openRouterAccount({ apiUrl }),
		get decisions() {
			return openRouterKey() ? decisions : null;
		},
		subscriptions: [chatGptSubscription()],
		runtimes: [claudeCodeRuntime({ configDir: config.claudeCode.configDir, executable: config.claudeCode.path || undefined })],
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
	};
}

export function getProviders(): Providers {
	providers ??= production();
	return providers;
}

/** Tests swap in fakes here. */
export function setProviders(next: Providers): void {
	providers = next;
}

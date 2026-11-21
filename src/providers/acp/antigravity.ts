// Google Antigravity's ACP agent (`agy acp`) as an AcpAgent descriptor — the
// route T3 Code takes. agy keeps its own tools inside the jailed container and
// authenticates itself from a token file Anton provisions; Anton's OAuth writes
// that file's host-side copy. Everything Antigravity-specific lives here.

import { chmod, mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { REASONING_LEVELS, type OAuthClient, type OAuthClientSlot, type Reasoning, type SubscriptionModel } from '../../core/ports.ts';
import { antigravitySignIn, antigravitySignOut } from '../antigravity/oauth.ts';
import { antigravityWindows } from '../antigravity/quota.ts';
import { downloadArchive, olderThan, untar } from './install.ts';
import type { AcpAgent, AcpRelease, SessionInfo } from './runtime.ts';

// Floor and fallback: the last version verified end to end. `release.latest`
// asks Antigravity's own update manifest for the newest build when the image is made.
const AGY_VERSION = '1.5.13';
const MANIFEST_BASE = 'https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/';
/** Host platform ('linux/arm64'…) → the updater's manifest name; Modal images are always 'linux/x64'. */
const AGY_MANIFESTS: Record<string, string> = {
	'linux/x64': 'linux_amd64',
	'linux/arm64': 'linux_arm64',
	'darwin/x64': 'darwin_amd64',
	'darwin/arm64': 'darwin_arm64',
};
// The floor build's own URLs and digests per platform, for hosts that cannot reach the manifest.
const AGY_FALLBACKS: Record<string, AcpRelease> = {
	'linux/x64': { version: AGY_VERSION, url: 'https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.13-5999302598852608/linux-x64/cli_linux_x64.tar.gz', sha512: '014b37387703acab1f47cd532c8bb60167a6a3537b0f9891de03f1b1ffa9614307bc83c4b2f7551273b0877d722716b0cd9e26782f6b2a50705db4f05e18c68f' },
	'linux/arm64': { version: AGY_VERSION, url: 'https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.13-5999302598852608/linux-arm/cli_linux_arm64.tar.gz', sha512: 'dccea2eb455099f5175f0c87cc47b38fcefe4cb0cb44dea3927469bb4bbf68ac3c0b30fc04affb24c17e90959386a93c3785e8e4b8b1a3338ca4e4d57b80057b' },
	'darwin/arm64': { version: AGY_VERSION, url: 'https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.13-5999302598852608/darwin-arm/cli_mac_arm64.tar.gz', sha512: 'd9825ebce6954df6b7841970fd7ef3d37acdfe628993f14c396ec73b20ed06bbe95e7b7be047e7c0b0baaf009f75fe95ce051b9f4af5e84b002da15bda4a1f45' },
	'darwin/x64': { version: AGY_VERSION, url: 'https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.13-5999302598852608/darwin-x64/cli_mac_x64.tar.gz', sha512: '6a7087eb847029bead89d496a6c4a5d3ec8552f351a486b3917948fee2a9a72ec6e2be7eae866b975b8ed3fc2a1827cf176b5bd45d6eb9970424fec4352d3930' },
};

async function agyLatest(platform: string): Promise<AcpRelease | null> {
	const manifestName = AGY_MANIFESTS[platform];
	if (!manifestName) return null;
	try {
		const res = await fetch(`${MANIFEST_BASE}${manifestName}.json`, { signal: AbortSignal.timeout(10_000) });
		const manifest = (await res.json()) as { version?: string; url?: string; sha512?: string };
		if (!manifest.version || !manifest.url) return null;
		// Never downgrade below the floor the image recipe was verified against.
		if (olderThan(manifest.version, AGY_VERSION)) return null;
		return { version: manifest.version, url: manifest.url, sha512: manifest.sha512 };
	} catch {
		return null;
	}
}

/** Where agy keeps its OAuth token inside its data dir; it refreshes the access token in place. */
const TOKEN_NAME = 'antigravity-oauth-token';
/** agy resolves this under $HOME; containers run as root, probes redirect HOME. */
const tokenPath = (home: string) => join(home, '.gemini', 'antigravity-cli', TOKEN_NAME);

/** `client` is the OAuth client saved in Settings; signing in and reading quota need it. */
export function antigravityAgent(opts: { credentialFile: string; client?: OAuthClientSlot }): AcpAgent {
	const file = opts.credentialFile;
	const client = async (): Promise<OAuthClient> => {
		const saved = await opts.client?.get();
		if (!saved) throw new Error('Add Antigravity’s OAuth client id and secret under Settings › Subscriptions › Antigravity first.');
		return saved;
	};
	return {
		id: 'antigravity',
		name: 'Antigravity',
		gateway: 'antigravity',
		plan: 'Google Antigravity',
		signInCommand: 'Sign in with Google',
		image: {
			// node runs the MCP link scripts; the agy CLI is a single static binary in a tarball.
			base: 'node:22-bookworm',
			commands: (release) => {
				const url = release?.url;
				if (!url) throw new Error('Antigravity release URL is required to build the agent image');
				const check = release?.sha512 ? ` && echo "${release.sha512}  /tmp/agy.tgz" | sha512sum -c --quiet` : '';
				return [
					'RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*',
					// provision() writes the OAuth token here before authenticate; the dir must exist first.
					'RUN mkdir -p /root/.gemini/antigravity-cli',
					`RUN curl -fsSL ${url} -o /tmp/agy.tgz${check} && tar -xzf /tmp/agy.tgz -C /usr/local/bin && chmod +x /usr/local/bin/antigravity && ln -sf /usr/local/bin/antigravity /usr/local/bin/agy && agy --version`,
				];
			},
		},
		release: { floor: AGY_VERSION, latest: agyLatest },
		// The tarball carries `antigravity` at its root; `agy` is the name everything uses.
		install: {
			fallback: (platform) => AGY_FALLBACKS[platform] ?? null,
			fetch: async (release, dir) => {
				const stage = await mkdtemp(join(dir, '.stage-'));
				try {
					const archive = join(stage, 'agy.tgz');
					await downloadArchive(release, archive);
					await untar(archive, stage);
					const bin = join(dir, 'antigravity');
					await rename(join(stage, 'antigravity'), bin);
					await chmod(bin, 0o755);
					await symlink('antigravity', join(dir, 'agy'));
				} finally {
					await rm(stage, { recursive: true, force: true });
				}
			},
		},
		// Cloud Code, Google sign-in and the update manifest; verified by the local ACP probe.
		egress: ['*.googleapis.com', '*.google.com', 'antigravity.google', '*.gstatic.com', 'antigravity-cli-auto-updater-974169037036.us-central1.run.app'],
		workdir: '/work',
		linkDir: '/opt/acp',
		// Its own port: sidecars for different agents can share an anchor sandbox.
		linkPort: 47910,
		command: ['agy', 'acp'],
		mcpServerName: 'anton',
		modelConfigId: 'model',
		// thought_level is agy's effort dial (low/medium/high/xhigh); Anton's 'off'/'minimal'/'max' clamp onto its ends.
		effortConfigId: 'thought_level',
		effortMap: { off: 'low', minimal: 'low', max: 'xhigh' },
		// 'auto' approves edits and safe commands without prompts; the jail is what contains them.
		sessionConfig: { mode: 'auto' },
		// models.availableModels lists each model × effort as its own id (`gemini-4-neon-high`);
		// the suffixes a base model has are the reasoning levels it accepts. The payload carries
		// no context size, so windows are the vendors' documented ones (Gemini 1M — T3's usage
		// meter reads 1,048,576 on agy; gpt-oss 131K; Claude 200K standard).
		modelInfo: (value, session: SessionInfo) => {
			const suffixes = new Set<string>();
			for (const entry of session.models?.availableModels ?? []) {
				const id = entry.modelId ?? '';
				if (id === value || !id.startsWith(`${value}-`)) continue;
				const suffix = id.slice(value.length + 1);
				if ((REASONING_LEVELS as readonly string[]).includes(suffix)) suffixes.add(suffix);
			}
			const out: Partial<Pick<SubscriptionModel, 'reasoning' | 'defaultReasoning' | 'contextLength'>> = {};
			if (suffixes.size) {
				const reasoning = REASONING_LEVELS.filter((level): level is Reasoning => suffixes.has(level));
				out.reasoning = reasoning;
				out.defaultReasoning = reasoning.includes('high') ? 'high' : (reasoning[0] ?? 'low');
			}
			if (value.startsWith('gemini-')) out.contextLength = 1_000_000;
			else if (value.startsWith('claude-')) out.contextLength = 200_000;
			else if (value.startsWith('gpt-oss-')) out.contextLength = 131_072;
			return out;
		},
		// agy reads its token file lazily at authenticate; provision lands it first. There is
		// no keyring in the container, so the file is the only credential store it consults.
		auth: {
			kind: 'token-file',
			methodId: 'oauth-personal',
			credentialFile: file,
			login: async () => antigravitySignIn(file, await client()),
			logout: () => antigravitySignOut(file),
			provision: async (proc, token) => {
				const path = tokenPath('/root');
				await proc.writeFile(path, token);
			},
		},
		// ACP reports the tier but no quota; the 5-hour/weekly bars read Google's
		// retrieveUserQuotaSummary with this same token file (see quota.ts).
		windows: () => antigravityWindows(file, client),
		...(opts.client ? { oauthClient: opts.client } : {}),
		// listModels probes agy on this host with a throwaway HOME holding only the token file
		// and a dead D-Bus address, so the keyring can never leak in or be consulted.
		probeCommand: () => ['agy', 'acp'],
		probeEnv: (dir) => ({ HOME: dir, DBUS_SESSION_BUS_ADDRESS: 'unix:path=/nonexistent' }),
		probeSeed: async (token, dir) => {
			const path = tokenPath(dir);
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, token, { mode: 0o600 });
		},
	};
}

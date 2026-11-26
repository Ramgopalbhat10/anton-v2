// Devin's ACP agent (`devin acp`) as an AcpAgent descriptor. Everything
// Devin-specific lives here; the runtime in runtime.ts stays generic.

import { chmod, mkdtemp, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { AcpAgent, AcpRelease } from './runtime.ts';
import { downloadArchive, olderThan, untar } from './install.ts';
import { devinUsage } from './devin-usage.ts';
import type { SubscriptionModel } from '../../core/ports.ts';

// Floor and fallback: the last version verified end to end. `release.latest`
// asks Devin's own manifest for the newest build when the image is made.
const DEVIN_VERSION = '3000.14.30821';
const DEVIN_TGZ = `https://static.devin.ai/cli/${DEVIN_VERSION}/devin-${DEVIN_VERSION}-x86_64-unknown-linux.tar.gz`;
const MANIFEST = 'https://static.devin.ai/cli/current/manifest.json';

/** Host platform ('linux/arm64'…) → the manifest's Rust target triple; Modal images are always 'linux/x64'. */
const DEVIN_TRIPLES: Record<string, string> = {
	'linux/x64': 'x86_64-unknown-linux',
	'linux/arm64': 'aarch64-unknown-linux',
	'darwin/x64': 'x86_64-apple-darwin',
	'darwin/arm64': 'aarch64-apple-darwin',
};

async function devinLatest(platform: string): Promise<AcpRelease | null> {
	const triple = DEVIN_TRIPLES[platform];
	if (!triple) return null;
	try {
		const res = await fetch(MANIFEST, { signal: AbortSignal.timeout(10_000) });
		const manifest = (await res.json()) as { version?: string; platforms?: Record<string, { url?: string; sha256?: string }> };
		const p = manifest.platforms?.[triple];
		if (!manifest.version || !p?.url) return null;
		// Never downgrade below the floor the image recipe was verified against.
		if (olderThan(manifest.version, DEVIN_VERSION)) return null;
		return { version: manifest.version, url: p.url, sha256: p.sha256 };
	} catch {
		return null;
	}
}

// `devin models list` prints one line per variant: two-space indent, id, name,
// then a bracket with "262K context" and "$X / 1M Input · … · $Y / 1M Output" or "Free".
// Family headers sit at column 0 and "aliases:" lines carry no bracket, so both skip themselves.
function parseModelCatalog(text: string): Map<string, { contextLength: number; listPrice: SubscriptionModel['listPrice'] }> {
	const models = new Map<string, { contextLength: number; listPrice: SubscriptionModel['listPrice'] }>();
	for (const line of text.split('\n')) {
		const row = /^\s{2}(\S+)\s{2,}.+?\s{2,}\[([^\]]+)\]/.exec(line);
		if (!row) continue;
		const [, id, spec] = row;
		const context = /([\d.]+)\s*([KM])\s+context/i.exec(spec);
		const input = /\$([\d.]+)\s*\/\s*1M Input/.exec(spec);
		const cached = /\$([\d.]+)\s*\/\s*1M Cached input/.exec(spec);
		const output = /\$([\d.]+)\s*\/\s*1M Output/.exec(spec);
		models.set(id, {
			contextLength: context ? Math.round(Number(context[1]) * (context[2].toUpperCase() === 'M' ? 1_000_000 : 1_000)) : 0,
			listPrice:
				input && output
					? { input: Number(input[1]), output: Number(output[1]), cacheRead: cached ? Number(cached[1]) : 0, cacheWrite: 0 }
					: null,
		});
	}
	return models;
}

export const devinAgent: AcpAgent = {
	id: 'devin',
	name: 'Devin',
	gateway: 'devin',
	plan: 'Devin',
	signInCommand: 'devin auth login',
	image: {
		// node runs the MCP link scripts; the devin CLI is a static binary.
		base: 'node:22-bookworm',
		commands: (release) => {
			const url = release?.url ?? DEVIN_TGZ;
			const check = release?.sha256 ? ` && echo "${release.sha256}  /tmp/devin.tgz" | sha256sum -c --quiet` : '';
			return [
				'RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates git fd-find && rm -rf /var/lib/apt/lists/* && ln -sf /usr/bin/fdfind /usr/local/bin/fd',
				`RUN curl -fsSL ${url} -o /tmp/devin.tgz${check} && tar -xzf /tmp/devin.tgz -C /usr/local && rm /tmp/devin.tgz && chmod +x /usr/local/bin/devin && devin --version`,
			];
		},
	},
	release: { floor: DEVIN_VERSION, latest: devinLatest },
	// Same tarball the image installs; the floor URL carries no pinned checksum,
	// matching the image recipe's trust level when the manifest is unreachable.
	install: {
		fallback: (platform) => {
			const triple = DEVIN_TRIPLES[platform];
			return triple ? { version: DEVIN_VERSION, url: `https://static.devin.ai/cli/${DEVIN_VERSION}/devin-${DEVIN_VERSION}-${triple}.tar.gz` } : null;
		},
		fetch: async (release, dir) => {
			const stage = await mkdtemp(join(dir, '.stage-'));
			try {
				const archive = join(stage, 'devin.tgz');
				await downloadArchive(release, archive);
				await untar(archive, stage);
				// The tarball carries bin/devin, which the image puts under /usr/local.
				const bin = join(dir, 'devin');
				await rename(join(stage, 'bin', 'devin'), bin);
				await chmod(bin, 0o755);
			} finally {
				await rm(stage, { recursive: true, force: true });
			}
		},
	},
	// Only what the CLI needs to reach Devin; verified by the sidecar spike.
	egress: ['*.devin.ai', '*.codeium.com', '*.windsurf.com'],
	workdir: '/work',
	linkDir: '/opt/acp',
	linkPort: 47900,
	command: ['devin', 'acp'],
	// devin acp --model presets each new session's default, sparing the ~seconds-long set_config_option.
	modelArgs: (model) => ['--model', model],
	mcpServerName: 'anton',
	// Devin's model reaches MCP tools only through these (field names from the CLI's McpCallToolInput, 3000.14 and 3000.15).
	mcpCall: { tool: 'mcp_call_tool', server: 'server_name', name: 'tool_name', args: 'arguments', list: 'mcp_list_tools' },
	// Devin lists MCP tools only when it looks, and a listing of Anton's whole toolset came back cut, with the rest in a
	// file in its own container that it could not open; the tool list in its instructions names every tool either way.
	mcpDescriptionChars: 300,
	modelConfigId: 'model',
	modelMetaImages: 'cognition.ai/supportsImages',
	// Devin's own turn stats, logged beside Anton's wall-clock timings: its ttft
	// excludes our spawn+handshake, its tok/s explains slow streams.
	notification: (method, params) => {
		if (method !== '_cognition.ai/agent_stopped') return;
		const s = ((params as { stats?: Record<string, unknown> })?.stats ?? {}) as Record<string, unknown>;
		const num = (key: string) => (typeof s[key] === 'number' ? (s[key] as number) : null);
		console.error(
			`[acp:devin] vendor: model=${String(s.modelLabel ?? '?')} ttft=${num('ttftMs') ?? '?'}ms turn=${num('totalTimeMs') ?? '?'}ms tok/s=${num('tokensPerSec')?.toFixed(1) ?? '?'} tools=${num('toolCalls') ?? 0} in=${num('inputTokens') ?? 0} out=${num('outputTokens') ?? 0}`,
		);
	},
	catalog: { command: ['devin', 'models', 'list'], parse: parseModelCatalog },
	// Plan quota via the CLI's own SeatManagement status call; the public
	// consumption API is Enterprise-only.
	windows: () => devinUsage(devinAgent, DEVIN_VERSION),
	metaNamespace: 'cognition.ai',
	auth: {
		kind: 'cli',
		// The one method devin acp advertises; the token rides in _meta.api_key.
		methodId: 'devin-browser',
		params: (token) => ({ _meta: { api_key: token } }),
		// Local CLI auth: `devin auth login` writes this file on the host; sidecars never see it.
		credentialFile: '~/.local/share/devin/credentials.toml',
		credentialKey: 'windsurf_api_key',
		loginCommand: ['devin', 'auth', 'login', '--force-manual-token-flow'],
		logoutCommand: ['devin', 'auth', 'logout'],
		loginUrl: /https:\/\/\S+/,
	},
};

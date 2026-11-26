import { DEFAULT_PREVIEW_PORTS, listProjects } from '../../db/projects.ts';

/** Read once a while: a preview's every request and socket asks. */
const FRESH_MS = 30_000;
let cached: { at: number; ports: Promise<Set<number>> } | null = null;

/** The ports a task on this server may preview on: the defaults and every project's own (src/core/preview-proxy.ts). */
export async function previewPortsServed(port: number): Promise<boolean> {
	if (!cached || Date.now() - cached.at > FRESH_MS) {
		const ports = listProjects().then((projects) => new Set([...DEFAULT_PREVIEW_PORTS, ...projects.flatMap((project) => project.previewPorts ?? [])]));
		cached = { at: Date.now(), ports };
		ports.catch(() => {
			cached = null;
		});
	}
	return (await cached.ports).has(port);
}

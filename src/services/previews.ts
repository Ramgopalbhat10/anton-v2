import { text } from '../core/shell.ts';
import { getProject } from '../db/projects.ts';
import { getSessionRecord } from '../db/sessions.ts';
import { NotFoundError } from '../core/errors.ts';
import type { Machine } from '../core/ports.ts';
import { liveMachine } from './workspace.ts';

export type Preview = { port: number; url: string | null; listening: boolean };
export type PreviewsView = { live: boolean; previews: Preview[] };

/** Ports with a server accepting connections inside the machine, checked in one command. */
async function listening(machine: Machine, ports: number[]): Promise<Set<number>> {
	const probe = ports.map((port) => `(exec 3<>/dev/tcp/127.0.0.1/${port}) 2>/dev/null && echo ${port}`).join('; ');
	const result = await machine.exec(`${probe}; true`);
	return new Set(text(result.stdout).split('\n').filter(Boolean).map(Number));
}

/** The task's preview ports, their URLs and which have a server up. Never starts a machine. */
export async function previewsView(id: string): Promise<PreviewsView> {
	const session = await getSessionRecord(id);
	const project = session && (await getProject(session.projectId));
	if (!session || !project) throw new NotFoundError('Session not found');
	const machine = await liveMachine(id);
	if (!machine) return { live: false, previews: [] };
	const ports = project.previewPorts;
	const [up, urls] = await Promise.all([listening(machine, ports), Promise.all(ports.map((port) => machine.previewUrl(port)))]);
	return { live: true, previews: ports.map((port, index) => ({ port, url: urls[index], listening: up.has(port) })) };
}

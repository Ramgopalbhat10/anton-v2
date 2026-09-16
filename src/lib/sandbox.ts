import { execFile as execFileCb } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { workspacesDir } from './env.ts';

const execFile = promisify(execFileCb);

export type WarmSandbox = {
	id: string;
	projectId: string;
	cwd: string;
};

const warmByProject = new Map<string, WarmSandbox>();

async function git(cwd: string, args: string[]): Promise<string> {
	const { stdout } = await execFile('git', args, { cwd });
	return stdout.trim();
}

export async function ensureLocalWorkspace(projectId: string, repoFullName: string): Promise<string> {
	const cwd = path.join(workspacesDir(), projectId.replaceAll('/', '__'));
	mkdirSync(cwd, { recursive: true });
	if (!existsSync(path.join(cwd, '.git'))) {
		await git(cwd, ['init', '-b', 'main']);
		await git(cwd, ['config', 'user.name', 'Anton']);
		await git(cwd, ['config', 'user.email', 'anton@localhost']);
		writeFileSync(
			path.join(cwd, 'README.md'),
			`# ${repoFullName}\n\nLocal Anton v2 workspace. Chat with the agent to edit this tree.\n`,
			'utf8',
		);
		mkdirSync(path.join(cwd, 'agent'), { recursive: true });
		writeFileSync(path.join(cwd, 'agent', '.gitkeep'), '', 'utf8');
		await git(cwd, ['add', '.']);
		await git(cwd, ['commit', '-m', 'chore: initial anton workspace']);
	}
	return cwd;
}

export function getWarmSandbox(projectId: string): WarmSandbox | undefined {
	return warmByProject.get(projectId);
}

export function attachLocalSandbox(projectId: string, cwd: string): WarmSandbox {
	const existing = warmByProject.get(projectId);
	if (existing) return existing;
	const sandbox: WarmSandbox = { id: `local:${randomUUID()}`, projectId, cwd };
	warmByProject.set(projectId, sandbox);
	return sandbox;
}

export function releaseSandbox(projectId: string): void {
	warmByProject.delete(projectId);
}

export function sandboxById(sandboxId: string): WarmSandbox | undefined {
	for (const sandbox of warmByProject.values()) {
		if (sandbox.id === sandboxId) return sandbox;
	}
	return undefined;
}

export function workspaceForConversation(conversationId: string, lookup: (id: string) => string | undefined): string {
	const cwd = lookup(conversationId);
	if (!cwd) {
		throw new Error(`No workspace for conversation ${conversationId}`);
	}
	return cwd;
}

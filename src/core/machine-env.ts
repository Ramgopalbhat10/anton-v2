import type { Machine } from './ports.ts';

/**
 * The same machine, with `env` under every command and shell it runs. A
 * command's own variables win, so Anton's git credentials are never
 * overridden by a repo setting of the same name.
 */
export function withEnv(machine: Machine, env: Record<string, string>): Machine {
	return {
		id: machine.id,
		root: machine.root,
		exec: (command, options = {}) => machine.exec(command, { ...options, env: { ...env, ...options.env } }),
		openPty: (options) => machine.openPty({ ...options, env: { ...env, ...options.env } }),
		previewUrl: (port) => machine.previewUrl(port),
	};
}

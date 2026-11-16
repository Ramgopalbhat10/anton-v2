import type { Machine } from './ports.ts';

/** A command's own variables win, so a repo setting of the same name never overrides Anton's git credentials. */
export function withEnv(machine: Machine, env: Record<string, string>): Machine {
	return {
		id: machine.id,
		root: machine.root,
		exec: (command, options = {}) => machine.exec(command, { ...options, env: { ...env, ...options.env } }),
		openPty: (options) => machine.openPty({ ...options, env: { ...env, ...options.env } }),
		previewUrl: (port) => machine.previewUrl(port),
		socketUrl: (port) => machine.socketUrl(port),
	};
}

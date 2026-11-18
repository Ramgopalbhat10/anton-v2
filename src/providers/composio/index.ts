import type { AppsConnector } from '../../core/ports.ts';
import type { KeySlot } from '../key-slot.ts';
import * as api from './api.ts';

export function composioApps(options: { key: KeySlot }): AppsConnector {
	const key = (): string => {
		const found = options.key.get();
		if (!found) throw new Error('No Composio API key is set.');
		return found;
	};
	return {
		keySource: () => options.key.source(),
		checkKey: async (candidate) => {
			await api.listToolkits(candidate, { limit: 1 });
		},
		toolkits: (query) => api.listToolkits(key(), query),
		tools: (toolkit) => api.listToolkitTools(key(), toolkit),
		toolkitAuth: (toolkit) => api.toolkitAuth(key(), toolkit),
		authConfigs: (toolkit) => api.listAuthConfigs(key(), toolkit),
		createAuthConfig: (toolkit, input) => api.createAuthConfig(key(), toolkit, input),
		connectLink: (input) => api.createLink(key(), input),
		connectedAccount: (id) => api.getConnectedAccount(key(), id),
		connectedAccounts: (input) => api.listConnectedAccounts(key(), input),
		deleteConnectedAccount: (id) => api.deleteConnectedAccount(key(), id),
		revokeConnectedAccount: (id) => api.revokeConnectedAccount(key(), id),
		runTool: (slug, input, signal) => api.executeTool(key(), slug, input, signal),
	};
}

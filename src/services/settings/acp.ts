import { getSetting, setSetting } from '../../db/settings.ts';
import { acpIsolationKey, type AcpIsolation } from '../../providers/acp/runtime.ts';

export const acpIsolation = (agentId: string): Promise<AcpIsolation> => getSetting<AcpIsolation>(acpIsolationKey(agentId), 'sidecar');

export const setAcpIsolation = async (agentId: string, mode: AcpIsolation): Promise<AcpIsolation> => {
	await setSetting(acpIsolationKey(agentId), mode);
	return mode;
};

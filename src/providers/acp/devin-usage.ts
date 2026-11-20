// Devin's plan quota for the Settings usage bars. ACP reports nothing and the
// public consumption API is Enterprise-only, so this reads the same
// SeatManagement GetUserStatus the CLI's own billing view uses: the
// windsurf_api_key in credentials.toml rides in the request metadata (the
// Codeium Connect pattern — no bearer header needed).
//
// PlanStatus is plan-dependent: quota-billing tiers send daily/weekly percents
// and reset times, credit tiers send used/available credits, ACU tiers send
// acuConsumed/acuLimit. proto3 JSON omits zero fields, so a missing field means
// "not reported", never "zero used" — only populated fields become windows.

import type { PlanWindow } from '../../core/ports.ts';
import type { AcpAgent } from './runtime.ts';
import { localCredential } from './local-cli.ts';

const ENDPOINT = 'https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus';
const REQUEST_MS = 10_000;
const TTL_MS = 60_000;

export type DevinPlanStatus = {
	dailyQuotaRemainingPercent?: number;
	weeklyQuotaRemainingPercent?: number;
	dailyQuotaResetAtUnix?: string | number;
	weeklyQuotaResetAtUnix?: string | number;
	availablePromptCredits?: number;
	usedPromptCredits?: number;
	availableFlowCredits?: number;
	usedFlowCredits?: number;
	acuConsumed?: number;
	acuLimit?: number;
	overageBalanceMicros?: string;
};

const unixIso = (value: string | number | undefined): string | null => {
	const secs = typeof value === 'string' ? Number(value) : value;
	return typeof secs === 'number' && secs > 0 ? new Date(secs * 1000).toISOString() : null;
};

const pct = (used: number, whole: number) => Math.round(Math.min(1, Math.max(0, used / whole)) * 1000) / 10;

export function statusWindows(status: DevinPlanStatus | undefined): PlanWindow[] {
	if (!status) return [];
	const out: PlanWindow[] = [];
	// Quota-billing tiers: remaining percent → used percent; -1/absent fields skip themselves.
	for (const [label, remaining, reset] of [
		['Daily', status.dailyQuotaRemainingPercent, status.dailyQuotaResetAtUnix],
		['Weekly', status.weeklyQuotaRemainingPercent, status.weeklyQuotaResetAtUnix],
	] as const) {
		if (typeof remaining !== 'number') continue;
		const used = Math.min(100, Math.max(0, 100 - remaining));
		out.push({ label: `Devin · ${label}`, usedPercent: Math.round(used * 10) / 10, resetsAt: unixIso(reset), limited: remaining <= 0 });
	}
	// Credit tiers: real used/available pairs only (available -1 means unlimited).
	for (const [label, used, available] of [
		['Prompt credits', status.usedPromptCredits, status.availablePromptCredits],
		['Flow credits', status.usedFlowCredits, status.availableFlowCredits],
	] as const) {
		if (typeof used !== 'number' || typeof available !== 'number' || available <= 0) continue;
		out.push({ label: `Devin · ${label}`, usedPercent: pct(used, available), resetsAt: null, limited: used >= available });
	}
	if (typeof status.acuConsumed === 'number' && typeof status.acuLimit === 'number' && status.acuLimit > 0) {
		out.push({ label: 'Devin · ACU', usedPercent: pct(status.acuConsumed, status.acuLimit), resetsAt: null, limited: status.acuConsumed >= status.acuLimit });
	}
	return out;
}

async function read(agent: AcpAgent, version: string): Promise<PlanWindow[] | null> {
	const apiKey = await localCredential(agent);
	if (!apiKey) return null;
	const res = await fetch(ENDPOINT, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' },
		body: JSON.stringify({
			metadata: { apiKey, ideName: 'devin-cli', ideVersion: version, extensionName: 'devin', extensionVersion: version },
		}),
		signal: AbortSignal.timeout(REQUEST_MS),
	});
	if (!res.ok) return null;
	const body = (await res.json()) as { userStatus?: { planStatus?: DevinPlanStatus } };
	const windows = statusWindows(body.userStatus?.planStatus);
	return windows.length ? windows : null;
}

let cache: { at: number; value: PlanWindow[] | null } | null = null;
let lastGood: PlanWindow[] | null = null;
let inflight: Promise<PlanWindow[] | null> | null = null;

/** The plan's usage windows, or null when signed out/unreported; a failed read serves the last good answer. */
export async function devinUsage(agent: AcpAgent, version: string): Promise<PlanWindow[] | null> {
	if (cache && Date.now() - cache.at < TTL_MS) return cache.value ?? lastGood;
	inflight ??= read(agent, version).catch(() => null);
	const value = await inflight.finally(() => {
		inflight = null;
	});
	cache = { at: Date.now(), value };
	if (value?.length) lastGood = value;
	return value ?? lastGood;
}

import type { FlueConversationMessage } from '@flue/react';
import { Check, Copy } from '@/lib/icons';
import { useEffect, useState } from 'react';
import { TraceIcon } from '@/components/marks/trace-icon';
import { Btn, IconBtn } from '@/components/kit/signal';
import { HoverPeek } from '@/components/kit/hover-peek';
import { Caption, Chip, Figure, SplitBar } from '@/components/kit/instrument';
import { type Usage, type UsagePart } from '@/lib/api/sessions';
import { dollars, tokens } from '@/lib/format';
import { logoFor } from '@/lib/provider-logos';

/** Every call sends the conversation again, so the tokens add up each call's context; `context` is the largest one call held (0 when not known). Older replies have no `context` or `plan`. */
type ReplyUsageView = Usage & {
	parts: { main: UsagePart; subagents: UsagePart } | null;
	billing: 'plan' | 'api' | null;
	context: { peak: number; window: number } | null;
	plan: { gateway: string; name: string } | null;
	/** Counted from the text sent, as the provider (Cursor) reports no one call's tokens or cache. */
	estimated: boolean;
};

export function usageOf(message: FlueConversationMessage): ReplyUsageView | null {
	const metadata = message.metadata;
	const usage = metadata?.usage as Usage | undefined;
	if (!usage || typeof usage.inputTokens !== 'number') return null;
	const parts = metadata?.usageParts as ReplyUsageView['parts'] | undefined;
	const billing = metadata?.billing;
	const context = metadata?.context as ReplyUsageView['context'] | undefined;
	const plan = metadata?.plan as ReplyUsageView['plan'] | undefined;
	return {
		...usage,
		parts: parts?.main ? parts : null,
		billing: billing === 'plan' || billing === 'api' ? billing : null,
		context: typeof context?.peak === 'number' && context.peak > 0 ? context : null,
		plan: typeof plan?.gateway === 'string' && typeof plan.name === 'string' ? plan : null,
		estimated: metadata?.estimated === true,
	};
}

const callsOf = (usage: ReplyUsageView) => (usage.parts ? usage.parts.main.calls + usage.parts.subagents.calls : 0);

function PlanChip({ plan }: { plan: ReplyUsageView['plan'] }) {
	const logo = plan ? logoFor({ id: `${plan.gateway}/` }) : undefined;
	return (
		<Chip tone="accent">
			{logo ? <span aria-hidden className="flex text-small" dangerouslySetInnerHTML={{ __html: logo }} /> : null}
			{plan?.name ?? 'Your plan'}
		</Chip>
	);
}

const USAGE_COLORS = { cached: 'var(--a-700)', input: 'var(--data-1)', output: 'var(--data-2)' };

function ReplyUsagePeek({ usage, onTrace }: { usage: ReplyUsageView; onTrace?: () => void }) {
	const total = usage.inputTokens + usage.outputTokens;
	const cached = Math.min(usage.cachedTokens ?? 0, usage.inputTokens);
	const plan = usage.billing === 'plan';
	const who = usage.parts ? [{ label: 'The agent', part: usage.parts.main }, ...(usage.parts.subagents.calls ? [{ label: 'Subagents', part: usage.parts.subagents }] : [])] : [];
	const notes = [
		...(usage.estimated ? ["Cursor reports tokens only for a whole run, so each call is estimated from the text it was sent, and its cache isn't shown."] : []),
		...(plan
			? [`Run on your ${usage.plan ? `${usage.plan.name} ` : ''}plan: no charge per token.`]
			: cached
				? [`${Math.round((cached / usage.inputTokens) * 100)}% of the input came from the provider's cache, which costs less.`]
				: []),
	];
	return (
		<>
			<div className="flex items-end justify-between gap-3">
				<div className="flex min-w-0 flex-col gap-1">
					<Caption>This reply</Caption>
					<Figure size="md" value={`${usage.estimated ? '~' : ''}${tokens(total)}`} unit="tokens" />
				</div>
				<div className="flex flex-col items-end gap-1">
					<Caption>{plan ? 'Billed to' : 'Charged'}</Caption>
					{plan ? <PlanChip plan={usage.plan} /> : <span className="in-figure text-h2 leading-[24px]">{dollars(usage.cost)}</span>}
				</div>
			</div>
			<SplitBar
				label={`${total.toLocaleString()} tokens: ${usage.inputTokens.toLocaleString()} in, ${cached.toLocaleString()} of them cached, and ${usage.outputTokens.toLocaleString()} out`}
				format={(part) => tokens(part.value)}
				parts={[
					...(cached ? [{ key: 'cached', label: 'Cached', value: cached, color: USAGE_COLORS.cached }] : []),
					{ key: 'input', label: cached ? 'New input' : 'Input', value: usage.inputTokens - cached, color: USAGE_COLORS.input },
					{ key: 'output', label: 'Output', value: usage.outputTokens, color: USAGE_COLORS.output },
				]}
			/>
			{usage.context ? (
				<div className="flex items-baseline justify-between gap-3 border-t border-(--line) pt-2 text-small">
					<span className="text-(--text-2)">Largest context</span>
					<span className="in-num text-(--text)">
						{tokens(usage.context.peak)}
						{usage.context.window ? (
							<span className="text-(--text-3)">
								{' '}
								of {tokens(usage.context.window)} · {Math.round((usage.context.peak / usage.context.window) * 100)}%
							</span>
						) : null}
					</span>
				</div>
			) : null}
			{who.length ? (
				<table className="w-full border-collapse text-small">
					<thead>
						<tr className="in-caption text-left">
							<th className="pb-1 font-medium">Made by</th>
							<th className="pb-1 text-right font-medium">Calls</th>
							<th className="pb-1 text-right font-medium">Tokens</th>
							{plan ? null : <th className="pb-1 text-right font-medium">Cost</th>}
						</tr>
					</thead>
					<tbody>
						{who.map(({ label, part }) => (
							<tr key={label} className="border-t border-(--line)">
								<td className="py-1.5 text-(--text-2)">{label}</td>
								<td className="in-num py-1.5 pl-3 text-right text-(--text-3)">{part.calls}</td>
								<td className="in-num py-1.5 pl-3 text-right text-(--text)">{tokens(part.inputTokens + part.outputTokens)}</td>
								{plan ? null : <td className="in-num py-1.5 pl-3 text-right text-(--text)">{dollars(part.cost)}</td>}
							</tr>
						))}
					</tbody>
				</table>
			) : null}
			{notes.length ? (
				<div className="flex flex-col gap-1 border-t border-(--line) pt-2">
					{notes.map((note) => (
						<p key={note} className="m-0 text-small leading-4 text-(--text-3)">
							{note}
						</p>
					))}
				</div>
			) : null}
			{onTrace ? (
				<Btn size="sm" variant="secondary" icon={TraceIcon} block onClick={onTrace}>
					Open the trace
				</Btn>
			) : null}
		</>
	);
}

export function ReplyUsageLine({ usage, onTrace }: { usage: ReplyUsageView; onTrace?: () => void }) {
	const calls = callsOf(usage);
	return (
		<HoverPeek content={<ReplyUsagePeek usage={usage} onTrace={onTrace} />} width={300} openDelay={200}>
			<div
				tabIndex={0}
				className="in-num rounded-control text-micro text-(--text-4) decoration-dotted underline-offset-[3px] outline-none hover:text-(--text-3) hover:underline focus-visible:shadow-(--focus)"
			>
				{usage.estimated ? '~' : ''}
				{tokens(usage.inputTokens + usage.outputTokens)} tokens{calls > 1 ? ` · ${calls} calls` : ''} ·{' '}
				{usage.billing === 'plan' ? (usage.plan?.name ?? 'plan') : dollars(usage.cost)}
			</div>
		</HoverPeek>
	);
}

export function CopyResponse({ text }: { text: string }) {
	const [state, setState] = useState<'ready' | 'copied' | 'failed'>('ready');
	useEffect(() => {
		if (state === 'ready') return;
		const timer = setTimeout(() => setState('ready'), 2000);
		return () => clearTimeout(timer);
	}, [state]);
	return (
		<IconBtn
			size="xs"
			icon={state === 'copied' ? Check : Copy}
			label={state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed. Try again' : 'Copy response'}
			disabled={!text}
			onClick={() => {
				void navigator.clipboard
					.writeText(text)
					.then(() => setState('copied'))
					.catch(() => setState('failed'));
			}}
		/>
	);
}

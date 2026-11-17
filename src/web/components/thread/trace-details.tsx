import { ArrowLeftRight, ChevronDown, ChevronRight, CircleAlert, Sparkles, X, Zap } from '@/lib/icons';
import { type ReactNode, useState } from 'react';
import { Disclosure } from '@/components/kit/disclosure';
import { ModelLogo } from '@/components/marks/model-marks';
import { Caption, Chip, SplitBar, type Tone } from '@/components/kit/instrument';
import { EmptyLine, Icon, IconBtn } from '@/components/kit/signal';
import { lookOf, titleOf } from '@/lib/subagents';
import { dollars, tokens } from '@/lib/format';
import {
	callNumber,
	gatewayOf,
	modelChanges,
	modelsUsed,
	previousCall,
	seconds,
	shortModel,
	type TraceNode,
	traceStats,
} from '@/lib/trace-view';
import { cn } from '@/lib/utils';
import { type AgentSpan, cacheShare, cacheVerdict, type CompactionSpan, type ModelSpan, PART_LABELS, type ToolSpan, type Trace, TRACE_PARTS, type TraceMessage, type TracePart } from '../../../core/trace';
import { type ModelNames, Provider, RowIcon, rowText } from '@/components/thread/trace-timeline';

const PART_COLORS: Record<TracePart, string> = {
	messages: 'var(--data-1)',
	systemPrompt: 'var(--data-2)',
	tools: 'var(--data-3)',
	mcpTools: 'var(--data-4)',
	skills: 'var(--data-5)',
};

export const TONE_TEXT: Record<Tone, string> = {
	neutral: '',
	accent: 'text-(--accent-text)',
	attention: 'text-(--warn)',
	success: 'text-(--ok)',
	warning: 'text-(--warn)',
	danger: 'text-(--bad)',
};

/* The picked step, in a card beside the timeline. */

export function StepCard({ node, trace, names, onClose, onSelect }: { node: TraceNode; trace: Trace; names: ModelNames; onClose: () => void; onSelect: (key: string) => void }) {
	const span = node.span;
	const { label } = rowText(node, trace, names);
	const failed = span?.error;
	return (
		<aside
			aria-label="Step details"
			className="in-pop absolute inset-x-2 bottom-2 z-10 flex max-h-[72%] flex-col overflow-hidden sm:inset-x-auto sm:top-3 sm:right-3 sm:bottom-3 sm:max-h-none sm:w-[420px]"
		>
			<header className="flex min-h-12 shrink-0 items-center gap-2.5 border-b border-(--line) px-3.5 py-2">
				<RowIcon node={node} />
				<div className="min-w-0 flex-1 truncate text-body font-medium text-(--text)">{label}</div>
				{span ? <Chip tone={failed ? 'danger' : 'success'}>{failed ? 'Failed' : 'Done'}</Chip> : null}
				<IconBtn icon={X} size="sm" label="Close details" onClick={onClose} />
			</header>
			<div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain px-3.5 py-3.5 *:shrink-0">
				{failed ? (
					<div className="flex items-start gap-2 rounded-control border border-(--bad-line) bg-(--bad-soft) px-3 py-2 text-small leading-[18px] text-(--bad)">
						<Icon icon={CircleAlert} size={12} className="mt-[3px]" />
						<span className="min-w-0 break-words">{failed}</span>
					</div>
				) : null}
				{!span ? <ReplyDetail trace={trace} names={names} onSelect={onSelect} /> : null}
				{span?.kind === 'model' ? <ModelDetail span={span} trace={trace} names={names} onSelect={onSelect} /> : null}
				{span?.kind === 'tool' ? <ToolDetail span={span} trace={trace} onSelect={onSelect} /> : null}
				{span?.kind === 'agent' ? <AgentDetail span={span} trace={trace} names={names} /> : null}
				{span?.kind === 'compaction' ? <CompactionDetail span={span} /> : null}
			</div>
		</aside>
	);
}

function Facts({ items }: { items: Array<{ label: string; value: ReactNode; tone?: Tone }> }) {
	return (
		<dl className="m-0 grid grid-cols-3 gap-px overflow-hidden rounded-control border border-(--line) bg-(--line)">
			{items.map((item) => (
				<div key={item.label} className="flex min-w-0 flex-col gap-0.5 bg-(--bg-surface) px-3 py-2">
					<dt className="truncate text-micro text-(--text-3)">{item.label}</dt>
					<dd className={cn('in-num m-0 truncate text-body text-(--text)', item.tone && TONE_TEXT[item.tone])}>{item.value}</dd>
				</div>
			))}
		</dl>
	);
}

function Section({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) {
	return (
		<section className="flex flex-col gap-2">
			<div className="flex items-center gap-2">
				<Caption className="flex-1">{title}</Caption>
				{hint ? <span className="in-num text-micro text-(--text-4)">{hint}</span> : null}
			</div>
			{children}
		</section>
	);
}

function Pre({ text, tall }: { text: string; tall?: boolean }) {
	if (!text.trim()) return <span className="text-small text-(--text-4)">Empty</span>;
	return (
		<pre className={cn('in-well m-0 overflow-auto px-3 py-2 font-mono text-small leading-[17px] break-words whitespace-pre-wrap text-(--text-2)', tall ? 'max-h-[360px]' : 'max-h-[200px]')}>
			{text}
		</pre>
	);
}

function Fold({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
	const [open, setOpen] = useState(false);
	return (
		<div className="flex flex-col">
			<button
				type="button"
				aria-expanded={open}
				onClick={() => setOpen(!open)}
				className="flex h-7 items-center gap-1.5 rounded-control px-1 text-left text-small text-(--text-2) outline-none hover:bg-(--bg-hover) hover:text-(--text) focus-visible:shadow-(--focus)"
			>
				<Icon icon={open ? ChevronDown : ChevronRight} size={12} className="text-(--text-3)" />
				<span className="flex-1">{label}</span>
				{hint ? <span className="in-num text-micro text-(--text-4)">{hint}</span> : null}
			</button>
			<Disclosure open={open}>
				<div className="pt-1.5">{children}</div>
			</Disclosure>
		</div>
	);
}

const ROLE: Record<TraceMessage['role'], { label: string; tone: Tone }> = {
	user: { label: 'User', tone: 'accent' },
	assistant: { label: 'Model', tone: 'neutral' },
	toolResult: { label: 'Tool result', tone: 'warning' },
	system: { label: 'System', tone: 'neutral' },
};

function ModelDetail({ span, trace, names, onSelect }: { span: ModelSpan; trace: Trace; names: ModelNames; onSelect: (key: string) => void }) {
	const previous = previousCall(trace, span);
	const changed = previous && (previous.model !== span.model || (previous.served ?? null) !== (span.served ?? null)) ? previous : null;
	const verdict = cacheVerdict(span, previous);
	const share = span.usage ? cacheShare(span.usage) : null;
	const tools = trace.toolsets[span.toolset] ?? [];
	const prompt = trace.prompts[span.prompt] ?? '';
	const totalParts = TRACE_PARTS.reduce((sum, part) => sum + span.parts[part], 0);
	return (
		<>
			<Facts
				items={[
					{ label: 'Duration', value: seconds(span.durationMs) },
					{ label: 'Started', value: `+${seconds(span.start)}` },
					{ label: 'Cost', value: span.usage ? dollars(span.usage.cost) : '—' },
					{ label: 'Input', value: share ? tokens(share.total) : '—' },
					{ label: 'Output', value: span.usage ? tokens(span.usage.output) : '—' },
					{ label: 'Messages', value: span.messages },
				]}
			/>
			<div className="flex flex-col gap-2 rounded-control border border-(--line) bg-(--bg-surface) px-3 py-2.5">
				<div className="flex min-w-0 items-center gap-2">
					<ModelLogo model={span.model} size={20} />
					<div className="flex min-w-0 flex-1 flex-col">
						<span className="truncate text-body font-medium text-(--text)">{names.name(span.model)}</span>
						<span className="in-num truncate text-micro text-(--text-4)">{span.served && span.served !== span.model ? `answered by ${span.served}` : span.model}</span>
					</div>
				</div>
				<div className="flex flex-wrap items-center gap-1.5 text-small text-(--text-3)">
					<Chip>
						<Provider gateway={gatewayOf(span.model)} size={11} />
					</Chip>
					<Chip mono>call {callNumber(trace, span)}</Chip>
					{span.finish ? <Chip mono>{span.finish}</Chip> : null}
				</div>
				{changed ? (
					<div className="flex items-center gap-1.5 text-small text-(--warn)">
						<Icon icon={ArrowLeftRight} size={11} />
						<span className="min-w-0 truncate">Changed from {names.of(changed)} on the call before</span>
					</div>
				) : null}
			</div>
			<Section title="Context" hint={totalParts ? `${tokens(totalParts)} tokens` : undefined}>
				<SplitBar
					label="What the request held, by part"
					format={(part) => tokens(part.value)}
					parts={TRACE_PARTS.filter((part) => span.parts[part] > 0).map((part) => ({ key: part, label: PART_LABELS[part], value: span.parts[part], color: PART_COLORS[part] }))}
				/>
				<div className="flex flex-col">
					<Fold label="System prompt" hint={prompt ? `${prompt.length.toLocaleString()} chars${previous && previous.prompt !== span.prompt ? ' · changed' : ''}` : undefined}>
						<Pre text={prompt} tall />
					</Fold>
					<Fold label="Tools offered" hint={`${tools.length}${previous && previous.toolset !== span.toolset ? ' · changed' : ''}`}>
						<div className="flex flex-wrap gap-1">
							{tools.map((tool) => (
								<Chip key={tool.name} mono title={`About ${tokens(tool.tokens)} tokens`}>
									{tool.name}
								</Chip>
							))}
						</div>
					</Fold>
				</div>
			</Section>
			<Section title="Cache">
				<div className="flex items-start gap-2">
					<Chip tone={verdict.tone === 'neutral' ? 'neutral' : verdict.tone} icon={Zap}>
						{verdict.label}
					</Chip>
					<p className="m-0 min-w-0 flex-1 text-small leading-[17px] text-(--text-2)">{verdict.why}</p>
				</div>
				{share && share.total ? (
					<SplitBar
						label="Where the input came from"
						format={(part) => tokens(part.value)}
						parts={[
							{ key: 'read', label: 'Read from cache', value: share.read, color: 'var(--ok)' },
							{ key: 'write', label: 'Written to cache', value: share.write, color: 'var(--warn)' },
							{ key: 'fresh', label: 'Uncached', value: share.fresh, color: 'var(--text-4)' },
						]}
					/>
				) : null}
			</Section>
			<Section title="Added to the context" hint={span.added.length ? `${span.added.length + span.addedMore} message${span.added.length + span.addedMore === 1 ? '' : 's'}` : undefined}>
				{span.addedMore ? <span className="text-small text-(--text-4)">{span.addedMore} earlier not shown</span> : null}
				{span.added.length ? (
					span.added.map((message, index) => (
						<div key={index} className="flex flex-col gap-1">
							<div className="flex items-center gap-1.5">
								<Chip tone={ROLE[message.role].tone}>{ROLE[message.role].label}</Chip>
								{message.tool ? <span className="in-num text-micro text-(--text-3)">{message.tool}</span> : null}
								<span className="in-num ml-auto text-micro text-(--text-4)">{message.chars.toLocaleString()} chars</span>
							</div>
							<Pre text={message.text} />
						</div>
					))
				) : (
					<EmptyLine className="p-0">Nothing new: the same conversation as the call before.</EmptyLine>
				)}
			</Section>
			<Section title="Output">
				{span.output.thinking ? (
					<Fold label="Thinking" hint={`${span.output.thinking.length.toLocaleString()} chars`}>
						<Pre text={span.output.thinking} tall />
					</Fold>
				) : null}
				{span.output.text ? <Pre text={span.output.text} /> : null}
				{span.output.toolCalls.length ? (
					<div className="flex flex-wrap gap-1">
						{span.output.toolCalls.map((call) => (
							<button key={call.id} type="button" onClick={() => onSelect(`tool:${call.id}`)} className="rounded-control outline-none focus-visible:shadow-(--focus)">
								<Chip mono icon={ChevronRight} className="hover:border-(--line-strong) hover:text-(--text)">
									{call.name}
								</Chip>
							</button>
						))}
					</div>
				) : null}
				{!span.output.text && !span.output.thinking && !span.output.toolCalls.length ? <EmptyLine className="p-0">No output</EmptyLine> : null}
			</Section>
		</>
	);
}

function ToolDetail({ span, trace, onSelect }: { span: ToolSpan; trace: Trace; onSelect: (key: string) => void }) {
	const caller = trace.spans.find((other): other is ModelSpan => other.kind === 'model' && other.output.toolCalls.some((call) => call.id === span.id));
	return (
		<>
			<Facts
				items={[
					{ label: 'Duration', value: seconds(span.durationMs) },
					{ label: 'Started', value: `+${seconds(span.start)}` },
					{ label: 'Output', value: `~${tokens(Math.ceil(span.outputChars / 4))} tok` },
				]}
			/>
			<div className="flex flex-wrap items-center gap-1.5">
				<Chip mono>{span.tool}</Chip>
				{caller ? (
					<button type="button" onClick={() => onSelect(`model:${caller.id}`)} className="rounded-control outline-none focus-visible:shadow-(--focus)">
						<Chip icon={Sparkles} className="hover:border-(--line-strong) hover:text-(--text)">
							Called by model call {callNumber(trace, caller)}
						</Chip>
					</button>
				) : null}
			</div>
			<Section title="Input">
				<Pre text={span.input} tall />
			</Section>
			<Section title="Output" hint={span.outputChars > span.output.length ? `first ${span.output.length.toLocaleString()} of ${span.outputChars.toLocaleString()} chars` : `${span.outputChars.toLocaleString()} chars`}>
				<Pre text={span.output} tall />
			</Section>
		</>
	);
}

function AgentDetail({ span, trace, names }: { span: AgentSpan; trace: Trace; names: ModelNames }) {
	const stats = traceStats(trace, span.id);
	const model = trace.spans.find((other): other is ModelSpan => other.kind === 'model' && other.lane === span.id)?.model ?? null;
	return (
		<>
			<Facts
				items={[
					{ label: 'Duration', value: seconds(span.durationMs) },
					{ label: 'Started', value: `+${seconds(span.start)}` },
					{ label: 'Cost', value: dollars(stats.cost) },
					{ label: 'Model calls', value: stats.modelCalls },
					{ label: 'Tool calls', value: stats.toolCalls },
					{ label: 'Cache', value: stats.input ? `${Math.round(stats.hit * 100)}%` : '—' },
				]}
			/>
			{model ? (
				<div className="flex flex-wrap items-center gap-1.5">
					<ModelLogo model={model} size={18} />
					<span className="text-small text-(--text-2)">{names.name(model)}</span>
					<Chip>
						<Provider gateway={gatewayOf(model)} size={11} />
					</Chip>
					<Chip mono>{tokens(stats.input + stats.output)} tokens</Chip>
				</div>
			) : null}
			<Section title="Brief">
				<Pre text={span.prompt} tall />
			</Section>
			<Section title="Answer">
				<Pre text={span.result} tall />
			</Section>
		</>
	);
}

function CompactionDetail({ span }: { span: CompactionSpan }) {
	return (
		<>
			<Facts
				items={[
					{ label: 'Duration', value: seconds(span.durationMs) },
					{ label: 'Started', value: `+${seconds(span.start)}` },
					{ label: 'Before', value: span.tokensBefore ? `${tokens(span.tokensBefore)} tok` : '—' },
				]}
			/>
			<p className="m-0 text-small leading-[18px] text-(--text-2)">
				The conversation{span.reason ? ` reached its ${span.reason === 'threshold' ? 'compaction point' : span.reason}` : ' was compacted'}: older turns were summarized
				{span.messagesBefore !== null && span.messagesAfter !== null ? `, from ${span.messagesBefore} messages to ${span.messagesAfter}` : ''}. The calls after it start a fresh cache.
			</p>
		</>
	);
}

function ReplyDetail({ trace, names, onSelect }: { trace: Trace; names: ModelNames; onSelect: (key: string) => void }) {
	const stats = traceStats(trace);
	const used = modelsUsed(trace);
	const changes = modelChanges(trace);
	const lanes = ['main', ...trace.spans.filter((span): span is AgentSpan => span.kind === 'agent').map((span) => span.id)];
	const calls = trace.spans.filter((span): span is ModelSpan => span.kind === 'model');
	return (
		<>
			<Facts
				items={[
					{ label: 'Duration', value: seconds(stats.durationMs) },
					{ label: 'Cost', value: dollars(stats.cost) },
					{ label: 'Cache', value: stats.input ? `${Math.round(stats.hit * 100)}%` : '—' },
				]}
			/>
			<Section title="Models" hint={changes.length ? `changed ${changes.length} time${changes.length === 1 ? '' : 's'}` : undefined}>
				{used.map((use) => (
					<div key={use.model} className="flex items-center gap-2.5 text-small">
						<ModelLogo model={use.model} size={20} />
						<div className="flex min-w-0 flex-1 flex-col">
							<span className="truncate text-(--text)">{names.name(use.model)}</span>
							<span className="flex min-w-0 items-center gap-1 text-micro text-(--text-3)">
								<Provider gateway={use.gateway} size={11} />
								{use.served.length ? <span className="in-num truncate text-(--text-4)">· {use.served.map(shortModel).join(', ')}</span> : null}
							</span>
						</div>
						<span className="in-num text-right text-micro text-(--text-3)">
							{use.calls} call{use.calls === 1 ? '' : 's'}
							<br />
							{tokens(use.tokens)} · {dollars(use.cost)}
						</span>
					</div>
				))}
				{changes.map((change) => (
					<button
						key={change.span}
						type="button"
						onClick={() => onSelect(`model:${change.span}`)}
						className="flex items-center gap-1.5 rounded-control px-1 py-0.5 text-left text-small text-(--warn) outline-none hover:bg-(--bg-hover) focus-visible:shadow-(--focus)"
					>
						<Icon icon={ArrowLeftRight} size={11} />
						<span className="min-w-0 truncate">
							+{seconds(change.at)}: {names.short(change.from)} → {names.short(change.to)}
						</span>
					</button>
				))}
			</Section>
			<Section title="Input per call" hint="cached · uncached">
				<div className="flex h-16 items-end gap-[3px]" role="img" aria-label="Each model call's input, cached and not">
					{calls.map((call) => {
						const share = call.usage ? cacheShare(call.usage) : null;
						const top = Math.max(1, ...calls.map((other) => (other.usage ? cacheShare(other.usage).total : 0)));
						return (
							<button
								key={call.id}
								type="button"
								title={`Call ${callNumber(trace, call)}: ${share ? `${tokens(share.total)} in, ${Math.round(share.hit * 100)}% cached` : 'no usage'}`}
								onClick={() => onSelect(`model:${call.id}`)}
								className="flex min-w-[4px] flex-1 flex-col justify-end overflow-hidden rounded-mark outline-none hover:opacity-80 focus-visible:shadow-(--focus)"
								style={{ height: `${share ? Math.max(6, (share.total / top) * 100) : 6}%` }}
							>
								<span className="w-full bg-(--text-4)" style={{ flexGrow: share ? share.fresh + share.write : 1 }} />
								<span className="w-full bg-(--ok)" style={{ flexGrow: share?.read ?? 0 }} />
							</button>
						);
					})}
				</div>
			</Section>
			<Section title="By conversation">
				<table className="w-full border-collapse text-small">
					<thead>
						<tr className="in-caption text-left">
							<th className="pb-1 font-medium">Who</th>
							<th className="pb-1 text-right font-medium">Calls</th>
							<th className="pb-1 text-right font-medium">Tokens</th>
							<th className="pb-1 text-right font-medium">Cache</th>
						</tr>
					</thead>
					<tbody>
						{lanes.map((lane) => {
							const part = traceStats(trace, lane);
							const agent = trace.spans.find((span): span is AgentSpan => span.kind === 'agent' && span.id === lane);
							return (
								<tr key={lane} className="border-t border-(--line)">
									<td className="max-w-[150px] truncate py-1.5 text-(--text-2)">{agent ? `${lookOf(agent.agent).label} · ${titleOf(agent.prompt, agent.description ?? undefined)}` : 'Anton'}</td>
									<td className="in-num py-1.5 pl-3 text-right text-(--text-3)">{part.modelCalls}</td>
									<td className="in-num py-1.5 pl-3 text-right text-(--text)">{tokens(part.input + part.output)}</td>
									<td className="in-num py-1.5 pl-3 text-right text-(--text)">{part.input ? `${Math.round(part.hit * 100)}%` : '—'}</td>
								</tr>
							);
						})}
					</tbody>
				</table>
			</Section>
			<p className="m-0 text-small leading-4 text-(--text-3)">
				Every call sends the whole conversation again, so input adds up fast; a provider's cache reads the unchanged start of it at a lower price. Pick a model call to see what it held and why its cache hit or missed.
			</p>
		</>
	);
}

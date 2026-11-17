import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, CircleAlert, CornerDownRight } from '@/lib/icons';
import { memo, useContext, useId, useState } from 'react';
import { Disclosure } from '@/components/kit/disclosure';
import { describeTool, field, toolTone } from '@/components/thread/tool-describe';
import { toolServerMark, useBrands, useMcpServers } from '@/components/marks/brand-marks';
import { DeletedArtifact } from '@/components/content/output-viewer';
import { Icon, Spinner } from '@/components/kit/signal';
import { type ScriptCall } from '@/lib/api/sessions';
import { outputUrl } from '@/lib/api/outputs';
import { elapsed } from '@/lib/format';
import { cn } from '@/lib/utils';
import { openViewer } from '@/lib/viewer';
import { useDeletedOutput } from '@/lib/deleted-outputs';
import { taskQueries } from '@/lib/task-queries';
import { changedPaths, outputText, type ReasoningPart, sameItems, screenshotPath, type Step, type ToolPart } from '@/components/thread/blocks';
import { SessionId } from '@/components/thread/session-context';
import { NowLabel } from '@/components/thread/waiting';

/* Every streamed chunk gives only the reply being written a new object; the pieces below are memoized on those objects, so a chunk re-renders the reply it lands in and not the whole conversation. */

const ThoughtRow = memo(function ThoughtRow({ part }: { part: ReasoningPart }) {
	const [open, setOpen] = useState(false);
	const words = part.text.trim().split(/\s+/).filter(Boolean).length;
	return (
		<>
			<button type="button" aria-expanded={open} onClick={() => setOpen((current) => !current)} className="flex h-[26px] min-w-0 items-center gap-2 rounded-control px-2 text-left outline-none hover:bg-(--bg-hover) focus-visible:shadow-(--focus)">
				<span className={NODE}>
					<Icon icon={open ? ChevronDown : ChevronRight} size={13} className="text-(--text-3)" />
				</span>
				<span className="text-body whitespace-nowrap text-(--text-3)">
					{part.state === 'streaming' ? 'Thinking…' : `Thought${words ? ` · ${words} words` : ''}`}
				</span>
			</button>
			{open && part.text.trim() ? (
				<div className="mt-0.5 mr-2 mb-1.5 ml-[30px] text-small leading-[18px] whitespace-pre-wrap text-pretty text-(--text-3)">{part.text.trim()}</div>
			) : null}
		</>
	);
});

function scriptText(input: unknown): string {
	const file = field(input, 'file');
	if (!file) return field(input, 'code').trim();
	const args = (input as { args?: unknown } | null)?.args;
	return args && Object.keys(args).length ? `${file}\nargs ${JSON.stringify(args)}` : file;
}

/** Read from Anton, as the runtime only has the program and its result; live while it runs. */
function useScriptCalls(sessionId: string, toolCallId: string, enabled: boolean): ScriptCall[] {
	const { data } = useQuery({ ...taskQueries.scripts(sessionId), enabled: enabled && Boolean(sessionId) });
	return data?.scripts[toolCallId] ?? [];
}

function ScriptCalls({ calls }: { calls: ScriptCall[] }) {
	const mcp = calls.some((call) => call.tool.startsWith('mcp__'));
	const servers = useMcpServers(mcp);
	const brands = useBrands(mcp);
	return (
		<ul className="flex min-w-0 flex-col gap-0.5 pt-1 pr-1 pl-6">
			{calls.map((call, index) => (
				<li key={index} className="flex min-w-0 items-center gap-1.5 text-small leading-[18px] text-(--text-3)">
					{call.state === 'running' ? (
						<Spinner size={10} />
					) : (
						<Icon
							icon={call.state === 'failed' ? CircleAlert : (toolServerMark(call.tool, servers, brands)?.icon ?? CornerDownRight)}
							size={10}
							className={call.state === 'failed' ? 'shrink-0 text-(--bad)' : 'shrink-0 text-(--text-4)'}
						/>
					)}
					<span className={cn('shrink-0', call.state === 'failed' ? 'text-(--bad)' : 'text-(--text-2)')}>{call.tool.replace(/^mcp__/, '').replace('__', ' · ')}</span>
					<span className="min-w-0 flex-1 truncate" title={call.input}>
						{call.input}
					</span>
					{call.durationMs !== null ? (
						<span className="in-num shrink-0 text-micro text-(--text-4)">{call.durationMs < 1000 ? `${call.durationMs}ms` : elapsed(call.durationMs)}</span>
					) : null}
				</li>
			))}
		</ul>
	);
}

const ToolRow = memo(function ToolRow({ part }: { part: ToolPart }) {
	const described = describeTool(part);
	const { body } = described;
	// A server's tool given to the agent directly shows the server's mark.
	const mcp = part.toolName.startsWith('mcp__');
	const servers = useMcpServers(mcp);
	const brands = useBrands(mcp);
	const icon = (mcp ? toolServerMark(part.toolName, servers, brands)?.icon : null) ?? described.icon;
	const failed = part.state === 'output-error';
	const script = part.toolName === 'run_script';
	const expandable = script || part.toolName === 'bash';
	const running = part.state === 'input-available';
	const [open, setOpen] = useState(running);
	// Opens as it starts and closes as it ends, set while drawing rather than one render later from an effect.
	const [wasRunning, setWasRunning] = useState(running);
	if (wasRunning !== running) {
		setWasRunning(running);
		setOpen(running);
	}
	const detailsId = useId();
	const output = (part.toolName === 'bash' || script) && part.state === 'output-available' ? outputText(part.output).trimEnd() : '';
	const command = script ? scriptText(part.input) : `$ ${field(part.input, 'command')}`;
	const sessionId = useContext(SessionId);
	const calls = useScriptCalls(sessionId, part.toolCallId, script);
	const image = part.toolName === 'screenshot' || part.toolName === 'browser' ? screenshotPath(part) : '';
	const imageDeleted = useDeletedOutput(image ? sessionId : null, image);
	const heading = (
		<>
			<span className={cn(NODE, 'relative')}>
				<span
					className={
						expandable
							? 'inline-flex transition-opacity duration-(--t-fast) group-hover/trace:opacity-0 group-focus-visible/trace:opacity-0'
							: 'inline-flex'
					}
				>
					{running ? (
						<Spinner size={13} />
					) : (
						<Icon icon={failed ? CircleAlert : icon} size={14} className={failed ? 'text-(--bad)' : 'text-(--text-3)'} />
					)}
				</span>
				{expandable ? (
					<Icon
						icon={ChevronRight}
						size={14}
						className="absolute inset-0 text-(--text-3) opacity-0 transition-[opacity,transform] duration-(--t) ease-(--ease) group-hover/trace:opacity-100 group-focus-visible/trace:opacity-100"
						style={{ transform: open ? 'rotate(90deg)' : 'rotate(0)' }}
					/>
				) : null}
			</span>
			<span className="min-w-0 flex-1 truncate">{body}</span>
			{script && calls.length ? (
				<span className="in-num shrink-0 text-micro text-(--text-4)">
					{calls.length} {calls.length === 1 ? 'call' : 'calls'}
				</span>
			) : null}
		</>
	);
	const details = (
		<>
			{script && calls.length ? <ScriptCalls calls={calls} /> : null}
			{failed ? <div className="mr-2 mb-1 ml-[30px] text-small leading-[18px] text-(--bad)">{part.errorText}</div> : null}
			{image && imageDeleted ? (
				<DeletedArtifact path={image} className="mr-2 mb-1 ml-[30px]" />
			) : image ? (
				<button
					type="button"
					title={`Open ${image}`}
					onClick={() => openViewer({ sessionId, path: image }, [], sessionId)}
					className="mr-2 mb-1 ml-[30px] block w-fit cursor-zoom-in rounded-control outline-none focus-visible:shadow-(--focus)"
				>
					<img src={outputUrl(sessionId, image)} alt={image} className="block max-h-48 max-w-full rounded-control border border-(--line)" />
				</button>
			) : null}
			{output || (expandable && command) ? (
				<div className="pt-1 pr-2 pb-1 pl-[30px]">
					<div className="max-h-56 overflow-auto rounded-control bg-(--bg-surface) px-3 py-2.5 font-mono text-small leading-[19px] whitespace-pre text-(--text-2) shadow-[inset_0_0_0_1px_var(--line)]">
						{`${command}${output ? `${script ? '\n\n// Result' : ''}\n${output.split('\n').slice(-40).join('\n')}` : ''}`}
					</div>
				</div>
			) : null}
		</>
	);
	return (
		<>
			{expandable ? (
				<button
					type="button"
					aria-expanded={open}
					aria-controls={detailsId}
					onClick={() => setOpen((current) => !current)}
					className="group/trace flex h-[26px] min-w-0 items-center gap-2 rounded-control px-2 text-left text-body text-(--text-2) hover:bg-(--bg-hover) outline-none focus-visible:shadow-(--focus)"
				>
					{heading}
				</button>
			) : (
				<div className="flex h-[26px] min-w-0 items-center gap-2 px-2 text-body text-(--text-2)">{heading}</div>
			)}
			{expandable ? (
				<Disclosure open={open} id={detailsId}>
					{details}
				</Disclosure>
			) : (
				details
			)}
		</>
	);
});

function stepTone(step: Step): string {
	return step.type === 'reasoning' ? 'var(--track)' : toolTone(step.toolName, step.state === 'output-error');
}

/** Steps shown in a card's strip; a long turn shows its latest. */
const STRIP = 36;

function StepStrip({ steps, live }: { steps: Step[]; live: boolean }) {
	const shown = steps.slice(-STRIP);
	return (
		<span aria-hidden className="hidden h-3.5 shrink-0 items-end gap-[2px] sm:flex">
			{shown.map((step, index) => {
				const running = live && index === shown.length - 1;
				return (
					<span
						key={index}
						className={cn('w-[3px] rounded-mark', running && 'in-pulse')}
						style={{ height: step.type === 'reasoning' ? 7 : 14, background: running ? 'var(--accent)' : stepTone(step), opacity: running ? 1 : 0.85 }}
					/>
				);
			})}
		</span>
	);
}

const NODE = 'inline-flex size-3.5 shrink-0 items-center justify-center';

function StepsCardView({ steps, live, duration }: { steps: Step[]; live: boolean; duration?: number }) {
	const [open, setOpen] = useState(live);
	// Open while the reply works and closed once it is done, set while drawing rather than one render later from an effect.
	const [wasLive, setWasLive] = useState(live);
	if (wasLive !== live) {
		setWasLive(live);
		setOpen(live);
	}
	const detailsId = useId();
	const edits = changedPaths(steps);
	const label = duration !== undefined && Number.isFinite(duration) && duration >= 1000 ? `Worked for ${elapsed(duration)}` : 'Worked';
	return (
		<div className="flex flex-col">
			<button
				type="button"
				aria-expanded={open}
				aria-controls={detailsId}
				onClick={() => setOpen((current) => !current)}
				className="group/steps -mx-2 flex h-7 w-[calc(100%+16px)] items-center gap-2 rounded-control px-2 text-left outline-none hover:bg-(--bg-hover) focus-visible:shadow-(--focus)"
			>
				{/* One mark: the spinner while it works, which gives way to the chevron under the pointer; the chevron alone once done. */}
				<span className="inline-flex size-3.5 shrink-0 items-center justify-center">
					{live ? (
						<span className="inline-flex group-hover/steps:hidden group-focus-visible/steps:hidden">
							<Spinner size={13} />
						</span>
					) : null}
					<Icon
						icon={ChevronDown}
						size={13}
						className={cn(
							'text-(--text-3) transition-transform duration-(--t) ease-(--ease)',
							live && 'hidden group-hover/steps:block group-focus-visible/steps:block',
						)}
						style={{ transform: open ? 'rotate(0)' : 'rotate(-90deg)' }}
					/>
				</span>
				{live ? <NowLabel /> : <div className="min-w-0 flex-auto truncate text-body font-medium text-(--text-2)">{label}</div>}
				{edits.length ? <span className="hidden min-w-0 max-w-[45%] truncate text-small text-(--text-3) sm:inline" title={edits.join(', ')}>{edits.map((path) => path.split('/').pop()).join(', ')}</span> : null}
				<StepStrip steps={steps} live={live} />
				<div className="in-num shrink-0 text-small whitespace-nowrap text-(--text-4)">
					{steps.length} {steps.length === 1 ? 'step' : 'steps'}
				</div>
			</button>
			<Disclosure open={open} id={detailsId}>
				<div className="mt-0.5 ml-1.5 flex flex-col border-l border-(--line) pl-1.5">
					{steps.map((step, index) => (step.type === 'reasoning' ? <ThoughtRow key={index} part={step} /> : <ToolRow key={step.toolCallId} part={step} />))}
				</div>
			</Disclosure>
		</div>
	);
}

/** Its steps list is rebuilt each render; the card re-renders only when a step in it changed. */
export const StepsCard = memo(StepsCardView, (prev, next) => prev.live === next.live && prev.duration === next.duration && sameItems(prev.steps, next.steps));

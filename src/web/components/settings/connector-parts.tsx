import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Check, Copy, ExternalLink, X } from '@/lib/icons';
import { type ReactNode, useState } from 'react';
import { type Mark, MarkTile } from '@/components/marks/brand-marks';
import { Status } from '@/components/kit/instrument';
import { Icon, IconBtn, Switch } from '@/components/kit/signal';
import { api } from '@/lib/api';
import type { ConnectorsView } from '@/lib/api/connectors';
import { type ConnectorItem, type ConnectorState, setConnectorOn } from '@/lib/connectors';
import { cn } from '@/lib/utils';
import { FIELD } from './parts';

export function useConnectors() {
	return useQuery({ queryKey: ['connectors'], queryFn: api.connectors });
}

export function useConnectorMutation<T>(run: (input: T) => Promise<Partial<ConnectorsView>>) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: run,
		onSuccess: (next) => queryClient.setQueryData<ConnectorsView>(['connectors'], (current) => (current ? { ...current, ...next } : current)),
	});
}

export function ErrorLine({ error }: { error: Error | null }) {
	return error ? <span className="text-small text-(--bad)">{error.message}</span> : null;
}

export function CopyField({ value, label }: { value: string; label: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<div className="flex min-w-0 items-center gap-1.5">
			<input readOnly value={value} aria-label={label} className={cn(FIELD, 'flex-1 font-mono text-small text-(--text-2)')} onFocus={(event) => event.target.select()} />
			<IconBtn
				icon={copied ? Check : Copy}
				size="sm"
				label={`Copy ${label.toLowerCase()}`}
				onClick={() => {
					void navigator.clipboard?.writeText(value).then(() => {
						setCopied(true);
						setTimeout(() => setCopied(false), 1500);
					});
				}}
			/>
		</div>
	);
}

export function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
	return (
		<li className="flex gap-3">
			<span className="in-num mt-px inline-flex size-5 shrink-0 items-center justify-center rounded-control border border-(--line-strong) text-micro text-(--text-3)">{n}</span>
			<div className="flex min-w-0 flex-1 flex-col gap-1.5">
				<div className="text-body font-medium text-(--text)">{title}</div>
				<div className="flex flex-col gap-1.5 text-small leading-[18px] text-pretty text-(--text-3)">{children}</div>
			</div>
		</li>
	);
}

export const ConsoleLink = ({ href, children }: { href: string; children: ReactNode }) => (
	<a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-(--accent-text) hover:underline">
		{children}
		<Icon icon={ExternalLink} size={11} />
	</a>
);

export function ToolChips({ tools }: { tools: Array<{ name: string; about: string }> }) {
	return (
		<ul className="m-0 grid list-none grid-cols-1 gap-1.5 p-0 sm:grid-cols-2">
			{tools.map((tool) => (
				<li key={tool.name} className="min-w-0" title={tool.about || undefined}>
					<span className="inline-flex max-w-full items-center rounded-control border border-(--line) bg-(--bg-raised) px-2 py-1 text-small text-(--text-2)">
						<span className="truncate">{tool.name}</span>
					</span>
				</li>
			))}
		</ul>
	);
}

export function StateBadge({ state }: { state: ConnectorState }) {
	if (state === 'needs-sign-in') return <Status tone="danger">Needs sign-in</Status>;
	return state === 'on' ? <Status tone="success">On</Status> : <Status tone="neutral">Off</Status>;
}

export function OnSwitch({ item, label }: { item: ConnectorItem; label?: ReactNode }) {
	const queryClient = useQueryClient();
	const [problem, setProblem] = useState<string | null>(null);
	return (
		<>
			{problem ? <span className="text-small text-(--bad)">{problem}</span> : null}
			<Switch
				checked={item.state !== 'off'}
				onChange={(on) => {
					setProblem(null);
					setConnectorOn(queryClient, item, on).catch((error: unknown) => setProblem(error instanceof Error ? error.message : String(error)));
				}}
				label={label ?? <span className="sr-only">Use {item.name} in tasks</span>}
			/>
		</>
	);
}

export type Opened = { c?: string; add?: string; connected?: string; problem?: string };

export const hostOf = (url: string) => (URL.canParse(url) ? new URL(url).hostname : url);

export function Returned({ search }: { search: Opened }) {
	const navigate = useNavigate();
	if (!search.connected && !search.problem) return null;
	const dismiss = () =>
		search.c || search.add
			? void navigate({ to: '/settings/connectors/view', search: { c: search.c, add: search.add }, replace: true })
			: void navigate({ to: '/settings/$section', params: { section: 'connectors' }, search: {}, replace: true });
	return (
		<div
			role="status"
			className={cn(
				'flex items-center gap-3 rounded-control border px-3.5 py-2.5 text-body',
				search.problem ? 'border-(--bad-line) text-(--bad)' : 'border-(--ok-line) text-(--ok)',
			)}
		>
			<span className="min-w-0 flex-1">{search.problem ? `Not connected: ${search.problem}` : 'Connected. Turn it on or off for tasks here or from the + menu in any composer.'}</span>
			<IconBtn icon={X} size="sm" label="Dismiss" onClick={dismiss} />
		</div>
	);
}

export type Fact = { label: string; value: ReactNode };

export function DetailFrame({ mark, title, mono, tagline, actions, facts, children }: { mark: Mark; title: string; mono?: boolean; tagline: string; actions?: ReactNode; facts: Fact[]; children: ReactNode }) {
	return (
		<div className="flex flex-col gap-5">
			<div className="flex flex-wrap items-center gap-4 border-b border-(--line) pb-5">
				<MarkTile mark={mark} size={64} label={mark.title} className="rounded-control" />
				<div className="flex min-w-0 flex-1 basis-[240px] flex-col gap-1">
					<h1 className={cn('m-0 truncate text-h1 leading-[32px] font-semibold tracking-[-0.02em]', mono && 'text-h1')}>{title}</h1>
					<p className="m-0 text-body leading-[19px] text-pretty text-(--text-3)">{tagline}</p>
				</div>
				{actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
			</div>
			<div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_220px]">
				<div className="flex min-w-0 flex-col gap-6">{children}</div>
				<dl className="m-0 flex flex-col gap-4 lg:border-l lg:border-(--line) lg:pl-6">
					{facts.map((fact) => (
						<div key={fact.label} className="flex min-w-0 flex-col gap-1">
							<dt className="in-caption text-(--text-4)">{fact.label}</dt>
							<dd className="m-0 min-w-0 text-body leading-[18px] break-words text-(--text-2)">{fact.value}</dd>
						</div>
					))}
				</dl>
			</div>
		</div>
	);
}

export function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
	return (
		<section className="flex flex-col gap-2.5">
			<div className="flex items-center gap-2">
				<h2 className="m-0 flex-1 text-h3 font-semibold">{title}</h2>
				{aside}
			</div>
			{children}
		</section>
	);
}

export const Prose = ({ children }: { children: ReactNode }) => <p className="m-0 max-w-[68ch] text-body leading-[21px] text-pretty text-(--text-2)">{children}</p>;

export const DocsLink = ({ href }: { href: string }) => <ConsoleLink href={href}>Documentation</ConsoleLink>;

export const since = (at: string | null) => (at ? new Date(at).toLocaleDateString(undefined, { month: 'long', year: 'numeric', day: 'numeric' }) : '—');

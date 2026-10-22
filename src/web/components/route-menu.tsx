import { useQuery } from '@tanstack/react-query';
import { ArrowDownWideNarrow, CircleDollarSign, Gauge, type LucideIcon, Server, Timer } from 'lucide-react';
import { Icon, Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger, Spinner } from '@/components/signal';
import { api, type ModelEndpoint, type ModelInfo, type ModelRoute, type RouteSort } from '@/lib/api';
import { dollars, sourceOf, tokens, vendorHue } from '@/lib/model-catalog';
import { hostLogo } from '@/lib/provider-logos';
import { cn } from '@/lib/utils';

/** The sorts a gateway ranks a model's providers by, each with what it puts first. */
export const ROUTE_SORT: Record<RouteSort, { label: string; hint: string; icon: LucideIcon }> = {
	price: { label: 'Price', hint: 'cheapest first', icon: CircleDollarSign },
	throughput: { label: 'Throughput', hint: 'fastest output first', icon: Gauge },
	latency: { label: 'Latency', hint: 'quickest first token first', icon: Timer },
};

/** What a route says, in a few words, for the chip's tooltip and the menu's heading. */
export function routeLabel(route: ModelRoute | null, endpoints: ModelEndpoint[] = []): string {
	if (!route) return 'Default routing';
	if (route.provider) return `Prefers ${endpoints.find((endpoint) => endpoint.slug === route.provider)?.name ?? route.provider}`;
	return `Sorted by ${ROUTE_SORT[route.sort!].label.toLowerCase()}`;
}

/** A hosting provider on a small tile: its logo when the set has one, else two letters in its hue. */
export function HostMark({ slug, name, size = 14 }: { slug: string; name: string; size?: number }) {
	const logo = hostLogo(slug);
	const hue = vendorHue(name);
	return (
		<span
			aria-hidden
			className="inline-flex shrink-0 items-center justify-center rounded-[4px] font-mono font-semibold uppercase"
			style={
				logo
					? { width: size, height: size, fontSize: Math.round(size * 0.72), background: 'var(--alpha-white-6)', boxShadow: 'inset 0 0 0 1px var(--border-subtle)' }
					: { width: size, height: size, fontSize: size * 0.45, color: hue, background: `${hue}1f`, boxShadow: `inset 0 0 0 1px ${hue}33` }
			}
		>
			{logo ? <span className="flex text-(--text-primary)" dangerouslySetInnerHTML={{ __html: logo }} /> : name.replace(/[^a-z0-9]/gi, '').slice(0, 2)}
		</span>
	);
}

/** One provider's line: its mark and name, then its price per million tokens and, where known, its speed. */
function ProviderLine({ endpoint }: { endpoint: ModelEndpoint }) {
	const speed = endpoint.throughput ? `${Math.round(endpoint.throughput)} tok/s` : endpoint.latency ? `${endpoint.latency.toFixed(1)}s` : null;
	return (
		<span className="flex min-w-0 flex-1 items-center gap-2">
			<HostMark slug={endpoint.slug} name={endpoint.name} />
			<span className="min-w-0 flex-1 truncate">{endpoint.name}</span>
			<span className="in-num shrink-0 text-[10.5px] text-(--text-tertiary)">
				{dollars(endpoint.price.input)}/{dollars(endpoint.price.output)}
				{speed ? ` · ${speed}` : ''}
			</span>
		</span>
	);
}

/** The routing buttons: as small as the pin beside them, lit once one is set. */
const CONTROL =
	'inline-flex size-5 shrink-0 items-center justify-center rounded-[5px] text-(--icon-tertiary) outline-none hover:bg-(--alpha-white-6) hover:text-(--icon-secondary) focus-visible:shadow-(--focus-ring) data-[state=open]:bg-(--alpha-white-6)';

/** The providers the gateway lists for the model, shared by the menu and the mark on the picker's button. */
function useEndpoints(model: ModelInfo) {
	return useQuery({ queryKey: ['model-endpoints', model.id], queryFn: () => api.modelEndpoints(model.id), staleTime: 10 * 60_000 });
}

type RouteProps = { route: ModelRoute | null; onChange: (route: ModelRoute | null) => void };

/**
 * Where the gateway sends this task's calls, as two icon menus beside the
 * chosen model's pin in the picker: a provider to try first, and a sort over
 * all of them. They exclude each other, so once one is set only its icon
 * stays: the provider's mark, or the sort's icon. The gateway falls back to
 * its own routing when the provider fails, so a route never stops a call that
 * would otherwise work.
 */
export function RouteControls({ model, route, onChange }: RouteProps & { model: ModelInfo }) {
	return (
		// Clicks in the menus reach the row through React's tree; they are not a pick.
		<span className="flex shrink-0 items-center" onClick={(event) => event.stopPropagation()}>
			{route?.sort ? null : <ProviderMenu model={model} route={route} onChange={onChange} />}
			{route?.provider ? null : <SortMenu route={route} onChange={onChange} />}
		</span>
	);
}

function ProviderMenu({ model, route, onChange }: RouteProps & { model: ModelInfo }) {
	const endpoints = useEndpoints(model);
	const listed = endpoints.data?.endpoints ?? [];
	const chosen = route?.provider ? listed.find((endpoint) => endpoint.slug === route.provider) : undefined;
	return (
		<Menu>
			<MenuTrigger asChild>
				<button
					type="button"
					aria-label={`Provider: ${route?.provider ? (chosen?.name ?? route.provider) : 'any'}`}
					title={route?.provider ? `${routeLabel(route, listed)}, then ${sourceOf(model)}'s default` : 'Try a provider first'}
					className={cn(CONTROL, route?.provider && 'text-(--accent-text)')}
				>
					{route?.provider ? <HostMark slug={route.provider} name={chosen?.name ?? route.provider} size={14} /> : <Icon icon={Server} size={11} />}
				</button>
			</MenuTrigger>
			<MenuContent align="start" collisionPadding={8} className="max-h-[min(380px,var(--radix-dropdown-menu-content-available-height))] w-[min(300px,calc(100vw-24px))] overflow-y-auto">
				<MenuItem checked={!route?.provider} onSelect={() => onChange(null)}>
					Any provider
				</MenuItem>
				<p className="m-0 px-2 pt-0.5 pb-1.5 text-[11px] leading-[15px] text-(--text-tertiary)">
					For this task only. If the provider you pick fails, {sourceOf(model)} falls back to its default routing.
				</p>
				<MenuSeparator />
				<div className="flex items-center justify-between pr-2">
					<MenuLabel>Try first</MenuLabel>
					<span className="in-caption text-(--text-disabled)" title="US dollars per million input / output tokens">
						in/out
					</span>
				</div>
				{endpoints.isPending ? (
					<div className="flex h-8 items-center gap-2 px-2 text-[12px] text-(--text-tertiary)">
						<Spinner size={11} /> Loading providers
					</div>
				) : endpoints.isError ? (
					<div className="px-2 py-1.5 text-[12px] text-(--danger-text)">Could not load providers: {endpoints.error.message}</div>
				) : listed.length === 0 ? (
					<div className="px-2 py-1.5 text-[12px] text-(--text-tertiary)">{sourceOf(model)} lists no providers for this model.</div>
				) : (
					listed.map((endpoint) => (
						<MenuItem
							key={endpoint.slug}
							checked={route?.provider === endpoint.slug}
							className="[&_.sg-menu-item__label]:flex [&_.sg-menu-item__label]:min-w-0 [&_.sg-menu-item__label]:flex-1"
							title={[
								endpoint.name,
								`${tokens(endpoint.contextLength)} context`,
								endpoint.uptime !== null ? `${endpoint.uptime.toFixed(1)}% up recently` : null,
								endpoint.latency !== null ? `${endpoint.latency.toFixed(2)}s to first token` : null,
							]
								.filter(Boolean)
								.join(' · ')}
							onSelect={() => onChange(route?.provider === endpoint.slug ? null : { provider: endpoint.slug })}
						>
							<ProviderLine endpoint={endpoint} />
						</MenuItem>
					))
				)}
				{route?.provider && listed.length > 0 && !chosen ? (
					<div className="px-2 py-1.5 text-[11px] text-(--warning-text)">{route.provider} no longer serves this model; calls use the default routing.</div>
				) : null}
			</MenuContent>
		</Menu>
	);
}

function SortMenu({ route, onChange }: RouteProps) {
	return (
		<Menu>
			<MenuTrigger asChild>
				<button
					type="button"
					aria-label={`Sort providers: ${route?.sort ? ROUTE_SORT[route.sort].label : 'default'}`}
					title={route?.sort ? routeLabel(route) : 'Sort providers by'}
					className={cn(CONTROL, route?.sort && 'text-(--accent-text)')}
				>
					<Icon icon={route?.sort ? ROUTE_SORT[route.sort].icon : ArrowDownWideNarrow} size={11} />
				</button>
			</MenuTrigger>
			<MenuContent align="start" collisionPadding={8} className="w-[min(260px,calc(100vw-24px))]">
				<MenuLabel>Sort providers by</MenuLabel>
				<MenuItem checked={!route?.sort} hint="gateway's pick" onSelect={() => onChange(null)}>
					Default
				</MenuItem>
				{(Object.keys(ROUTE_SORT) as RouteSort[]).map((sort) => (
					<MenuItem key={sort} icon={ROUTE_SORT[sort].icon} checked={route?.sort === sort} hint={ROUTE_SORT[sort].hint} onSelect={() => onChange(route?.sort === sort ? null : { sort })}>
						{ROUTE_SORT[sort].label}
					</MenuItem>
				))}
				<p className="m-0 px-2 pt-1 pb-1.5 text-[11px] leading-[15px] text-(--text-tertiary)">For this task only.</p>
			</MenuContent>
		</Menu>
	);
}

/** The route on the picker's own button, so it shows with the panel closed: the provider's mark or the sort's icon. */
export function RouteBadge({ model, route, size }: { model: ModelInfo; route: ModelRoute; size: number }) {
	const listed = useEndpoints(model).data?.endpoints ?? [];
	const name = route.provider ? (listed.find((endpoint) => endpoint.slug === route.provider)?.name ?? route.provider) : '';
	return (
		<span className="flex shrink-0 items-center text-(--accent-text)" title={routeLabel(route, listed)}>
			{route.provider ? <HostMark slug={route.provider} name={name} size={size} /> : <Icon icon={ROUTE_SORT[route.sort!].icon} size={11} />}
		</span>
	);
}

import { CircleAlert } from '@/lib/icons';
import { Component, type ErrorInfo, type ReactNode, Suspense } from 'react';
import { Btn, Icon, Spinner } from '@/components/kit/signal';
import { cn } from '@/lib/utils';

/** A part of the page that could not load its code, as after a release replaced the files this page was built from. */
const isChunkError = (error: unknown) =>
	error instanceof Error && /dynamically imported module|Importing a module script failed|error loading dynamically imported module|Failed to fetch/i.test(error.message);

type Props = {
	label: string;
	children: ReactNode;
	className?: string;
};

/** Keeps a failure where it happened: the part that threw shows a notice with Try again, instead of the whole app turning into the router's error page. */
export class ErrorBoundary extends Component<Props, { error: unknown }> {
	state: { error: unknown } = { error: null };

	static getDerivedStateFromError(error: unknown) {
		return { error };
	}

	componentDidCatch(error: unknown, info: ErrorInfo) {
		console.error(`${this.props.label} failed to draw`, error, info.componentStack);
	}

	render() {
		const { error } = this.state;
		if (error === null) return this.props.children;
		const stale = isChunkError(error);
		return (
			<div
				role="alert"
				className={cn(
					'flex items-start gap-2 rounded-control border border-(--bad-line) bg-(--bad-soft) px-3 py-2 text-small leading-[18px] text-(--bad)',
					this.props.className,
				)}
			>
				<Icon icon={CircleAlert} size={12} className="mt-[3px]" />
				<div className="flex min-w-0 flex-1 flex-col items-start gap-2">
					<span className="break-words">{stale ? `${this.props.label} needs the newest version of Anton.` : `${this.props.label} could not be shown.`}</span>
					<Btn size="sm" onClick={() => (stale ? window.location.reload() : this.setState({ error: null }))}>
						{stale ? 'Reload' : 'Try again'}
					</Btn>
				</div>
			</div>
		);
	}
}

export function LazyPart({ label, children, className }: Props) {
	return (
		<ErrorBoundary label={label} className={className}>
			<Suspense
				fallback={
					<div className="flex h-full min-h-16 items-center justify-center">
						<Spinner tone="neutral" />
					</div>
				}
			>
				{children}
			</Suspense>
		</ErrorBoundary>
	);
}

/** A page that failed outside the guarded parts: the app's own notice, not the router's bare one. */
export function RouteError({ error, reset }: { error: unknown; reset: () => void }) {
	const stale = isChunkError(error);
	return (
		<div role="alert" className="flex h-full min-h-0 flex-1 items-center justify-center bg-(--bg-panel) p-6">
			<div className="flex max-w-[420px] flex-col items-center gap-3 text-center">
				<Icon icon={CircleAlert} size={20} className="text-(--bad)" />
				<div className="flex flex-col gap-1">
					<span className="text-body-lg leading-[20px] font-semibold text-(--text)">{stale ? 'Anton was updated' : 'This page could not be shown'}</span>
					<span className="text-body leading-[18px] break-words text-(--text-3)">
						{stale ? 'Reload to get the newest version.' : error instanceof Error ? error.message : String(error)}
					</span>
				</div>
				<div className="flex gap-2">
					{stale ? null : (
						<Btn variant="secondary" onClick={reset}>
							Try again
						</Btn>
					)}
					<Btn variant={stale ? 'primary' : 'ghost'} onClick={() => window.location.reload()}>
						Reload
					</Btn>
				</div>
			</div>
		</div>
	);
}

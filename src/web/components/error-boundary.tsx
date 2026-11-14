import { CircleAlert } from 'lucide-react';
import { Component, type ErrorInfo, type ReactNode, Suspense } from 'react';
import { Btn, Icon, Spinner } from '@/components/signal';
import { cn } from '@/lib/utils';

/** A part of the page that could not load its code, as after a release replaced the files this page was built from. */
const isChunkError = (error: unknown) =>
	error instanceof Error && /dynamically imported module|Importing a module script failed|error loading dynamically imported module|Failed to fetch/i.test(error.message);

type Props = {
	/** What failed, as the reader knows it: "The sidebar", "This reply". */
	label: string;
	children: ReactNode;
	className?: string;
};

/**
 * Keeps a failure where it happened. A part of the page that throws while drawing shows a short
 * notice with Try again in its place, and the rest of the page keeps working, instead of the whole
 * app turning into the router's error page.
 */
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

/** A part of the page whose code loads when it is first shown: a spinner while it loads, and the notice above if it fails. */
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

import { ChevronDown, ChevronUp } from 'lucide-react';
import { type ClipboardEvent, type CSSProperties, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { DraftInput, type DraftHandle } from '@/components/draft-input';
import { IconBtn } from '@/components/signal';
import { useSuggestions } from '@/components/suggestions';
import { cn } from '@/lib/utils';

/** Lines a draft shows before it scrolls, until it is opened out. */
const LINES = 5;
/** An opened-out draft stops growing at this share of the window, and scrolls. */
const OPEN_SHARE = 0.6;
/** How long opening out or folding back takes. */
const EASE_MS = 220;

/**
 * The draft keeps to a few lines; a longer one scrolls, and a chevron opens it
 * out to its whole height (up to most of the window) or folds it back.
 * Heights come from the box's own line height and padding, so it fits every composer.
 */
function useFold(box: () => HTMLElement | null, value: string) {
	const [open, setOpen] = useState(false);
	const [heights, setHeights] = useState<{ folded: number; whole: number; long: boolean } | null>(null);
	const [easing, setEasing] = useState(false);
	const measure = useCallback(() => {
		const element = box();
		if (!element) return;
		const style = getComputedStyle(element);
		const px = (value: string) => Number.parseFloat(value) || 0;
		const folded = Math.round((px(style.lineHeight) || 22) * LINES + px(style.paddingTop) + px(style.paddingBottom));
		const whole = Math.min(element.scrollHeight, Math.round(window.innerHeight * OPEN_SHARE));
		const long = element.scrollHeight > folded + 1;
		setHeights((current) => (current?.folded === folded && current.whole === whole && current.long === long ? current : { folded, whole, long }));
	}, [box]);
	useLayoutEffect(measure, [measure, value, open]);
	useEffect(() => {
		const element = box();
		if (!element) return;
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		window.addEventListener('resize', measure);
		return () => {
			observer.disconnect();
			window.removeEventListener('resize', measure);
		};
	}, [box, measure]);
	useEffect(() => {
		if (!easing) return;
		const timer = setTimeout(() => setEasing(false), EASE_MS);
		return () => clearTimeout(timer);
	}, [easing]);
	const long = heights?.long ?? false;
	// A draft that fits again (sent, or cut back) folds, so the next long one starts folded.
	useEffect(() => {
		if (!long) setOpen(false);
	}, [long]);
	// The height eases only on a toggle, so typing never waits on it.
	const style: CSSProperties | undefined = heights
		? { maxHeight: open ? heights.whole : heights.folded, transition: easing ? `max-height ${EASE_MS}ms ease-in` : undefined }
		: undefined;
	return {
		long,
		open,
		style,
		toggle: () => {
			setEasing(true);
			setOpen((current) => !current);
		},
	};
}

/** The same rich draft, completion, caret and editing behavior in both task composers. */
export function ComposerInput({
	value,
	onChange,
	sessionId,
	projectId,
	branch,
	placeholder,
	autoFocus,
	className,
	submitOn = 'enter',
	suggestionsPosition = 'above',
	onPaste,
}: {
	value: string;
	onChange: (value: string) => void;
	sessionId?: string;
	projectId?: string;
	branch?: string;
	placeholder: string;
	autoFocus?: boolean;
	className?: string;
	submitOn?: 'enter' | 'mod-enter';
	suggestionsPosition?: 'above' | 'below';
	onPaste?: (event: ClipboardEvent<HTMLDivElement>) => void;
}) {
	const box = useRef<DraftHandle>(null);
	const wrap = useRef<HTMLDivElement>(null);
	const draft = useCallback(() => wrap.current?.querySelector<HTMLElement>('.sg-draft') ?? null, []);
	const fold = useFold(draft, value);
	const suggestions = useSuggestions({ text: value, setText: onChange, sessionId, projectId, branch, box: () => box.current, keepCommands: true });
	return (
		<>
			{suggestions.list ? (
				<div className={`absolute right-0 left-0 z-10 ${suggestionsPosition === 'above' ? 'bottom-full mb-1.5' : 'top-full mt-1.5'}`}>{suggestions.list}</div>
			) : null}
			<div ref={wrap} className="relative">
				<DraftInput
					ref={box}
					value={value}
					tokens={suggestions.tokens}
					placeholder={placeholder}
					autoFocus={autoFocus}
					className={cn(className, fold.long && 'pr-8')}
					style={fold.style}
					onChange={(next, caret) => {
						onChange(next);
						suggestions.track(caret);
					}}
					onSelect={suggestions.track}
					onPaste={onPaste}
					onKeyDown={(event) => {
						if (suggestions.onKeyDown(event)) return;
						if (event.key === 'Enter' && !event.shiftKey && (submitOn === 'enter' || event.metaKey || event.ctrlKey)) {
							event.preventDefault();
							event.currentTarget.closest('form')?.requestSubmit();
						}
					}}
				/>
				{fold.long ? (
					<IconBtn
						size="xs"
						icon={fold.open ? ChevronDown : ChevronUp}
						label={fold.open ? 'Fold the message back' : 'Show the whole message'}
						aria-expanded={fold.open}
						className="absolute top-0 right-0"
						onMouseDown={(event) => event.preventDefault()}
						onClick={fold.toggle}
					/>
				) : null}
			</div>
		</>
	);
}

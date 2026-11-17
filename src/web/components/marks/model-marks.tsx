import type { ModelInfo } from '@/lib/api/plans';
import { vendorHue } from '@/lib/model-catalog';
import { logoFor, vendorSlug } from '@/lib/provider-logos';
import { cn } from '@/lib/utils';

/** Its logo when the set has one, else two letters in the vendor's hue; a model on your plan gets a lit corner. */
export function ModelMark({ model, size = 16 }: { model: ModelInfo; size?: number }) {
	const logo = logoFor(model);
	const hue = vendorHue(model.vendor);
	return (
		<span
			aria-hidden
			title={model.vendor}
			className="relative inline-flex shrink-0 items-center justify-center rounded-control font-semibold uppercase"
			style={
				logo
					? { width: size, height: size, fontSize: Math.round(size * 0.72), background: 'var(--bg-active)', boxShadow: 'inset 0 0 0 1px var(--line)' }
					: { width: size, height: size, fontSize: size * 0.45, color: hue, background: `${hue}1f`, boxShadow: `inset 0 0 0 1px ${hue}33` }
			}
		>
			{logo ? (
				// The set's own files, sized by font size and drawn in the text colour where they have one colour.
				<span className="flex text-(--text)" dangerouslySetInnerHTML={{ __html: logo }} />
			) : (
				model.vendor.replace(/[^a-z0-9]/gi, '').slice(0, 2)
			)}
			{model.subscription ? <span className="absolute -top-[2px] -right-[2px] size-[6px] rounded-full bg-(--accent) shadow-[0_0_0_1.5px_var(--bg-overlay)]" /> : null}
		</span>
	);
}

export function ModelLogo({ model, size = 16, title }: { model: string; size?: number; title?: string }) {
	const logo = logoFor({ id: model });
	const vendor = vendorSlug({ id: model });
	const hue = vendorHue(vendor);
	return (
		<span
			aria-hidden={title ? undefined : true}
			title={title}
			className="inline-flex shrink-0 items-center justify-center rounded-control font-semibold uppercase"
			style={
				logo
					? { width: size, height: size, fontSize: Math.round(size * 0.68), background: 'var(--bg-active)', boxShadow: 'inset 0 0 0 1px var(--line)' }
					: { width: size, height: size, fontSize: size * 0.45, color: hue, background: `${hue}1f`, boxShadow: `inset 0 0 0 1px ${hue}33` }
			}
		>
			{logo ? <span className="flex text-(--text)" dangerouslySetInnerHTML={{ __html: logo }} /> : vendor.replace(/[^a-z0-9]/gi, '').slice(0, 2)}
		</span>
	);
}

export function ReasoningMeter({ strength, className }: { strength: number; className?: string }) {
	return (
		<span aria-hidden className={cn('inline-flex h-2.5 items-end gap-px', className)}>
			{[0.25, 0.5, 0.75, 1].map((step) => (
				<span
					key={step}
					className={cn('w-[2px] rounded-full', strength >= step ? 'bg-(--accent)' : 'bg-(--line-strong)')}
					style={{ height: `${30 + step * 70}%` }}
				/>
			))}
		</span>
	);
}

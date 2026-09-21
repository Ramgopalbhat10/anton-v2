import { cva, type VariantProps } from 'class-variance-authority';
import type { ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
	'inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50',
	{
		variants: {
			variant: {
				default: 'bg-primary text-primary-foreground hover:bg-primary/90',
				ghost: 'hover:bg-accent text-foreground',
				outline: 'border border-border bg-transparent hover:bg-accent',
				secondary: 'bg-muted text-foreground hover:bg-accent',
			},
			size: {
				default: 'h-8 px-3',
				sm: 'h-7 px-2 text-xs',
				icon: 'size-7',
			},
		},
		defaultVariants: { variant: 'default', size: 'default' },
	},
);

export function Button({
	className,
	variant,
	size,
	...props
}: ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants>) {
	return <button className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}

import * as React from 'react';
import { cn } from 'cn';
import { X } from 'lucide-react';
import { Dialog as DialogPrimitive } from 'radix-ui';

function Dialog({ ...props }: React.ComponentProps<typeof DialogPrimitive.Root>) {
	return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogContent({ className, children, ...props }: React.ComponentProps<typeof DialogPrimitive.Content>) {
	return (
		<DialogPrimitive.Portal>
			<DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50" />
			<DialogPrimitive.Content
				data-slot="dialog-content"
				className={cn(
					'fixed top-1/2 left-1/2 z-50 flex w-[min(100%-2rem,28rem)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border border-border bg-background shadow-lg',
					className,
				)}
				{...props}
			>
				{children}
				<DialogPrimitive.Close className="absolute top-2 right-2 rounded-lg p-1 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Close">
					<X className="size-4" />
				</DialogPrimitive.Close>
			</DialogPrimitive.Content>
		</DialogPrimitive.Portal>
	);
}

function DialogHeader({ className, ...props }: React.ComponentProps<'div'>) {
	return <div className={cn('flex flex-col gap-1 px-4 pt-4 pr-10', className)} {...props} />;
}

function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
	return <DialogPrimitive.Title className={cn('text-[13px] font-medium', className)} {...props} />;
}

function DialogDescription({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Description>) {
	return <DialogPrimitive.Description className={cn('text-[12px] text-muted-foreground', className)} {...props} />;
}

export { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle };

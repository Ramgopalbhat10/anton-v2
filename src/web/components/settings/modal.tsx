import { Dialog } from 'radix-ui';
import { lazy } from 'react';
import { LazyPart } from '@/components/error-boundary';
import { closeSettings, useSettingsHref } from '@/lib/settings-modal';

/** The settings pages, loaded the first time Settings opens (`card.tsx`). */
const SettingsCard = lazy(() => import('./card').then((module) => ({ default: module.SettingsCard })));

/** The Settings card, shown while Settings is open. */
export function SettingsModal() {
	const href = useSettingsHref();
	return (
		<Dialog.Root open={href !== null} onOpenChange={(open) => (open ? undefined : closeSettings())}>
			<Dialog.Portal>
				<Dialog.Overlay className="settings-overlay fixed inset-0 z-50" />
				<Dialog.Content
					aria-describedby={undefined}
					className="settings-card fixed inset-0 z-50 flex flex-col overflow-hidden outline-none md:inset-auto md:top-1/2 md:left-1/2 md:h-[min(820px,calc(100dvh-64px))] md:w-[min(1180px,calc(100vw-64px))] md:-translate-x-1/2 md:-translate-y-1/2"
				>
					<Dialog.Title className="sr-only">Settings</Dialog.Title>
					{href !== null ? (
						<LazyPart label="Settings" className="m-6">
							<SettingsCard href={href} />
						</LazyPart>
					) : null}
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}

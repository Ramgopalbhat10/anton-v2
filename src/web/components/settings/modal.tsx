import { Dialog } from 'radix-ui';
import { lazy, useState } from 'react';
import { LazyPart } from '@/components/kit/error-boundary';
import { FloatingLayerContainer } from '@/components/kit/signal';
import { closeSettings, useSettingsHref } from '@/lib/settings-modal';

const SettingsCard = lazy(() => import('./card').then((module) => ({ default: module.SettingsCard })));

export function SettingsModal() {
	const href = useSettingsHref();
	const [dialog, setDialog] = useState<HTMLDivElement | null>(null);
	return (
		<Dialog.Root open={href !== null} onOpenChange={(open) => (open ? undefined : closeSettings())}>
			<Dialog.Portal>
				<Dialog.Overlay className="settings-overlay fixed inset-0 z-50" />
				<Dialog.Content
					ref={setDialog}
					aria-describedby={undefined}
					className="settings-card fixed inset-0 z-50 flex flex-col overflow-hidden outline-none md:m-auto md:h-[min(820px,calc(100dvh-64px))] md:w-[min(1180px,calc(100vw-64px))]"
				>
					<FloatingLayerContainer.Provider value={dialog}>
						<Dialog.Title className="sr-only">Settings</Dialog.Title>
						{href !== null ? (
							<LazyPart label="Settings" className="m-6">
								<SettingsCard href={href} />
							</LazyPart>
						) : null}
					</FloatingLayerContainer.Provider>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}

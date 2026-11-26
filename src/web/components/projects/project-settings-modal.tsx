import { Dialog } from 'radix-ui';
import { lazy, useState } from 'react';
import { LazyPart } from '@/components/kit/error-boundary';
import { FloatingLayerContainer } from '@/components/kit/signal';
import { closeProjectSettings, useProjectSettings } from '@/lib/project-settings-modal';

const ProjectSettingsCard = lazy(() => import('@/components/projects/project-settings').then((module) => ({ default: module.ProjectSettingsCard })));

/** A link inside it to anywhere else closes it and goes there. */
export function ProjectSettingsModal() {
	const at = useProjectSettings();
	const [dialog, setDialog] = useState<HTMLDivElement | null>(null);
	return (
		<Dialog.Root open={at !== null} onOpenChange={(next) => (next ? undefined : closeProjectSettings())}>
			<Dialog.Portal>
				<Dialog.Overlay className="settings-overlay fixed inset-0 z-50" />
				<Dialog.Content
					ref={setDialog}
					aria-describedby={undefined}
					// Focus the card itself, not its first control, so opening it draws no focus ring.
					onOpenAutoFocus={(event) => {
						event.preventDefault();
						(event.currentTarget as HTMLElement | null)?.focus();
					}}
					tabIndex={-1}
					onClickCapture={(event) => {
						if ((event.target as Element).closest('a[href]')) closeProjectSettings();
					}}
					className="settings-card fixed inset-0 z-50 flex flex-col overflow-hidden outline-none md:m-auto md:h-[min(820px,calc(100dvh-64px))] md:w-[min(1180px,calc(100vw-64px))]"
				>
					<FloatingLayerContainer.Provider value={dialog}>
						<Dialog.Title className="sr-only">Project settings</Dialog.Title>
						{at ? (
							<LazyPart label="Project settings" className="m-6">
								<ProjectSettingsCard spaceId={at.spaceId} section={at.section} />
							</LazyPart>
						) : null}
					</FloatingLayerContainer.Provider>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}

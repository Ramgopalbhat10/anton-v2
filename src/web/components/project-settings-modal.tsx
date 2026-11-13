import { Dialog } from 'radix-ui';
import { lazy } from 'react';
import { LazyPart } from '@/components/error-boundary';
import { closeProjectSettings, useProjectSettings } from '@/lib/project-settings-modal';

/** A project's settings, loaded the first time they open (`project-settings.tsx`). */
const ProjectSettingsCard = lazy(() => import('@/components/project-settings').then((module) => ({ default: module.ProjectSettingsCard })));

/**
 * A project's settings, as a card over the page you are on, like the app's
 * Settings. A link inside it to anywhere else closes it and goes there.
 */
export function ProjectSettingsModal() {
	const at = useProjectSettings();
	return (
		<Dialog.Root open={at !== null} onOpenChange={(next) => (next ? undefined : closeProjectSettings())}>
			<Dialog.Portal>
				<Dialog.Overlay className="settings-overlay fixed inset-0 z-50" />
				<Dialog.Content
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
					className="settings-card fixed inset-0 z-50 flex flex-col overflow-hidden outline-none md:inset-auto md:top-1/2 md:left-1/2 md:h-[min(820px,calc(100dvh-64px))] md:w-[min(1180px,calc(100vw-64px))] md:-translate-x-1/2 md:-translate-y-1/2"
				>
					<Dialog.Title className="sr-only">Project settings</Dialog.Title>
					{at ? (
						<LazyPart label="Project settings" className="m-6">
							<ProjectSettingsCard spaceId={at.spaceId} section={at.section} />
						</LazyPart>
					) : null}
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}

import type { IconComponent } from '@/lib/icons';
import { ArrowRight, Box, Brain, Cloud, GitBranch, HardDrive, Monitor, Settings } from '@/lib/icons';
import { Status } from '@/components/instrument';
import { Btn, Icon } from '@/components/signal';
import type { SetupSlot, SetupView } from '@/lib/api';
import { SERVICE_LOGOS } from '@/lib/service-logos';
import { openSettings } from '@/lib/settings-modal';

const LOGO: Record<string, string> = { openrouter: 'openrouter', vercel: 'vercel', github: 'github', modal: 'modal', docker: 'docker' };
const GLYPH: Record<string, IconComponent> = { local: Monitor, s3: Cloud, disk: HardDrive };
const SLOT_ICON: Record<string, IconComponent> = { models: Brain, git: GitBranch, sandbox: Box, store: HardDrive };

/** From what is set rather than a live check. */
export function isReady(slot: SetupSlot, setup: SetupView): boolean {
	if (slot.id === 'models') return setup.canRunTasks;
	if (slot.id === 'git') return slot.options[0]?.fields.some((field) => field.env === 'ANTON_GITHUB_TOKEN' && field.source !== null) ?? false;
	return slot.provider !== null;
}

export const setupLeft = (setup: SetupView) => setup.slots.filter((slot) => slot.required && !isReady(slot, setup)).length;

function SlotMark({ slot }: { slot: SetupSlot }) {
	const provider = slot.id === 'models' && !slot.provider ? null : slot.provider;
	const logo = provider ? SERVICE_LOGOS[LOGO[provider] ?? ''] : undefined;
	if (logo) return <span aria-hidden className="flex shrink-0 text-(--text-2)" style={{ fontSize: 16 }} dangerouslySetInnerHTML={{ __html: logo }} />;
	return <Icon icon={(provider && GLYPH[provider]) || SLOT_ICON[slot.id] || Settings} size={16} className="text-(--text-2)" />;
}

export function SetupCard({ setup }: { setup: SetupView }) {
	const needed = setup.slots.filter((slot) => slot.required);
	const done = needed.filter((slot) => isReady(slot, setup)).length;
	return (
		<section aria-label="Set up Anton" className="in-card in-enter">
			<header className="flex min-h-11 items-center gap-2.5 px-4 pt-3 pb-2">
				<span className="inline-flex size-[26px] shrink-0 items-center justify-center text-(--text-2)">
					<Icon icon={Settings} size={16} />
				</span>
				<div className="flex min-w-0 flex-1 items-baseline gap-1.5">
					<h2 className="m-0 truncate text-body leading-[18px] font-semibold text-(--text)">Set up Anton</h2>
					<span className="text-small text-(--text-4)">/</span>
					<span className="in-num truncate text-small text-(--text-3)">
						{done} of {needed.length} ready
					</span>
				</div>
				<Btn variant="primary" onClick={() => openSettings('/settings/connections')}>
					Set up <Icon icon={ArrowRight} size={14} />
				</Btn>
			</header>
			<ul className="m-0 grid list-none gap-x-5 px-4 pb-2 sm:grid-cols-2">
				{needed.map((slot) => {
					const option = slot.options.find((candidate) => candidate.id === slot.provider);
					return (
						<li key={slot.id} className="flex h-9 min-w-0 items-center gap-2.5 border-t border-(--line)">
							<SlotMark slot={slot} />
							<span className="min-w-0 flex-1 truncate text-body">
								<span className="font-medium text-(--text)">{slot.name}</span>
								{option && isReady(slot, setup) ? <span className="text-(--text-3)"> / {option.label.toLowerCase()}</span> : null}
							</span>
							{isReady(slot, setup) ? <Status tone="success">Ready</Status> : <span className="text-small text-(--text-3)">Not set up</span>}
						</li>
					);
				})}
			</ul>
		</section>
	);
}

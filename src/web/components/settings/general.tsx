import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Bot, Braces, Cpu, GitPullRequest, ImagePlus, LayoutPanelTop, ListChecks } from 'lucide-react';
import { Segmented, SegmentedItem } from '@/components/instrument';
import { ModelPicker, useModels } from '@/components/model-picker';
import { Btn, Menu, MenuContent, MenuItem, MenuSub, MenuSubContent, MenuSubTrigger, MenuTrigger, PickerChip, Spinner, Switch } from '@/components/signal';
import { api, type GeneralSettings, type HelperAgent, type ImageModelInfo, type Reasoning } from '@/lib/api';
import { Block, PageHeading, SaveState, SettingRow } from './parts';

const HELPERS: Array<{ agent: HelperAgent; title: string; help: string; info?: string }> = [
	{ agent: 'explorer', title: 'Explorer', help: 'Reads and searches the code.' },
	{ agent: 'tester', title: 'Tester', help: 'Runs the tests and reports failures.' },
	{ agent: 'browser', title: 'Browser', help: 'Works on web pages.', info: 'In the Browser panel or the sandbox, and reports back.' },
	{
		agent: 'computer',
		title: 'Computer',
		help: 'Uses the sandbox desktop.',
		info: "Apps, dialogs, a visual check. It sees the screen with this model when it is an OpenRouter model that reads images, else with the task's, else with ANTON_VISION_MODEL.",
	},
	{ agent: 'reviewer', title: 'Reviewer', help: 'Reviews pull requests on GitHub.', info: 'Each pull request the agent opens or updates.' },
];

type AgentModel = { model: string; reasoning: Reasoning | null };

const VISUAL_LEVELS: Array<{ value: GeneralSettings['visualReplies']; label: string }> = [
	{ value: 'off', label: 'Off' },
	{ value: 'some', label: 'Some' },
	{ value: 'more', label: 'More' },
];

const COMPACT_POINTS: Array<{ value: GeneralSettings['compactAt']; label: string }> = [
	{ value: 100_000, label: '100K' },
	{ value: 200_000, label: '200K' },
	{ value: 400_000, label: '400K' },
	{ value: null, label: 'Full' },
];

/** One helper agent: the task's model, or its own when switched on. */
function HelperModel({
	title,
	help,
	info,
	value,
	fallback,
	disabled,
	onChange,
}: {
	title: string;
	help: string;
	info?: string;
	value: AgentModel | null;
	fallback: string;
	disabled: boolean;
	onChange: (value: AgentModel | null) => void;
}) {
	return (
		<SettingRow title={title} help={help} info={info}>
			{value ? (
				<ModelPicker
					value={value}
					onChange={(change) => onChange({ model: change.model ?? value.model, reasoning: change.reasoning ?? null })}
					height={28}
					side="bottom"
				/>
			) : (
				<span className="text-[12px] text-(--text-tertiary)">Task's model</span>
			)}
			<Switch
				checked={value !== null}
				disabled={disabled || !fallback}
				onChange={(on) => onChange(on ? { model: fallback, reasoning: null } : null)}
				label={<span className="sr-only">{title} uses its own model</span>}
			/>
		</SettingRow>
	);
}

/** The image model generate_image draws with: Anton's default, or one of OpenRouter's image models, by maker. */
function ImageModelPicker({ value, onChange, disabled }: { value: string | null; onChange: (value: string | null) => void; disabled: boolean }) {
	const listed = useQuery({ queryKey: ['image-models'], queryFn: api.imageModels, staleTime: 5 * 60_000 });
	if (!listed.data) return listed.error ? <span className="text-[12px] text-(--danger-text)">Could not list image models</span> : <Spinner size={12} />;
	if (!listed.data.available) return <span className="text-[12px] text-(--text-tertiary)">Needs an OpenRouter key</span>;
	const { models, default: fallback } = listed.data;
	const label = (id: string) => models.find((model) => model.id === id)?.name ?? id.replace(/^openrouter\//, '');
	const vendors = new Map<string, ImageModelInfo[]>();
	for (const model of models) vendors.set(model.vendor, [...(vendors.get(model.vendor) ?? []), model]);
	return (
		<Menu>
			<MenuTrigger asChild disabled={disabled}>
				<PickerChip icon={ImagePlus} label={value ? label(value) : `Default · ${label(fallback)}`} height={28} />
			</MenuTrigger>
			<MenuContent align="end" className="max-h-[min(420px,var(--radix-dropdown-menu-content-available-height))] overflow-y-auto">
				<MenuItem checked={value === null} hint={label(fallback)} onSelect={() => onChange(null)}>
					Default
				</MenuItem>
				{[...vendors].map(([vendor, list]) => (
					<MenuSub key={vendor}>
						<MenuSubTrigger hint={list.some((model) => model.id === value) ? label(value!) : undefined}>{vendor}</MenuSubTrigger>
						<MenuSubContent className="max-w-[320px]">
							{list.map((model) => (
								<MenuItem key={model.id} checked={model.id === value} title={model.description} onSelect={() => onChange(model.id)}>
									{model.name}
								</MenuItem>
							))}
						</MenuSubContent>
					</MenuSub>
				))}
			</MenuContent>
		</Menu>
	);
}

export const useGeneralSettings = () => useQuery({ queryKey: ['general-settings'], queryFn: api.generalSettings });

/**
 * Changes gather in a draft until Save sends them all, and Cancel puts the
 * page back as it was saved; the launcher picks them up for the next task.
 */
function Form({ settings: savedSettings }: { settings: GeneralSettings }) {
	const queryClient = useQueryClient();
	const models = useModels();
	const [draft, setDraft] = useState<GeneralSettings | null>(null);
	const settings = draft ?? savedSettings;
	const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(savedSettings);
	const edit = (patch: Partial<GeneralSettings>) => setDraft({ ...settings, ...patch });
	const save = useMutation({
		mutationFn: (next: GeneralSettings) => api.saveGeneralSettings(next),
		onSuccess: (saved) => {
			queryClient.setQueryData(['general-settings'], saved);
			void queryClient.invalidateQueries({ queryKey: ['models'] });
			setDraft(null);
		},
	});
	// Leaving the page with changes not saved asks first.
	useEffect(() => {
		if (!dirty) return;
		const warn = (event: BeforeUnloadEvent) => event.preventDefault();
		window.addEventListener('beforeunload', warn);
		return () => window.removeEventListener('beforeunload', warn);
	}, [dirty]);
	const model = settings.model ?? models.data?.default ?? '';
	return (
		<div className="flex flex-col gap-6">
			<Block
				title="Default model"
				icon={Cpu}
				help="What new tasks and automations start on."
				info="With its reasoning level, unless a task or automation picks its own. Each task can change its own."
			>
				<div className="self-start">
					<ModelPicker
						value={{ model, reasoning: settings.reasoning }}
						onChange={(change) => edit({ model: change.model ?? model, reasoning: change.reasoning ?? null })}
						height={28}
						side="bottom"
					/>
				</div>
			</Block>
			<Block title="New tasks" icon={ListChecks}>
				<SettingRow
					title="Start in plan mode"
					help="Changes nothing until you approve a plan."
					info="The agent reads the code and proposes a plan first. The launcher can still turn it off for a task."
				>
					<Switch
						checked={settings.planMode}
						disabled={save.isPending}
						onChange={(planMode) => edit({ planMode })}
						label={<span className="sr-only">Start in plan mode</span>}
					/>
				</SettingRow>
			</Block>
			<Block title="Agent" icon={Braces}>
				<SettingRow
					title="Code mode"
					help="Calls many tools in one short program."
					info="The agent writes one program that calls repo reads and searches, MCP servers and the decision model, and reads back only its result, which saves turns and tokens on jobs with many lookups. MCP servers are reached only this way unless a server opts out. Programs run on Anton, not in the sandbox, and can reach nothing else."
				>
					<Switch
						checked={settings.codeMode}
						disabled={save.isPending}
						onChange={(codeMode) => edit({ codeMode })}
						label={<span className="sr-only">Code mode</span>}
					/>
				</SettingRow>
				<SettingRow
					title="Compact at"
					help="Summarizes older turns past this context."
					info="Every model call sends the whole conversation again, tool results included, so a long thread on a 1M-token model can send hundreds of thousands of tokens a call. Past this size the agent folds older turns into a summary and keeps the latest work word for word. Full waits until the model's window is nearly full. A model with a smaller window compacts before it fills either way."
				>
					<Segmented label="Compact at" role="radiogroup">
						{COMPACT_POINTS.map((point) => (
							<SegmentedItem key={point.label} role="radio" on={settings.compactAt === point.value} onClick={() => edit({ compactAt: point.value })}>
								{point.label}
							</SegmentedItem>
						))}
					</Segmented>
				</SettingRow>
			</Block>
			<Block title="Replies" icon={LayoutPanelTop}>
				<SettingRow
					title="Visual replies"
					help="Cards, charts and small pages in replies."
					info="Figures, tables, charts, timelines, buttons and forms, and small pages it draws. Some uses them when they say it better than text; More reaches for them whenever a reply has numbers or choices; Off keeps replies to text. Questions for you still come with options to tap."
				>
					<Segmented label="Visual replies" role="radiogroup">
						{VISUAL_LEVELS.map((level) => (
							<SegmentedItem key={level.value} role="radio" on={settings.visualReplies === level.value} onClick={() => edit({ visualReplies: level.value })}>
								{level.label}
							</SegmentedItem>
						))}
					</Segmented>
				</SettingRow>
				<SettingRow
					title="Pages reach the web"
					help="Pages the agent draws can call web APIs."
					info="Such as a dashboard fetching live prices. Anton makes each request for the page, so it works whatever the API's CORS rules, reaches only the public internet (never this machine or its network) and carries no cookies. Off, pages have no network at all."
				>
					<Switch
						checked={settings.pageNetwork}
						disabled={save.isPending}
						onChange={(pageNetwork) => edit({ pageNetwork })}
						label={<span className="sr-only">Pages reach the web</span>}
					/>
				</SettingRow>
				<SettingRow
					title="Image model"
					help="Draws and edits images you ask for."
					info="Whatever model the task runs on; a task running on an image model draws with its own. Images show in the thread and are kept in the Library, and each is counted in the task's spend."
				>
					<ImageModelPicker value={settings.imageModel} disabled={save.isPending} onChange={(imageModel) => edit({ imageModel })} />
				</SettingRow>
			</Block>
			<Block
				title="Helper agents"
				icon={Bot}
				help="Each can run on its own, cheaper or faster model."
				info="The agents that work for the main one. Off, they use the task's model."
			>
				{HELPERS.map((helper) => (
					<HelperModel
						key={helper.agent}
						title={helper.title}
						help={helper.help}
						info={helper.info}
						value={settings.agentModels[helper.agent]}
						fallback={model}
						disabled={save.isPending}
						onChange={(choice) => edit({ agentModels: { ...settings.agentModels, [helper.agent]: choice } })}
					/>
				))}
			</Block>
			<Block title="Pull requests" icon={GitPullRequest}>
				<SettingRow
					title="Review pull requests"
					help="A reviewer comments on each push."
					info="Each time the agent opens or updates a pull request, a reviewer agent reads the change and comments on GitHub; with follow-ups on, the agent then fixes what it found. It follows the repository's REVIEW.md if there is one, and stops after three reviews of one pull request."
				>
					<Switch
						checked={settings.reviewPullRequests}
						disabled={save.isPending}
						onChange={(reviewPullRequests) => edit({ reviewPullRequests })}
						label={<span className="sr-only">Review pull requests</span>}
					/>
				</SettingRow>
			</Block>
			{/* The page's own footer, after the last card, so it never covers one. */}
			<div
				role="group"
				aria-label="Save changes"
				className="flex items-center gap-3 self-stretch border-t border-(--border-subtle) pt-4"
			>
				<span className="min-w-0 flex-1 text-[12px]">
					{dirty ? (
						<span className="inline-flex items-center gap-1.5 text-(--text-secondary)">
							<span className="size-1.5 shrink-0 rounded-full bg-(--accent-base)" />
							Unsaved changes
						</span>
					) : (
						<SaveState pending={save.isPending} success={save.isSuccess} error={save.error} saved="Saved." />
					)}
				</span>
				{dirty && save.error ? <span className="text-[12px] text-(--danger-text)">{save.error.message}</span> : null}
				<Btn
					size="sm"
					variant="ghost"
					disabled={!dirty || save.isPending}
					onClick={() => {
						setDraft(null);
						save.reset();
					}}
				>
					Cancel
				</Btn>
				<Btn size="sm" variant="primary" disabled={!dirty || save.isPending} onClick={() => save.mutate(settings)}>
					{save.isPending ? 'Saving…' : 'Save'}
				</Btn>
			</div>
		</div>
	);
}

export function GeneralPage() {
	const settings = useGeneralSettings();
	return (
		<>
			<PageHeading title="General">How new tasks start and how the agent works.</PageHeading>
			{settings.data ? <Form settings={settings.data} /> : <Spinner size={12} />}
		</>
	);
}

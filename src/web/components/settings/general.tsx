import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Bot, Braces, Cpu, GitPullRequest, LayoutPanelTop, ListChecks } from 'lucide-react';
import { Segmented, SegmentedItem } from '@/components/instrument';
import { ModelPicker, useModels } from '@/components/model-picker';
import { Btn, Spinner, Switch } from '@/components/signal';
import { api, type GeneralSettings, type HelperAgent, type Reasoning } from '@/lib/api';
import { Block, PageHeading, SaveState, SettingRow } from './parts';

const HELPERS: Array<{ agent: HelperAgent; title: string; help: string }> = [
	{ agent: 'explorer', title: 'Explorer', help: 'Reads and searches the code for the agent and reports what it found.' },
	{ agent: 'tester', title: 'Tester', help: 'Runs the project\'s tests and reports the failures.' },
	{ agent: 'browser', title: 'Browser', help: 'Does tasks on web pages for the agent, in the Browser panel or the sandbox, and reports back.' },
	{
		agent: 'computer',
		title: 'Computer',
		help: "Uses the desktop in the sandbox for the agent: apps, dialogs, a visual check. It sees the screen with this model when it is an OpenRouter model that reads images, else with the task's, else with ANTON_VISION_MODEL.",
	},
	{ agent: 'reviewer', title: 'Reviewer', help: 'Reviews each pull request the agent opens or updates and comments on GitHub.' },
];

type AgentModel = { model: string; reasoning: Reasoning | null };

const VISUAL_LEVELS: Array<{ value: GeneralSettings['visualReplies']; label: string }> = [
	{ value: 'off', label: 'Off' },
	{ value: 'some', label: 'Some' },
	{ value: 'more', label: 'More' },
];

/** One helper agent: the task's model, or its own when switched on. */
function HelperModel({
	title,
	help,
	value,
	fallback,
	disabled,
	onChange,
}: {
	title: string;
	help: string;
	value: AgentModel | null;
	fallback: string;
	disabled: boolean;
	onChange: (value: AgentModel | null) => void;
}) {
	return (
		<SettingRow title={title} help={help}>
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
				help="New tasks and automations without a model of their own start with this one and its reasoning level. Each task can change its own."
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
				<SettingRow title="Start in plan mode" help="The agent reads the code and proposes a plan, and changes nothing until you approve it. The launcher can still turn it off.">
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
					help="The agent can write one short program that calls many tools at once (repo reads and searches, MCP servers, the decision model) and reads back only its result, which saves turns and tokens on jobs with many lookups. A repository's MCP servers are reached only this way, listed in a line per tool, unless a server opts out in its settings. Programs run on Anton, not in the sandbox, and can reach nothing else."
				>
					<Switch
						checked={settings.codeMode}
						disabled={save.isPending}
						onChange={(codeMode) => edit({ codeMode })}
						label={<span className="sr-only">Code mode</span>}
					/>
				</SettingRow>
			</Block>
			<Block title="Replies" icon={LayoutPanelTop}>
				<SettingRow
					title="Visual replies"
					help="The agent can answer with cards in the thread: figures, tables, charts, timelines, buttons and forms you press, and small pages it draws in a sandbox. Some uses them when they say it better than text; More reaches for them whenever a reply has numbers or choices; Off keeps replies to text. Questions it needs you to decide still come with options to tap."
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
					help="Pages the agent draws can call web APIs, such as a dashboard fetching live prices. Anton makes each request for the page, so it works whatever the API's CORS rules, reaches only the public internet (never this machine or its network) and carries no cookies. Off, pages have no network at all."
				>
					<Switch
						checked={settings.pageNetwork}
						disabled={save.isPending}
						onChange={(pageNetwork) => edit({ pageNetwork })}
						label={<span className="sr-only">Pages reach the web</span>}
					/>
				</SettingRow>
			</Block>
			<Block
				title="Helper agents"
				icon={Bot}
				help="The agents that work for the main one can each run on their own model, often a cheaper or faster one. Off, they use the task's model."
			>
				{HELPERS.map((helper) => (
					<HelperModel
						key={helper.agent}
						title={helper.title}
						help={helper.help}
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
					help="Each time the agent opens or updates a pull request, a reviewer agent reads the change and comments on GitHub; with follow-ups on, the agent then fixes what it found. It follows the repository's REVIEW.md if there is one, and stops after three reviews of one pull request."
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
			<PageHeading title="General">How a new task starts when you do not choose on the launcher, how the agent works, and how its pull requests are reviewed.</PageHeading>
			{settings.data ? <Form settings={settings.data} /> : <Spinner size={12} />}
		</>
	);
}

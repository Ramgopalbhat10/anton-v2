import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ModelPicker, useModels } from '@/components/model-picker';
import { Spinner, Switch } from '@/components/signal';
import { api, type GeneralSettings, type HelperAgent, type Reasoning } from '@/lib/api';
import { Block, PageHeading, SaveState, SettingRow } from './parts';

const HELPERS: Array<{ agent: HelperAgent; title: string; help: string }> = [
	{ agent: 'explorer', title: 'Explorer', help: 'Reads and searches the code for the agent and reports what it found.' },
	{ agent: 'tester', title: 'Tester', help: 'Runs the project\'s tests and reports the failures.' },
	{ agent: 'reviewer', title: 'Reviewer', help: 'Reviews each pull request the agent opens or updates and comments on GitHub.' },
];

type AgentModel = { model: string; reasoning: Reasoning | null };

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

/** Each change saves at once; the launcher picks it up for the next task. */
function Form({ settings }: { settings: GeneralSettings }) {
	const queryClient = useQueryClient();
	const models = useModels();
	const save = useMutation({
		mutationFn: (patch: Partial<GeneralSettings>) => api.saveGeneralSettings({ ...settings, ...patch }),
		onSuccess: (saved) => {
			queryClient.setQueryData(['general-settings'], saved);
			void queryClient.invalidateQueries({ queryKey: ['models'] });
		},
	});
	const model = settings.model ?? models.data?.default ?? '';
	return (
		<div className="flex flex-col gap-6">
			<Block
				title="Default model"
				help="New tasks and automations without a model of their own start with this one and its reasoning level. Each task can change its own."
			>
				<div className="self-start">
					<ModelPicker
						value={{ model, reasoning: settings.reasoning }}
						onChange={(change) => save.mutate({ model: change.model ?? model, reasoning: change.reasoning ?? null })}
						height={28}
						side="bottom"
					/>
				</div>
			</Block>
			<Block title="New tasks">
				<SettingRow title="Start in plan mode" help="The agent reads the code and proposes a plan, and changes nothing until you approve it. The launcher can still turn it off.">
					<Switch
						checked={settings.planMode}
						disabled={save.isPending}
						onChange={(planMode) => save.mutate({ planMode })}
						label={<span className="sr-only">Start in plan mode</span>}
					/>
				</SettingRow>
			</Block>
			<Block title="Agent">
				<SettingRow
					title="Code mode"
					help="The agent can write one short program that calls many tools at once (repo reads and searches, MCP servers, the decision model) and reads back only its result, which saves turns and tokens on jobs with many lookups. It runs on Anton, not in the sandbox, and can reach nothing else."
				>
					<Switch
						checked={settings.codeMode}
						disabled={save.isPending}
						onChange={(codeMode) => save.mutate({ codeMode })}
						label={<span className="sr-only">Code mode</span>}
					/>
				</SettingRow>
			</Block>
			<Block
				title="Helper agents"
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
						onChange={(choice) => save.mutate({ agentModels: { ...settings.agentModels, [helper.agent]: choice } })}
					/>
				))}
			</Block>
			<Block title="Pull requests">
				<SettingRow
					title="Review pull requests"
					help="Each time the agent opens or updates a pull request, a reviewer agent reads the change and comments on GitHub; with follow-ups on, the agent then fixes what it found. It follows the repository's REVIEW.md if there is one, and stops after three reviews of one pull request."
				>
					<Switch
						checked={settings.reviewPullRequests}
						disabled={save.isPending}
						onChange={(reviewPullRequests) => save.mutate({ reviewPullRequests })}
						label={<span className="sr-only">Review pull requests</span>}
					/>
				</SettingRow>
			</Block>
			<SaveState pending={save.isPending} success={save.isSuccess} error={save.error} saved="Saved." />
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

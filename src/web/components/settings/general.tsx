import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ModelPicker, useModels } from '@/components/model-picker';
import { Spinner, Switch } from '@/components/signal';
import { api, type GeneralSettings } from '@/lib/api';
import { Block, PageHeading, SaveState, SettingRow } from './parts';

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
			<PageHeading title="General">How a new task starts when you do not choose on the launcher, and how its pull requests are reviewed.</PageHeading>
			{settings.data ? <Form settings={settings.data} /> : <Spinner size={12} />}
		</>
	);
}

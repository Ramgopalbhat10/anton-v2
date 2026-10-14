import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BellRing, Download, ListChecks, MonitorSmartphone, Send, Smartphone, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Status } from '@/components/instrument';
import { Btn, IconBtn, Spinner, Switch } from '@/components/signal';
import { api, type PushView } from '@/lib/api';
import { age } from '@/lib/format';
import { canPromptInstall, currentSubscription, deviceIdOf, isInstalled, isIos, onInstallChange, promptInstall, pushSupport, turnOffPush, turnOnPush } from '@/lib/push';
import { Block, List, PageHeading, RowIcon, SaveState, SettingRow } from './parts';

/** The id this browser is listed under, once its subscription is known; null when it has none. */
function useThisDevice(view: PushView | undefined): string | null | undefined {
	const [id, setId] = useState<string | null | undefined>(undefined);
	useEffect(() => {
		let live = true;
		void currentSubscription().then(async (subscription) => {
			const next = subscription ? await deviceIdOf(subscription.endpoint) : null;
			if (live) setId(next);
		});
		return () => {
			live = false;
		};
	}, [view]);
	return id;
}

function ThisDevice({ view, thisDevice }: { view: PushView; thisDevice: string | null | undefined }) {
	const queryClient = useQueryClient();
	const support = pushSupport();
	const on = Boolean(thisDevice && view.devices.some((device) => device.id === thisDevice));
	const toggle = useMutation({
		mutationFn: () => (on ? turnOffPush() : turnOnPush(view.publicKey)),
		onSuccess: (next) => queryClient.setQueryData(['push'], next),
	});
	const test = useMutation({ mutationFn: () => api.testPush(thisDevice ?? undefined) });
	const status =
		support !== 'ready' || !view.publicKey ? <Status tone="warning">Unavailable</Status> : on ? <Status tone="success">On</Status> : <Status>Off</Status>;
	const help = !view.publicKey
		? 'The server cannot send notifications.'
		: support === 'install-first'
			? 'An iPhone or iPad gets notifications only from Anton on its home screen. Tap Share, then Add to Home Screen, and open Anton from there to turn them on.'
			: support === 'blocked'
				? 'Notifications are blocked for Anton in this browser. Allow them in its site settings, then come back.'
				: support === 'unsupported'
					? 'This browser cannot get notifications from Anton.'
					: 'Notifications reach this device with no Anton tab open, so you can answer from your phone.';
	return (
		<Block title="This device" icon={Smartphone} help={help} aside={status}>
			{support === 'ready' && view.publicKey ? (
				<SettingRow title={on ? 'Notifications are on here' : 'Get notifications here'} help={on ? 'Send a test to see one arrive.' : 'Your browser asks to allow notifications.'}>
					{on ? (
						<Btn size="sm" icon={Send} disabled={test.isPending} onClick={() => test.mutate()}>
							Send a test
						</Btn>
					) : null}
					<Btn size="sm" variant={on ? 'secondary' : 'primary'} icon={BellRing} disabled={toggle.isPending || thisDevice === undefined} onClick={() => toggle.mutate()}>
						{on ? 'Turn off' : 'Turn on'}
					</Btn>
				</SettingRow>
			) : null}
			{toggle.error ? <span className="text-[12px] text-(--danger-text)">{toggle.error.message}</span> : null}
			{test.error ? <span className="text-[12px] text-(--danger-text)">{test.error.message}</span> : null}
			{test.isSuccess ? (
				<SaveState pending={false} success error={null} saved={test.data.sent ? 'Sent. It shows when no Anton window is in front of you.' : 'Not sent: this device is not listed.'} />
			) : null}
		</Block>
	);
}

function WhatYouHear({ view }: { view: PushView }) {
	const queryClient = useQueryClient();
	const save = useMutation({ mutationFn: api.savePushOptions, onSuccess: (next) => queryClient.setQueryData(['push'], next) });
	return (
		<Block
			title="What you hear about"
			icon={ListChecks}
			help="Every device below gets these, unless an Anton window is in front of you at the time: the page shows it there."
		>
			<SettingRow title="A task needs you" help="It asks a question, or a plan waits for your approval. The notification says what it asks.">
				<Status tone="success">Always</Status>
			</SettingRow>
			<SettingRow title="A task fails" help="Its reply stopped with an error.">
				<Status tone="success">Always</Status>
			</SettingRow>
			<SettingRow title="A task finishes" help="It replied and waits on nothing, with the start of what it said.">
				<Switch
					checked={view.finished}
					disabled={save.isPending}
					onChange={(finished) => save.mutate({ finished })}
					label={<span className="sr-only">Notify when a task finishes</span>}
				/>
			</SettingRow>
			<SaveState pending={save.isPending} success={save.isSuccess} error={save.error} />
		</Block>
	);
}

function Devices({ view, thisDevice }: { view: PushView; thisDevice: string | null | undefined }) {
	const queryClient = useQueryClient();
	const remove = useMutation({ mutationFn: api.removePushDevice, onSuccess: (next) => queryClient.setQueryData(['push'], next) });
	return (
		<Block title="Devices" icon={MonitorSmartphone} help="Each phone and browser that turned notifications on. Removing one stops its notifications.">
			{view.devices.length === 0 ? (
				<p className="m-0 text-[12px] text-(--text-tertiary)">None yet. Turn them on above, on each device you want to hear from Anton on.</p>
			) : (
				<List>
					{view.devices.map((device) => (
						<div key={device.id} className="flex min-h-11 items-center gap-3 rounded-lg px-2.5 py-1.5">
							<RowIcon icon={/iPhone|Android phone/.test(device.name) ? Smartphone : MonitorSmartphone} />
							<div className="flex min-w-0 flex-1 flex-col gap-0.5">
								<div className="flex items-center gap-2 text-[13px] font-medium">
									<span className="truncate">{device.name}</span>
									{device.id === thisDevice ? <Status tone="accent">This device</Status> : null}
								</div>
								<div className={device.lastError ? 'text-[12px] text-(--danger-text)' : 'text-[12px] text-(--text-tertiary)'}>
									{device.lastError ? `Last send failed: ${device.lastError}` : device.lastSentAt ? `Last notified ${age(device.lastSentAt)} ago` : `Added ${age(device.addedAt)} ago`}
								</div>
							</div>
							<IconBtn icon={Trash2} size="sm" label={`Remove ${device.name}`} disabled={remove.isPending} onClick={() => remove.mutate(device.id)} />
						</div>
					))}
				</List>
			)}
		</Block>
	);
}

/** Putting Anton on the home screen: a button where the browser offers one, else how to do it. */
function Install() {
	const [, rerender] = useState(0);
	useEffect(() => onInstallChange(() => rerender((count) => count + 1)), []);
	if (isInstalled()) {
		return <Block title="Anton as an app" icon={Download} help="You are using Anton as an app, opened from your home screen or dock." aside={<Status tone="success">Installed</Status>} />;
	}
	const help = isIos()
		? 'In Safari, tap Share, then Add to Home Screen. Anton then opens full screen, like an app, and can send notifications.'
		: canPromptInstall()
			? 'Anton opens in its own window, from your home screen or dock, and keeps getting notifications.'
			: 'Use your browser’s Install or Add to Home Screen item, in its menu or address bar. Anton then opens in its own window.';
	return (
		<Block title="Anton as an app" icon={Download} help={help}>
			{canPromptInstall() ? (
				<div>
					<Btn size="sm" variant="primary" icon={Download} onClick={() => void promptInstall()}>
						Install Anton
					</Btn>
				</div>
			) : null}
		</Block>
	);
}

export function NotificationsPage() {
	const view = useQuery({ queryKey: ['push'], queryFn: api.push });
	const thisDevice = useThisDevice(view.data);
	return (
		<>
			<PageHeading title="Notifications">
				Hear from Anton on your phone or with the browser closed when a task needs you, so a question or a plan waiting for approval does not sit until
				you open a tab.
			</PageHeading>
			{view.data ? (
				<>
					<ThisDevice view={view.data} thisDevice={thisDevice} />
					<WhatYouHear view={view.data} />
					<Devices view={view.data} thisDevice={thisDevice} />
				</>
			) : view.isError ? (
				<p className="m-0 text-[12px] text-(--danger-text)">{view.error.message}</p>
			) : (
				<Spinner size={12} />
			)}
			<Install />
		</>
	);
}

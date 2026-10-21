import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { ScheduleEditor } from '@/components/schedule-editor';
import { defaultSchedule, type Schedule } from '../../src/core/schedule';

function Editor({ initial, seen }: { initial: Schedule; seen: Schedule[] }) {
	const [value, setValue] = useState(initial);
	return (
		<ScheduleEditor
			value={value}
			onChange={(next) => {
				seen.push(next);
				setValue(next);
			}}
		/>
	);
}

describe('ScheduleEditor', () => {
	it('picks days of the week and a time, and says when it runs in its time zone', async () => {
		const seen: Schedule[] = [];
		render(<Editor initial={{ ...defaultSchedule('Asia/Kolkata'), frequency: 'weekly', days: [1] }} seen={seen} />);
		expect(screen.getByText('Runs every Monday at 9:00 AM, Kolkata time')).toBeTruthy();
		await userEvent.click(screen.getByRole('button', { name: 'Friday' }));
		expect(seen.at(-1)?.days).toEqual([1, 5]);
		// The last day picked stays picked.
		await userEvent.click(screen.getByRole('button', { name: 'Monday' }));
		await userEvent.click(screen.getByRole('button', { name: 'Friday' }));
		expect(seen.at(-1)?.days).toEqual([5]);
		fireEvent.change(screen.getByLabelText('Time of day'), { target: { value: '18:30' } });
		expect(screen.getByText('Runs every Friday at 6:30 PM, Kolkata time')).toBeTruthy();
		expect(screen.getAllByRole('listitem')).toHaveLength(3);
		expect(screen.getByRole('button', { name: 'Time zone' }).textContent).toContain('Asia/Kolkata');
	});

	it('finds a time zone by name', async () => {
		const seen: Schedule[] = [];
		render(<Editor initial={defaultSchedule('UTC')} seen={seen} />);
		await userEvent.click(screen.getByRole('button', { name: 'Time zone' }));
		await userEvent.type(screen.getByLabelText('Find a time zone'), 'kolkata');
		await userEvent.click(screen.getByRole('option', { name: /Asia\/Kolkata/ }));
		expect(seen.at(-1)?.timeZone).toBe('Asia/Kolkata');
		expect(screen.getByText('Runs every day at 9:00 AM, Kolkata time')).toBeTruthy();
	});

	it('says what is wrong with a cron expression', () => {
		render(<Editor initial={{ ...defaultSchedule('UTC'), frequency: 'cron', cron: '0 9 * * 1-5' }} seen={[]} />);
		expect(screen.getByText('Runs on the cron schedule “0 9 * * 1-5”, UTC')).toBeTruthy();
		fireEvent.change(screen.getByLabelText('Cron expression'), { target: { value: '0 9 * *' } });
		expect(screen.getByText(/five fields/)).toBeTruthy();
		expect(screen.queryAllByRole('listitem')).toHaveLength(0);
	});
});

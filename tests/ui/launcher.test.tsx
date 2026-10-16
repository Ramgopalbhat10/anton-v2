import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithQueries } from './render';

const mocks = vi.hoisted(() => ({ mutate: vi.fn(), navigate: vi.fn() }));
const api = vi.hoisted(() => ({
	projects: vi.fn(),
	sessions: vi.fn(),
	models: vi.fn(),
	generalSettings: vi.fn(),
	branches: vi.fn(),
	commands: vi.fn(),
	plugins: vi.fn(async () => ({ plugins: [] })),
	projectFiles: vi.fn(async (id: string, branch: string) => ({
		paths: id === 'p2' ? ['other/repo.ts'] : branch === 'feature/ui' ? ['feature/view.ts'] : ['src/server.ts', 'README.md'],
	})),
}));
vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api }));
vi.mock('@tanstack/react-router', async (original) => ({ ...(await original<typeof import('@tanstack/react-router')>()), useNavigate: () => mocks.navigate }));
vi.mock('@/lib/create-chat', () => ({ useCreateChat: () => ({ mutate: mocks.mutate, isPending: false, isError: false }) }));
const { Launcher } = await import('@/components/launcher');

function setup() {
	return renderWithQueries(<Launcher />, [
		[
			['projects'],
			{
				projects: [
					{ id: 'p1', repoFullName: 'acme/demo', defaultBranch: 'main' },
					{ id: 'p2', repoFullName: 'acme/other', defaultBranch: 'main' },
				],
			},
		],
		[['sessions'], { sessions: [] }],
		[['models'], { models: [], default: '' }],
		[['general-settings'], { reasoning: null, planMode: false }],
		[['branches', 'p1'], { branches: ['main', 'feature/ui'] }],
		[['branches', 'p2'], { branches: ['main'] }],
		[['commands'], { commands: [{ name: 'review', prompt: 'Review the branch for bugs.' }] }],
	]);
}

describe('new task composer', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		localStorage.clear();
	});
	it('uses command and file chips and submits the expanded command with the original file path', async () => {
		setup();
		const box = screen.getByRole('textbox');
		await userEvent.type(box, '/rev');
		await screen.findByRole('option', { name: /\/review/ });
		await userEvent.keyboard('{Tab}');
		expect(screen.getByLabelText('Command /review')).toBeTruthy();
		await userEvent.keyboard('Check @serv');
		await screen.findByRole('option', { name: /server.ts/ });
		await userEvent.keyboard('{Tab}');
		expect(screen.getByLabelText('File src/server.ts').textContent).toBe('@server.ts');
		expect(screen.getByLabelText('File src/server.ts').getAttribute('title')).toBe('src/server.ts');
		expect(api.projectFiles).toHaveBeenCalledWith('p1', 'main');
		await userEvent.keyboard('{Control>}{Enter}{/Control}');
		await waitFor(() =>
			expect(mocks.mutate).toHaveBeenCalledWith(
				expect.objectContaining({ projectId: 'p1', branch: 'main', prompt: 'Review the branch for bugs.\n\nCheck @src/server.ts' }),
			),
		);
	});
	it('keeps Enter as a newline and submits only with the modifier shortcut', async () => {
		setup();
		await userEvent.type(screen.getByRole('textbox'), 'First line');
		await userEvent.keyboard('{Enter}Second line');
		expect(mocks.mutate).not.toHaveBeenCalled();
		await userEvent.keyboard('{Control>}{Enter}{/Control}');
		await waitFor(() => expect(mocks.mutate).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'First line\nSecond line' })));
	});
	it('refreshes file suggestions when the chosen branch or repository changes', async () => {
		setup();
		const box = screen.getByRole('textbox');
		await userEvent.type(box, '@');
		await screen.findByRole('option', { name: /server.ts/ });
		await userEvent.click(screen.getByRole('button', { name: 'main' }));
		await userEvent.click(screen.getByRole('menuitem', { name: 'feature/ui' }));
		await screen.findByRole('option', { name: /view.ts/ });
		expect(screen.queryByRole('option', { name: /server.ts/ })).toBeNull();
		await userEvent.click(screen.getByRole('button', { name: 'demo' }));
		await userEvent.click(screen.getByRole('menuitem', { name: 'acme/other' }));
		await screen.findByRole('option', { name: /repo.ts/ });
		expect(screen.queryByRole('option', { name: /view.ts/ })).toBeNull();
		expect(api.projectFiles).toHaveBeenCalledWith('p2', 'main');
	});
	it('starts a chat with no repository: no branch or plan mode, and the choice is remembered', async () => {
		const { unmount } = setup();
		expect(screen.getByRole('button', { name: 'Plan' })).toBeTruthy();
		await userEvent.click(screen.getByRole('button', { name: 'demo' }));
		await userEvent.click(screen.getByRole('menuitem', { name: 'No repository' }));
		expect(screen.getByRole('button', { name: 'No repository' })).toBeTruthy();
		expect(screen.queryByRole('button', { name: 'main' })).toBeNull();
		expect(screen.queryByRole('button', { name: 'Plan' })).toBeNull();
		expect(screen.getByLabelText('How a chat runs')).toBeTruthy();
		await userEvent.type(screen.getByRole('textbox'), 'What is new in React 19?');
		await userEvent.click(screen.getByRole('button', { name: 'Start chat' }));
		await waitFor(() =>
			expect(mocks.mutate).toHaveBeenCalledWith(expect.objectContaining({ projectId: undefined, branch: undefined, planMode: false, prompt: 'What is new in React 19?' })),
		);
		unmount();
		// The real create remembers it; the next New task starts as a chat too, and a repo can be picked back.
		localStorage.setItem('anton.project', 'none');
		setup();
		expect(screen.getByRole('button', { name: 'Start chat' })).toBeTruthy();
		await userEvent.click(screen.getByRole('button', { name: 'No repository' }));
		await userEvent.click(screen.getByRole('menuitem', { name: 'acme/demo' }));
		expect(screen.getByRole('button', { name: 'Start task' })).toBeTruthy();
		expect(screen.getByRole('button', { name: 'main' })).toBeTruthy();
	});
	it('takes images and any other files, pasted, dropped or picked, and starts the task with them', async () => {
		setup();
		const box = screen.getByRole('textbox');
		fireEvent.paste(box, { clipboardData: { files: [new File(['png'], 'image.png', { type: 'image/png' })], getData: () => '' } });
		const form = box.closest('form')!;
		fireEvent.drop(form, { dataTransfer: { files: [new File(['xlsx'], 'sales.xlsx')], types: ['Files'] } });
		expect(await screen.findByText('sales.xlsx')).toBeTruthy();
		await screen.findByRole('button', { name: /^Remove pasted-\d+\.png$/ });
		await userEvent.type(box, 'Chart the sales');
		await userEvent.click(screen.getByRole('button', { name: 'Start task' }));
		await waitFor(() => expect(mocks.mutate).toHaveBeenCalled());
		const input = mocks.mutate.mock.calls[0]![0];
		expect(input.prompt).toBe('Chart the sales');
		expect(input.images).toEqual([expect.objectContaining({ mimeType: 'image/png', data: btoa('png') })]);
		expect(input.files).toEqual([expect.objectContaining({ name: 'sales.xlsx' })]);
	});
});

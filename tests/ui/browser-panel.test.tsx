import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserView, PickedElement } from '@/lib/api';
import { renderWithQueries, session } from './render';
import { DESCRIBE_ELEMENT } from '../../src/services/describe-element';

const api = vi.hoisted(() => ({
	browser: vi.fn(),
	openBrowser: vi.fn(),
	closeBrowser: vi.fn(),
	navigateBrowser: vi.fn(),
	inspectBrowser: vi.fn(),
	clearBrowserHighlight: vi.fn(async () => undefined),
	browserScreenshot: vi.fn(),
	editSession: vi.fn(),
	session: vi.fn(),
	budget: vi.fn(),
	models: vi.fn(),
	files: vi.fn(),
	commands: vi.fn(),
}));
vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api }));

const { BrowserTab } = await import('@/components/browser-tab');
const { Composer } = await import('@/components/composer');
const { addToComposer, elementContext } = await import('@/lib/composer-inbox');

const picked: PickedElement = {
	tag: 'button',
	selector: 'form > button.primary',
	text: 'Sign in',
	html: '<button class="primary">Sign in</button>',
	rect: { x: 100, y: 200, width: 80, height: 32 },
	styles: { color: 'rgb(255, 255, 255)', margin: '0px' },
	components: [
		{ name: 'LoginForm', source: 'src/login-form.tsx:46' },
		{ name: 'App', source: null },
	],
	url: 'https://example.com/login',
	title: 'Log in',
	image: 'cG5n',
};

const open: BrowserView = {
	available: true,
	browser: {
		liveViewUrl: 'about:blank',
		viewport: { width: 1280, height: 800 },
		openedAt: '2026-10-09T00:00:00Z',
		page: { url: 'https://example.com/login', title: 'Log in', canGoBack: false, canGoForward: false },
		agentBusy: false,
		needsYou: null,
	},
};

describe('Picking an element in the page', () => {
	it('describes the element, its selector, styles, and the React components that render it, nearest first', () => {
		document.body.innerHTML = '<main><form id="login"><input name="email"><button class="primary large">Sign in</button></form></main>';
		const button = document.querySelector('button')!;
		function LoginForm() {}
		const App = Object.assign(() => null, { displayName: 'App' });
		Object.assign(button, {
			'__reactFiber$x1': {
				type: 'button',
				return: {
					type: LoginForm,
					_debugSource: { fileName: 'src/login-form.tsx', lineNumber: 46 },
					return: {
						type: { $$typeof: Symbol.for('react.memo'), type: LoginForm },
						return: { type: App, _debugStack: { stack: 'Error: react-stack-top-frame\n    at App (http://localhost:5173/src/App.tsx?t=17:12:5)' }, return: null },
					},
				},
			},
		});
		const describeElement = new Function(`return ${DESCRIBE_ELEMENT}`)() as (this: Node) => PickedElement | null;
		const described = describeElement.call(button.firstChild!)!;
		expect(described.tag).toBe('button');
		expect(described.selector).toBe('form#login > button.primary.large');
		expect(described.text).toBe('Sign in');
		expect(described.html).toBe('<button class="primary large">Sign in</button>');
		expect(described.components).toEqual([
			{ name: 'LoginForm', source: 'src/login-form.tsx:46' },
			{ name: 'App', source: '/src/App.tsx:12' },
		]);
		expect(Object.keys(described.styles)).toContain('font-size');
	});

	it('gives the agent what it needs to find the code: page, selector, components with files, styles that are set, and the HTML', () => {
		const context = elementContext(picked);
		expect(context).toContain('<selected_element page="https://example.com/login" title="Log in">');
		expect(context).toContain('Element: <button> at `form > button.primary`, text "Sign in"');
		expect(context).toContain('React components, nearest first: LoginForm (src/login-form.tsx:46) › App');
		expect(context).toContain('Styles: color: rgb(255, 255, 255)');
		expect(context).not.toContain('margin: 0px');
		expect(context).toContain('```html\n<button class="primary">Sign in</button>\n```');
	});
});

describe('Browser panel', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('says when the agent stopped for you on a page, over its busy note', () => {
		renderWithQueries(<BrowserTab sessionId="s1" />, [
			[['browser', 's1'], { ...open, browser: { ...open.browser!, agentBusy: true, needsYou: 'Sign in or pass the check here, then ask the agent to carry on.' } }],
		]);
		expect(screen.getByText('Sign in or pass the check here, then ask the agent to carry on.')).toBeTruthy();
		expect(screen.queryByText('The agent is using this browser')).toBeNull();
	});

	it('says when the agent is using the browser', () => {
		renderWithQueries(<BrowserTab sessionId="s1" />, [[['browser', 's1'], { ...open, browser: { ...open.browser!, agentBusy: true } }]]);
		expect(screen.getByText('The agent is using this browser')).toBeTruthy();
	});

	it('says how to turn it on without a Kernel key', () => {
		renderWithQueries(<BrowserTab sessionId="s1" />, [[['browser', 's1'], { available: false, browser: null }]]);
		expect(screen.getByText('The browser needs a Kernel key')).toBeTruthy();
		expect(screen.getByText(/KERNEL_API_KEY/)).toBeTruthy();
	});

	it('opens a browser at the address typed', async () => {
		api.openBrowser.mockResolvedValue(open);
		renderWithQueries(<BrowserTab sessionId="s1" />, [[['browser', 's1'], { available: true, browser: null }]]);
		await userEvent.type(screen.getByRole('textbox', { name: 'Address to open' }), 'example.com/login');
		await userEvent.click(screen.getByRole('button', { name: 'Open browser' }));
		expect(api.openBrowser).toHaveBeenCalledWith('s1', 'example.com/login');
		expect(await screen.findByTitle('Browser')).toBeTruthy();
		expect((screen.getByRole('textbox', { name: 'Address' }) as HTMLInputElement).value).toBe('https://example.com/login');
	});

	it('goes where the address bar says, and back once there is somewhere to go back to', async () => {
		api.navigateBrowser.mockResolvedValue({ url: 'https://news.ycombinator.com/', title: 'HN', canGoBack: true, canGoForward: false });
		renderWithQueries(<BrowserTab sessionId="s1" />, [[['browser', 's1'], open]]);
		expect((screen.getByRole('button', { name: 'Back' }) as HTMLButtonElement).disabled).toBe(true);
		const address = screen.getByRole('textbox', { name: 'Address' });
		await userEvent.clear(address);
		await userEvent.type(address, 'news.ycombinator.com{Enter}');
		expect(api.navigateBrowser).toHaveBeenCalledWith('s1', { url: 'news.ycombinator.com' });
		await waitFor(() => expect((screen.getByRole('button', { name: 'Back' }) as HTMLButtonElement).disabled).toBe(false));
		expect((address as HTMLInputElement).value).toBe('https://news.ycombinator.com/');
	});

	it('picks an element into the message: highlights under the pointer, adds the element on click, then stops picking', async () => {
		api.inspectBrowser.mockImplementation(async (_id: string, point: { pick: boolean }) => ({ element: point.pick ? picked : null }));
		const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 640, height: 400, top: 0, left: 0, right: 640, bottom: 400, x: 0, y: 0, toJSON: () => ({}) });
		const onSend = vi.fn(async () => undefined);
		renderWithQueries(
			<>
				<BrowserTab sessionId="s1" />
				<Composer sessionId="s1" onSend={onSend} onStop={async () => undefined} />
			</>,
			[
				[['browser', 's1'], open],
				[['session', 's1'], session({ id: 's1' })],
				[['models'], { models: [], default: '' }],
				[['budget', 's1'], { limits: { dailyUsd: null, taskUsd: null }, today: 0, task: 0, blocked: null }],
				[['commands'], { commands: [] }],
			],
		);
		fireEvent.click(screen.getByRole('button', { name: 'Pick an element for the message' }));
		const layer = screen.getByRole('button', { name: 'Pick an element on the page' });
		fireEvent.pointerMove(layer, { clientX: 64, clientY: 100 });
		// The panel shows the page at half size, so the point doubles on the page.
		await waitFor(() => expect(api.inspectBrowser).toHaveBeenCalledWith('s1', { x: 128, y: 200, pick: false }));
		fireEvent.click(layer, { clientX: 60, clientY: 100 });
		await waitFor(() => expect(api.inspectBrowser).toHaveBeenCalledWith('s1', { x: 120, y: 200, pick: true }));
		expect(await screen.findByText('<button> in LoginForm')).toBeTruthy();
		expect(screen.getByText('Added <button> in LoginForm to the message')).toBeTruthy();
		await waitFor(() => expect(screen.queryByRole('button', { name: 'Pick an element on the page' })).toBeNull());
		expect(api.clearBrowserHighlight).toHaveBeenCalled();

		fireEvent.submit(screen.getByRole('button', { name: 'Send message' }).closest('form')!);
		await waitFor(() => expect(onSend).toHaveBeenCalled());
		const [text, images] = onSend.mock.calls[0] as unknown as [string, Array<{ data: string }>];
		expect(text.startsWith('Look at the selected element.\n\n<selected_element page="https://example.com/login"')).toBe(true);
		expect(images.map((image) => image.data)).toEqual(['cG5n']);
		expect(screen.queryByText('<button> in LoginForm')).toBeNull();
		rect.mockRestore();
	});

	it('draws on a picture of the page and adds it to the message', async () => {
		api.browserScreenshot.mockResolvedValue({ data: 'cG5n', width: 1280, height: 800 });
		renderWithQueries(<BrowserTab sessionId="s1" />, [[['browser', 's1'], open]]);
		fireEvent.click(screen.getByRole('button', { name: 'Draw on the page' }));
		const tools = await screen.findByRole('toolbar', { name: 'Drawing tools' });
		for (const name of ['Pen', 'Line', 'Arrow', 'Rectangle', 'Ellipse', 'Text', 'Undo', 'Redo', 'Clear', 'Close', 'Add to chat']) {
			expect(within(tools).getByRole('button', { name })).toBeTruthy();
		}
		fireEvent.click(within(tools).getByRole('button', { name: 'Arrow' }));
		expect(within(tools).getByRole('button', { name: 'Arrow' }).getAttribute('aria-pressed')).toBe('true');
		fireEvent.click(within(tools).getByRole('radio', { name: 'Blue' }));
		const dialog = screen.getByRole('dialog', { name: 'Draw on the page' });
		const canvas = dialog.querySelector('svg')!;
		const rect = vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({ width: 640, height: 400, top: 0, left: 0, right: 640, bottom: 400, x: 0, y: 0, toJSON: () => ({}) });
		fireEvent.pointerDown(canvas, { button: 0, clientX: 10, clientY: 10, pointerId: 1 });
		fireEvent.pointerMove(canvas, { clientX: 100, clientY: 50, pointerId: 1 });
		fireEvent.pointerUp(canvas, { pointerId: 1 });
		// Drawn in the page's own pixels, at twice the size shown.
		expect(canvas.querySelector('line')?.getAttribute('x2')).toBe('200');
		expect(canvas.querySelector('g')?.getAttribute('stroke')).toBe('#3b82f6');
		fireEvent.click(within(tools).getByRole('button', { name: 'Undo' }));
		expect(canvas.querySelector('line')).toBeNull();
		fireEvent.click(within(tools).getByRole('button', { name: 'Redo' }));
		expect(canvas.querySelector('line')).toBeTruthy();
		rect.mockRestore();

		fireEvent.click(within(tools).getByRole('button', { name: 'Close' }));
		expect(screen.queryByRole('dialog', { name: 'Draw on the page' })).toBeNull();
	});
});

describe('Composer inbox', () => {
	it('takes a drawing handed over before the composer mounted', async () => {
		act(() =>
			addToComposer('s2', { kind: 'image', image: { id: 'd1', filename: 'drawing.png', mimeType: 'image/png', data: 'cG5n', preview: 'data:image/png;base64,cG5n' } }),
		);
		renderWithQueries(<Composer sessionId="s2" onSend={async () => undefined} onStop={async () => undefined} />, [
			[['session', 's2'], session({ id: 's2' })],
			[['models'], { models: [], default: '' }],
			[['budget', 's2'], { limits: { dailyUsd: null, taskUsd: null }, today: 0, task: 0, blocked: null }],
		]);
		expect(await screen.findByRole('img', { name: 'drawing.png' })).toBeTruthy();
	});
});

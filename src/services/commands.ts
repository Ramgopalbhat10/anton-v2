import { InvalidInputError } from '../core/errors.ts';
import { getSetting, setSetting } from '../db/settings.ts';

/** A saved prompt, typed as `/name` in the composer. */
export type Command = { name: string; prompt: string };

const NAME = /^[a-z0-9][a-z0-9-]*$/;

export const commands = () => getSetting<Command[]>('commands', []);

export async function setCommands(list: Command[]): Promise<Command[]> {
	const saved = list.map(({ name, prompt }) => ({ name: name.trim().replace(/^\//, '').toLowerCase(), prompt: prompt.trim() }));
	for (const command of saved) {
		if (!NAME.test(command.name)) throw new InvalidInputError(`"${command.name}" is not a command name: use letters, digits and dashes`);
		if (!command.prompt) throw new InvalidInputError(`/${command.name} needs a prompt`);
	}
	if (new Set(saved.map((command) => command.name)).size !== saved.length) throw new InvalidInputError('Each command needs its own name');
	await setSetting('commands', saved);
	return saved;
}

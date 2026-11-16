import { config } from '../../config.ts';
import { keySlot } from '../key-slot.ts';

/** The key pasted in Settings › Connectors, else COMPOSIO_API_KEY. */
export const composioKeySlot = keySlot(() => config.composio.apiKey);

import { config } from '../../config.ts';
import { keySlot } from '../key-slot.ts';

/** The project key Composio is called with: the one pasted in Settings › Connectors, else COMPOSIO_API_KEY. */
export const composioKeySlot = keySlot(() => config.composio.apiKey);

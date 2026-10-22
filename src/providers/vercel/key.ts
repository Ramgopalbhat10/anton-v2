import { config } from '../../config.ts';
import { keySlot } from '../key-slot.ts';

/** The key Vercel AI Gateway is called with: the one pasted in Settings › Subscriptions, else AI_GATEWAY_API_KEY. */
export const vercelKeySlot = keySlot(() => config.vercel.apiKey);

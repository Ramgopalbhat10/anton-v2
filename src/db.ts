import path from 'node:path';
import { sqlite } from '@flue/runtime/node';
import { config } from './config.ts';

// Conversations, attachments, and accepted submissions are stored here so
// they survive a restart. Swap in another adapter (Postgres, libSQL, ...)
// when one host's SQLite file is no longer enough:
// https://flueframework.com/docs/guide/database/
export default sqlite(path.join(config.dataDir, 'flue.db'));

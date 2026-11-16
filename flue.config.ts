import { defineConfig } from '@flue/runtime/config';

export default defineConfig({
	target: 'node',
	// The persistence adapter lives with the rest of the database code, not at Flue's default src/db.ts.
	db: './src/db/adapter.ts',
});

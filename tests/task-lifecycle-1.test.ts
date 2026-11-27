/** One part of tests/task-lifecycle.suite.ts, so the runner takes the parts side by side. */
process.env.ANTON_TEST_PART = '1/3';
await import('./task-lifecycle.suite.ts');

export {};

import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The vendored Broker has upstream `node:test` suites that are executed
    // separately by `test:broker`; Vitest must not try to collect them.
    exclude: [...configDefaults.exclude, 'vendor/**'],
    // Live terminal tests create real PTYs and tmux servers. Two hosted-runner
    // workers keep their process and terminal transitions below contention
    // limits while preserving local parallelism.
    minWorkers: 1,
    maxWorkers: process.env.CI ? 2 : 4,
  },
});

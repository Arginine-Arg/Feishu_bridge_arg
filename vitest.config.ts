import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The vendored Broker has upstream `node:test` suites that are executed
    // separately by `test:broker`; Vitest must not try to collect them.
    exclude: [...configDefaults.exclude, 'vendor/**'],
    // Live terminal tests create real PTYs and tmux servers. The default worker
    // count follows host CPU count and can starve those processes in CI.
    minWorkers: 1,
    maxWorkers: 4,
  },
});

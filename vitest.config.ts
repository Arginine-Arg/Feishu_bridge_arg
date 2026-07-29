import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Live terminal tests create real PTYs and tmux servers. The default worker
    // count follows host CPU count and can starve those processes in CI.
    minWorkers: 1,
    maxWorkers: 4,
  },
});

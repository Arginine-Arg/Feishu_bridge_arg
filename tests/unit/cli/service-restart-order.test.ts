import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.LARK_CHANNEL_PROFILE = 'codex';
});

const order = vi.hoisted(() => [] as string[]);
const registry = vi.hoisted(() => ({ reads: 0 }));
const adapter = vi.hoisted(() => ({
  platformName: 'test',
  fileExists: () => true,
  isRunning: () => true,
  servicePath: () => '/tmp/service',
  install: vi.fn(async () => {}),
  start: vi.fn(() => { order.push('start'); return { ok: true, stdout: '', stderr: '' }; }),
  stop: vi.fn(async () => { order.push('stop'); return { ok: true, stdout: '', stderr: '' }; }),
  stopAndDisableAutostart: vi.fn(),
  restart: vi.fn(),
}));

vi.mock('../../../src/daemon/service-adapter', () => ({
  getServiceAdapter: () => adapter,
}));
vi.mock('../../../src/agent/structured/host-registry', () => ({
  terminateProfileHosts: vi.fn(async () => {
    order.push('terminate');
    return { terminated: 1, inUse: 0 };
  }),
}));
vi.mock('../../../src/runtime/profile-runtime', () => ({
  resolveProfileRuntime: vi.fn(async () => ({ cfg: { accounts: { app: { id: 'cli_x' } } } })),
  materializeEnvSecretForService: vi.fn(),
}));
vi.mock('../../../src/runtime/registry', () => ({
  readAndPrune: () => {
    registry.reads += 1;
    return registry.reads === 1
      ? []
      : [{ pid: 42, appId: 'cli_x', profileName: 'codex', botName: 'bot', agentKind: 'codex' }];
  },
}));
vi.mock('../../../src/config/app-paths', () => ({
  resolveAppPaths: () => ({ profile: 'codex', profileDir: '/tmp/profile' }),
}));
vi.mock('../../../src/cli/preflight', () => ({ preFlightChecks: vi.fn() }));
vi.mock('../../../src/cli/commands/migrate', () => ({
  promptAndStopActiveBridgeMigrationConflict: vi.fn(),
}));
vi.mock('../../../src/cli/commands/ps', () => ({ stopProcessEntry: vi.fn() }));
vi.mock('../../../src/runtime/locks', () => ({ checkRuntimeLock: vi.fn() }));

import { runServiceRestart } from '../../../src/cli/commands/service';

describe('service restart order', () => {
  it('stops the bot before reclaiming App Servers so its own socket is not "in use"', async () => {
    order.length = 0;
    registry.reads = 0;
    await runServiceRestart({ profile: 'codex' });
    expect(order).toEqual(['stop', 'terminate', 'start']);
  });
});

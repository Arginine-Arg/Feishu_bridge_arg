import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  connectCodexHost,
  nextHostRetryDelayMs,
  resetHostBreakers,
} from '../../../src/agent/structured/host';

afterEach(() => resetHostBreakers());

describe('Codex App Server spawn circuit breaker', () => {
  it('uses exponential backoff capped at 60 seconds', () => {
    expect(nextHostRetryDelayMs(1, () => 0)).toBe(3_000);
    expect(nextHostRetryDelayMs(2, () => 0)).toBe(6_000);
    expect(nextHostRetryDelayMs(3, () => 0)).toBe(12_000);
    expect(nextHostRetryDelayMs(4, () => 0)).toBe(24_000);
    expect(nextHostRetryDelayMs(10, () => 0)).toBe(60_000);
    expect(nextHostRetryDelayMs(1, () => 0.999)).toBeLessThan(4_000);
  });

  it.skipIf(process.platform === 'win32')('parks the next spawn after an app-server start failure', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'host-backoff-'));
    const options = {
      binary: '/nonexistent/codex-for-backoff-test',
      profileDir: dir,
      scope: 'scope',
      cwd: dir,
      env: {},
    };
    await expect(connectCodexHost(options)).rejects.toBeTruthy();
    await expect(connectCodexHost(options)).rejects.toThrow(/已暂停/u);
  }, 30_000);
});

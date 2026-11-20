import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  loaded: [] as Array<{ id: string }>,
  status: 'idle' as 'idle' | 'active',
  fail: false,
}));

vi.mock('../../../src/agent/structured/rpc', () => ({
  RpcClient: {
    connect: vi.fn(async () => {
      if (state.fail) throw new Error('connect failed');
      return {
        initialize: vi.fn(async () => {}),
        request: vi.fn(async (method: string) => {
          if (method === 'thread/loaded/list') return { data: state.loaded };
          return { thread: { status: { type: state.status } } };
        }),
        close: vi.fn(),
      };
    }),
  },
}));

import { hostIsIdle } from '../../../src/agent/structured/host-registry';

const host = { directory: '/tmp/host' };

describe('host idle probe', () => {
  it('is idle when every loaded thread is idle', async () => {
    state.loaded = [{ id: 'a' }, { id: 'b' }];
    state.status = 'idle';
    state.fail = false;
    await expect(hostIsIdle(host)).resolves.toBe(true);
  });

  it('is busy when any loaded thread is active', async () => {
    state.loaded = [{ id: 'a' }];
    state.status = 'active';
    state.fail = false;
    await expect(hostIsIdle(host)).resolves.toBe(false);
  });

  it('treats an unreadable server as busy', async () => {
    state.fail = true;
    await expect(hostIsIdle(host)).resolves.toBe(false);
  });

  it('probes known threads when the loaded list is empty', async () => {
    state.loaded = [];
    state.status = 'active';
    state.fail = false;
    await expect(hostIsIdle(host, ['known-thread'])).resolves.toBe(false);
  });
});

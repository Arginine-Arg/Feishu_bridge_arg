import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StructuredAdapter } from '../../../src/agent/structured/adapter';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.useRealTimers(); });
const unixIt = process.platform === 'win32' ? it.skip : it;
describe('recovery after bot restart', () => {
  unixIt('subscribes to an existing native main without starting work and /stop cancels its recovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bridge-recovery-restore-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const rpc = new EventEmitter() as EventEmitter & { request: ReturnType<typeof vi.fn>; initialize: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
    let status = 'inProgress';
    rpc.initialize = vi.fn(async () => {}); rpc.close = vi.fn();
    rpc.request = vi.fn(async (method: string) => {
      if (method === 'thread/loaded/list') return { data: ['main'] };
      if (method === 'thread/turns/list') return { data: [{ id: 't', status }] };
      if (method === 'thread/goal/get') return { goal: null };
      if (method === 'thread/resume') return { thread: { id: 'main' } };
      return {};
    });
    const adapter = new StructuredAdapter({ kind: 'codex', binary: 'unused', profileDir: root });
    cleanups.push(() => adapter.shutdown());
    vi.spyOn(adapter as any, 'connectExisting').mockResolvedValue(rpc);
    await (adapter as any).restoreRecoveryObserver('scope', 'main', root, 'unix:///existing.sock', { scope: 'scope', token: 'test', socketPath: '/test.sock' });
    expect(rpc.request.mock.calls.some(([m]) => m === 'thread/resume')).toBe(true);
    expect(rpc.request.mock.calls.some(([m]) => m === 'turn/start' || m === 'thread/start')).toBe(false);
    vi.useFakeTimers();
    status = 'failed';
    rpc.emit('message', { method: 'turn/completed', params: { threadId: 'main', turn: { id: 't', status, error: { codexErrorInfo: 'serverOverloaded', message: 'busy' } } } });
    expect(await adapter.tmux.interrupt!('scope', root)).toBe(true);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(rpc.request.mock.calls.some(([m]) => m === 'turn/start')).toBe(false);
    await adapter.tmux.unbind('scope');
    expect((adapter as any).recoveryObservers.size).toBe(0);
  });
  unixIt('does not create a host or revive an unloaded thread', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bridge-recovery-dormant-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const adapter = new StructuredAdapter({ kind: 'codex', binary: 'unused', profileDir: root });
    cleanups.push(() => adapter.shutdown());
    const rpc = { initialize: vi.fn(async () => {}), request: vi.fn(async () => ({ data: [] })), close: vi.fn() };
    vi.spyOn(adapter as any, 'connectExisting').mockResolvedValue(rpc);
    await (adapter as any).restoreRecoveryObserver('scope', 'main', root, 'unix:///existing.sock', { scope: 'scope', token: 'test', socketPath: '/test.sock' });
    expect(rpc.request).toHaveBeenCalledTimes(1); expect(rpc.close).toHaveBeenCalledOnce();
    expect((adapter as any).recoveryObservers.size).toBe(0);
  });
});

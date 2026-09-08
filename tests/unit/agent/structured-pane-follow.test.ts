import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { StructuredAdapter } from '../../../src/agent/structured/adapter';
import { CodexStructuredSession } from '../../../src/agent/structured/codex';
import { StructuredView } from '../../../src/agent/structured/view';
import type { RpcClient } from '../../../src/agent/structured/rpc';
import type { TmuxPaneTarget } from '../../../src/agent/tmux-control';

const state = vi.hoisted(() => ({ panes: [] as TmuxPaneTarget[] }));
vi.mock('../../../src/agent/structured/tmux-discovery', async importOriginal => ({
  ...await importOriginal<object>(),
  listStructuredTmuxPanes: () => state.panes,
}));

async function harness() {
  const dir = await mkdtemp(join(tmpdir(), 'pane-follow-'));
  const adapter = new StructuredAdapter({ kind: 'codex', binary: '/not-started', profileDir: dir });
  const pane: TmuxPaneTarget = {
    socketPath: '/tmp/example.sock', sessionName: 'selected', windowIndex: '0', paneIndex: '0',
    paneId: '%1', panePid: 123, paneCurrentCommand: 'codex', paneCurrentPath: dir,
    agentKind: 'codex', ownership: 'external', attachCommand: 'tmux attach',
    structured: { endpoint: 'unix:///old.sock', threadId: 'thread-old' },
  };
  const binding = { target: pane, endpoint: pane.structured!.endpoint, threadId: 'thread-old', cwd: dir, updatedAt: Date.now() };
  const rpc = Object.assign(new EventEmitter(), { close: vi.fn(), request: vi.fn() });
  const main = new CodexStructuredSession('thread-old', 'unix:///old.sock', rpc as unknown as RpcClient);
  Reflect.get(adapter, 'bindings').set('scope', binding);
  const previous = { main, view: new StructuredView(join(dir, 'view'), 'test'), bound: binding, cwd: dir };
  Reflect.get(adapter, 'sessions').set('scope', previous);
  const create = vi.spyOn(adapter as never as { createSession: (...args: unknown[]) => Promise<unknown> }, 'createSession').mockResolvedValue(previous);
  state.panes = [pane];
  return { adapter, pane, create, rpc, dir, session: () => Reflect.get(adapter, 'session').call(adapter, { scopeId: 'scope', cwd: dir, runId: 'test', prompt: 'hello' }) };
}

describe('structured binding follows the selected pane', () => {
  it('does not submit to the cached thread after the user exits into a shell', async () => {
    const h = await harness();
    state.panes = [];
    await expect(h.session()).rejects.toThrow('消息未提交到旧 thread');
    expect(h.create).not.toHaveBeenCalled();
    expect(h.rpc.request).not.toHaveBeenCalled();
    await h.adapter.shutdown();
  });

  it('does not follow another pane or mistake a legacy process for a shared server', async () => {
    const h = await harness();
    state.panes = [{ ...h.pane, paneId: '%2' }];
    await expect(h.session()).rejects.toThrow('消息未提交到旧 thread');
    state.panes = [{ ...h.pane, structured: { threadId: 'other', legacy: true } }];
    await expect(h.session()).rejects.toThrow('消息未提交到旧 thread');
    expect(h.create).not.toHaveBeenCalled();
    await h.adapter.shutdown();
  });

  it('reconnects when the same pane resumes another thread', async () => {
    const h = await harness();
    state.panes = [{ ...h.pane, structured: { endpoint: 'unix:///new.sock', threadId: 'thread-new' } }];
    await h.session();
    expect(h.create).toHaveBeenCalledWith('scope', expect.anything(), expect.objectContaining({ endpoint: 'unix:///new.sock', threadId: 'thread-new' }));
    expect(h.rpc.request).not.toHaveBeenCalled();
    await h.adapter.shutdown();
  });

  it('does not reuse a connection just because the thread ID is unchanged', async () => {
    const h = await harness();
    state.panes = [{ ...h.pane, structured: { endpoint: 'unix:///replacement.sock', threadId: 'thread-old' } }];
    await h.session();
    expect(h.create).toHaveBeenCalledWith('scope', expect.anything(), expect.objectContaining({ endpoint: 'unix:///replacement.sock' }));
    await h.adapter.shutdown();
  });
});

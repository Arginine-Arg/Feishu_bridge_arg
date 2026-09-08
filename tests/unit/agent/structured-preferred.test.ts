import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AgentAdapter, AgentEvent } from '../../../src/agent/types';
import type { TmuxPaneTarget } from '../../../src/agent/tmux-control';
import { PreferredStructuredAdapter } from '../../../src/agent/structured/preferred';
const state = vi.hoisted(() => ({ panes: [] as TmuxPaneTarget[] }));
vi.mock('../../../src/agent/tmux-control', async original => ({ ...await original<object>(), listTmuxAgentPanes: () => state.panes }));
vi.mock('../../../src/agent/structured/tmux-discovery', () => ({ listStructuredTmuxPanes: () => state.panes.filter(pane => pane.structured) }));

function backend(structured: boolean): AgentAdapter {
  return {
    id: 'codex', displayName: 'test', isAvailable: async () => true,
    ...(structured ? { structuredControl: vi.fn(async () => []), structuredReady: () => true } : {}),
    run: vi.fn(opts => ({ runId: opts.runId, events: (async function* () { yield { type: 'done', terminationReason: 'normal' } as AgentEvent; })(), stop: vi.fn(), waitForExit: async () => true })),
    tmux: { list: async () => state.panes, bind: vi.fn(async () => state.panes[0]!), unbind: vi.fn(async () => true), status: async () => ({ state: 'none' }) },
  };
}
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'preferred-test-'));
  const structured = backend(true), live = backend(false);
  state.panes = [{ socketPath: '/tmp/tmux.sock', sessionName: 'mine', windowIndex: '0', paneIndex: '0', paneId: '%1', panePid: 100, paneCurrentCommand: 'codex', paneCurrentPath: dir, agentKind: 'codex', ownership: 'external', attachCommand: 'tmux attach' }];
  const adapter = new PreferredStructuredAdapter(structured, live, dir);
  const run = async () => { const events: AgentEvent[] = []; for await (const event of adapter.run({ runId: 'r', scopeId: 's', cwd: dir, prompt: 'exact message' }).events) events.push(event); return events; };
  return { adapter, structured, live, run };
}
describe('structured first with safe native fallback', () => {
  it('binds an existing native process without creating an App Server writer', async () => {
    const h = await setup();
    await h.adapter.tmux.bind('s', '1');
    expect(h.structured.tmux!.bind).not.toHaveBeenCalled();
    expect(h.adapter.forScope('s').structuredControl).toBeUndefined();
    await h.run();
    expect(h.live.run).toHaveBeenCalledTimes(1);
    expect(h.structured.run).not.toHaveBeenCalled();
  });
  it('switches the same pane to structured after a manual shared resume', async () => {
    const h = await setup();
    await h.adapter.tmux.bind('s', '1');
    state.panes[0]!.structured = { endpoint: 'unix:///shared.sock', threadId: 'thread-new' };
    expect(h.adapter.forScope('s').structuredControl).toBeTypeOf('function');
    await h.run();
    expect(h.structured.run).toHaveBeenCalledTimes(1);
    expect(h.live.run).not.toHaveBeenCalled();
  });
  it('does not replay an uncertain structured submission through live', async () => {
    const h = await setup();
    state.panes[0]!.structured = { endpoint: 'unix:///shared.sock', threadId: 'thread' };
    await h.adapter.tmux.bind('s', '1');
    vi.mocked(h.structured.run).mockImplementation(() => { throw new Error('outcome unknown'); });
    const events = await h.run();
    expect(events).toContainEqual(expect.objectContaining({ type: 'error', message: 'outcome unknown' }));
    expect(h.live.run).not.toHaveBeenCalled();
  });
  it('keeps the shell free when the bound agent exits and ignores other panes', async () => {
    const h = await setup();
    await h.adapter.tmux.bind('s', '1');
    state.panes = [{ ...state.panes[0]!, paneId: '%2' }];
    const events = await h.run();
    expect(events).toContainEqual(expect.objectContaining({ type: 'error' }));
    expect(h.live.run).not.toHaveBeenCalled();
    expect(h.structured.run).not.toHaveBeenCalled();
  });
});

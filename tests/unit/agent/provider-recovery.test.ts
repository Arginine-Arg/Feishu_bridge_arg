import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexStructuredSession } from '../../../src/agent/structured/codex';
import type { RpcClient } from '../../../src/agent/structured/rpc';
import type { AgentEvent } from '../../../src/agent/types';
import { normalizeProviderRecovery, isTransientProviderError, type ProviderRecoveryConfig } from '../../../src/config/provider-recovery';
import { initialState, reduce } from '../../../src/card/run-state';

const sessions: CodexStructuredSession[] = [];
afterEach(async () => { for (const s of sessions.splice(0)) await s.close(); vi.useRealTimers(); });
const transient = { message: 'stream disconnected', codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 503 } } };
function harness(policy: Partial<ProviderRecoveryConfig> = {}) {
  vi.useFakeTimers();
  let latest = { id: 't1', status: 'inProgress' };
  let count = 0;
  const rpc = new EventEmitter() as EventEmitter & { request: ReturnType<typeof vi.fn> };
  rpc.request = vi.fn(async (method: string) => {
    if (method === 'turn/start') { latest = { id: `t${++count}`, status: 'inProgress' }; return { turn: latest }; }
    if (method === 'thread/turns/list') return { data: [latest] };
    if (method === 'thread/goal/get') return { goal: null };
    return {};
  });
  const session = new CodexStructuredSession('thread', '', rpc as unknown as RpcClient, undefined, {
    policy: normalizeProviderRecovery(policy), providerIds: ['provider-a'],
  });
  sessions.push(session);
  const events: AgentEvent[] = [];
  const abort = new AbortController();
  const done = session.submit({ runId: 'run', prompt: 'original task', cwd: '/workspace', sandbox: 'read-only' }, e => events.push(e), abort.signal);
  const emit = (method: string, params: Record<string, unknown> = {}) => rpc.emit('message', { method, params: { threadId: 'thread', ...params } });
  const complete = (status: string, error?: object, id = latest.id) => {
    latest = { id, status }; emit('turn/completed', { turn: { ...latest, ...(error ? { error } : {}) } });
  };
  const retry = () => emit('error', { turnId: latest.id, willRetry: true, error: transient });
  const starts = () => rpc.request.mock.calls.filter(([method]) => method === 'turn/start');
  const interrupts = () => rpc.request.mock.calls.filter(([method]) => method === 'turn/interrupt');
  return { session, rpc, done, events, emit, complete, retry, starts, interrupts, abort };
}

describe('provider recovery', () => {
  it('continues a confirmed transient failure after backoff without replaying the task', async () => {
    const h = harness(); await Promise.resolve();
    h.complete('failed', transient);
    await vi.advanceTimersByTimeAsync(29_999); expect(h.starts()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1); expect(h.starts()).toHaveLength(2);
    expect(h.starts()[1]![1]).toEqual({ threadId: 'thread', input: [{ type: 'text', text: expect.stringContaining('do not repeat completed actions') }] });
    expect(h.events.some(e => e.type === 'error')).toBe(false);
    h.complete('completed'); await h.done;
  });
  it('caps attempts even when turn/started arrives after the turn/start response', async () => {
    const h = harness({ maxAttempts: 2, delaySeconds: 5 }); await Promise.resolve();
    for (let i = 1; i <= 2; i++) {
      h.complete('failed', transient);
      await vi.advanceTimersByTimeAsync(5_000 * 2 ** (i - 1));
      h.emit('turn/started', { turn: { id: `t${i + 1}` } });
    }
    h.complete('failed', transient); await h.done;
    await vi.advanceTimersByTimeAsync(600_000);
    expect(h.starts()).toHaveLength(3);
    expect(h.events.filter(e => e.type === 'error')).toHaveLength(1);
  });
  it.each(['unauthorized', 'usageLimitExceeded', 'contextWindowExceeded', 'sandboxError', 'badRequest'])('never retries %s', async code => {
    const h = harness(); await Promise.resolve(); h.complete('failed', { message: '503', codexErrorInfo: code });
    await h.done; await vi.advanceTimersByTimeAsync(600_000); expect(h.starts()).toHaveLength(1);
  });
  it('respects selected providers and disabled recovery', async () => {
    for (const policy of [{ providers: ['provider-b'] }, { enabled: false }]) {
      const h = harness(policy); await Promise.resolve(); h.complete('failed', transient); await h.done;
      await vi.advanceTimersByTimeAsync(600_000); expect(h.starts()).toHaveLength(1);
    }
  });
  it('cancels a pending continuation on stop', async () => {
    const h = harness(); await Promise.resolve(); h.complete('failed', transient);
    expect(await h.session.interrupt()).toBe(true); await h.done;
    await vi.advanceTimersByTimeAsync(600_000); expect(h.starts()).toHaveLength(1);
    expect(h.events).toContainEqual({ type: 'done', terminationReason: 'interrupted' });
  });
  it('does not revive a user-interrupted turn', async () => {
    const h = harness(); await Promise.resolve(); h.retry(); h.complete('interrupted'); await h.done;
    await vi.advanceTimersByTimeAsync(600_000); expect(h.starts()).toHaveLength(1); expect(h.interrupts()).toHaveLength(0);
  });
  it('preempts stalled API retries after 60s and waits for confirmed interruption before continuing', async () => {
    const h = harness(); await Promise.resolve(); h.retry();
    await vi.advanceTimersByTimeAsync(30_000); h.retry();
    await vi.advanceTimersByTimeAsync(29_999); expect(h.interrupts()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1); expect(h.interrupts()).toHaveLength(1); expect(h.starts()).toHaveLength(1);
    h.complete('interrupted');
    await vi.advanceTimersByTimeAsync(4_999); expect(h.starts()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1); expect(h.starts()).toHaveLength(2);
    h.complete('completed'); await h.done;
  });
  it('cancels the stall watchdog when real text or tool progress resumes', async () => {
    const h = harness(); await Promise.resolve(); h.retry();
    await vi.advanceTimersByTimeAsync(59_000);
    h.emit('item/agentMessage/delta', { turnId: 't1', itemId: 'a', delta: 'resumed' });
    await vi.advanceTimersByTimeAsync(120_000); expect(h.interrupts()).toHaveLength(0);
    h.retry(); h.emit('item/started', { turnId: 't1', item: { id: 'cmd', type: 'commandExecution' } }); h.retry();
    await vi.advanceTimersByTimeAsync(120_000); expect(h.interrupts()).toHaveLength(0);
    h.complete('completed'); await h.done;
  });
  it('never continues when the interrupt acknowledgement is missing', async () => {
    const h = harness(); await Promise.resolve(); h.retry();
    await vi.advanceTimersByTimeAsync(75_000); await h.done;
    expect(h.starts()).toHaveLength(1); expect(h.events).toContainEqual(expect.objectContaining({ type: 'error', message: expect.stringContaining('中断确认') }));
  });
  it('stop wins over a watchdog-initiated interrupt', async () => {
    const h = harness(); await Promise.resolve(); h.retry(); await vi.advanceTimersByTimeAsync(60_000);
    await h.session.interrupt(); h.complete('interrupted'); await h.done;
    await vi.advanceTimersByTimeAsync(600_000); expect(h.starts()).toHaveLength(1);
  });
  it('stop invalidates a pending read-only recovery preflight', async () => {
    const h = harness(); await Promise.resolve(); h.complete('failed', transient);
    let resolveRead!: (value: object) => void;
    h.rpc.request.mockImplementationOnce(() => new Promise(resolve => { resolveRead = resolve; }));
    await vi.advanceTimersByTimeAsync(30_000);
    await h.session.interrupt(); resolveRead({ data: [{ id: 't1', status: 'failed' }] });
    await h.done; await vi.advanceTimersByTimeAsync(60_000); expect(h.starts()).toHaveLength(1);
  });
  it('does not interrupt a new native turn after the old retry warning', async () => {
    const h = harness(); await Promise.resolve(); h.retry();
    h.emit('turn/started', { turn: { id: 'native-new' } });
    await vi.advanceTimersByTimeAsync(120_000); expect(h.interrupts()).toHaveLength(0);
    h.complete('completed', undefined, 'native-new'); await h.done;
  });
  it('reconciles corrected complete messages and turn snapshots without duplication', async () => {
    const h = harness(); await Promise.resolve();
    h.emit('item/agentMessage/delta', { turnId: 't1', itemId: 'a', delta: 'Hello wor' });
    const item = { type: 'agentMessage', id: 'a', text: 'hello world — 完整正文' };
    h.emit('item/completed', { turnId: 't1', item });
    h.emit('turn/completed', { turn: { id: 't1', status: 'completed', items: [item] } });
    await h.done;
    const state = h.events.reduce(reduce, initialState);
    expect(state.blocks.filter(b => b.kind === 'text').map(b => b.content).join('')).toBe(item.text);
  });
  it('uses a complete turn snapshot to recover missing final-item notification', async () => {
    const h = harness(); await Promise.resolve();
    h.emit('item/agentMessage/delta', { turnId: 't1', itemId: 'a', delta: '前几个字' });
    h.emit('turn/completed', { turn: { id: 't1', status: 'completed', items: [{ type: 'agentMessage', id: 'a', text: '前几个字之后的完整正文' }] } });
    await h.done;
    expect(h.events.reduce(reduce, initialState).blocks).toContainEqual(expect.objectContaining({ content: '前几个字之后的完整正文' }));
  });
  it('repairs a stale short item completion from the authoritative turn snapshot', async () => {
    const h = harness(); await Promise.resolve();
    h.emit('item/agentMessage/delta', { turnId: 't1', itemId: 'a', delta: 'hello world' });
    h.emit('item/completed', { turnId: 't1', item: { id: 'a', type: 'agentMessage', text: 'hello' } });
    h.emit('item/completed', { turnId: 't1', item: { id: 'a', type: 'agentMessage', text: '' } });
    expect(h.events.reduce(reduce, initialState).blocks).toContainEqual(expect.objectContaining({ content: 'hello world' }));
    h.emit('item/completed', { turnId: 't1', item: { id: 'a', type: 'agentMessage', text: 'hello world' } });
    h.emit('turn/completed', { turn: { id: 't1', status: 'completed', items: [{ id: 'a', type: 'agentMessage', text: 'hello world — corrected' }] } });
    await h.done;
    const blocks = h.events.reduce(reduce, initialState).blocks;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ content: 'hello world — corrected' });
  });
  it('serializes retries when terminal notification precedes the start acknowledgement', async () => {
    const h = harness({ delaySeconds: 5 }); await Promise.resolve();
    const normal = h.rpc.request.getMockImplementation()!;
    let acknowledge!: (value: object) => void;
    h.rpc.request.mockImplementation(async (method: string, ...args: unknown[]) => {
      if (method === 'turn/start' && !acknowledge) {
        await normal(method, ...args);
        return new Promise(resolve => { acknowledge = resolve; });
      }
      return normal(method, ...args);
    });
    h.complete('failed', transient); await vi.advanceTimersByTimeAsync(5_000);
    h.emit('turn/started', { turn: { id: 't2' } }); h.complete('failed', transient);
    await vi.advanceTimersByTimeAsync(10_000); expect(h.starts()).toHaveLength(2);
    acknowledge({ turn: { id: 't2' } }); await vi.advanceTimersByTimeAsync(0);
    expect(h.starts()).toHaveLength(3);
    h.complete('completed'); await h.done;
  });
  it('waits for a starting continuation before observer teardown and interrupts that exact turn', async () => {
    const h = harness({ delaySeconds: 5 }); await Promise.resolve();
    const normal = h.rpc.request.getMockImplementation()!;
    let acknowledge!: (value: object) => void;
    h.rpc.request.mockImplementation(async (method: string, ...args: unknown[]) => {
      if (method === 'turn/start') return new Promise(resolve => { acknowledge = resolve; });
      return normal(method, ...args);
    });
    h.complete('failed', transient); await vi.advanceTimersByTimeAsync(5_000);
    let closed = false;
    const closing = h.session.close().then(() => { closed = true; });
    await Promise.resolve(); expect(closed).toBe(false);
    acknowledge({ turn: { id: 'late-recovery-turn' } }); await closing; await h.done;
    expect(h.interrupts()).toContainEqual(['turn/interrupt', { threadId: 'thread', turnId: 'late-recovery-turn' }]);
    expect(h.starts()).toHaveLength(2);
  });
  it('bounds config and rejects authentication even inside network error variants', () => {
    expect(normalizeProviderRecovery({ maxAttempts: 999, delaySeconds: -1, retryStallSeconds: 0 })).toMatchObject({ maxAttempts: 5, delaySeconds: 5, retryStallSeconds: 0 });
    expect(isTransientProviderError({ codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401 } } })).toBe(false);
  });
});

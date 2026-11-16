import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexStructuredSession } from '../../../src/agent/structured/codex';
import type { RpcClient } from '../../../src/agent/structured/rpc';
import type { AgentEvent } from '../../../src/agent/types';
import { normalizeProviderRecovery, isTransientProviderError, providerRecoveryDelayMs, providerRetryAfterMs, type ProviderRecoveryConfig } from '../../../src/config/provider-recovery';
import { initialState, reduce } from '../../../src/card/run-state';

const sessions: CodexStructuredSession[] = [];
afterEach(async () => { for (const s of sessions.splice(0)) await s.close(); vi.useRealTimers(); });
const transient = { message: 'stream disconnected', codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 503 } } };
const tick = async (ms = 0) => { await vi.advanceTimersByTimeAsync(ms); };
function harness(policy: Partial<ProviderRecoveryConfig> = {}) {
  vi.useFakeTimers();
  let latest: Record<string, any> = { id: 't1', status: 'inProgress' };
  let count = 0;
  const rpc = new EventEmitter() as EventEmitter & { request: ReturnType<typeof vi.fn> };
  rpc.request = vi.fn(async (method: string) => {
    if (method === 'turn/start') { latest = { id: `t${++count}`, status: 'inProgress' }; return { turn: latest }; }
    if (method === 'thread/turns/list') return { data: [latest] };
    if (method === 'thread/goal/get') return { goal: null };
    return {};
  });
  const session = new CodexStructuredSession('thread', '', rpc as unknown as RpcClient, undefined, {
    policy: normalizeProviderRecovery({ version: 2, jitterRatio: 0, ...policy }), providerIds: ['provider-a'],
  });
  sessions.push(session);
  const events: AgentEvent[] = [];
  const abort = new AbortController();
  const done = session.submit({ runId: 'run', prompt: 'original task', cwd: '/workspace', sandbox: 'read-only' }, e => events.push(e), abort.signal);
  const emit = (method: string, params: Record<string, unknown> = {}) => rpc.emit('message', { method, params: { threadId: 'thread', ...params } });
  const complete = (status: string, error?: object, id = latest.id) => {
    latest = { id, status, ...(error ? { error } : {}) }; emit('turn/completed', { turn: latest });
  };
  const retry = () => emit('error', { turnId: latest.id, willRetry: true, error: transient });
  const calls = (method: string) => rpc.request.mock.calls.filter(([m]) => m === method);
  return { session, rpc, done, events, emit, complete, retry, calls, abort, setLatest: (turn: object) => { latest = turn; } };
}

describe('bounded terminal-only provider recovery', () => {
  it('adds zero continue messages for 10,000 native retries and ends its finite monitor', async () => {
    const h = harness(); await tick();
    for (let i = 0; i < 10_000; i++) h.retry();
    await tick(3_600_000);
    expect(h.calls('turn/steer')).toHaveLength(0);
    expect(h.calls('turn/start')).toHaveLength(1);
    expect(h.calls('turn/interrupt')).toHaveLength(0);
    expect(h.calls('thread/turns/list').length).toBeLessThanOrEqual(8);
    expect(h.calls('thread/turns/list').every(([,p]) => p.itemsView !== 'full' && p.limit === 1)).toBe(true);
    expect(h.session.diagnostics().recovery).toMatchObject({ state: 'recovery_exhausted', underlyingTurn: 'running', attempts: 0 });
    expect(h.events.some(e => e.type === 'text' && /continue|Provider/.test(e.delta))).toBe(false);
    h.complete('completed'); await h.done;
  });
  it.each(['silent thinking', 'long tool'])('does not recover or interrupt %s', async mode => {
    const h = harness(); await tick();
    if (mode === 'long tool') h.emit('item/started', { turnId: 't1', item: { type: 'commandExecution', id: 'train' } });
    await tick(12 * 3_600_000);
    expect(h.calls('turn/start')).toHaveLength(1); expect(h.calls('turn/interrupt')).toHaveLength(0);
    expect(h.calls('thread/turns/list')).toHaveLength(0);
    h.complete('completed'); await h.done;
  });
  it('starts one continuation only after confirmed failure and backoff', async () => {
    const h = harness(); await tick(); h.complete('failed', transient);
    await tick(29_999); expect(h.calls('turn/start')).toHaveLength(1);
    await tick(1); expect(h.calls('turn/start')).toHaveLength(2);
    expect(h.calls('turn/start')[1]![1]).toEqual({ threadId: 'thread', clientUserMessageId: expect.stringMatching(/^arg-bridge-recovery-/), input: [{ type: 'text', text: 'continue' }] });
    h.complete('completed'); await h.done;
  });
  it('uses one hour across turns, allowing more than three attempts', async () => {
    const h = harness(); await tick();
    for (let i = 0; i < 4; i++) { h.complete('failed', transient); await tick(Math.min(120, 30 * 2 ** i) * 1000); }
    expect(h.calls('turn/start')).toHaveLength(5);
    await tick(3_600_000);
    h.complete('failed', transient); await tick(); await h.done;
    expect(h.session.diagnostics().recovery).toMatchObject({ state: 'recovery_exhausted', attempts: 4 });
    expect(h.calls('turn/start')).toHaveLength(5); expect(h.calls('turn/interrupt')).toHaveLength(0);
    expect(h.events).toContainEqual(expect.objectContaining({ type: 'error', message: transient.message }));
  });
  it('does not refresh its budget on fragments, repeated status or polling output', async () => {
    const h = harness(); await tick(); h.retry(); await tick();
    for (let i = 0; i < 61; i++) {
      h.emit('item/agentMessage/delta', { turnId: 't1', itemId: 'a', delta: 'checking' });
      h.emit('item/commandExecution/outputDelta', { turnId: 't1', itemId: 'p', delta: '12:00 waiting' });
      h.retry(); await tick(60_000);
    }
    expect(h.session.diagnostics().recovery!.state).toBe('recovery_exhausted');
    h.complete('failed', transient); await tick(); await h.done;
    expect(h.calls('turn/start')).toHaveLength(1);
  });
  it.each(['completed', 'interrupted'])('never auto-runs a %s turn after retry notices', async status => {
    const h = harness(); await tick(); h.retry(); await tick(); h.complete(status);
    await h.done; await tick(7_200_000); expect(h.calls('turn/start')).toHaveLength(1);
  });
  it.each(['unauthorized', 'usageLimitExceeded', 'contextWindowExceeded', 'sandboxError', 'badRequest'])('never retries %s', async code => {
    const h = harness(); await tick(); h.complete('failed', { message: '503', codexErrorInfo: code });
    await h.done; await tick(600_000); expect(h.calls('turn/start')).toHaveLength(1);
  });
  it('respects disabled recovery and provider restrictions', async () => {
    for (const policy of [{ providers: ['provider-b'] }, { enabled: false }]) {
      const h = harness(policy); await tick(); h.complete('failed', transient); await h.done; await tick(600_000);
      expect(h.calls('turn/start')).toHaveLength(1);
    }
  });
  it.each(['/recover off', '/stop', '/goal pause'])('cancels queued recovery and late callbacks after %s', async command => {
    const h = harness(); await tick(); h.complete('failed', transient); await tick();
    if (command === '/stop') await h.session.interrupt(); else await h.session.command(command);
    h.emit('turn/completed', { turn: { id: 't1', status: 'failed', error: transient } });
    await tick(7_200_000); expect(h.calls('turn/start')).toHaveLength(1);
    await h.session.close(); await h.done;
  });
  it('off preserves an active turn and on preserves the deadline', async () => {
    const h = harness(); await tick(); h.retry(); await tick(60_000);
    await h.session.command('/recover off'); await tick(60_000);
    expect((await h.session.command('/recover status'))[0]).toMatchObject({ delta: expect.stringContaining('"enabled": false') });
    await h.session.command('/recover on'); await tick(3_600_000);
    expect(h.calls('turn/interrupt')).toHaveLength(0); expect(h.calls('turn/start')).toHaveLength(1);
    expect(h.session.diagnostics().recovery!.state).toBe('recovery_exhausted');
    h.complete('completed'); await h.done;
  });
  it('treats a status timeout as unknown and ends bounded checks', async () => {
    const h = harness(); await tick(); h.retry();
    const normal = h.rpc.request.getMockImplementation()!;
    h.rpc.request.mockImplementation(async (method: string, ...args: unknown[]) => {
      if (method === 'thread/turns/list') throw new Error('timeout');
      return normal(method, ...args);
    });
    await tick(3_599_999);
    expect(h.calls('turn/start')).toHaveLength(1); expect(h.calls('turn/interrupt')).toHaveLength(0);
    expect(h.calls('thread/turns/list').length).toBeLessThanOrEqual(8);
    expect(h.session.diagnostics().recovery!.underlyingTurn).toBe('unknown');
    h.complete('completed'); await h.done;
  });
  it('does not overlap monitor requests and invalidates a late read on off', async () => {
    const h = harness(); await tick(); h.retry();
    let resolve!: (value: object) => void;
    const normal = h.rpc.request.getMockImplementation()!;
    h.rpc.request.mockImplementation(async (method: string, ...args: unknown[]) => method === 'thread/turns/list'
      ? new Promise(r => { resolve = r; }) : normal(method, ...args));
    await tick(60_000); await tick(600_000); expect(h.calls('thread/turns/list')).toHaveLength(1);
    await h.session.command('/recover off'); resolve({ data: [{ id: 't1', status: 'failed', error: transient }] });
    await tick(600_000); expect(h.calls('turn/start')).toHaveLength(1);
    h.complete('completed'); await h.done;
  });
  it('recovers a missed terminal failure with metadata only', async () => {
    const h = harness(); await tick(); h.retry(); h.setLatest({ id: 't1', status: 'failed', error: transient });
    await tick(90_000); expect(h.calls('turn/start')).toHaveLength(2);
    h.complete('completed'); await h.done;
  });
  it('checks acceptance and never replays an acknowledgement-lost continuation', async () => {
    const h = harness(); await tick(); const normal = h.rpc.request.getMockImplementation()!;
    let operationId = '';
    h.rpc.request.mockImplementation(async (method: string, ...args: any[]) => {
      if (method === 'turn/start') { operationId = args[0].clientUserMessageId; throw new Error('ack lost'); }
      if (method === 'thread/turns/list' && operationId) return { data: [{ id: 't2', status: 'inProgress', items: [{ type: 'userMessage', clientId: operationId }] }] };
      return normal(method, ...args);
    });
    h.complete('failed', transient); await tick(30_000);
    expect(h.session.snapshot().turnId).toBe('t2');
    await tick(600_000); expect(h.calls('turn/start')).toHaveLength(2);
    h.complete('completed', undefined, 't2'); await h.done;
  });
  it('leaves an uncertain submission pending without another start', async () => {
    const h = harness(); await tick(); const normal = h.rpc.request.getMockImplementation()!;
    h.rpc.request.mockImplementation(async (method: string, ...args: unknown[]) => {
      if (method === 'turn/start') throw new Error('ack lost');
      return normal(method, ...args);
    });
    h.complete('failed', transient); await tick(32_000); await h.done; await tick(7_200_000);
    expect(h.calls('turn/start')).toHaveLength(2);
    expect(h.session.diagnostics().recovery!.underlyingTurn).toBe('unknown');
  });
  it('isolates a cancelled preflight from its late successful read', async () => {
    const h = harness(); await tick(); h.complete('failed', transient);
    let resolve!: (value: object) => void; const normal = h.rpc.request.getMockImplementation()!;
    h.rpc.request.mockImplementation(async (method: string, ...args: unknown[]) => method === 'thread/turns/list'
      ? new Promise(r => { resolve = r; }) : normal(method, ...args));
    await tick(30_000); await h.session.command('/recover off');
    resolve({ data: [{ id: 't1', status: 'failed' }] }); await tick(60_000);
    expect(h.calls('turn/start')).toHaveLength(1); await h.done;
  });
  it('honors Retry-After beyond the remaining hour by requesting attention', async () => {
    const h = harness(); await tick(); h.complete('failed', { ...transient, retryAfterSeconds: 4000 });
    await tick(); await h.done; await tick(4_000_000); expect(h.calls('turn/start')).toHaveLength(1);
    expect(h.session.diagnostics().recovery!.state).toBe('recovery_exhausted');
  });
  it('migrates legacy infinite defaults and centralizes jitter and Retry-After', () => {
    expect(normalizeProviderRecovery({ continuous: true, maxAttempts: 0, delaySeconds: 5, retryStallSeconds: 15 }))
      .toMatchObject({ version: 2, continuous: false, budgetSeconds: 3600, delaySeconds: 30, retryStallSeconds: 60, maxAttempts: 0 });
    const config = normalizeProviderRecovery({ version: 2, budgetSeconds: 7200, jitterRatio: 0.2 });
    expect(providerRecoveryDelayMs(config, 1, undefined, 0, () => 0)).toBe(24000);
    expect(providerRecoveryDelayMs(config, 2, undefined, 0, () => 1)).toBe(72000);
    expect(providerRecoveryDelayMs(config, 9, undefined, 0, () => 0.5)).toBe(120000);
    expect(providerRetryAfterMs({ headers: { 'retry-after': '90' } })).toBe(90000);
    expect(providerRetryAfterMs({ headers: { 'retry-after': 'Thu, 01 Jan 1970 00:01:00 GMT' } }, 30000)).toBe(30000);
    expect(providerRecoveryDelayMs(config, 1, { retryAfterSeconds: 180 }, 0, () => 0)).toBe(180000);
  });
  it.each([
    [{ message: '503 overloaded' }, true], [{ message: '429 rate limit' }, true],
    [{ message: 'insufficient balance', codexErrorInfo: 'serverOverloaded' }, false],
    [{ message: 'stream disconnected', codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401 } } }, false],
    [{ message: 'context length exceeded' }, false], [{ message: 'tool timeout', codexErrorInfo: 'sandboxError' }, false],
  ])('classifies %j', (error, retryable) => expect(isTransientProviderError(error)).toBe(retryable));
  it('keeps recovery notices outside assistant answer blocks', async () => {
    const h = harness(); await tick(); h.retry(); await tick();
    expect(h.events.reduce(reduce, initialState).blocks).toEqual([]);
    expect(h.events.reduce(reduce, initialState).recovery?.state).toBe('provider_retrying');
    h.complete('completed'); await h.done;
  });
  it('resets after successful requests inside a continuing goal without ending its relay', async () => {
    const h = harness(); await tick();
    h.emit('thread/goal/updated', { goal: { status: 'active' } });
    const normal = h.rpc.request.getMockImplementation()!;
    h.rpc.request.mockImplementation(async (method: string, ...args: unknown[]) => method === 'thread/goal/get'
      ? { goal: { status: 'active' } } : normal(method, ...args));
    h.complete('failed', transient); await tick(30_000);
    h.complete('completed'); await tick();
    expect(h.session.diagnostics().recovery!.attempts).toBe(0);
    await tick(3_600_000);
    expect(h.session.diagnostics().recovery!.state).toBe('normal');
    h.setLatest({ id: 'native-next', status: 'inProgress' });
    h.emit('turn/started', { turn: { id: 'native-next' } });
    h.complete('failed', transient); await tick(30_000);
    expect(h.calls('turn/start')).toHaveLength(3);
    await h.session.close(); await h.done;
  });
  it('reconciles corrected complete messages and turn snapshots without duplication', async () => {
    const h = harness(); await tick();
    h.emit('item/agentMessage/delta', { turnId: 't1', itemId: 'a', delta: 'Hello wor' });
    const item = { type: 'agentMessage', id: 'a', text: 'hello world — 完整正文' };
    h.emit('item/completed', { turnId: 't1', item });
    h.emit('turn/completed', { turn: { id: 't1', status: 'completed', items: [item] } });
    await h.done;
    const state = h.events.reduce(reduce, initialState);
    expect(state.blocks.filter(b => b.kind === 'text').map(b => b.content).join('')).toBe(item.text);
  });
  it('uses a complete turn snapshot to recover missing final-item notification', async () => {
    const h = harness(); await tick();
    h.emit('item/agentMessage/delta', { turnId: 't1', itemId: 'a', delta: '前几个字' });
    h.emit('turn/completed', { turn: { id: 't1', status: 'completed', items: [{ type: 'agentMessage', id: 'a', text: '前几个字之后的完整正文' }] } });
    await h.done;
    expect(h.events.reduce(reduce, initialState).blocks).toContainEqual(expect.objectContaining({ content: '前几个字之后的完整正文' }));
  });
  it('repairs a stale short item completion from the authoritative turn snapshot', async () => {
    const h = harness(); await tick();
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
});

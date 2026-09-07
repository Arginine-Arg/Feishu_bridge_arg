import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { StructuredAdapter } from '../../../src/agent/structured/adapter';
import { CodexStructuredSession } from '../../../src/agent/structured/codex';
import { StructuredView } from '../../../src/agent/structured/view';
import type { RpcClient } from '../../../src/agent/structured/rpc';
import type { AgentRun } from '../../../src/agent/types';

afterEach(() => vi.restoreAllMocks());
const drain = async (run: AgentRun) => { const events = []; for await (const event of run.events) events.push(event); return events; };

it('routes idle side commands to side rather than changing the main configuration', async () => {
  const rpc = new EventEmitter() as EventEmitter & { request: ReturnType<typeof vi.fn> };
  rpc.request = vi.fn(async () => ({}));
  const main = new CodexStructuredSession('main', '', rpc as unknown as RpcClient);
  const side = new CodexStructuredSession('side', '', rpc as unknown as RpcClient);
  const adapter = new StructuredAdapter({ kind: 'codex', binary: 'not-spawned', profileDir: '/not-used' });
  Reflect.get(adapter, 'sessions').set('scope', { main, side, cwd: '/workspace', view: new StructuredView('/not-used', 'main') });
  await drain(adapter.run({ runId: 'status', scopeId: 'scope', cwd: '/workspace', prompt: '/status', liveInputMode: 'command' }));
  expect(rpc.request).toHaveBeenCalledWith('thread/read', { threadId: 'side', includeTurns: false });
  expect(rpc.request.mock.calls.some(call => call[1]?.threadId === 'main')).toBe(false);
  await side.close(); await main.close();
});

it('serializes a slow side opening with exit and never sends its queued body', async () => {
  const rpc = new EventEmitter() as EventEmitter & { request: ReturnType<typeof vi.fn> };
  let resolveFork!: (value: unknown) => void;
  rpc.request = vi.fn(async method => {
    if (method === 'config/read') return { config: {} };
    if (method === 'thread/fork') return new Promise(resolve => { resolveFork = resolve; });
    return {};
  });
  vi.spyOn(StructuredView.prototype, 'start').mockResolvedValue();
  vi.spyOn(StructuredView.prototype, 'dispose').mockResolvedValue();
  const main = new CodexStructuredSession('main', '', rpc as unknown as RpcClient);
  const adapter = new StructuredAdapter({ kind: 'codex', binary: 'not-spawned', profileDir: '/not-used' });
  Reflect.get(adapter, 'sessions').set('scope', { main, cwd: '/workspace', view: new StructuredView('/not-used', 'main') });
  const opening = drain(adapter.runSide({ runId: 'open', scopeId: 'scope', cwd: '/workspace', prompt: '/btw never send this after exit', liveInputMode: 'side' }));
  await vi.waitFor(() => expect(resolveFork).toBeTypeOf('function'));
  const exiting = drain(adapter.runSide({ runId: 'exit', scopeId: 'scope', cwd: '/workspace', prompt: '/btw out', liveInputMode: 'side-exit' }));
  const repeatedExit = drain(adapter.runSide({ runId: 'exit-again', scopeId: 'scope', cwd: '/workspace', prompt: '/btw out', liveInputMode: 'side-exit' }));
  await Promise.resolve();
  resolveFork({ thread: { id: 'side' } });
  const [openEvents, exitEvents] = await Promise.all([opening, exiting]);
  await repeatedExit;
  expect([...openEvents, ...exitEvents].filter(event => event.type === 'error')).toEqual([]);
  expect(exitEvents).toContainEqual(expect.objectContaining({ type: 'system', sideConversation: 'exited' }));
  expect(rpc.request.mock.calls.some(call => call[0] === 'turn/start' || call[0] === 'turn/interrupt')).toBe(false);
  expect(rpc.request.mock.calls.filter(call => call[0] === 'thread/unsubscribe')).toEqual([['thread/unsubscribe', { threadId: 'side' }]]);
  await main.close();
});

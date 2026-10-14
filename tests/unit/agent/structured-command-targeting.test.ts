import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import {
  StructuredAdapter,
  isMainScopedNativeCommand,
} from '../../../src/agent/structured/adapter';
import { CodexStructuredSession } from '../../../src/agent/structured/codex';
import { StructuredView } from '../../../src/agent/structured/view';
import type { RpcClient } from '../../../src/agent/structured/rpc';
import type { AgentEvent, AgentRun } from '../../../src/agent/types';
import { contentWithoutLeadingMention } from '../../../src/bot/live-input';

afterEach(() => vi.restoreAllMocks());

const drain = async (run: AgentRun): Promise<AgentEvent[]> => {
  const events: AgentEvent[] = [];
  for await (const event of run.events) events.push(event);
  return events;
};

function fakeRpc(handler: (method: string, params: any) => unknown = () => ({})) {
  const rpc = new EventEmitter() as EventEmitter & { request: ReturnType<typeof vi.fn> };
  rpc.request = vi.fn(async (method: string, params: any) => handler(method, params));
  return rpc;
}

function scopeWithSide(rpc: EventEmitter, main: CodexStructuredSession, side: CodexStructuredSession) {
  const adapter = new StructuredAdapter({ kind: 'codex', binary: 'not-spawned', profileDir: '/not-used' });
  Reflect.get(adapter, 'sessions').set('scope', {
    main,
    side,
    cwd: '/workspace',
    view: new StructuredView('/not-used', 'main'),
  });
  return adapter;
}

it('recognizes a slash command that still carries a leading mention', () => {
  expect(contentWithoutLeadingMention('@bot /goal write tests', true)).toBe('/goal write tests');
  expect(contentWithoutLeadingMention('@Araneid_codex_5090_worker01 /model', true)).toBe('/model');
  expect(contentWithoutLeadingMention('@bot hello there', true)).toBe('@bot hello there');
  expect(contentWithoutLeadingMention('/goal plain', true)).toBe('/goal plain');
  expect(contentWithoutLeadingMention('@bot /goal x', false)).toBe('@bot /goal x');
});

it('classifies state-changing native commands as main-scoped', () => {
  for (const command of ['/goal x', '/goal', '/model', '/stop', '/compact']) {
    expect(isMainScopedNativeCommand(command), command).toBe(true);
  }
  // Conversation-following commands stay with the side the user is in.
  for (const command of ['/status', '/skills']) {
    expect(isMainScopedNativeCommand(command), command).toBe(false);
  }
  expect(isMainScopedNativeCommand('/btw something')).toBe(false);
  expect(isMainScopedNativeCommand('plain text')).toBe(false);
});

it('runs /goal on the main thread while a side conversation is open', async () => {
  const rpc = fakeRpc();
  const main = new CodexStructuredSession('main', '', rpc as unknown as RpcClient);
  const side = new CodexStructuredSession('side', '', rpc as unknown as RpcClient);
  const adapter = scopeWithSide(rpc, main, side);

  await drain(adapter.run({
    runId: 'goal', scopeId: 'scope', cwd: '/workspace',
    prompt: '/goal 完成结构化修复', liveInputMode: 'command',
  }));

  const goalCalls = rpc.request.mock.calls.filter(call => call[0] === 'thread/goal/set');
  expect(goalCalls).toHaveLength(1);
  expect(goalCalls[0]?.[1]).toMatchObject({ threadId: 'main', status: 'active' });
  // The side must not receive the goal as a prompt.
  expect(rpc.request.mock.calls.some(call => call[0] === 'turn/start' && call[1]?.threadId === 'side')).toBe(false);
  await main.close(); await side.close();
});

it('answers a /model picker on the thread that owns it', async () => {
  const rpc = fakeRpc((method) => {
    if (method === 'model/list') {
      return { data: [{ id: 'deepseek-chat', displayName: 'DeepSeek Chat', supportedReasoningEfforts: [] }] };
    }
    return {};
  });
  const main = new CodexStructuredSession('main', '', rpc as unknown as RpcClient);
  const side = new CodexStructuredSession('side', '', rpc as unknown as RpcClient);
  const adapter = scopeWithSide(rpc, main, side);

  const events = await drain(adapter.run({
    runId: 'model', scopeId: 'scope', cwd: '/workspace',
    prompt: '/model', liveInputMode: 'command',
  }));
  const menu = events.find(event => event.type === 'interactive');
  const requestId = menu?.type === 'interactive' ? menu.interaction?.id : undefined;
  expect(requestId).toBeTruthy();

  await (adapter as unknown as {
    structuredControl(scope: string, input: string): Promise<AgentEvent[]>;
  }).structuredControl('scope', `/answer ${requestId} 1`);

  expect(rpc.request).toHaveBeenCalledWith('thread/settings/update', { threadId: 'main', model: 'deepseek-chat' });
  await main.close(); await side.close();
});

it('stops the main goal with /stop even while a side handle is open', async () => {
  const rpc = fakeRpc((method) => {
    if (method === 'thread/goal/get') return { goal: { status: 'active' } };
    return {};
  });
  const main = new CodexStructuredSession('main', '', rpc as unknown as RpcClient);
  const side = new CodexStructuredSession('side', '', rpc as unknown as RpcClient);
  const adapter = scopeWithSide(rpc, main, side);

  const stopped = await adapter.tmux.interrupt!('scope', '/workspace', {});

  expect(stopped).toBe(true);
  const pauseCalls = rpc.request.mock.calls.filter(
    call => call[0] === 'thread/goal/set' && call[1]?.status === 'paused',
  );
  expect(pauseCalls).toHaveLength(1);
  expect(pauseCalls[0]?.[1]).toMatchObject({ threadId: 'main' });
  await main.close(); await side.close();
});

it('pauses a goal the local session never observed', async () => {
  const rpc = fakeRpc((method) => {
    if (method === 'thread/goal/get') return { goal: { status: 'active' } };
    return {};
  });
  const session = new CodexStructuredSession('main', '', rpc as unknown as RpcClient);

  await expect(session.interrupt()).resolves.toBe(true);
  expect(rpc.request).toHaveBeenCalledWith('thread/goal/set', { threadId: 'main', status: 'paused' });
  await session.close();
});

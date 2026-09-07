import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { RpcClient } from '../../../src/agent/structured/rpc';
import { CodexStructuredSession } from '../../../src/agent/structured/codex';
import type { AgentEvent } from '../../../src/agent/types';
import { StructuredAdapter } from '../../../src/agent/structured/adapter';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('structured transport contracts', () => {
  it('does not launch a backend to stop or exit a side that does not exist', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'structured-no-spawn-'));
    const adapter = new StructuredAdapter({ kind: 'codex', binary: '/nonexistent/agent', profileDir: directory });
    expect(await adapter.tmux.interrupt!('scope', directory)).toBe(false);
    const events: AgentEvent[] = [];
    for await (const event of adapter.runSide({ runId: 'out', scopeId: 'scope', cwd: directory, prompt: '/btw out', liveInputMode: 'side-exit' }).events) events.push(event);
    expect(events.some(event => event.type === 'error')).toBe(false);
    expect(events.filter(event => event.type === 'text').map(event => event.delta).join('')).toContain('没有已打开');
    await adapter.shutdown();
  });
  it('answers a structured question with its original question ID and exact text', async () => {
    const rpc = new EventEmitter() as EventEmitter & { request: ReturnType<typeof vi.fn>; respond: ReturnType<typeof vi.fn> };
    rpc.request = vi.fn(async () => ({ turn: { id: 't' } }));
    rpc.respond = vi.fn(id => queueMicrotask(() => rpc.emit('message', { method: 'serverRequest/resolved', params: { threadId: 'main', requestId: id } })));
    const session = new CodexStructuredSession('main', '', rpc as unknown as RpcClient);
    const done = session.submit({ runId: 'r', prompt: 'task' }, () => {}, new AbortController().signal);
    await Promise.resolve();
    rpc.emit('message', { id: 9, method: 'item/tool/requestUserInput', params: { threadId: 'main', questions: [{ id: 'database', question: 'Which database?', options: [{ label: 'Postgres' }] }] } });
    expect(session.freeTextRequest()).toBe('9.q0');
    await session.command('/answer 9.q0 exact answer\nsecond line');
    expect(rpc.respond).toHaveBeenCalledWith(9, { answers: { database: { answers: ['exact answer\nsecond line'] } } });
    expect(rpc.request).toHaveBeenCalledTimes(1);
    rpc.emit('message', { method: 'turn/completed', params: { threadId: 'main', turn: { id: 't', status: 'completed' } } });
    await done; await session.close();
  });
  it('keeps a goal relay across turn boundaries and stops only its current turn', async () => {
    const rpc = new EventEmitter() as EventEmitter & { request: ReturnType<typeof vi.fn> };
    rpc.request = vi.fn(async (_method, params) => ({ goal: { status: params.status } }));
    const session = new CodexStructuredSession('main', '', rpc as unknown as RpcClient);
    let finished = false;
    const events: AgentEvent[] = [];
    const done = session.submit({ runId: 'r', prompt: '/goal finish the task', liveInputMode: 'command' }, event => events.push(event), new AbortController().signal).then(() => { finished = true; });
    await new Promise(resolve => setTimeout(resolve, 0));
    rpc.emit('message', { method: 'turn/started', params: { threadId: 'main', turn: { id: 't1' } } });
    rpc.emit('message', { method: 'turn/completed', params: { threadId: 'main', turn: { id: 't1', status: 'completed' } } });
    await Promise.resolve(); expect(finished).toBe(false);
    rpc.emit('message', { method: 'turn/started', params: { threadId: 'main', turn: { id: 't2' } } });
    await session.interrupt();
    expect(rpc.request).toHaveBeenCalledWith('thread/goal/set', { threadId: 'main', status: 'paused' });
    expect(rpc.request).toHaveBeenCalledWith('turn/interrupt', { threadId: 'main', turnId: 't2' });
    expect(finished).toBe(false);
    rpc.emit('message', { method: 'turn/completed', params: { threadId: 'main', turn: { id: 't2', status: 'interrupted' } } });
    await done;
    expect(events.some(event => event.type === 'done' && event.terminationReason === 'interrupted')).toBe(true);
    await session.close();
  });
  it('waits for explicit turn completion, reconciles final text, and ignores other threads', async () => {
    const rpc = new EventEmitter() as EventEmitter & { request: ReturnType<typeof vi.fn> };
    rpc.request = vi.fn(async () => ({ turn: { id: 'turn-1' } }));
    const session = new CodexStructuredSession('main', 'unix:///test', rpc as unknown as RpcClient);
    const events: AgentEvent[] = [];
    let finished = false;
    const done = session.submit({ runId: 'run', prompt: 'exact\nuser input', cwd: '/test' }, event => events.push(event), new AbortController().signal).then(() => { finished = true; });
    await Promise.resolve();
    expect(rpc.request).toHaveBeenCalledWith('turn/start', { threadId: 'main', input: [{ type: 'text', text: 'exact\nuser input' }] });
    rpc.emit('message', { method: 'item/agentMessage/delta', params: { threadId: 'main', turnId: 'turn-1', itemId: 'a', delta: 'hello' } });
    rpc.emit('message', { method: 'turn/completed', params: { threadId: 'side', turn: { id: 'side-turn', status: 'completed' } } });
    await new Promise(resolve => setTimeout(resolve, 30)); expect(finished).toBe(false);
    rpc.emit('message', { method: 'item/completed', params: { threadId: 'main', turnId: 'turn-1', item: { id: 'a', type: 'agentMessage', text: 'hello world' } } });
    rpc.emit('message', { method: 'turn/completed', params: { threadId: 'main', turn: { id: 'turn-1', status: 'completed' } } });
    await done;
    expect(events.filter(event => event.type === 'text').map(event => event.delta).join('')).toBe('hello world');
    expect(session.diagnostics().phase).toBe('idle');
    await session.close();
  });
  it('matches approvals by request ID and never turns a choice into a prompt', async () => {
    const rpc = new EventEmitter() as EventEmitter & { request: ReturnType<typeof vi.fn>; respond: ReturnType<typeof vi.fn> };
    rpc.request = vi.fn(async () => ({ turn: { id: 't' } }));
    rpc.respond = vi.fn(id => queueMicrotask(() => rpc.emit('message', { method: 'serverRequest/resolved', params: { threadId: 'main', requestId: id } })));
    const session = new CodexStructuredSession('main', '', rpc as unknown as RpcClient);
    const events: AgentEvent[] = [];
    const done = session.submit({ runId: 'run', prompt: 'task' }, event => events.push(event), new AbortController().signal);
    await Promise.resolve();
    rpc.emit('message', { id: 71, method: 'item/commandExecution/requestApproval', params: { threadId: 'main', turnId: 't', command: 'echo test', availableDecisions: ['accept', 'decline'] } });
    expect(events.some(event => event.type === 'interactive' && event.interaction?.id === '71')).toBe(true);
    await expect(session.answer('72', '1')).rejects.toThrow();
    await session.answer('71', '2');
    expect(rpc.respond).toHaveBeenCalledWith(71, { decision: 'decline' });
    await expect(session.answer('71', '1')).rejects.toThrow();
    expect(rpc.request).toHaveBeenCalledTimes(1);
    rpc.emit('message', { method: 'turn/completed', params: { threadId: 'main', turn: { id: 't', status: 'completed' } } });
    await done; await session.close();
  });
  it('does not replay a timed-out mutating RPC request', async () => {
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address() as { port: number };
    const requests: unknown[] = [];
    server.on('connection', socket => socket.on('message', data => requests.push(JSON.parse(data.toString()))));
    const client = await RpcClient.connect(`ws://127.0.0.1:${address.port}`);
    try {
      await expect(client.request('turn/start', { threadId: 'a', input: [] }, 25)).rejects.toThrow('outcome unknown');
      expect(requests).toHaveLength(1);
    } finally { client.close(); for (const socket of server.clients) socket.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});

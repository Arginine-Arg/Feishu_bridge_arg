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
import { sendStructuredCard } from '../../../src/card/structured-interaction';

describe('structured transport contracts', () => {
  it('reconciles a timed-out legacy resume with read-only loaded checks and never retries it', async () => {
    let probes = 0;
    const request = vi.fn(async (method: string) => {
        if (method === 'thread/resume') throw new Error('RPC thread/resume timed out; outcome unknown, not retried');
        probes += 1;
        return { data: probes > 1 ? ['thread-1'] : [] };
      });
    const rpc = {
      request,
      close: vi.fn(),
    } as unknown as RpcClient;
    const adapter = new StructuredAdapter({ kind: 'codex', binary: '/nonexistent', profileDir: '/tmp/structured-reconcile-test' });
    const result = await (adapter as unknown as { resumeLegacyThread: Function }).resumeLegacyThread(rpc, 'unix:///tmp/server.sock', 'thread-1', '/workspace');
    expect(result.rpc).toBe(rpc);
    expect(result.result.thread.id).toBe('thread-1');
    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls[0]?.[0]).toBe('thread/resume');
    expect(request.mock.calls.filter(call => call[0] === 'thread/resume')).toHaveLength(1);
    await adapter.shutdown();
  });

  it('prepares native side boundaries before sending text and never interrupts the parent', async () => {
    const rpc = new EventEmitter() as EventEmitter & { request: ReturnType<typeof vi.fn> };
    rpc.request = vi.fn(async (method, params) => {
      if (method === 'config/read') return { config: { developer_instructions: 'Existing policy.' } };
      if (method === 'thread/fork') return { thread: { id: 'child' } };
      if (method === 'turn/start') return { turn: { id: 'child-turn' } };
      return {};
    });
    const main = new CodexStructuredSession('parent', '', rpc as unknown as RpcClient);
    const child = await main.forkSide('/workspace');
    expect(rpc.request.mock.calls.map(call => call[0])).toEqual(['config/read', 'thread/fork', 'thread/inject_items']);
    expect(rpc.request.mock.calls[1]?.[1]).toMatchObject({ threadId: 'parent', ephemeral: true, developerInstructions: expect.stringContaining('Existing policy.') });
    expect(rpc.request.mock.calls[1]?.[1]).not.toHaveProperty('deferGoalContinuation');
    expect(rpc.request.mock.calls[2]?.[1]).toMatchObject({ threadId: 'child', items: [{ role: 'user', content: [{ type: 'input_text', text: expect.stringContaining('It is not your current task.') }] }] });
    const events: AgentEvent[] = [];
    const turn = child.submit({ runId: 'side', prompt: 'Exact side question' }, event => events.push(event), new AbortController().signal);
    await Promise.resolve();
    rpc.emit('message', { method: 'turn/completed', params: { threadId: 'parent', turn: { id: 'main-turn', status: 'completed' } } });
    await child.discardSide();
    await turn;
    expect(rpc.request.mock.calls.filter(call => call[0] === 'turn/start')).toEqual([['turn/start', { threadId: 'child', input: [{ type: 'text', text: 'Exact side question' }] }]]);
    expect(rpc.request.mock.calls.filter(call => call[0] === 'turn/interrupt')).toEqual([['turn/interrupt', { threadId: 'child', turnId: 'child-turn' }]]);
    expect(rpc.request.mock.calls.filter(call => call[0] === 'thread/unsubscribe')).toEqual([['thread/unsubscribe', { threadId: 'child' }]]);
    await main.close();
  });

  it('never submits side text when native boundary preparation fails', async () => {
    const rpc = new EventEmitter() as EventEmitter & { request: ReturnType<typeof vi.fn> };
    rpc.request = vi.fn(async method => {
      if (method === 'config/read') return { config: {} };
      if (method === 'thread/fork') return { thread: { id: 'child' } };
      if (method === 'thread/inject_items') throw new Error('boundary rejected');
      return {};
    });
    const main = new CodexStructuredSession('parent', '', rpc as unknown as RpcClient);
    await expect(main.forkSide()).rejects.toThrow('boundary rejected');
    expect(rpc.request).toHaveBeenLastCalledWith('thread/unsubscribe', { threadId: 'child' });
    expect(rpc.request.mock.calls.some(call => call[0] === 'turn/start' || call[0] === 'turn/interrupt')).toBe(false);
    await main.close();
  });
  it('keeps the request actionable in text when CardKit delivery fails', async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error('card rejected')).mockResolvedValueOnce({});
    await sendStructuredCard({ send } as never, 'chat', {
      id: 'approval-7', prompt: 'Allow the command?', choices: [{ label: 'Deny', value: 'deny' }],
    }, () => 'signed-token', { replyTo: 'message', replyInThread: true });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]?.[1].markdown).toContain('/answer approval-7 deny');
    expect(send.mock.calls[1]?.[2]).toEqual({ replyTo: 'message', replyInThread: true });
  });
  it('does not launch a backend to stop or exit a side that does not exist', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'structured-no-spawn-'));
    const adapter = new StructuredAdapter({ kind: 'codex', binary: '/nonexistent/agent', profileDir: directory });
    expect(await adapter.tmux.interrupt!('scope', directory)).toBe(false);
    const events: AgentEvent[] = [];
    for await (const event of adapter.runSide({ runId: 'out', scopeId: 'scope', cwd: directory, prompt: '/btw out', liveInputMode: 'side-exit' }).events) events.push(event);
    expect(events.some(event => event.type === 'error')).toBe(false);
    expect(events.filter(event => event.type === 'text').map(event => event.delta).join('')).toContain('没有已打开');
    const controlEvents: AgentEvent[] = [];
    for await (const event of adapter.run({ runId: 'cold', scopeId: 'scope', cwd: directory, prompt: '/answer stale deny', liveInputMode: 'control' }).events) controlEvents.push(event);
    expect(controlEvents.find(event => event.type === 'error')).toMatchObject({ message: '没有可恢复的结构化会话；选择操作未启动新任务' });
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
  it('passes the selected YOLO permission policy to every structured turn', async () => {
    const rpc = new EventEmitter() as EventEmitter & { request: ReturnType<typeof vi.fn> };
    rpc.request = vi.fn(async () => ({ turn: { id: 'turn-yolo' } }));
    const session = new CodexStructuredSession('main', 'unix:///test', rpc as unknown as RpcClient);
    const done = session.submit({ runId: 'run-yolo', prompt: 'task', cwd: '/repo', sandbox: 'danger-full-access' }, () => {}, new AbortController().signal);
    await Promise.resolve();
    expect(rpc.request).toHaveBeenCalledWith('turn/start', {
      threadId: 'main',
      input: [{ type: 'text', text: 'task' }],
      sandboxPolicy: { type: 'dangerFullAccess' },
      approvalPolicy: 'never',
    });
    rpc.emit('message', { method: 'turn/completed', params: { threadId: 'main', turn: { id: 'turn-yolo', status: 'completed' } } });
    await done;
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

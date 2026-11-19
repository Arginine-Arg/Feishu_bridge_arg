import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { relayCodexTerminalReplies } from '../../../src/agent/structured/terminal-relay';
import type { RpcClient } from '../../../src/agent/structured/rpc';

describe('terminal reply relay', () => {
  it('delivers authoritative paginated text once and excludes tools, old turns and Feishu input', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ data: [{ item: { type: 'userMessage', clientId: 'native-user' } }], nextCursor: 'more' })
      .mockResolvedValueOnce({ data: [
        { item: { type: 'commandExecution', command: 'tool' } },
        { item: { type: 'agentMessage', phase: 'commentary', text: 'Working' } },
        { item: { type: 'agentMessage', phase: 'final_answer', text: '正文和结尾' } },
      ] });
    const rpc = Object.assign(new EventEmitter(), { request });
    const send = vi.fn(async () => {});
    relayCodexTerminalReplies(rpc as unknown as RpcClient, 'shared', send);
    const notify = (method: string, turn: object, threadId = 'shared') => rpc.emit('message', { method, params: { threadId, turn } });
    notify('turn/completed', { id: 'old', status: 'completed' });
    notify('turn/started', { id: 'native' });
    notify('turn/completed', { id: 'native', status: 'completed' }, 'other');
    notify('turn/completed', { id: 'native', status: 'completed', itemsView: 'summary' });
    notify('turn/completed', { id: 'native', status: 'completed', itemsView: 'summary' });
    notify('turn/started', { id: 'feishu' });
    notify('turn/completed', { id: 'feishu', status: 'completed', itemsView: 'full', items: [
      { type: 'userMessage', clientId: 'arg-bridge-feishu-id' }, { type: 'agentMessage', text: 'already relayed' },
    ] });
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith('native', '正文和结尾'));
    expect(send).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1]?.[1]).toMatchObject({ threadId: 'shared', turnId: 'native', cursor: 'more' });
  });
});

import { expect, it, vi } from 'vitest';
import { verifyNativeProviderSelection } from '../../../src/agent/structured/native-bridge';
import type { RpcClient } from '../../../src/agent/structured/rpc';

const expected = { modelProvider: 'custom', model: 'gpt-6.1-sol' };
it('uses the effective top-level resume identity rather than historical nested metadata', async () => {
  const rpc = { request: vi.fn() };
  await verifyNativeProviderSelection(rpc as unknown as RpcClient, 't', {
    ...expected, thread: { modelProvider: 'old', model: 'gpt-6-luna' },
  }, expected);
  expect(rpc.request).not.toHaveBeenCalled();
});
it('updates an idle already-loaded thread model and verifies the effective result', async () => {
  let model = 'gpt-6-luna';
  const rpc = { request: vi.fn(async (method: string, params: any) => {
    if (method === 'thread/settings/update') { model = params.model; return {}; }
    return { thread: { status: { type: 'idle' }, model } };
  }) };
  await verifyNativeProviderSelection(rpc as unknown as RpcClient, 't', { ...expected, model: 'gpt-6-luna' }, expected);
  expect(rpc.request).toHaveBeenCalledWith('thread/settings/update', { threadId: 't', model: expected.model }, 10000);
  expect(rpc.request.mock.calls.some(([method]) => method === 'turn/start' || method === 'turn/interrupt')).toBe(false);
});
it('keeps active tasks and unexpected providers intact', async () => {
  const rpc = { request: vi.fn(async (_method: string) => ({ thread: { status: { type: 'active' } } })) };
  await expect(verifyNativeProviderSelection(rpc as unknown as RpcClient, 't', { ...expected, model: 'old' }, expected)).rejects.toThrow('活动 turn');
  await expect(verifyNativeProviderSelection(rpc as unknown as RpcClient, 't', { ...expected, modelProvider: 'unexpected' }, expected)).rejects.toThrow('不匹配');
  expect(rpc.request.mock.calls.every(([method]) => method === 'thread/read')).toBe(true);
});
it('reconciles an uncertain settings response without repeating the mutation', async () => {
  let model = 'old';
  const rpc = { request: vi.fn(async (method: string) => {
    if (method === 'thread/settings/update') { model = expected.model; throw new Error('ack lost'); }
    return { thread: { status: { type: 'idle' }, model } };
  }) };
  await verifyNativeProviderSelection(rpc as unknown as RpcClient, 't', { ...expected, model: 'old' }, expected);
  expect(rpc.request.mock.calls.filter(([method]) => method === 'thread/settings/update')).toHaveLength(1);
});

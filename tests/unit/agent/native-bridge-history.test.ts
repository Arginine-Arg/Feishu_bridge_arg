import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  extractAssistantHistory,
  findAdoptedThreadMarker,
  findLatestAdoptedThreadMarker,
  readAdoptionSourceHistory,
  readIdleThread,
  readThreadHistoryFromRollout,
  resolveFollowCurrentProviderSelection,
  type NativeCodexEnvironment,
  type NativeBridgeProviderSelection,
} from '../../../src/agent/structured/native-bridge';
import type { RpcClient } from '../../../src/agent/structured/rpc';

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('Bridge managed native history migration', () => {
  it('falls back to rollout history and reconnects after an oversized RPC frame', async () => {
    const root = await mkdtemp(join(tmpdir(), 'native-adopt-reconnect-'));
    temporary.push(root);
    const threadId = '01a1bc10-2f32-7ad0-992c-1363bf478450';
    const directory = join(root, 'sessions', '2026', '11', '08');
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, `rollout-2026-11-08T00-00-00-${threadId}.jsonl`),
      [
        {
          type: 'response_item',
          ordinal: 1,
          payload: {
            type: 'message',
            id: 'oversized-user',
            role: 'user',
            content: [{ type: 'input_text', text: 'preserve this after reconnect' }],
            internal_chat_message_metadata_passthrough: { turn_id: 'turn-large' },
          },
        },
      ].map(record => JSON.stringify(record)).join('\n') + '\n',
      'utf8',
    );

    let closed = false;
    let reconnects = 0;
    const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === 'thread/read') {
        expect(params).toEqual({ threadId, includeTurns: false });
        return { thread: { id: threadId, status: { type: 'idle' }, turns: [] } };
      }
      if (method === 'thread/turns/list') {
        closed = true;
        throw new Error('Max payload size exceeded');
      }
      throw new Error(`unexpected RPC ${method}`);
    });
    const rpc = {
      request,
      get closed() {
        return closed;
      },
    } as unknown as RpcClient;

    const result = await readIdleThread(rpc, threadId, {
      codexHome: root,
      reconnect: async () => {
        reconnects += 1;
        return rpc;
      },
    });

    expect(extractAssistantHistory(result).items).toEqual([
      expect.objectContaining({
        role: 'user',
        content: [{ type: 'input_text', text: 'preserve this after reconnect' }],
      }),
    ]);
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      'thread/read',
      'thread/turns/list',
    ]);
    expect(reconnects).toBe(1);
  });

  it('streams a bounded text tail from a rollout with an oversized tool output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'native-adopt-rollout-'));
    temporary.push(root);
    const threadId = '01a1bc10-2f32-7ad0-992c-1363bf478450';
    const directory = join(root, 'sessions', '2026', '11', '08');
    await mkdir(directory, { recursive: true });
    const records = [
      {
        type: 'response_item',
        ordinal: 1,
        payload: {
          type: 'message',
          id: 'user-before-tool',
          role: 'user',
          content: [{ type: 'input_text', text: 'question before the large tool output' }],
          internal_chat_message_metadata_passthrough: { turn_id: 'turn-1' },
        },
      },
      {
        type: 'response_item',
        ordinal: 2,
        payload: {
          type: 'function_call_output',
          call_id: 'large-tool',
          output: 'TOOL_OUTPUT_MUST_NOT_BE_COPIED'.repeat(1_300_000),
        },
      },
      {
        type: 'response_item',
        ordinal: 3,
        payload: {
          type: 'message',
          id: 'assistant-after-tool',
          role: 'assistant',
          content: [{
            type: 'output_text',
            text: 'latest answer with sk-this-value-must-be-redacted',
          }],
          internal_chat_message_metadata_passthrough: { turn_id: 'turn-1' },
        },
      },
      {
        type: 'event_msg',
        ordinal: 4,
        payload: {
          type: 'item_completed',
          turn_id: 'turn-2',
          item: {
            type: 'UserMessage',
            id: 'event-only-user',
            content: [{ type: 'text', text: 'event-only follow-up' }],
          },
        },
      },
      {
        type: 'response_item',
        ordinal: 5,
        payload: {
          type: 'message',
          id: 'developer-message',
          role: 'developer',
          content: [{ type: 'input_text', text: 'DEVELOPER_MESSAGE_MUST_NOT_BE_COPIED' }],
        },
      },
    ];
    await writeFile(
      join(directory, `rollout-2026-11-08T00-00-00-${threadId}.jsonl`),
      `${records.map(record => JSON.stringify(record)).join('\n')}\n`,
      'utf8',
    );

    const rollout = await readThreadHistoryFromRollout(root, threadId);
    const history = extractAssistantHistory(rollout!);
    const serialized = JSON.stringify(history);

    expect(history.sourceChars).toBeLessThanOrEqual(48_000);
    expect(serialized).toContain('latest answer with sk-[REDACTED]');
    expect(serialized).toContain('event-only follow-up');
    expect(serialized).not.toContain('TOOL_OUTPUT_MUST_NOT_BE_COPIED');
    expect(serialized).not.toContain('DEVELOPER_MESSAGE_MUST_NOT_BE_COPIED');
  }, 20_000);

  it('prefers the complete rollout when the lineage head owner is already gone', async () => {
    const root = await mkdtemp(join(tmpdir(), 'native-adopt-head-rollout-'));
    temporary.push(root);
    const threadId = '01a1f9ad-b17c-7fc3-a491-2cb9ce037c09';
    const directory = join(root, 'sessions', '2026', '11', '20');
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, `rollout-2026-11-20T23-57-52-${threadId}.jsonl`),
      [
        {
          type: 'response_item',
          ordinal: 1,
          payload: {
            type: 'message',
            id: 'inherited-user',
            role: 'user',
            content: [{ type: 'input_text', text: 'older inherited context' }],
            internal_chat_message_metadata_passthrough: { turn_id: 'turn-1' },
          },
        },
        {
          type: 'response_item',
          ordinal: 2,
          payload: {
            type: 'message',
            id: 'newest-assistant',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'newest answer before the abort' }],
            internal_chat_message_metadata_passthrough: { turn_id: 'turn-2' },
          },
        },
      ].map(record => JSON.stringify(record)).join('\n') + '\n',
      'utf8',
    );

    const request = vi.fn(async () => {
      throw new Error('RPC should not be used when the rollout is readable');
    });
    const rpc = { request } as unknown as RpcClient;
    const result = await readAdoptionSourceHistory({
      profileDir: join(root, 'profile'),
      codexHome: root,
      sourceThreadId: threadId,
      rpc,
      reconnect: async () => rpc,
      lineageHead: true,
    });
    const serialized = JSON.stringify(extractAssistantHistory(result.old));

    expect(serialized).toContain('older inherited context');
    expect(serialized).toContain('newest answer before the abort');
    expect(result.snapshot).toBeUndefined();
    expect(request).not.toHaveBeenCalled();
  });

  it('refuses a lineage head when neither its owner nor its rollout is available', async () => {
    const root = await mkdtemp(join(tmpdir(), 'native-adopt-head-missing-'));
    temporary.push(root);
    const threadId = '01a1f9ad-b17c-7fc3-a491-2cb9ce037c09';
    const rpc = {
      request: vi.fn(async () => {
        throw new Error('provider mismatch');
      }),
    } as unknown as RpcClient;

    await expect(readAdoptionSourceHistory({
      profileDir: join(root, 'profile'),
      codexHome: root,
      sourceThreadId: threadId,
      rpc,
      reconnect: async () => rpc,
      lineageHead: true,
    })).rejects.toThrow(/owner App Server 当前不可用.*provider mismatch/s);
  });

  it('migrates bounded user and assistant text without tool or encrypted items', () => {
    const history = extractAssistantHistory({
      thread: {
        turns: [{
          items: [
            {
              type: 'userMessage',
              content: [
                { type: 'inputText', text: 'keep this context' },
                { type: 'image', path: '/tmp/not-copied.png' },
              ],
            },
            {
              type: 'agentMessage',
              text: 'assistant answer',
            },
            {
              type: 'agentMessage',
              text: 'secret sk-this-value-must-be-redacted',
            },
            {
              type: 'functionCallOutput',
              name: 'shell',
              output: 'tool output must not be copied',
            },
          ],
        }],
      },
    });

    expect(history.items).toEqual([
      expect.objectContaining({
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'keep this context' }],
      }),
      expect.objectContaining({
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'assistant answer' }],
      }),
      expect.objectContaining({
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: expect.stringContaining('sk-[REDACTED]') }],
      }),
    ]);
    expect(JSON.stringify(history)).not.toContain('tool output must not be copied');
    expect(JSON.stringify(history)).not.toContain('/tmp/not-copied.png');
  });

  it('keeps only a bounded recent tail when the old transcript is large', () => {
    const turns = Array.from({ length: 300 }, (_, index) => ({
      items: [{
        type: 'userMessage',
        content: [{ type: 'inputText', text: `${index}:`.padEnd(300, 'x') }],
      }],
    }));
    const history = extractAssistantHistory({ thread: { turns } });
    expect(history.sourceChars).toBeLessThanOrEqual(48_000);
    expect(history.items.length).toBeGreaterThan(0);
    expect(JSON.stringify(history.items)).toContain('299:');
  });

  it('reuses the newest existing adoption instead of creating another thread', async () => {
    const root = await mkdtemp(join(tmpdir(), 'native-adopt-marker-'));
    temporary.push(root);
    const markerPath = join(root, 'broker-threads.json');
    await writeFile(markerPath, JSON.stringify({
      version: 1,
      threads: {
        older: {
          version: 1,
          namespace: 'arg_bridge',
          createdAt: 10,
          adoptedFrom: 'legacy-thread',
        },
        newest: {
          version: 1,
          namespace: 'arg_bridge',
          createdAt: 20,
          adoptedFrom: 'legacy-thread',
        },
        other: {
          version: 1,
          namespace: 'other',
          createdAt: 30,
          adoptedFrom: 'legacy-thread',
        },
      },
    }));

    await expect(findAdoptedThreadMarker(markerPath, 'legacy-thread', 'arg_bridge'))
      .resolves.toEqual({ threadId: 'newest', createdAt: 20 });
  });

  it('never rewinds to an older provider branch after a newer generation exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'native-adopt-provider-marker-'));
    temporary.push(root);
    const markerPath = join(root, 'broker-threads.json');
    await writeFile(markerPath, JSON.stringify({
      version: 1,
      threads: {
        old: {
          version: 1,
          namespace: 'arg_bridge',
          createdAt: 10,
          adoptedFrom: 'legacy-thread',
        },
        providerA: {
          version: 1,
          namespace: 'arg_bridge',
          createdAt: 20,
          adoptedFrom: 'legacy-thread',
          followCurrentProvider: true,
          ccSwitchProviderId: 'provider-a',
          modelProvider: 'codex-a',
          model: 'model-a',
          runtimeFingerprint: 'fingerprint-a',
        },
        providerB: {
          version: 1,
          namespace: 'arg_bridge',
          createdAt: 30,
          adoptedFrom: 'legacy-thread',
          followCurrentProvider: true,
          ccSwitchProviderId: 'provider-b',
          modelProvider: 'codex-b',
          model: 'model-b',
          runtimeFingerprint: 'fingerprint-b',
          previousThreadId: 'providerA',
        },
      },
    }));
    const selector: NativeBridgeProviderSelection = {
      ccSwitchProviderId: 'provider-a',
      modelProvider: 'codex-a',
      model: 'model-a',
      runtimeFingerprint: 'fingerprint-a',
    };

    await expect(findLatestAdoptedThreadMarker(
      markerPath,
      'legacy-thread',
      'arg_bridge',
    )).resolves.toMatchObject({
      threadId: 'providerB',
      previousThreadId: 'providerA',
    });

    await expect(findAdoptedThreadMarker(
      markerPath,
      'legacy-thread',
      'arg_bridge',
      selector,
    )).resolves.toBeUndefined();

    const selectorB: NativeBridgeProviderSelection = {
      ccSwitchProviderId: 'provider-b',
      modelProvider: 'codex-b',
      model: 'model-b',
      runtimeFingerprint: 'fingerprint-b',
    };
    await expect(findAdoptedThreadMarker(
      markerPath,
      'legacy-thread',
      'arg_bridge',
      selectorB,
    )).resolves.toMatchObject({
      threadId: 'providerB',
      followCurrentProvider: true,
      ccSwitchProviderId: 'provider-b',
      runtimeFingerprint: 'fingerprint-b',
    });
  });

  it('requires a resolvable current provider, model and credential before follow-provider migration', () => {
    const prepared = (overrides: Partial<NativeCodexEnvironment> = {}): NativeCodexEnvironment => ({
      env: {},
      thirdParty: true,
      credential: {
        env: { OPENAI_API_KEY: 'must-not-be-fingerprinted-directly' },
        provider: 'codex-provider',
        envKey: 'OPENAI_API_KEY',
        injected: true,
        missingToken: false,
      },
      runtimeIdentity: {
        ccSwitchProviderId: 'cc-switch-provider',
        codexProviderId: 'codex-provider',
        model: 'model-current',
        recordedAt: 123,
      },
      fingerprint: {
        credentials: { OPENAI_API_KEY: 'credential-fingerprint' },
        networkMode: 'inherit:third-party-direct',
        configStamp: 'config-stamp',
        authStamp: 'auth-stamp',
      },
      ...overrides,
    });

    expect(resolveFollowCurrentProviderSelection(prepared())).toMatchObject({
      ccSwitchProviderId: 'cc-switch-provider',
      modelProvider: 'codex-provider',
      model: 'model-current',
      runtimeFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(resolveFollowCurrentProviderSelection(prepared()).runtimeFingerprint)
      .not.toContain('must-not-be-fingerprinted-directly');

    expect(() => resolveFollowCurrentProviderSelection(prepared({
      credential: {
        env: {},
        provider: 'codex-provider',
        envKey: 'OPENAI_API_KEY',
        injected: false,
        missingToken: true,
      },
    }))).toThrow(/缺少凭据字段 OPENAI_API_KEY/);

    expect(() => resolveFollowCurrentProviderSelection(prepared({
      runtimeIdentity: {
        ccSwitchProviderId: 'cc-switch-provider',
        codexProviderId: 'codex-provider',
        recordedAt: 123,
      },
    }))).toThrow(/无法解析当前 Codex model/);
  });
});

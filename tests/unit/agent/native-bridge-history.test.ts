import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  extractAssistantHistory,
  findAdoptedThreadMarker,
  resolveFollowCurrentProviderSelection,
  type NativeCodexEnvironment,
  type NativeBridgeProviderSelection,
} from '../../../src/agent/structured/native-bridge';

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('Bridge managed native history migration', () => {
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
    const turns = Array.from({ length: 100 }, (_, index) => ({
      items: [{
        type: 'userMessage',
        content: [{ type: 'inputText', text: `${index}:`.padEnd(300, 'x') }],
      }],
    }));
    const history = extractAssistantHistory({ thread: { turns } });
    expect(history.sourceChars).toBeLessThanOrEqual(12_000);
    expect(history.items.length).toBeGreaterThan(0);
    expect(JSON.stringify(history.items)).toContain('99:');
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

  it('selects the adoption generation for the requested provider fingerprint', async () => {
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
        },
      },
    }));
    const selector: NativeBridgeProviderSelection = {
      ccSwitchProviderId: 'provider-a',
      modelProvider: 'codex-a',
      model: 'model-a',
      runtimeFingerprint: 'fingerprint-a',
    };

    await expect(findAdoptedThreadMarker(
      markerPath,
      'legacy-thread',
      'arg_bridge',
      selector,
    )).resolves.toMatchObject({
      threadId: 'providerA',
      followCurrentProvider: true,
      ccSwitchProviderId: 'provider-a',
      runtimeFingerprint: 'fingerprint-a',
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

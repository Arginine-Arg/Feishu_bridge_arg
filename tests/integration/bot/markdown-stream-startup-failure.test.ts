import type { NormalizedMessage } from '@larksuite/channel';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import {
  createRootConfig,
  loadRootConfig,
  saveRootConfig,
} from '../../../src/config/profile-store.js';
import { log } from '../../../src/core/logger.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { FakeAgentAdapter } from '../../helpers/fake-agent.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

const sdkMock = vi.hoisted(() => ({
  channel: undefined as FakeLarkChannel | undefined,
  createLarkChannel: vi.fn(() => {
    if (!sdkMock.channel) throw new Error('fake channel not configured');
    return sdkMock.channel;
  }),
}));

vi.mock('@larksuite/channel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@larksuite/channel')>();
  return {
    ...actual,
    createLarkChannel: sdkMock.createLarkChannel,
  };
});

import { startChannel } from '../../../src/bot/channel.js';

interface MessageHandlerMap {
  message?: (msg: NormalizedMessage) => Promise<void> | void;
}

interface FakeLarkChannel {
  botIdentity: { openId: string; name: string };
  handlers: MessageHandlerMap;
  sent: Array<{ chatId: string; content: unknown; options?: unknown }>;
  rawClient: {
    request: ReturnType<typeof vi.fn>;
    application: {
      v6: {
        application: {
          get: ReturnType<typeof vi.fn>;
        };
      };
    };
    im: {
      v1: {
        message: {
          get: ReturnType<typeof vi.fn>;
        };
        messageReaction: {
          create: ReturnType<typeof vi.fn>;
          delete: ReturnType<typeof vi.fn>;
        };
      };
    };
  };
  on(handlers: MessageHandlerMap): void;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getChatMode(chatId: string): Promise<'group' | 'topic'>;
  getConnectionStatus(): { state: 'connected'; reconnectAttempts: number };
  send(chatId: string, content: unknown, options?: unknown): Promise<void>;
  stream(chatId: string, input: unknown, options?: unknown): Promise<void>;
  addReaction(messageId: string, emojiType: string): Promise<string>;
  removeReaction(messageId: string, reactionId: string): Promise<void>;
}

type StreamFn = FakeLarkChannel['stream'];

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  sdkMock.channel = undefined;
  sdkMock.createLarkChannel.mockClear();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('markdown stream startup failures', () => {
  it.each(['markdown', 'card'] as const)(
    'delivers an oversized academic answer completely in %s mode',
    async (messageReply) => {
      const markdownUpdates: string[] = [];
      const cardUpdates: object[] = [];
      const h = await createHarness({
        stream: async (_chatId, input) => {
          if (messageReply === 'markdown') {
            const producer = (input as {
              markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void>;
            }).markdown;
            if (!producer) throw new Error('expected markdown stream producer');
            await producer({
              setContent: async (markdown) => {
                markdownUpdates.push(markdown);
              },
            });
            return;
          }
          const producer = (input as {
            card?: { producer?: (ctrl: { update(next: object): Promise<void> }) => Promise<void> };
          }).card?.producer;
          if (!producer) throw new Error('expected card stream producer');
          await producer({
            update: async (next) => {
              cardUpdates.push(next);
            },
          });
        },
      });
      h.profileConfig.preferences = { ...(h.profileConfig.preferences ?? {}), messageReply };
      h.controls.profileConfig.preferences = h.profileConfig.preferences;
      h.controls.cfg.preferences = h.profileConfig.preferences;

      const longAnswer = [
        '一、完整训练结构',
        'Bio Transformer -> chemical queries -> shared DeFoG flow',
        '二、验证门：correct-own > shuffled-cross',
        '每个阶段都必须保留生物学含义和化学条件控制。',
      ].join('\n\n').repeat(180) + '\n\n最终结论：先完成 teacher-forced probe，再进入 blind sampling。';
      h.agent.setEvents([
        [{ type: 'text', delta: longAnswer }, { type: 'done', terminationReason: 'normal' }],
      ]);
      await startTestBridge(h);

      await h.channel.handlers.message?.(message(`om_long_answer_${messageReply}`, 'summarize the design'));
      await waitFor(() =>
        h.channel.sent.some((item) => JSON.stringify(item.content).includes('最终结论：先完成 teacher-forced probe')),
      );

      const delivered = h.channel.sent
        .map((item) => (item.content as { markdown?: string }).markdown ?? '')
        .join('\n\n');
      expect(delivered).toContain('一、完整训练结构');
      expect(delivered).toContain('最终结论：先完成 teacher-forced probe，再进入 blind sampling。');
      expect(h.channel.sent.length).toBeGreaterThan(1);
      expect(
        JSON.stringify(messageReply === 'markdown' ? markdownUpdates : cardUpdates),
      ).toContain('正文较长');
    },
  );

  it.each(['markdown', 'card'] as const)(
    'keeps a redrawn terminal table aligned and delivers the complete final analysis once in %s streams',
    async (messageReply) => {
      const markdownUpdates: string[] = [];
      const cardUpdates: object[] = [];
      const h = await createHarness({
        stream: async (_chatId, input) => {
          if (messageReply === 'markdown') {
            const producer = (input as {
              markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void>;
            }).markdown;
            if (!producer) throw new Error('expected markdown stream producer');
            await producer({
              setContent: async (markdown) => {
                markdownUpdates.push(markdown);
              },
            });
            return;
          }

          const producer = (input as {
            card?: { producer?: (ctrl: { update(next: object): Promise<void> }) => Promise<void> };
          }).card?.producer;
          if (!producer) throw new Error('expected card stream producer');
          await producer({
            update: async (next) => {
              cardUpdates.push(next);
            },
          });
        },
      });
      h.profileConfig.preferences = { ...(h.profileConfig.preferences ?? {}), messageReply };
      h.controls.profileConfig.preferences = h.profileConfig.preferences;
      h.controls.cfg.preferences = h.profileConfig.preferences;

      const intro = '• 当前可以把多版本实验归纳为一句话：条件表征需要先校准。';
      const terminalHeader = '问题 结果 结论';
      const terminalRule = '━━━━ ━━━━ ━━━━';
      const firstRow = 'MMELON    correct > shuffled    条件进入生成器';
      const secondRow = 'Bio    尚未通过分子级 gate    暂不作生物学结论';
      const finalTail = '对 TBDD 建模的启示：使用 scaffold-disjoint 多指标 gate。';
      h.agent.setEvents([
        [
          { type: 'text', source: 'live-terminal', sequence: 1, delta: `${intro}\n` },
          {
            type: 'text',
            source: 'live-terminal',
            sequence: 2,
            delta: `${intro}\n• Explored\n└ Read stablefate_v126_cgate_interpretation.md\n`,
          },
          {
            type: 'text',
            source: 'live-terminal',
            sequence: 3,
            delta: `${intro}\n| 问题 | 结果 | 结论 |\n| --- | --- | --- |\n${terminalHeader}\n${terminalRule}\n${firstRow}\n`,
          },
          {
            type: 'text',
            source: 'live-terminal',
            sequence: 4,
            delta: `${intro}\n${firstRow}\n${secondRow}\n\n${finalTail}\n`,
          },
          { type: 'done', terminationReason: 'normal' },
        ],
      ]);
      await startTestBridge(h);

      await h.channel.handlers.message?.(message(`om_terminal_table_${messageReply}`, 'summarize results'));
      await waitFor(() => {
        const delivered = messageReply === 'markdown'
          ? markdownUpdates.at(-1) ?? ''
          : JSON.stringify(cardUpdates.at(-1) ?? {});
        return delivered.includes(finalTail);
      });

      const delivered = messageReply === 'markdown'
        ? markdownUpdates.at(-1) ?? ''
        : JSON.stringify(cardUpdates.at(-1) ?? {});
      expect(delivered).toContain('PLAIN_TEXT');
      expect(delivered.match(/当前可以把多版本实验归纳/g)).toHaveLength(1);
      expect(delivered.match(/Read stablefate_v126_cgate_interpretation/g)).toHaveLength(1);
      expect(delivered.match(/问题 结果 结论/g)).toHaveLength(1);
      expect(delivered.match(/MMELON/g)).toHaveLength(1);
      expect(delivered.match(/Bio/g)).toHaveLength(1);
      expect(delivered.match(/对 TBDD 建模的启示/g)).toHaveLength(1);
      expect(delivered).not.toContain('| 问题 | 结果 | 结论 |');
      expect(delivered).not.toContain('| --- | --- | --- |');
    },
  );

  it.each(['markdown', 'card'] as const)(
    'delivers terminal reflow history once and retains the final tail in %s streams',
    async (messageReply) => {
      const markdownUpdates: string[] = [];
      const cardUpdates: object[] = [];
      const h = await createHarness({
        stream: async (_chatId, input) => {
          if (messageReply === 'markdown') {
            const producer = (input as {
              markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void>;
            }).markdown;
            if (!producer) throw new Error('expected markdown stream producer');
            await producer({
              setContent: async (markdown) => {
                markdownUpdates.push(markdown);
              },
            });
            return;
          }

          const producer = (input as {
            card?: {
              producer?: (ctrl: {
                update(next: object | ((current: object) => object)): Promise<void>;
              }) => Promise<void>;
            };
          }).card?.producer;
          if (!producer) throw new Error('expected card stream producer');
          await producer({
            update: async (next) => {
              if (typeof next === 'function') throw new Error('unexpected card updater function');
              cardUpdates.push(next);
            },
          });
        },
      });
      h.profileConfig.preferences = {
        ...(h.profileConfig.preferences ?? {}),
        messageReply,
      };
      h.controls.profileConfig.preferences = h.profileConfig.preferences;
      h.controls.cfg.preferences = h.profileConfig.preferences;
      h.agent.setEvents([
        [
          {
            type: 'text',
            source: 'live-terminal',
            sequence: 1,
            delta: '• inspect the stream\n• verify the queue\n',
          },
          {
            type: 'text',
            source: 'live-terminal',
            sequence: 2,
            delta: '• inspect\n  the stream\n• verify the queue\n• retain the final tail\n',
          },
          { type: 'done', terminationReason: 'normal' },
        ],
      ]);
      await startTestBridge(h);

      await h.channel.handlers.message?.(message(`om_reflow_${messageReply}`, 'inspect progress'));
      await waitFor(() =>
        (messageReply === 'markdown' ? markdownUpdates : cardUpdates.map((update) => JSON.stringify(update))).some((update) =>
          update.includes('retain the final tail'),
        ),
      );

      const delivered = messageReply === 'markdown'
        ? markdownUpdates.at(-1) ?? ''
        : JSON.stringify(cardUpdates.at(-1) ?? {});
      expect(delivered.match(/inspect the stream/g)).toHaveLength(1);
      expect(delivered.match(/verify the queue/g)).toHaveLength(1);
      expect(delivered.match(/retain the final tail/g)).toHaveLength(1);
      expect(delivered).not.toContain('inspect\\n  the stream');
    },
  );

  it.each(['markdown', 'card'] as const)(
    'repairs an internal terminal-history replay and retains the final tail in %s streams',
    async (messageReply) => {
      const markdownUpdates: string[] = [];
      const cardUpdates: object[] = [];
      const h = await createHarness({
        stream: async (_chatId, input) => {
          if (messageReply === 'markdown') {
            const producer = (input as {
              markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void>;
            }).markdown;
            if (!producer) throw new Error('expected markdown stream producer');
            await producer({
              setContent: async (markdown) => {
                markdownUpdates.push(markdown);
              },
            });
            return;
          }
          const producer = (input as {
            card?: { producer?: (ctrl: { update(next: object): Promise<void> }) => Promise<void> };
          }).card?.producer;
          if (!producer) throw new Error('expected card stream producer');
          await producer({
            update: async (next) => {
              cardUpdates.push(next);
            },
          });
        },
      });
      h.profileConfig.preferences = { ...(h.profileConfig.preferences ?? {}), messageReply };
      h.controls.profileConfig.preferences = h.profileConfig.preferences;
      h.controls.cfg.preferences = h.profileConfig.preferences;
      const history = [
        '• inspect the stream and delivery state',
        '• verify terminal history anchoring',
        '• retain the final answer after rollover',
      ].join('\n') + '\n';
      h.agent.setEvents([
        [
          { type: 'text', source: 'live-terminal', sequence: 1, delta: history },
          {
            type: 'text',
            source: 'live-terminal',
            sequence: 2,
            delta: `• inspect the remaining renderer path\n${history}• FINAL_COMPLETION_MESSAGE\n`,
          },
          { type: 'done', terminationReason: 'normal' },
        ],
      ]);
      await startTestBridge(h);

      await h.channel.handlers.message?.(message(`om_internal_replay_${messageReply}`, 'inspect progress'));
      await waitFor(() => {
        const delivered = messageReply === 'markdown'
          ? markdownUpdates.at(-1) ?? ''
          : JSON.stringify(cardUpdates.at(-1) ?? {});
        return delivered.includes('FINAL_COMPLETION_MESSAGE');
      });

      const delivered = messageReply === 'markdown'
        ? markdownUpdates.at(-1) ?? ''
        : JSON.stringify(cardUpdates.at(-1) ?? {});
      expect(delivered.match(/inspect the stream and delivery state/g)).toHaveLength(1);
      expect(delivered.match(/verify terminal history anchoring/g)).toHaveLength(1);
      expect(delivered).toContain('FINAL_COMPLETION_MESSAGE');
    },
  );

  it('suppresses a replayed Feishu message before it can start a second agent turn', async () => {
    const h = await createHarness();
    h.profileConfig.preferences = {
      ...(h.profileConfig.preferences ?? {}),
      messageReply: 'text',
      messageReplyMigrated: true,
    };
    h.controls.profileConfig.preferences = h.profileConfig.preferences;
    h.controls.cfg.preferences = h.profileConfig.preferences;
    h.agent.setEvents([
      [{ type: 'text', delta: 'one response\n' }, { type: 'done', terminationReason: 'normal' }],
    ]);
    await startTestBridge(h);

    const replay = message('om_same_delivery', 'continue once');
    await Promise.all([
      h.channel.handlers.message?.(replay),
      h.channel.handlers.message?.(replay),
    ]);
    await waitFor(() => h.agent.runOptions.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 800));

    expect(h.agent.runOptions).toHaveLength(1);
    expect(userTextOrNative(h.agent.runOptions[0]?.prompt ?? '')).toBe('continue once');
  }, 10_000);

  it('waits for startup interaction input before replaying the original task', async () => {
    const h = await createHarness();
    h.profileConfig.preferences = {
      ...(h.profileConfig.preferences ?? {}),
      agentSessionMode: 'live',
      messageReply: 'text',
      messageReplyMigrated: true,
    };
    h.controls.profileConfig.preferences = h.profileConfig.preferences;
    h.controls.cfg.preferences = h.profileConfig.preferences;
    h.agent.setEvents([
      [
        {
          type: 'interactive',
          phase: 'startup',
          text: [
            'WARNING: Claude Code running in Bypass Permissions mode',
            '❯ 1. No, exit',
            '2. Yes, I accept',
            'Enter to confirm · Esc to cancel',
          ].join('\n'),
        },
        { type: 'done', terminationReason: 'normal' },
      ],
      [{ type: 'done', terminationReason: 'normal' }],
      [{ type: 'text', delta: 'original task completed\n' }, { type: 'done', terminationReason: 'normal' }],
    ]);
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_startup_task', 'original task'));
    await waitFor(() => h.agent.runOptions.length === 1 && h.channel.sent.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 800));

    expect(h.agent.runOptions.map((options) => userTextOrNative(options.prompt))).toEqual(['original task']);
    expect(buttonLabels((h.channel.sent[0]?.content as { card?: unknown }).card)).toEqual([
      '1',
      '2',
      'esc',
    ]);

    await h.channel.handlers.message?.(message('om_startup_choice', 'down enter'));
    await waitFor(() => h.agent.runOptions.length === 3, 4000);

    expect(h.agent.runOptions.map((options) => userTextOrNative(options.prompt))).toEqual([
      'original task',
      'down enter',
      'original task',
    ]);
    expect(h.agent.runOptions.map((options) => options.liveInputMode)).toEqual([
      undefined,
      'control',
      undefined,
    ]);
  }, 10_000);

  it('sends native live picker output as a final button card without streaming', async () => {
    const h = await createHarness({
      stream: async () => {
        throw new Error('native live picker output should not use stream');
      },
    });
    h.profileConfig.preferences = {
      ...(h.profileConfig.preferences ?? {}),
      messageReply: 'markdown',
    };
    h.agent.setEvents([
      [
        {
          type: 'text',
          delta: [
            'Select Model and Effort',
            'Access legacy models by running codex -m <model_name> or in your config.toml',
            '',
            '› 1. gpt-5.5 (current)',
            '2. gpt-5.4',
            'Press enter to confirm or esc to go back',
          ].join('\n'),
        },
        { type: 'done', terminationReason: 'normal' },
      ],
    ]);
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_model', '/codex /model'));
    await waitFor(() => h.channel.sent.length === 1);
    await settle();

    const content = h.channel.sent.at(-1)?.content as { card?: unknown } | undefined;
    expect(h.channel.sent).toHaveLength(1);
    expect(content?.card).toBeDefined();
    expect(JSON.stringify(content?.card)).toContain('live CLI 正在等待选择');
    expect(buttonLabels(content?.card)).toEqual(['1', '2', 'enter', 'esc']);
  });

  it('uses the native Codex model picker and syncs its selection into later turn runs', async () => {
    const h = await createHarness();
    h.profileConfig.preferences = {
      ...(h.profileConfig.preferences ?? {}),
      messageReply: 'text',
      model: 'gpt-5.5',
      reasoningEffort: 'medium',
    };
    h.controls.profileConfig.preferences = h.profileConfig.preferences;
    h.controls.cfg.preferences = h.profileConfig.preferences;
    h.profileConfig.access.allowedChats = ['oc_dm'];
    h.agent.setEvents([
      [
        {
          type: 'text',
          delta: [
            'Select Model and Effort',
            '1. gpt-5.6-sol (default)',
            '2. gpt-5.6-terra',
            '3. gpt-5.6-luna',
            '4. gpt-5.5 (current)',
            '5. gpt-5.4',
            '6. gpt-5.4-mini',
            '7. gpt-5.2',
            'Press enter to confirm or esc to go back',
          ].join('\n'),
        },
        { type: 'done', terminationReason: 'normal' },
      ],
      [
        {
          type: 'text',
          delta: '• Model changed to gpt-5.6-sol medium',
        },
        {
          type: 'text',
          delta: [
            'Select Reasoning Level for gpt-5.6-sol',
            '1. Low',
            '2. Medium',
            '3. High',
            '4. Extra high',
            '5. Max',
            '6. Ultra',
            'Press enter to confirm or esc to go back',
          ].join('\n'),
        },
        { type: 'done', terminationReason: 'normal' },
      ],
      [
        { type: 'text', delta: '• Model changed to gpt-5.6-sol ultra\n' },
        { type: 'done', terminationReason: 'normal' },
      ],
      [
        { type: 'text', delta: 'ordinary turn complete\n' },
        { type: 'done', terminationReason: 'normal' },
      ],
    ]);
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_plain_model', '/model'));
    await waitFor(() => h.agent.runOptions.length === 1 && h.channel.sent.length >= 1);
    expect(h.agent.runOptions[0]).toMatchObject({ prompt: '/model', liveInputMode: 'command' });
    expect(buttonLabels((h.channel.sent[0]?.content as { card?: unknown }).card)).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
      'enter',
      'esc',
    ]);

    await h.channel.handlers.message?.(message('om_model_choice', '/codex 1'));
    await waitFor(() => h.agent.runOptions.length === 2 && h.channel.sent.length >= 2);
    expect(buttonLabels((h.channel.sent[1]?.content as { card?: unknown }).card)).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
      'enter',
      'esc',
    ]);
    expect(h.controls.profileConfig.preferences).toMatchObject({
      model: 'gpt-5.5',
      reasoningEffort: 'medium',
    });

    await h.channel.handlers.message?.(message('om_effort_choice', '/model 6'));
    await waitFor(
      () =>
        h.controls.profileConfig.preferences.model === 'gpt-5.6-sol' &&
        h.controls.profileConfig.preferences.reasoningEffort === 'ultra',
      4000,
    );
    expect(h.agent.runOptions[2]).toMatchObject({ prompt: '6', liveInputMode: 'control' });

    const root = await loadRootConfig(h.controls.configPath);
    expect(root?.profiles.codex?.preferences).toMatchObject({
      model: 'gpt-5.6-sol',
      reasoningEffort: 'ultra',
    });

    await h.channel.handlers.message?.(message('om_ordinary_turn', 'continue the task'));
    await waitFor(() => h.agent.runOptions.length === 4);
    expect(h.agent.runOptions[3]).toMatchObject({
      sessionMode: 'live',
      model: 'gpt-5.6-sol',
      reasoningEffort: 'ultra',
    });
  });

  it('keeps all practical Codex model-picker choices and accepts /codex model shorthand', async () => {
    const h = await createHarness({
      stream: async () => {
        throw new Error('native model picker output should not use stream');
      },
    });
    const choices = Array.from(
      { length: 12 },
      (_, index) => `${index === 0 ? '› ' : ''}${index + 1}. gpt-5.${index + 1}${index === 0 ? ' (current)' : ''}`,
    );
    h.agent.setEvents([
      [
        {
          type: 'text',
          delta: ['Select Model and Effort', ...choices, 'Press enter to confirm or esc to go back'].join('\n'),
        },
        { type: 'done', terminationReason: 'normal' },
      ],
    ]);
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_prefixed_model', '/codex model'));
    await waitFor(() => h.agent.runOptions.length === 1 && h.channel.sent.length === 1);

    expect(h.agent.runOptions[0]).toMatchObject({ prompt: '/model', liveInputMode: 'command' });
    const card = (h.channel.sent[0]?.content as { card?: unknown }).card;
    expect(buttonLabels(card)).toEqual([
      '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', 'enter', 'esc',
    ]);
    expect(JSON.stringify(card)).toContain('12. gpt-5.12');
  });

  it('keeps plain Codex /model restricted to profile admins', async () => {
    const h = await createHarness();
    h.profileConfig.access.admins = [];
    h.controls.profileConfig.access.admins = [];
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_model_denied', '/model'));
    await waitFor(() => h.channel.sent.length === 1);

    expect(h.agent.runOptions).toHaveLength(0);
    expect(lastMarkdown(h.channel)).toContain('仅管理员可用');
  });

  it('routes plain Claude /model to the native live picker', async () => {
    const h = await createHarness({
      agentKind: 'claude',
      stream: async () => {
        throw new Error('native Claude model picker output should not use stream');
      },
    });
    h.agent.setEvents([
      [
        {
          type: 'text',
          delta: [
            'Select Model',
            '› 1. claude-opus-4-8 (current)',
            '2. claude-sonnet-5',
            '3. claude-haiku-4-5-20251001',
            'Press enter to confirm or esc to go back',
          ].join('\n'),
        },
        { type: 'done', terminationReason: 'normal' },
      ],
    ]);
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_claude_model', '/model'));
    await waitFor(() => h.agent.runOptions.length === 1 && h.channel.sent.length === 1);

    expect(h.agent.runOptions[0]).toMatchObject({
      prompt: '/model',
      liveInputMode: 'command',
      sessionMode: 'live',
    });
    expect(buttonLabels((h.channel.sent[0]?.content as { card?: unknown }).card)).toEqual([
      '1',
      '2',
      '3',
      'esc',
    ]);
  });

  it('sends native live skills picker output as a final button card without explicit enter hint', async () => {
    const h = await createHarness({
      stream: async () => {
        throw new Error('native live skills picker output should not use stream');
      },
    });
    h.profileConfig.preferences = {
      ...(h.profileConfig.preferences ?? {}),
      messageReply: 'markdown',
    };
    h.agent.setEvents([
      [
        {
          type: 'text',
          delta: [
            'Skills',
            'Choose an action',
            '',
            '1. List skills            Tip: press @ to open this list directly.',
            '› 2. Enable/Disable Skills  Enable or disable skills.',
          ].join('\n'),
        },
        { type: 'done', terminationReason: 'normal' },
      ],
    ]);
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_skills', '/codex /skills'));
    await waitFor(() => h.channel.sent.length === 1);
    await settle();

    const content = h.channel.sent.at(-1)?.content as { card?: unknown } | undefined;
    expect(h.channel.sent).toHaveLength(1);
    expect(content?.card).toBeDefined();
    expect(JSON.stringify(content?.card)).toContain('live CLI 正在等待选择');
    expect(buttonLabels(content?.card)).toEqual(['1', '2', 'enter', 'esc']);
  });

  it('bridges an unknown CLI picker without vendor-specific titles or button caps', async () => {
    const h = await createHarness({
      stream: async () => {
        throw new Error('generic picker output should not use stream');
      },
    });
    h.profileConfig.preferences = {
      ...(h.profileConfig.preferences ?? {}),
      messageReply: 'markdown',
    };
    h.agent.setEvents([
      [
        {
          type: 'text',
          delta: [
            'Pick a deployment target',
            '› staging',
            '  production',
            '  canary',
            'Choose one:',
          ].join('\n'),
        },
        { type: 'done', terminationReason: 'normal' },
      ],
    ]);
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_generic_picker', '/codex /skills'));
    await waitFor(() => h.channel.sent.length === 1);
    const content = h.channel.sent[0]?.content as { card?: unknown } | undefined;
    expect(content?.card).toBeDefined();
    expect(buttonLabels(content?.card)).toEqual(['staging', 'production', 'canary', 'esc']);
  });

  it('falls back to captured picker text when sending the interaction card fails', async () => {
    const h = await createHarness({
      failCardSendOnce: true,
      stream: async () => {
        throw new Error('native live picker output should not use stream');
      },
    });
    h.profileConfig.preferences = {
      ...(h.profileConfig.preferences ?? {}),
      messageReply: 'markdown',
    };
    h.agent.setEvents([
      [
        {
          type: 'text',
          delta: [
            'Select Model and Effort',
            '',
            '› 1. gpt-5.5 (current)',
            '2. gpt-5.4',
            'Press enter to confirm or esc to go back',
          ].join('\n'),
        },
        { type: 'done', terminationReason: 'normal' },
      ],
    ]);
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_model_fallback', '/codex /model'));
    await waitFor(() => h.channel.sent.length === 1);
    await settle();

    expect(h.channel.sent).toHaveLength(1);
    const content = h.channel.sent.at(-1)?.content as { markdown?: string; card?: unknown } | undefined;
    expect(content?.card).toBeUndefined();
    expect(content?.markdown).toContain('交互卡片发送失败，已退回文本');
    expect(content?.markdown).toContain('Select Model and Effort');
    expect(content?.markdown).toContain('可直接回复：1 / 2 / enter / esc');
  });

  it('sends live permission approval prompts as button cards', async () => {
    const h = await createHarness({
      stream: async () => {
        throw new Error('native live approval prompts should not use stream');
      },
    });
    h.profileConfig.preferences = {
      ...(h.profileConfig.preferences ?? {}),
      messageReply: 'markdown',
    };
    h.agent.setEvents([
      [
        {
          type: 'text',
          delta: [
            'Command requires approval',
            'Do you want to allow running `npm test`?',
            '',
            '[y/n]',
          ].join('\n'),
        },
        { type: 'done', terminationReason: 'normal' },
      ],
    ]);
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_approval', '/codex /permissions'));
    await waitFor(() => h.channel.sent.length === 1);
    await settle();

    const content = h.channel.sent.at(-1)?.content as { card?: unknown } | undefined;
    expect(h.channel.sent).toHaveLength(1);
    expect(JSON.stringify(content?.card)).toContain('live CLI 正在等待选择');
    expect(buttonLabels(content?.card)).toEqual(['yes', 'no']);
  });

  it('does not merge rapid native live commands into an ordinary prompt', async () => {
    const h = await createHarness({
      stream: async () => {
        throw new Error('native live picker output should not use stream');
      },
    });
    h.profileConfig.preferences = {
      ...(h.profileConfig.preferences ?? {}),
      messageReply: 'markdown',
    };
    h.agent.setEvents([
      [
        {
          type: 'text',
          delta: [
            'Select Model and Effort',
            '',
            '› 1. gpt-5.5 (current)',
            '2. gpt-5.4',
            'Press enter to confirm or esc to go back',
          ].join('\n'),
        },
        { type: 'done', terminationReason: 'normal' },
      ],
      [
        {
          type: 'text',
          delta: [
            'Select Reasoning Level for gpt-5.5',
            '',
            '1. Low',
            '2. Medium',
            '› 3. High',
            'Press enter to confirm or esc to go back',
          ].join('\n'),
        },
        { type: 'done', terminationReason: 'normal' },
      ],
    ]);
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_model', '/codex /model'));
    await h.channel.handlers.message?.(message('om_choice', '/codex 1'));
    await waitFor(() => h.agent.runOptions.length === 2 && h.channel.sent.length === 2, 4000);

    expect(h.agent.runOptions.map((opts) => opts.prompt)).toEqual(['/model', '1']);
    expect(h.agent.runOptions.map((opts) => opts.liveInputMode)).toEqual(['command', 'control']);
    expect(buttonLabels((h.channel.sent[0]?.content as { card?: unknown }).card)).toEqual([
      '1',
      '2',
      'enter',
      'esc',
    ]);
    expect(buttonLabels((h.channel.sent[1]?.content as { card?: unknown }).card)).toEqual([
      '1',
      '2',
      '3',
      'enter',
      'esc',
    ]);
  });

  it('publishes a fresh nested picker after selecting More Options', async () => {
    const h = await createHarness({
      stream: async () => {
        throw new Error('native live picker output should not use stream');
      },
    });
    h.profileConfig.preferences = {
      ...(h.profileConfig.preferences ?? {}),
      messageReply: 'markdown',
    };
    h.agent.setEvents([
      [
        {
          type: 'text',
          delta: [
            'Select Reasoning Effort for gpt-5.6-sol',
            '› 1. Low',
            '2. Medium',
            '3. High',
            '4. Extra high',
            '5. More Options',
            'Press enter to confirm or esc to go back',
          ].join('\n'),
        },
        { type: 'done', terminationReason: 'normal' },
      ],
      [
        {
          type: 'text',
          delta: [
            'Choose an extended reasoning level',
            '› 1. Max',
            '2. Ultra',
            'Press enter to confirm or esc to go back',
          ].join('\n'),
        },
        { type: 'done', terminationReason: 'normal' },
      ],
    ]);
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_reasoning_picker', '/codex /model'));
    await waitFor(() => h.channel.sent.length === 1);
    expect(buttonLabels((h.channel.sent[0]?.content as { card?: unknown }).card)).toEqual([
      '1', '2', '3', '4', '5', 'enter', 'esc',
    ]);

    await h.channel.handlers.message?.(message('om_reasoning_more', '/codex 5'));
    await waitFor(() => h.agent.runOptions.length === 2 && h.channel.sent.length === 2, 4000);

    expect(h.agent.runOptions.map((options) => options.prompt)).toEqual(['/model', '5']);
    expect(h.agent.runOptions.map((options) => options.liveInputMode)).toEqual(['command', 'control']);
    const nextCard = (h.channel.sent[1]?.content as { card?: unknown }).card;
    expect(buttonLabels(nextCard)).toEqual(['1', '2', 'enter', 'esc']);
    expect(JSON.stringify(nextCard)).toContain('extended reasoning level');
  });

  it('keeps rapid group messages as separate live terminal turns', async () => {
    const h = await createHarness();
    h.profileConfig.preferences = {
      ...(h.profileConfig.preferences ?? {}),
      agentSessionMode: 'live',
      messageReply: 'text',
      messageReplyMigrated: true,
    };
    h.controls.profileConfig.preferences = h.profileConfig.preferences;
    h.controls.cfg.preferences = h.profileConfig.preferences;
    h.agent.setEvents([
      [{ type: 'text', delta: 'first reply\n' }, { type: 'done', terminationReason: 'normal' }],
      [{ type: 'text', delta: 'second reply\n' }, { type: 'done', terminationReason: 'normal' }],
      [{ type: 'text', delta: 'status reply\n' }, { type: 'done', terminationReason: 'normal' }],
    ]);
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_group_first', 'nihao', 'group', true));
    await h.channel.handlers.message?.(message('om_group_second', '你好', 'group', true));
    await h.channel.handlers.message?.(message('om_group_status', '/codex /status', 'group', true));
    await waitFor(() => h.agent.runOptions.length === 3, 4000);

    expect(h.agent.runOptions.map((opts) => userTextOrNative(opts.prompt))).toEqual(['nihao', '你好', '/status']);
    expect(h.agent.runOptions.map((opts) => opts.sessionMode)).toEqual(['live', 'live', 'live']);
    expect(h.agent.runOptions.map((opts) => opts.liveInputMode)).toEqual([
      undefined,
      undefined,
      'command',
    ]);
  });

  it('drains a muted live run without sending output and resumes delivery later', async () => {
    const h = await createHarness();
    h.profileConfig.preferences = {
      ...(h.profileConfig.preferences ?? {}),
      agentSessionMode: 'live',
      messageReply: 'text',
      messageReplyMigrated: true,
    };
    h.controls.profileConfig.preferences = h.profileConfig.preferences;
    h.controls.cfg.preferences = h.profileConfig.preferences;
    h.agent.setEvents([
      [{ type: 'text', delta: 'this must stay in the terminal\n' }, { type: 'done', terminationReason: 'normal' }],
      [{ type: 'text', delta: 'delivery restored\n' }, { type: 'done', terminationReason: 'normal' }],
    ]);
    h.sessions.setOutputMode('oc_dm', 'off');
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_muted', 'run quietly'));
    await waitFor(() => h.agent.runOptions.length === 1);
    await settle();
    expect(h.channel.sent).toHaveLength(0);
    expect(userTextOrNative(h.agent.runOptions[0]?.prompt ?? '')).toBe('run quietly');

    h.sessions.setOutputMode('oc_dm', 'final');
    await h.channel.handlers.message?.(message('om_restored', 'show the result'));
    await waitFor(() => h.agent.runOptions.length === 2 && h.channel.sent.length === 1);
    expect(lastMarkdown(h.channel)).toContain('delivery restored');
  });

  it('applies output policy changes to an already-running live task', async () => {
    const h = await createHarness();
    h.profileConfig.preferences = {
      ...(h.profileConfig.preferences ?? {}),
      agentSessionMode: 'live',
      messageReply: 'text',
      messageReplyMigrated: true,
    };
    h.controls.profileConfig.preferences = h.profileConfig.preferences;
    h.controls.cfg.preferences = h.profileConfig.preferences;
    h.agent.setEvents([
      [{ type: 'text', delta: 'this final answer must stay muted\n' }, { type: 'done', terminationReason: 'normal' }],
    ]);
    delayFakeAgentEvents(h.agent, 80);
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_running_muted', 'run while I change delivery'));
    await waitFor(() => h.agent.runOptions.length === 1);
    h.sessions.setOutputMode('oc_dm', 'off');
    await settle(250);

    expect(JSON.stringify(h.channel.sent)).not.toContain('this final answer must stay muted');
  });

  it('recovers only the final answer when output is re-enabled during a muted live task', async () => {
    const h = await createHarness();
    h.profileConfig.preferences = {
      ...(h.profileConfig.preferences ?? {}),
      agentSessionMode: 'live',
      messageReply: 'text',
      messageReplyMigrated: true,
    };
    h.controls.profileConfig.preferences = h.profileConfig.preferences;
    h.controls.cfg.preferences = h.profileConfig.preferences;
    h.agent.setEvents([
      [{ type: 'text', delta: 'recovered terminal answer\n' }, { type: 'done', terminationReason: 'normal' }],
    ]);
    h.sessions.setOutputMode('oc_dm', 'off');
    delayFakeAgentEvents(h.agent, 80);
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_running_reenabled', 'run silently first'));
    await waitFor(() => h.agent.runOptions.length === 1);
    h.sessions.setOutputMode('oc_dm', 'final');
    await waitFor(() => JSON.stringify(h.channel.sent).includes('recovered terminal answer'));

    expect(JSON.stringify(h.channel.sent)).toContain('recovered terminal answer');
  });

  it('routes enter after native resume as a live control even before picker text is recognized', async () => {
    const h = await createHarness({
      stream: async () => {
        throw new Error('native live resume controls should not use stream');
      },
    });
    h.profileConfig.preferences = {
      ...(h.profileConfig.preferences ?? {}),
      messageReply: 'markdown',
    };
    h.agent.setEvents([
      [
        {
          type: 'text',
          delta: [
            '──────────────────────────────────────── 1 / 16 · 100% ─',
            'session 1: latest research task',
            'session 2: benchmark diagnosis',
            'enter resume   esc exit   ctrl+c exit   tab focus sort/filter   ←/→ change option',
            'ctrl+o comfortable view   ctrl+t transcript   ctrl+e expand   ↑/↓ browse',
          ].join('\n'),
        },
        { type: 'done', terminationReason: 'normal' },
      ],
      [
        {
          type: 'text',
          delta: 'Resuming selected conversation\n',
        },
        { type: 'done', terminationReason: 'normal' },
      ],
    ]);
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_resume', '/codex /resume'));
    await waitFor(() => h.agent.runOptions.length === 1 && h.channel.sent.length === 1);
    expect(buttonLabels((h.channel.sent[0]?.content as { card?: unknown }).card)).toEqual([
      'enter',
      'esc',
      'ctrl+c',
      'tab',
      'left',
      'right',
      'up',
      'down',
    ]);
    await h.channel.handlers.message?.(message('om_enter', 'enter'));
    await waitFor(() => h.agent.runOptions.length === 2);

    expect(h.agent.runOptions.map((opts) => opts.prompt)).toEqual(['/resume', 'enter']);
    expect(h.agent.runOptions.map((opts) => opts.liveInputMode)).toEqual(['command', 'control']);
  });

  it('does not leave the IM queue blocked when the agent exits before stream producer starts', async () => {
    const h = await createHarness();
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_first', 'first'));
    await waitFor(() => h.agent.runOptions.length === 1);

    await h.channel.handlers.message?.(message('om_second', 'second'));
    await waitFor(() => h.agent.runOptions.length === 2);

    expect(h.channel.rawClient.im.v1.messageReaction.delete).toHaveBeenCalledWith(
      expect.objectContaining({
        path: { message_id: 'om_first', reaction_id: 'reaction_1' },
      }),
    );
    expect(lastMarkdown(h.channel)).toContain('agent 失败');
    expect(lastMarkdown(h.channel)).toContain('codex exited with code 1');
  });

  it('surfaces an error when an agent event stream ends without a terminal event', async () => {
    const h = await createHarness();
    h.agent.setEvents([[]]);
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_silent_end', 'first'));
    await waitFor(() => JSON.stringify(h.channel.sent).includes('agent 失败'));

    expect(JSON.stringify(h.channel.sent)).toContain('agent 事件流在未报告完成状态时结束');
  });

  it('does not wait for the working reaction before draining a failed agent run', async () => {
    const reaction = deferred<{ data: { reaction_id: string } }>();
    const h = await createHarness({
      reactionCreate: () => reaction.promise,
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_first', 'first'));
    await waitFor(() => h.agent.runOptions.length === 1);

    await h.channel.handlers.message?.(message('om_second', 'second'));
    await waitFor(() => h.agent.runOptions.length === 2, 1000);

    expect(lastMarkdown(h.channel)).toContain('agent 失败');

    reaction.resolve({ data: { reaction_id: 'reaction_1' } });
    await waitFor(() => h.channel.rawClient.im.v1.messageReaction.delete.mock.calls.length > 0);
  });

  it('logs stream failures that arrive after terminal grace expires', async () => {
    const streamFailure = deferred<void>();
    let streamProducerStarted = false;
    const h = await createHarness({
      stream: async (_chatId, input) => {
        const producer = (input as {
          markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void>;
        }).markdown;
        if (producer) {
          streamProducerStarted = true;
          void producer({ setContent: vi.fn(async () => {}) });
        }
        await streamFailure.promise;
      },
    });
    const fail = vi.spyOn(log, 'fail').mockImplementation(() => {});
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_first', 'first'));
    await waitFor(() => streamProducerStarted);
    await waitFor(
      () => h.channel.rawClient.im.v1.messageReaction.delete.mock.calls.length > 0,
      4500,
    );

    await h.channel.handlers.message?.(message('om_second', 'second'));
    await waitFor(() => h.agent.runOptions.length === 2);

    streamFailure.reject(new Error('late stream failed'));

    await waitFor(() =>
      fail.mock.calls.some((call) =>
        call[0] === 'stream' &&
        call[1] instanceof Error &&
        call[1].message === 'late stream failed' &&
        (call[2] as { step?: string } | undefined)?.step === 'stream-terminal-late',
      ),
    );
  }, 10_000);
});

async function createHarness(options: {
  reactionCreate?: () => Promise<{ data: { reaction_id: string } }>;
  stream?: StreamFn;
  failCardSendOnce?: boolean;
  agentKind?: 'claude' | 'codex';
} = {}): Promise<{
  tmp: TmpProfile;
  channel: FakeLarkChannel;
  agent: FakeAgentAdapter;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  profileConfig: ReturnType<typeof createDefaultProfileConfig>;
  controls: ReturnType<typeof createControls>;
}> {
  const tmp = await createTmpProfile('markdown-stream-startup-failure-');
  const workspace = await realpath(tmp.workspace);
  const agentKind = options.agentKind ?? 'codex';
  const baseProfileConfig = createDefaultProfileConfig({
    agentKind,
    accounts: {
      app: {
        id: 'cli_test',
        secret: 'secret',
        tenant: 'feishu',
      },
    },
    access: {
      allowedUsers: ['ou_user'],
      admins: ['ou_user'],
    },
    ...(agentKind === 'codex' ? { codex: { binaryPath: '/usr/local/bin/codex' } } : {}),
  });
  const profileConfig = {
    ...baseProfileConfig,
    workspaces: {
      ...baseProfileConfig.workspaces,
      default: workspace,
    },
  };
  const configPath = join(tmp.root, 'config.json');
  await saveRootConfig(createRootConfig(agentKind, profileConfig), configPath);
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const agent = new FakeAgentAdapter({
    id: agentKind,
    displayName: agentKind === 'codex' ? 'Codex' : 'Claude Code',
    events: [
      [
        {
          type: 'error',
          message: `${agentKind} exited with code 1: Error loading config`,
          terminationReason: 'failed',
        },
      ],
      [{ type: 'done', terminationReason: 'normal' }],
    ],
  });
  const channel = createFakeLarkChannel(options);
  sdkMock.channel = channel;
  const controls = createControls(profileConfig, configPath);
  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });
  return {
    tmp,
    channel,
    agent,
    sessions,
    workspaces,
    profileConfig,
    controls,
  };
}

async function startTestBridge(h: {
  tmp: TmpProfile;
  profileConfig: ReturnType<typeof createDefaultProfileConfig>;
  agent: FakeAgentAdapter;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  controls: ReturnType<typeof createControls>;
}): Promise<void> {
  const bridge = await startChannel({
    cfg: h.profileConfig,
    agent: h.agent,
    sessions: h.sessions,
    workspaces: h.workspaces,
    controls: h.controls,
    appPaths: {
      secretsFile: join(h.tmp.profile, 'secrets.enc'),
      keystoreSaltFile: join(h.tmp.profile, '.keystore.salt'),
      mediaDir: join(h.tmp.profile, 'media'),
    },
  });
  cleanups.push(() => bridge.disconnect());
}

function createFakeLarkChannel(options: {
  reactionCreate?: () => Promise<{ data: { reaction_id: string } }>;
  stream?: StreamFn;
  failCardSendOnce?: boolean;
} = {}): FakeLarkChannel {
  const handlers: MessageHandlerMap = {};
  const sent: FakeLarkChannel['sent'] = [];
  let failedCardSend = false;
  const channel: FakeLarkChannel = {
    handlers,
    sent,
    botIdentity: { openId: 'ou_bot', name: 'Bridge' },
    rawClient: {
      request: vi.fn(async () => ({ data: { items: [] } })),
      application: {
        v6: {
          application: {
            get: vi.fn(async () => ({
              data: { app: { owner: { owner_id: 'ou_owner' } } },
            })),
          },
        },
      },
      im: {
        v1: {
          message: {
            get: vi.fn(async () => ({ data: { items: [] } })),
          },
          messageReaction: {
            create: vi.fn(options.reactionCreate ?? (async () => ({ data: { reaction_id: 'reaction_1' } }))),
            delete: vi.fn(async () => ({})),
          },
        },
      },
    },
    on(nextHandlers) {
      Object.assign(handlers, nextHandlers);
    },
    async connect() {},
    async disconnect() {},
    async getChatMode() {
      return 'group';
    },
    getConnectionStatus() {
      return { state: 'connected', reconnectAttempts: 0 };
    },
    async send(chatId, content, sendOptions) {
      if (options.failCardSendOnce && (content as { card?: unknown }).card && !failedCardSend) {
        failedCardSend = true;
        throw new Error('card send failed');
      }
      sent.push({ chatId, content, options: sendOptions });
    },
    stream: options.stream ?? (async () => {
      await new Promise<void>(() => {});
    }),
    async addReaction(messageId, emojiType) {
      const r = await channel.rawClient.im.v1.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emojiType } },
      });
      return (r as { data?: { reaction_id?: string } })?.data?.reaction_id ?? '';
    },
    async removeReaction(messageId, reactionId) {
      await channel.rawClient.im.v1.messageReaction.delete({
        path: { message_id: messageId, reaction_id: reactionId },
      });
    },
  };
  return channel;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createControls(
  profileConfig: ReturnType<typeof createDefaultProfileConfig>,
  configPath: string,
) {
  return {
    profile: 'codex',
    profileConfig,
    ownerRefreshState: 'unknown' as const,
    async refreshOwner() {},
    async restart() {},
    async exit() {},
    configPath,
    cfg: profileConfig,
    processId: 'proc_test',
  };
}

function message(
  messageId: string,
  content: string,
  chatType: 'p2p' | 'group' = 'p2p',
  mentionedBot = false,
): NormalizedMessage {
  return {
    messageId,
    chatId: 'oc_dm',
    chatType,
    senderId: 'ou_user',
    senderName: 'User',
    content,
    rawContentType: 'text',
    resources: [],
    mentionedBot,
    createTime: 1760000001000,
  } as unknown as NormalizedMessage;
}

function lastMarkdown(channel: FakeLarkChannel): string {
  const content = channel.sent.at(-1)?.content as { markdown?: string } | undefined;
  expect(content?.markdown).toBeTypeOf('string');
  return content?.markdown ?? '';
}

async function settle(ms = 20): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function buttonLabels(card: unknown): string[] {
  const labels: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    if (obj.tag === 'button') {
      const text = obj.text as { content?: unknown } | undefined;
      if (typeof text?.content === 'string') labels.push(text.content);
    }
    for (const value of Object.values(obj)) walk(value);
  };
  walk(card);
  return labels;
}

function userTextOrNative(prompt: string): string {
  const match = prompt.match(/<user_input>\n([\s\S]*?)\n<\/user_input>/u);
  if (!match) return prompt;
  const input = JSON.parse(match[1] ?? 'null') as { text?: unknown };
  return typeof input.text === 'string' ? input.text : prompt;
}

function delayFakeAgentEvents(agent: FakeAgentAdapter, delayMs: number): void {
  const run = agent.run.bind(agent);
  agent.run = (opts) => {
    const result = run(opts);
    return {
      runId: result.runId,
      stop: () => result.stop(),
      waitForExit: (timeoutMs) => result.waitForExit(timeoutMs),
      events: (async function* () {
        for await (const event of result.events) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          yield event;
        }
      })(),
    };
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for async work');
}

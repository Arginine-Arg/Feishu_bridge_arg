import type { NormalizedMessage } from '@larksuite/channel';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
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
  const baseProfileConfig = createDefaultProfileConfig({
    agentKind: 'codex',
    accounts: {
      app: {
        id: 'cli_test',
        secret: 'secret',
        tenant: 'feishu',
      },
    },
    access: {
      allowedUsers: ['ou_user'],
    },
    codex: {
      binaryPath: '/usr/local/bin/codex',
    },
  });
  const profileConfig = {
    ...baseProfileConfig,
    workspaces: {
      ...baseProfileConfig.workspaces,
      default: workspace,
    },
  };
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const agent = new FakeAgentAdapter({
    id: 'codex',
    displayName: 'Codex',
    events: [
      [
        {
          type: 'error',
          message: 'codex exited with code 1: Error loading config.toml',
          terminationReason: 'failed',
        },
      ],
      [{ type: 'done', terminationReason: 'normal' }],
    ],
  });
  const channel = createFakeLarkChannel(options);
  sdkMock.channel = channel;
  const controls = createControls(profileConfig);
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

function createControls(profileConfig: ReturnType<typeof createDefaultProfileConfig>) {
  return {
    profile: 'codex',
    profileConfig,
    ownerRefreshState: 'unknown' as const,
    async refreshOwner() {},
    async restart() {},
    async exit() {},
    configPath: '/tmp/config.json',
    cfg: profileConfig,
    processId: 'proc_test',
  };
}

function message(messageId: string, content: string): NormalizedMessage {
  return {
    messageId,
    chatId: 'oc_dm',
    chatType: 'p2p',
    senderId: 'ou_user',
    senderName: 'User',
    content,
    rawContentType: 'text',
    resources: [],
    mentionedBot: false,
    createTime: 1760000001000,
  } as unknown as NormalizedMessage;
}

function lastMarkdown(channel: FakeLarkChannel): string {
  const content = channel.sent.at(-1)?.content as { markdown?: string } | undefined;
  expect(content?.markdown).toBeTypeOf('string');
  return content?.markdown ?? '';
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
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

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for async work');
}

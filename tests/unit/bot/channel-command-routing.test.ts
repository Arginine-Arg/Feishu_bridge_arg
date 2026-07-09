import { describe, expect, it } from 'vitest';
import type { NormalizedMessage } from '@larksuite/channel';
import { rewriteAgentCommandMessage } from '../../../src/bot/channel.js';

describe('agent command routing aliases', () => {
  it('forces matching agent-prefixed slash commands to the native live CLI', () => {
    expect(rewriteAgentCommandMessage(message('/codex /resume'), 'codex')).toMatchObject({
      msg: { content: '/resume' },
      forceNative: true,
    });
    expect(rewriteAgentCommandMessage(message('/codex-cli /fast'), 'codex')).toMatchObject({
      msg: { content: '/fast' },
      forceNative: true,
    });
    expect(rewriteAgentCommandMessage(message('/claude /resume'), 'claude')).toMatchObject({
      msg: { content: '/resume' },
      forceNative: true,
    });
    expect(rewriteAgentCommandMessage(message('/claudecode /compact'), 'claude')).toMatchObject({
      msg: { content: '/compact' },
      forceNative: true,
    });
  });

  it('maps a bare matching agent prefix to native status instead of forwarding the alias', () => {
    expect(rewriteAgentCommandMessage(message('/codex'), 'codex')).toMatchObject({
      msg: { content: '/status' },
      forceNative: true,
    });
    expect(rewriteAgentCommandMessage(message('/codex   '), 'codex')).toMatchObject({
      msg: { content: '/status' },
      forceNative: true,
    });
    expect(rewriteAgentCommandMessage(message('/claude'), 'claude')).toMatchObject({
      msg: { content: '/status' },
      forceNative: true,
    });
  });

  it('normalizes matching agent aliases for ordinary text without forcing native command mode', () => {
    expect(rewriteAgentCommandMessage(message('/codex resume'), 'codex')).toMatchObject({
      msg: { content: 'resume' },
      forceNative: false,
    });
  });

  it('forces matching agent-prefixed picker controls to live control input', () => {
    expect(rewriteAgentCommandMessage(message('/codex 2'), 'codex')).toMatchObject({
      msg: { content: '2' },
      forceNative: true,
      nativeMode: 'control',
    });
    expect(rewriteAgentCommandMessage(message('/codex /2'), 'codex')).toMatchObject({
      msg: { content: '2' },
      forceNative: true,
      nativeMode: 'control',
    });
    expect(rewriteAgentCommandMessage(message('/codex enter'), 'codex')).toMatchObject({
      msg: { content: 'enter' },
      forceNative: true,
      nativeMode: 'control',
    });
    expect(rewriteAgentCommandMessage(message('/codex esc'), 'codex')).toMatchObject({
      msg: { content: 'esc' },
      forceNative: true,
      nativeMode: 'control',
    });
  });

  it('leaves non-matching agent aliases untouched', () => {
    expect(rewriteAgentCommandMessage(message('/claude /resume'), 'codex')).toMatchObject({
      msg: { content: '/claude /resume' },
      forceNative: false,
    });
    expect(rewriteAgentCommandMessage(message('/codex /resume'), 'claude')).toMatchObject({
      msg: { content: '/codex /resume' },
      forceNative: false,
    });
  });
});

function message(content: string): NormalizedMessage {
  return {
    messageId: 'om-test',
    chatId: 'oc-test',
    chatType: 'p2p',
    senderId: 'ou-test',
    senderName: 'Tester',
    content,
    resources: [],
    mentionedBot: false,
  } as unknown as NormalizedMessage;
}

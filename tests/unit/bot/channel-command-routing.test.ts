import { describe, expect, it } from 'vitest';
import type { NormalizedMessage } from '@larksuite/channel';
import { rewriteAgentCommandMessage } from '../../../src/bot/channel.js';

describe('agent command routing aliases', () => {
  it('normalizes matching agent aliases before bridge command dispatch', () => {
    expect(rewriteAgentCommandMessage(message('/codex /resume'), 'codex').content).toBe('/resume');
    expect(rewriteAgentCommandMessage(message('/codex-cli /fast'), 'codex').content).toBe('/fast');
    expect(rewriteAgentCommandMessage(message('/claude /resume'), 'claude').content).toBe('/resume');
    expect(rewriteAgentCommandMessage(message('/claudecode /compact'), 'claude').content).toBe('/compact');
  });

  it('leaves non-matching agent aliases untouched', () => {
    expect(rewriteAgentCommandMessage(message('/claude /resume'), 'codex').content).toBe('/claude /resume');
    expect(rewriteAgentCommandMessage(message('/codex /resume'), 'claude').content).toBe('/codex /resume');
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

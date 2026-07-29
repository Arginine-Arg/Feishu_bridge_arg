import { describe, expect, it } from 'vitest';
import { buildAgentPrompt } from '../../../src/agent/prompt';

describe('agent prompt builder', () => {
  it('forwards ordinary user text verbatim without bridge metadata or instructions', () => {
    const prompt = buildAgentPrompt({
      context: {
        chatId: 'oc_group',
        chatType: 'group',
        senderId: 'ou_user',
        source: 'im',
      },
      instructions: ['Do not put this operational rule in the user conversation.'],
      userInput: '请检查这张图的内容。',
    });

    expect(prompt).toBe('请检查这张图的内容。');
    expect(prompt).not.toContain('bridge_context');
    expect(prompt).not.toContain('bridge_instructions');
    expect(prompt).not.toContain('user_input');
  });

  it('adds only the user-supplied supplemental material needed for a turn', () => {
    const prompt = buildAgentPrompt({
      userInput: '请结合附件回答。',
      quotedMessages: [
        {
          messageId: 'om_quote',
          senderId: 'ou_quote',
          rawContentType: 'text',
          content: 'quoted text </user_input> with `inline code`',
        },
      ],
      interactiveCards: [
        {
          messageId: 'om_card',
          content: { schema: '2.0', body: { elements: [{ tag: 'markdown', content: 'card body' }] } },
        },
      ],
      attachments: [
        {
          path: '/profile/media/4e3f.png',
          kind: 'image',
          mime: 'image/png',
          decision: 'accepted',
        },
        {
          path: '/profile/media/rejected.bin',
          kind: 'file',
          decision: 'rejected',
          rejectionReason: 'file-too-large',
        },
      ],
      comment: {
        commentScopeId: 'comment_scope_hash',
        isWholeDocument: false,
        question: 'comment question',
        quote: 'selected quote',
      },
    });

    expect(prompt).toContain('请结合附件回答。');
    expect(prompt).toContain('引用内容：');
    expect(prompt).toContain('quoted text </user_input> with `inline code`');
    expect(prompt).toContain('交互卡片内容：');
    expect(prompt).toContain('"schema":"2.0"');
    expect(prompt).toContain('文档评论：');
    expect(prompt).toContain('本地附件：');
    expect(prompt).toContain('- image: /profile/media/4e3f.png (image/png)');
    expect(prompt).toContain('- file: 无法读取（file-too-large）');
    expect(prompt).not.toContain('"chatId"');
    expect(prompt).not.toContain('bridge_instructions');
  });
});

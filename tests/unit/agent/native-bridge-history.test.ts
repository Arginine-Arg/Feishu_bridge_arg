import { describe, expect, it } from 'vitest';
import { extractAssistantHistory } from '../../../src/agent/structured/native-bridge';

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
});

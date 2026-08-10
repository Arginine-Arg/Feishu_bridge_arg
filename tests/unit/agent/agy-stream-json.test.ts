import { describe, expect, it } from 'vitest';
import { AgyAdapter } from '../../../src/agent/agy/adapter.js';
import { translateEvent } from '../../../src/agent/agy/stream-json.js';

describe('Agy stream-json translator', () => {
  it('translates system init metadata', () => {
    expect([
      ...translateEvent({
        type: 'system',
        subtype: 'init',
        session_id: 'sess-1',
        cwd: '/repo',
        model: 'gemini-3.6-flash',
      }),
    ]).toEqual([
      { type: 'system', sessionId: 'sess-1', cwd: '/repo', model: 'gemini-3.6-flash' },
    ]);
  });

  it('translates assistant text, thinking, and tool_use blocks', () => {
    expect([
      ...translateEvent({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'hello from agy' },
            { type: 'thinking', thinking: 'analyzing' },
            { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'ls' } },
          ],
        },
      }),
    ]).toEqual([
      { type: 'text', delta: 'hello from agy' },
      { type: 'thinking', delta: 'analyzing' },
      { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'ls' } },
    ]);
  });

  it('translates result usage before done', () => {
    expect([
      ...translateEvent({
        type: 'result',
        session_id: 'sess-2',
        usage: { input_tokens: 10, output_tokens: 20 },
      }),
    ]).toEqual([
      { type: 'usage', inputTokens: 10, outputTokens: 20, cachedInputTokens: undefined, costUsd: undefined },
      { type: 'done', sessionId: 'sess-2', terminationReason: 'normal' },
    ]);
  });
});

describe('AgyAdapter contract', () => {
  it('has correct id and displayName', () => {
    const adapter = new AgyAdapter();
    expect(adapter.id).toBe('agy');
    expect(adapter.displayName).toBe('Antigravity CLI');
  });
});

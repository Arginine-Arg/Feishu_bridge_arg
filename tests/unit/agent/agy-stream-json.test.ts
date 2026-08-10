import { describe, expect, it } from 'vitest';
import { AgyAdapter } from '../../../src/agent/agy/adapter.js';
import { translateEvent } from '../../../src/agent/agy/stream-json.js';

describe('Agy stream-json translator', () => {
  it('translates native agy init event', () => {
    expect([
      ...translateEvent({
        event: 'init',
        conversation_id: 'conv-123',
        init: { cwd: '/repo', model: 'gemini-3.6-flash' },
      }),
    ]).toEqual([
      { type: 'system', sessionId: 'conv-123', cwd: '/repo', model: 'gemini-3.6-flash' },
    ]);
  });

  it('translates native agy step_update text and tool events', () => {
    expect([
      ...translateEvent({
        event: 'step_update',
        step_update: {
          step_index: 7,
          state: 'ACTIVE',
          step_type: 'agent_response',
          text_delta: 'Hi! How can I help you today?',
        },
      }),
    ]).toEqual([
      { type: 'text', delta: 'Hi! How can I help you today?' },
    ]);

    expect([
      ...translateEvent({
        event: 'step_update',
        step_update: {
          step_index: 3,
          state: 'ACTIVE',
          step_type: 'tool',
          tool_name: 'list_dir',
          tool_info: { name: 'list_dir', parameters: { DirectoryPath: '/repo' } },
        },
      }),
    ]).toEqual([
      { type: 'tool_use', id: '3', name: 'list_dir', input: { DirectoryPath: '/repo' } },
    ]);
  });

  it('translates native agy result event', () => {
    expect([
      ...translateEvent({
        event: 'result',
        result: {
          conversation_id: 'conv-123',
          status: 'SUCCESS',
          usage: { input_tokens: 100, output_tokens: 50, cache_read_tokens: 20 },
        },
      }),
    ]).toEqual([
      { type: 'usage', inputTokens: 100, outputTokens: 50, cachedInputTokens: 20 },
      { type: 'done', sessionId: 'conv-123', terminationReason: 'normal' },
    ]);
  });

  it('translates fallback claude-style init metadata', () => {
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
});

describe('AgyAdapter contract', () => {
  it('has correct id and displayName', () => {
    const adapter = new AgyAdapter();
    expect(adapter.id).toBe('agy');
    expect(adapter.displayName).toBe('Antigravity CLI');
  });
});

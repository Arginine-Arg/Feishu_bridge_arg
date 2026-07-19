import { describe, expect, it } from 'vitest';
import { formatElapsed, renderCard } from '../../../src/card/run-renderer';
import { initialState, reduce, type RunState } from '../../../src/card/run-state';

describe('run renderer elapsed-time formatting', () => {
  it('formats seconds, minutes, and hours', () => {
    expect(formatElapsed(0)).toBe('0 秒');
    expect(formatElapsed(12_000)).toBe('12 秒');
    expect(formatElapsed(60_000)).toBe('1 分');
    expect(formatElapsed(90_000)).toBe('1 分 30 秒');
    expect(formatElapsed(194_000)).toBe('3 分 14 秒');
    expect(formatElapsed(3_900_000)).toBe('1 时 5 分');
    expect(formatElapsed(7_200_000)).toBe('2 时');
  });

  it('does not append a suffix when currentToolElapsedMs is missing', () => {
    const state = reduce(initialState, {
      type: 'tool_use',
      id: 't1',
      name: 'Bash',
      input: { command: 'pwd' },
    });
    const card = renderCard(state) as { body?: { elements?: Array<{ content?: string }> } };
    const footer = card.body?.elements?.find((el) => el.content?.includes('正在调用工具'));
    expect(footer?.content).toBe('🧰 正在调用工具');
  });

  it('appends the elapsed suffix when currentToolElapsedMs is set', () => {
    const base = reduce(initialState, {
      type: 'tool_use',
      id: 't1',
      name: 'Bash',
      input: { command: 'sleep 30' },
    });
    const state: RunState = { ...base, currentToolElapsedMs: 194_000 };
    const card = renderCard(state) as { body?: { elements?: Array<{ content?: string }> } };
    const footer = card.body?.elements?.find((el) => el.content?.includes('正在调用工具'));
    expect(footer?.content).toBe('🧰 正在调用工具 · 已运行 3 分 14 秒');
  });

  it('does not append the suffix for non-tool-running footers', () => {
    const thinking = reduce(initialState, { type: 'thinking', delta: 'r' });
    const state: RunState = { ...thinking, currentToolElapsedMs: 12_000 };
    const card = renderCard(state) as { body?: { elements?: Array<{ content?: string }> } };
    const footer = card.body?.elements?.find((el) => el.content?.includes('正在思考'));
    expect(footer?.content).toBe('🧠 正在思考');
  });
});

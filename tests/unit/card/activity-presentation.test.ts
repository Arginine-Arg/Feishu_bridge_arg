import { describe, expect, it } from 'vitest';
import { presentBlocks } from '../../../src/card/activity-presentation';
import { renderCard } from '../../../src/card/run-renderer';
import { initialState, reduce, type RunState } from '../../../src/card/run-state';
import { renderText } from '../../../src/card/text-renderer';
import { RunEventGate } from '../../../src/bot/run-delivery';

type CardPanel = {
  tag?: string;
  expanded?: boolean;
  header?: { title?: { content?: string } };
  elements?: Array<{ content?: string }>;
};

function stateFromText(text: string): RunState {
  let state = reduce(initialState, { type: 'text', delta: text, source: 'live-terminal', sequence: 1 });
  state = reduce(state, { type: 'done', terminationReason: 'normal' });
  return state;
}

function activityPanel(state: RunState): CardPanel | undefined {
  const card = renderCard(state) as { body?: { elements?: CardPanel[] } };
  return card.body?.elements?.find((element) => element.header?.title?.content?.includes('执行活动'));
}

describe('terminal activity presentation', () => {
  it('wraps Codex Ran and Explored frames while keeping normal progress prominent', () => {
    const state = stateFromText([
      '• Ran git status --short',
      '└ M src/bot/channel.ts',
      '• 当前正在核对投递队列和最终答复。',
      '• Explored',
      '└ Read src/card/run-renderer.ts',
      '• 最终结论：消息尾部完整保留。',
    ].join('\n'));

    const panel = activityPanel(state);
    const text = renderText(state);

    expect(panel?.expanded).toBe(false);
    expect(panel?.header?.title?.content).toContain('执行活动 · 2 项');
    expect(panel?.elements?.[0]?.content).toContain('Ran git status --short');
    expect(panel?.elements?.[0]?.content).toContain('Explored');
    expect(text).toContain('> _▸ 执行活动（2 项）_');
    expect(text).toContain('当前正在核对投递队列和最终答复。');
    expect(text.endsWith('最终结论：消息尾部完整保留。')).toBe(true);
  });

  it('recognizes Claude tool surfaces without hiding ordinary Claude prose', () => {
    const state = stateFromText([
      '⏺ Read(file_path: "src/bot/channel.ts")',
      '⎿  Read 120 lines',
      '⏺ 我会先检查渲染结果，再给出结论。',
      'Run pnpm vitest',
      '✓ 12 tests passed',
      '⏺ 结论：普通说明不应被压缩。',
    ].join('\n'));

    const panel = activityPanel(state);
    const text = renderText(state);

    expect(panel?.header?.title?.content).toContain('执行活动 · 2 项');
    expect(panel?.elements?.[0]?.content).toContain('Read(file_path');
    expect(panel?.elements?.[0]?.content).toContain('Run pnpm vitest');
    expect(text).toContain('我会先检查渲染结果，再给出结论。');
    expect(text.endsWith('⏺ 结论：普通说明不应被压缩。')).toBe(true);
  });

  it('does not compact an actionable native picker or its command echo', () => {
    const picker = [
      '› /model',
      'Select a model',
      '1. Default',
      '2. Fast',
      'Use arrow keys, then enter to continue',
    ].join('\n');
    const presentation = presentBlocks([{ kind: 'text', content: picker, streaming: true }]);

    expect(presentation.activity).toBeUndefined();
    expect(presentation.blocks).toEqual([{ kind: 'text', content: picker, streaming: true }]);
  });

  it('keeps dedupe and final-tail guarantees when a long activity trace is folded', () => {
    const activity = Array.from(
      { length: 180 },
      (_, index) => `• Ran git status --porcelain #${index}\n└ ${'x'.repeat(90)}`,
    ).join('\n');
    const finalAnswer = 'FINAL_ANSWER: delivery remains complete';
    const gate = new RunEventGate();
    let state = initialState;

    const first = gate.accept({ type: 'text', delta: `${activity}\n• ${finalAnswer}\n`, source: 'live-terminal', sequence: 1 });
    const replay = gate.accept({ type: 'text', delta: `${activity}\n• ${finalAnswer}\n`, source: 'live-terminal', sequence: 2 });
    expect(first).toBeDefined();
    expect(replay).toBeUndefined();
    if (first?.type === 'text') state = reduce(state, first);
    state = reduce(state, { type: 'done', terminationReason: 'normal' });

    const card = renderCard(state);
    const text = renderText(state);
    const flatCard = JSON.stringify(card);

    expect(flatCard).toContain('执行活动已折叠（保留首尾）');
    expect(flatCard).toContain('Ran git status --porcelain #0');
    expect(flatCard).toContain('Ran git status --porcelain #179');
    expect(flatCard).toContain(finalAnswer);
    expect(Buffer.byteLength(flatCard, 'utf8')).toBeLessThan(30_000);
    expect(text).toContain('执行活动已折叠（保留首尾）');
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThan(24_000);
    expect(text.endsWith(finalAnswer)).toBe(true);
  });
});

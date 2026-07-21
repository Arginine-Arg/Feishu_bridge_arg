/**
 * Regression tests for the v0.6.32 markdown-mode byte budget.
 *
 * Mirrors the v0.6.30 card-mode budget fix: when `renderText` would exceed
 * 24KB (the Lark SDK's per-element ceiling minus headroom), the trailing
 * content is folded with a middle marker. Without this, a long assistant
 * message rendered as markdown would crash the SDK's `setContent` call
 * (`230011 message withdrawn`), triggering a degraded fallback loop that
 * looks like "repeats of the same message" to the user.
 */
import { describe, expect, it } from 'vitest';
import { renderText } from '../../../src/card/text-renderer';
import { initialState, reduce, type RunState } from '../../../src/card/run-state';

function bigTextState(n: number): RunState {
  let state = initialState;
  state = reduce(state, { type: 'thinking', delta: 'thinking...' });
  state = reduce(state, { type: 'text', delta: 'x'.repeat(n) });
  return state;
}

describe('renderText byte budget (v0.6.32)', () => {
  it('passes through short text untouched', () => {
    const out = renderText(bigTextState(200));
    expect(out).toContain('x'.repeat(200));
    expect(out).not.toMatch(/已折叠/);
  });

  it('truncates long text and adds fold marker', () => {
    const out = renderText(bigTextState(60_000));
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThan(24_000);
    expect(out).toMatch(/已折叠/);
  });

  it('keeps the final answer after folding a long multi-block task', () => {
    const finalAnswer = 'FINAL_ANSWER: task completed successfully';
    const state: RunState = {
      ...initialState,
      terminal: 'done',
      footer: null,
      blocks: [
        { kind: 'text', content: 'old progress\n\n'.repeat(8_000), streaming: false },
        {
          kind: 'tool',
          tool: { id: 'tool-1', name: 'Bash', input: 'long task', status: 'done' },
        },
        { kind: 'text', content: finalAnswer, streaming: false },
      ],
    };

    const out = renderText(state);

    expect(Buffer.byteLength(out, 'utf8')).toBeLessThan(24_000);
    expect(out).toContain('old progress');
    expect(out).toMatch(/字节已折叠（保留首尾）/);
    expect(out.endsWith(finalAnswer)).toBe(true);
  });

  it('enforces the byte budget for multibyte text without splitting characters', () => {
    const state = bigTextState(1);
    state.blocks = [{ kind: 'text', content: '进度'.repeat(20_000) + '最终结论', streaming: false }];
    state.terminal = 'done';
    state.footer = null;

    const out = renderText(state);

    expect(Buffer.byteLength(out, 'utf8')).toBeLessThan(24_000);
    expect(out.endsWith('最终结论')).toBe(true);
    expect(out).not.toContain('�');
  });

  it('produces stable output on second call with same state', () => {
    const state = bigTextState(60_000);
    const a = renderText(state);
    const b = renderText(state);
    expect(a).toBe(b);
  });
});

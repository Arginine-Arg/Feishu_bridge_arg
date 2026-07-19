/**
 * Regression tests for the v0.6.32 markdown-mode byte budget.
 *
 * Mirrors the v0.6.30 card-mode budget fix: when `renderText` would exceed
 * 24KB (the Lark SDK's per-element ceiling minus headroom), the trailing
 * content is folded and a marker is appended. Without this, a long assistant
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
    expect(out).not.toMatch(/已截断/);
  });

  it('truncates long text and adds fold marker', () => {
    const out = renderText(bigTextState(60_000));
    expect(out.length).toBeLessThan(24_000);
    expect(out).toMatch(/已截断/);
  });

  it('produces stable output on second call with same state', () => {
    const state = bigTextState(60_000);
    const a = renderText(state);
    const b = renderText(state);
    expect(a).toBe(b);
  });
});
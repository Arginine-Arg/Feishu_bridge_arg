/**
 * Regression tests for the v0.6.30 card byte-budget fix.
 *
 * Background: Feishu's per-card-element limit (~30KB) means cards that grow
 * past it during a streamed `ctrl.update()` get rejected with `230011`
 * "message withdrawn", and our previous fallback path (`streamDegraded →
 * postFreshFinal`) could leave the user with a half-state and a duplicated
 * patch. To stop that we render-side cap the card at CARD_BYTE_BUDGET
 * (24_000) by:
 *   - folding earliest tool groups into header-only summaries, and
 *   - truncating oversized streaming text blocks (the actual offender;
 *     reasoning and per-tool bodies already had their own caps).
 */
import { describe, expect, it } from 'vitest';
import { renderCard } from '../../../src/card/run-renderer';
import {
  initialState,
  reduce,
  type RunState,
} from '../../../src/card/run-state';

describe('renderCard byte-budget enforcement', () => {
  it('keeps small cards untouched', () => {
    const state = reduce(initialState, {
      type: 'tool_use',
      id: 't1',
      name: 'Bash',
      input: { command: 'pwd' },
    });
    const card = renderCard(state) as { body: { elements: object[] } };
    const bytes = JSON.stringify(card).length;
    expect(bytes).toBeLessThan(5_000);
  });

  it('truncates oversized streaming text instead of letting it blow the budget', () => {
    // The actual offender: a 60KB assistant text block. There's no
    // per-block cap, so this used to render as a ~60KB card and crash the
    // stream update.
    const bigText = 'x'.repeat(60_000);
    let state: RunState = reduce(initialState, {
      type: 'text',
      delta: bigText,
    });
    state = reduce(state, { type: 'done', terminationReason: 'normal' });
    const card = renderCard(state);
    const bytes = JSON.stringify(card).length;

    expect(bytes).toBeLessThan(30_000);
    // Truncation marker should appear so the user knows content was folded.
    expect(JSON.stringify(card)).toMatch(/已截断/);
  });

  it('truncates oversized reasoning when it exceeds the cap', () => {
    // Reasoning already has REASONING_MAX=1500 — confirm budget path keeps
    // it under control too.
    const state = reduce(initialState, { type: 'thinking', delta: 'x'.repeat(80_000) });
    state.blocks; // satisfy lint
    const card = renderCard(state);
    expect(JSON.stringify(card).length).toBeLessThan(30_000);
  });
});

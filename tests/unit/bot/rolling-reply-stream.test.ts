import { describe, expect, it, vi } from 'vitest';
import { runRollingReplyStream } from '../../../src/bot/channel.js';
import { initialState, reduce, type RunState } from '../../../src/card/run-state.js';

describe('rolling reply stream', () => {
  it('opens a fresh stream segment before a long run finishes', async () => {
    vi.useFakeTimers();
    try {
      let resolveRender!: (state: RunState) => void;
      const renderDone = new Promise<RunState>((resolve) => {
        resolveRender = resolve;
      });
      let segments = 0;
      const segmentIds: number[] = [];
      const fallback = vi.fn(async () => {});
      const running = runRollingReplyStream({
        mode: 'markdown',
        renderDone,
        rolloverMs: 1_000,
        startSegment: async (segmentDone, markProducerStarted, segment) => {
          segments += 1;
          segmentIds.push(segment);
          markProducerStarted();
          await segmentDone;
        },
        fallback,
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(segments).toBe(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(segments).toBe(2);
      expect(segmentIds).toEqual([1, 2]);

      resolveRender(reduce(initialState, { type: 'done', terminationReason: 'normal' }));
      await running;

      expect(segments).toBe(2);
      expect(fallback).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('posts a fallback when the agent finishes before a producer starts', async () => {
    const finalState = reduce(initialState, { type: 'done', terminationReason: 'normal' });
    const fallback = vi.fn(async () => {});

    await runRollingReplyStream({
      mode: 'card',
      renderDone: Promise.resolve(finalState),
      rolloverMs: 1_000,
      startSegment: async (segmentDone) => {
        await segmentDone;
      },
      fallback,
    });

    expect(fallback).toHaveBeenCalledWith(finalState);
  });

  it('does not publish a footer-only continuation when no new text arrives', async () => {
    vi.useFakeTimers();
    try {
      let resolveRender!: (state: RunState) => void;
      const renderDone = new Promise<RunState>((resolve) => {
        resolveRender = resolve;
      });
      const waitingSegment = new Promise<void>(() => {});
      const opened: number[] = [];
      const fallback = vi.fn(async () => {});
      const running = runRollingReplyStream({
        mode: 'markdown',
        renderDone,
        rolloverMs: 1_000,
        startSegment: async (segmentDone, markProducerStarted, segment) => {
          if (segment > 1) await waitingSegment;
          opened.push(segment);
          markProducerStarted();
          await segmentDone;
        },
        fallback,
      });

      await vi.advanceTimersByTimeAsync(1_000);
      // The rollover asks for a continuation, but the producer is still
      // waiting for a real text delta, so no second Feishu stream is opened.
      expect(opened).toEqual([1]);

      const finalState = reduce(initialState, { type: 'done', terminationReason: 'normal' });
      resolveRender(finalState);
      await running;

      expect(opened).toEqual([1]);
      expect(fallback).toHaveBeenCalledWith(finalState);
    } finally {
      vi.useRealTimers();
    }
  });
});

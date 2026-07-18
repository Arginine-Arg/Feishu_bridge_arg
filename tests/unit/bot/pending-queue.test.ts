import { describe, expect, it, vi } from 'vitest';
import { PendingQueue } from '../../../src/bot/pending-queue';

const SCOPE = 'oc_test';

describe('PendingQueue busy-ack', () => {
  it('rate-limits busy acks and allows a later liveness acknowledgement', () => {
    let now = 1_000;
    const queue = new PendingQueue(10, () => {}, 30_000, () => now);

    // Not blocked → never ack.
    expect(queue.isBlocked(SCOPE)).toBe(false);
    expect(queue.shouldAckBusy(SCOPE)).toBe(false);

    // A run starts → blocked. The first queued message acks; a rapid burst does not.
    queue.block(SCOPE);
    expect(queue.isBlocked(SCOPE)).toBe(true);
    expect(queue.shouldAckBusy(SCOPE)).toBe(true);
    expect(queue.shouldAckBusy(SCOPE)).toBe(false);
    now += 29_999;
    expect(queue.shouldAckBusy(SCOPE)).toBe(false);
    now += 1;
    expect(queue.shouldAckBusy(SCOPE)).toBe(true);

    // Run ends → the next busy window is allowed a fresh immediate ack.
    queue.unblock(SCOPE);
    expect(queue.isBlocked(SCOPE)).toBe(false);
    expect(queue.shouldAckBusy(SCOPE)).toBe(false);

    queue.block(SCOPE);
    expect(queue.shouldAckBusy(SCOPE)).toBe(true);
    expect(queue.shouldAckBusy(SCOPE)).toBe(false);
  });

  it('cancelAll clears blocked and busy-ack state', () => {
    const queue = new PendingQueue(10, () => {});
    queue.block(SCOPE);
    expect(queue.shouldAckBusy(SCOPE)).toBe(true);

    queue.cancelAll();
    expect(queue.isBlocked(SCOPE)).toBe(false);
    expect(queue.shouldAckBusy(SCOPE)).toBe(false);
  });

  it('tracks busy-ack independently per scope', () => {
    const queue = new PendingQueue(10, () => {});
    queue.block('a');
    queue.block('b');
    expect(queue.shouldAckBusy('a')).toBe(true);
    expect(queue.shouldAckBusy('b')).toBe(true);
    expect(queue.shouldAckBusy('a')).toBe(false);
    // Unblocking one scope leaves the other's ack window intact.
    queue.unblock('a');
    expect(queue.shouldAckBusy('b')).toBe(false);
  });

  it('unblock re-arms the debounce timer for queued messages', () => {
    vi.useFakeTimers();
    try {
      const flushed: string[][] = [];
      const queue = new PendingQueue(10, (_scope, batch) => {
        flushed.push(batch.map((m) => m.content));
      });
      queue.block(SCOPE);
      // Message pushed while blocked accumulates without flushing.
      queue.push(SCOPE, { content: 'hi', chatId: SCOPE } as never);
      vi.advanceTimersByTime(50);
      expect(flushed).toHaveLength(0);
      // Unblock arms a fresh quiet window; batch flushes after the delay.
      queue.unblock(SCOPE);
      vi.advanceTimersByTime(50);
      expect(flushed).toEqual([['hi']]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('flushes a live interaction key before the deferred original task', () => {
    vi.useFakeTimers();
    try {
      const flushed: string[][] = [];
      const queue = new PendingQueue(10, (_scope, batch) => {
        flushed.push(batch.map((message) => message.content));
      });
      queue.block(SCOPE);
      queue.pushFront(SCOPE, { content: 'original task', chatId: SCOPE } as never);
      queue.pushFront(SCOPE, { content: 'down enter', chatId: SCOPE } as never);

      queue.unblock(SCOPE);
      vi.advanceTimersByTime(50);

      expect(flushed).toEqual([['down enter', 'original task']]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps startup work gated until a priority control releases it', () => {
    vi.useFakeTimers();
    try {
      const flushed: string[][] = [];
      const queue = new PendingQueue(10, (_scope, batch) => {
        flushed.push(batch.map((message) => message.content));
      });
      queue.block(SCOPE);
      queue.deferUntilPriority(SCOPE, [
        { content: 'original task', chatId: SCOPE } as never,
      ]);
      queue.push(SCOPE, { content: 'later message', chatId: SCOPE } as never);
      queue.unblock(SCOPE);
      vi.advanceTimersByTime(50);
      expect(flushed).toEqual([]);
      expect(queue.isBlocked(SCOPE)).toBe(true);

      queue.pushFront(SCOPE, { content: 'down enter', chatId: SCOPE } as never);
      vi.advanceTimersByTime(50);

      expect(flushed).toEqual([['down enter', 'original task', 'later message']]);
      expect(queue.isBlocked(SCOPE)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

import { describe, expect, it, vi } from 'vitest';
import { PendingQueue } from '../../../src/bot/pending-queue';

const SCOPE = 'oc_test';

describe('PendingQueue busy-ack', () => {
  it('acks once per blocked window and resets after unblock', () => {
    const queue = new PendingQueue(10, () => {});

    // Not blocked → never ack.
    expect(queue.isBlocked(SCOPE)).toBe(false);
    expect(queue.shouldAckBusy(SCOPE)).toBe(false);

    // A run starts → blocked. First queued message acks, subsequent ones don't.
    queue.block(SCOPE);
    expect(queue.isBlocked(SCOPE)).toBe(true);
    expect(queue.shouldAckBusy(SCOPE)).toBe(true);
    expect(queue.shouldAckBusy(SCOPE)).toBe(false);
    expect(queue.shouldAckBusy(SCOPE)).toBe(false);

    // Run ends → next busy window is allowed a fresh single ack.
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
});

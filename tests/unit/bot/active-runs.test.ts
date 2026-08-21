import { describe, expect, it } from 'vitest';
import type { AgentRun } from '../../../src/agent/types.js';
import { ActiveRuns, requestRunStop } from '../../../src/bot/active-runs.js';

function runWithCounters(counter: { stopCalls: number; detachCalls: number }): AgentRun {
  return {
    runId: 'run-1',
    events: {
      async *[Symbol.asyncIterator]() {
        yield { type: 'done' as const, terminationReason: 'normal' as const };
      },
    },
    async stop() {
      counter.stopCalls += 1;
    },
    async detach() {
      counter.detachCalls += 1;
    },
    async waitForExit() {
      return true;
    },
  };
}

describe('ActiveRuns stop delivery', () => {
  it('deduplicates concurrent watchdog, cleanup, and explicit-stop requests', async () => {
    const counter = { stopCalls: 0, detachCalls: 0 };
    const activeRuns = new ActiveRuns();
    const handle = activeRuns.register('scope-1', runWithCounters(counter));

    await Promise.all([
      requestRunStop(handle),
      requestRunStop(handle),
      requestRunStop(handle),
    ]);

    expect(handle.stopRequested).toBe(true);
    expect(counter.stopCalls).toBe(1);
  });

  it('does not send another stop after /stop has removed the active handle', async () => {
    const counter = { stopCalls: 0, detachCalls: 0 };
    const activeRuns = new ActiveRuns();
    const handle = activeRuns.register('scope-1', runWithCounters(counter));

    expect(activeRuns.interrupt('scope-1')).toBe(true);
    await requestRunStop(handle);

    expect(counter.stopCalls).toBe(1);
  });

  it('detaches a running relay without stopping the underlying agent', async () => {
    const counter = { stopCalls: 0, detachCalls: 0 };
    const activeRuns = new ActiveRuns();
    const handle = activeRuns.register('scope-1', runWithCounters(counter));

    expect(activeRuns.detach('scope-1')).toBe(true);
    await handle.detachPromise;

    expect(handle.detached).toBe(true);
    expect(handle.interrupted).toBe(true);
    expect(counter.detachCalls).toBe(1);
    expect(counter.stopCalls).toBe(0);
    expect(activeRuns.get('scope-1')).toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';
import type { AgentRun } from '../../../src/agent/types.js';
import { ActiveRuns, requestRunStop } from '../../../src/bot/active-runs.js';

function runWithStopCounter(counter: { calls: number }): AgentRun {
  return {
    runId: 'run-1',
    events: {
      async *[Symbol.asyncIterator]() {
        yield { type: 'done' as const, terminationReason: 'normal' as const };
      },
    },
    async stop() {
      counter.calls += 1;
    },
    async waitForExit() {
      return true;
    },
  };
}

describe('ActiveRuns stop delivery', () => {
  it('deduplicates concurrent watchdog, cleanup, and explicit-stop requests', async () => {
    const counter = { calls: 0 };
    const activeRuns = new ActiveRuns();
    const handle = activeRuns.register('scope-1', runWithStopCounter(counter));

    await Promise.all([
      requestRunStop(handle),
      requestRunStop(handle),
      requestRunStop(handle),
    ]);

    expect(handle.stopRequested).toBe(true);
    expect(counter.calls).toBe(1);
  });

  it('does not send another stop after /stop has removed the active handle', async () => {
    const counter = { calls: 0 };
    const activeRuns = new ActiveRuns();
    const handle = activeRuns.register('scope-1', runWithStopCounter(counter));

    expect(activeRuns.interrupt('scope-1')).toBe(true);
    await requestRunStop(handle);

    expect(counter.calls).toBe(1);
  });
});

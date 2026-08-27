import { describe, expect, it } from 'vitest';
import type { AgentRun } from '../../../src/agent/types.js';
import { ActiveRuns, requestRunStop } from '../../../src/bot/active-runs.js';

function runWithCounters(counter: { stopCalls: number; detachCalls: number; forceCalls?: number }): AgentRun {
  return {
    runId: 'run-1',
    events: {
      async *[Symbol.asyncIterator]() {
        yield { type: 'done' as const, terminationReason: 'normal' as const };
      },
    },
    async stop(options) {
      counter.stopCalls += 1;
      if (options?.force) counter.forceCalls = (counter.forceCalls ?? 0) + 1;
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
  it('upgrades a queued non-force stop to force without sending twice', async () => {
    const counter: { stopCalls: number; detachCalls: number; forceCalls?: number } = {
      stopCalls: 0,
      detachCalls: 0,
    };
    const activeRuns = new ActiveRuns();
    const handle = activeRuns.register('scope-upgrade', runWithCounters(counter));

    const safe = requestRunStop(handle);
    const forced = requestRunStop(handle, { force: true });
    await Promise.all([safe, forced]);

    expect(counter.stopCalls).toBe(1);
    expect(counter.forceCalls).toBe(1);
    expect(handle.stopStarted).toBe(true);
  });

  it('advances a per-scope stop generation even when no handle is registered', () => {
    const activeRuns = new ActiveRuns();
    const before = activeRuns.currentStopGeneration('scope-before-register');
    const after = activeRuns.advanceStopGeneration('scope-before-register');

    expect(after).toBe(before + 1);
    expect(activeRuns.isStopGenerationCurrent('scope-before-register', before)).toBe(false);
    expect(activeRuns.isStopGenerationCurrent('scope-before-register', after)).toBe(true);
  });

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
    const counter: { stopCalls: number; detachCalls: number; forceCalls?: number } = {
      stopCalls: 0,
      detachCalls: 0,
    };
    const activeRuns = new ActiveRuns();
    const handle = activeRuns.register('scope-1', runWithCounters(counter));

    expect(activeRuns.interrupt('scope-1')).toBe(true);
    await requestRunStop(handle);

    expect(counter.stopCalls).toBe(1);
    expect(counter.forceCalls).toBe(1);
  });

  it('keeps a stop-requested handle visible and makes repeated interrupts idempotent', async () => {
    const counter: { stopCalls: number; detachCalls: number; forceCalls?: number } = {
      stopCalls: 0,
      detachCalls: 0,
    };
    const activeRuns = new ActiveRuns();
    const handle = activeRuns.register('scope-repeat-stop', runWithCounters(counter));

    expect(activeRuns.interrupt('scope-repeat-stop')).toBe(true);
    expect(activeRuns.interrupt('scope-repeat-stop')).toBe(true);
    await handle.stopPromise;

    expect(counter.stopCalls).toBe(1);
    expect(counter.forceCalls).toBe(1);
    expect(activeRuns.get('scope-repeat-stop')).toBe(handle);

    activeRuns.unregister('scope-repeat-stop', handle.run);
    expect(activeRuns.get('scope-repeat-stop')).toBeUndefined();
  });

  it('deduplicates durable interrupt claims until a new run is registered', () => {
    const activeRuns = new ActiveRuns();

    expect(activeRuns.beginDurableInterrupt('scope-durable')).toBe(true);
    expect(activeRuns.beginDurableInterrupt('scope-durable')).toBe(false);
    activeRuns.finishDurableInterrupt('scope-durable', 'main', true);
    expect(activeRuns.beginDurableInterrupt('scope-durable')).toBe(false);

    activeRuns.finishDurableInterrupt('scope-durable', 'main', false);
    const run = runWithCounters({ stopCalls: 0, detachCalls: 0 });
    activeRuns.register('scope-durable', run);
    expect(activeRuns.beginDurableInterrupt('scope-durable')).toBe(true);
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

  it('stops a concurrent side handle before the main handle in auto mode', async () => {
    const mainCounter = { stopCalls: 0, detachCalls: 0 };
    const sideCounter: { stopCalls: number; detachCalls: number; forceCalls?: number } = {
      stopCalls: 0,
      detachCalls: 0,
    };
    const activeRuns = new ActiveRuns();
    const main = activeRuns.register('scope-1', runWithCounters(mainCounter));
    const side = activeRuns.registerSide('scope-1', runWithCounters(sideCounter));

    expect(activeRuns.interrupt('scope-1', 'auto')).toBe(true);
    await Promise.all([main.stopPromise, side.stopPromise]);

    expect(sideCounter.stopCalls).toBe(1);
    expect(sideCounter.forceCalls).toBe(1);
    expect(mainCounter.stopCalls).toBe(0);
    expect(activeRuns.get('scope-1')).toBe(main);
    // Side ownership is held until the observer's cleanup unregisters it.
    // This closes the race where a second /btw out writes before the first
    // stop has drained its event stream.
    expect(activeRuns.getSide('scope-1')).toBe(side);

    activeRuns.unregisterSide('scope-1', side.run);
    expect(activeRuns.getSide('scope-1')).toBeUndefined();

    expect(activeRuns.interrupt('scope-1', 'auto')).toBe(true);
    await main.stopPromise;
    expect(mainCounter.stopCalls).toBe(1);
  });
});

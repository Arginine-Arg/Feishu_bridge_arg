import { describe, expect, it } from 'vitest';
import {
  finalizeIfRunning,
  initialState,
  markIdleTimeout,
  markInterrupted,
  reduce,
  type RunState,
} from '../../../src/card/run-state';
import type { AgentEvent } from '../../../src/agent/types';

describe('run state elapsed-time bookkeeping', () => {
  it('stamps lastEventAt on every reducer transition', () => {
    const s0 = initialState;
    const s1 = reduce(s0, { type: 'thinking', delta: 'reasoning' });
    expect(s1.lastEventAt).toBeTypeOf('number');
    expect(s1.lastEventAt!).toBeGreaterThan(0);

    const s2 = reduce(s1, { type: 'text', delta: 'answer' });
    expect(s2.lastEventAt!).toBeGreaterThanOrEqual(s1.lastEventAt!);
  });

  it('sets lastToolStartedAt and resets currentToolElapsedMs on tool_use', () => {
    const s1 = reduce(initialState, {
      type: 'tool_use',
      id: 'tool-1',
      name: 'Bash',
      input: { command: 'sleep 30' },
    });
    expect(s1.lastToolStartedAt).toBeTypeOf('number');
    expect(s1.currentToolElapsedMs).toBe(0);
    expect(s1.footer).toBe('tool_running');
  });

  it('clears the tool-running fields when the matching tool_result arrives', () => {
    const opened = reduce(initialState, {
      type: 'tool_use',
      id: 'tool-1',
      name: 'Bash',
      input: { command: 'sleep 30' },
    });
    const closed = reduce(opened, {
      type: 'tool_result',
      id: 'tool-1',
      output: 'done',
      isError: false,
    });
    expect(closed.lastToolStartedAt).toBeUndefined();
    expect(closed.currentToolElapsedMs).toBeUndefined();
  });

  it('clears the tool-running fields on any terminal transition', () => {
    const opened: RunState = {
      ...reduce(initialState, {
        type: 'tool_use',
        id: 'tool-1',
        name: 'Bash',
        input: { command: 'sleep 30' },
      }),
      currentToolElapsedMs: 4500,
    };
    const done = reduce(opened, { type: 'done', terminationReason: 'normal' });
    expect(done.lastToolStartedAt).toBeUndefined();
    expect(done.currentToolElapsedMs).toBeUndefined();

    const interrupted = markInterrupted(opened);
    expect(interrupted.lastToolStartedAt).toBeUndefined();
    expect(interrupted.currentToolElapsedMs).toBeUndefined();

    const timedOut = markIdleTimeout(opened, 5);
    expect(timedOut.lastToolStartedAt).toBeUndefined();
    expect(timedOut.currentToolElapsedMs).toBeUndefined();

    const finalized = finalizeIfRunning(opened);
    expect(finalized.lastToolStartedAt).toBeUndefined();
    expect(finalized.currentToolElapsedMs).toBeUndefined();
  });

  it('does not throw when the reducer is fed events without a matching tool_use', () => {
    const events: AgentEvent[] = [
      { type: 'text', delta: 'orphan' },
      { type: 'tool_result', id: 'never-opened', output: 'x', isError: false },
    ];
    // Just ensure no crash and lastEventAt is monotonic.
    let state = initialState;
    for (const evt of events) state = reduce(state, evt);
    expect(state.lastEventAt).toBeTypeOf('number');
    expect(state.lastToolStartedAt).toBeUndefined();
  });
});

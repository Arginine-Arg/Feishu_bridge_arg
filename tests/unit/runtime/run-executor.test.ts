import { describe, expect, it } from 'vitest';
import { ActiveRuns } from '../../../src/bot/active-runs';
import { ProcessPool } from '../../../src/bot/process-pool';
import type { RunPolicyAllow } from '../../../src/policy/run-policy';
import { RunExecutor } from '../../../src/runtime/run-executor';
import { FakeAgentAdapter } from '../../helpers/fake-agent';

describe('RunExecutor policy runtime options', () => {
  it('cancels a run when /stop advances its generation before handle registration', async () => {
    const agent = new FakeAgentAdapter({
      events: [{ type: 'done', terminationReason: 'normal' }],
    });
    let releasePrepare!: () => void;
    const prepareBlocked = new Promise<void>((resolve) => {
      releasePrepare = resolve;
    });
    (agent as unknown as { prepareRun: () => Promise<void> }).prepareRun = async () => prepareBlocked;
    const activeRuns = new ActiveRuns();
    const scopeId = 'scope-stop-before-register';
    const generation = activeRuns.currentStopGeneration(scopeId);
    const executor = new RunExecutor({
      agent,
      pool: new ProcessPool(() => 1),
      activeRuns,
      createRunId: () => 'run-stop-before-register',
      now: () => 1000,
      postDoneExitGraceMs: 10,
    });

    const submit = executor.submit({
      scopeId,
      stopGeneration: generation,
      policy: policy(),
    });
    await Promise.resolve();
    activeRuns.advanceStopGeneration(scopeId);
    releasePrepare();

    await expect(submit).rejects.toMatchObject({ code: 'stop-requested' });
    expect(agent.runOptions).toHaveLength(0);
    expect(activeRuns.get(scopeId)).toBeUndefined();
  });

  it('passes policy sandbox and permission mode into each agent run', async () => {
    const agent = new FakeAgentAdapter({
      events: [{ type: 'done', terminationReason: 'normal' }],
    });
    const executor = new RunExecutor({
      agent,
      pool: new ProcessPool(() => 1),
      activeRuns: new ActiveRuns(),
      createRunId: () => 'run-policy',
      now: () => 1000,
      postDoneExitGraceMs: 10,
    });

    const execution = await executor.submit({
      scopeId: 'scope-policy',
      policy: policy({
        sandbox: 'workspace-write',
        permissionMode: 'acceptEdits',
      }),
    });

    expect(agent.runOptions[0]).toMatchObject({
      runId: 'run-policy',
      sandbox: 'workspace-write',
      permissionMode: 'acceptEdits',
    });

    await collect(execution.subscribe());
  });

  it('passes session override and Codex reasoning effort into each agent run', async () => {
    const agent = new FakeAgentAdapter({
      events: [{ type: 'done', terminationReason: 'normal' }],
    });
    const executor = new RunExecutor({
      agent,
      pool: new ProcessPool(() => 1),
      activeRuns: new ActiveRuns(),
      createRunId: () => 'run-hybrid',
      now: () => 1000,
      postDoneExitGraceMs: 10,
    });

    const execution = await executor.submit({
      scopeId: 'scope-hybrid',
      policy: policy(),
      sessionMode: 'live',
      reasoningEffort: 'high',
    });

    expect(agent.runOptions[0]).toMatchObject({
      runId: 'run-hybrid',
      sessionMode: 'live',
      reasoningEffort: 'high',
    });

    await collect(execution.subscribe());
  });

  it('runs a side conversation without replacing the active scope run', async () => {
    const agent = new FakeAgentAdapter({
      events: [
        [],
        [{ type: 'text', delta: 'side answer' }, { type: 'done', terminationReason: 'normal' }],
      ],
    });
    const activeRuns = new ActiveRuns();
    const executor = new RunExecutor({
      agent,
      pool: new ProcessPool(() => 2),
      activeRuns,
      createRunId: (() => {
        let n = 0;
        return () => `run-${++n}`;
      })(),
      now: () => 1000,
      postDoneExitGraceMs: 10,
    });

    const main = await executor.submit({
      scopeId: 'scope-side',
      policy: policy(),
      sessionMode: 'live',
    });
    const side = await executor.submit({
      scopeId: 'scope-side',
      policy: policy({ prompt: '/btw inspect the running goal' }),
      sessionMode: 'live',
      liveInputMode: 'side',
    });

    expect(agent.sideRunOptions).toHaveLength(1);
    expect(activeRuns.get('scope-side')).toBe(main.handle);
    expect(activeRuns.getSide('scope-side')).toBe(side.handle);
    expect(await collect(side.subscribe())).toEqual([
      { type: 'text', delta: 'side answer' },
      { type: 'done', terminationReason: 'normal' },
    ]);
    expect(activeRuns.get('scope-side')).toBe(main.handle);
    expect(activeRuns.getSide('scope-side')).toBeUndefined();

    await main.stop();
  });

  it('routes side-exit through runSide without a main handle and waits for a prior side observer', async () => {
    const agent = new FakeAgentAdapter({
      events: [
        [{ type: 'text', delta: 'side one' }, { type: 'done', terminationReason: 'normal' }],
        [{ type: 'text', delta: 'side two' }, { type: 'done', terminationReason: 'normal' }],
      ],
    });
    const activeRuns = new ActiveRuns();
    const executor = new RunExecutor({
      agent,
      pool: new ProcessPool(() => 1),
      activeRuns,
      createRunId: (() => {
        let n = 0;
        return () => `side-run-${++n}`;
      })(),
      now: () => 1000,
      postDoneExitGraceMs: 10,
    });

    const first = await executor.submit({
      scopeId: 'scope-side-only',
      policy: policy({ prompt: '/btw first' }),
      sessionMode: 'live',
      liveInputMode: 'side',
    });
    const secondPromise = executor.submit({
      scopeId: 'scope-side-only',
      policy: policy({ prompt: '/btw out' }),
      sessionMode: 'live',
      liveInputMode: 'side-exit',
    });

    await Promise.resolve();
    expect(agent.sideRunOptions).toHaveLength(1);
    expect(activeRuns.getSide('scope-side-only')).toBe(first.handle);

    expect(await collect(first.subscribe())).toEqual([
      { type: 'text', delta: 'side one' },
      { type: 'done', terminationReason: 'normal' },
    ]);
    const second = await secondPromise;
    expect(agent.sideRunOptions).toHaveLength(2);
    expect(await collect(second.subscribe())).toEqual([
      { type: 'text', delta: 'side two' },
      { type: 'done', terminationReason: 'normal' },
    ]);
  });

  it('detaches a stuck side body before starting /btw out', async () => {
    const agent = new FakeAgentAdapter({
      events: [
        [],
        [{ type: 'text', delta: 'side exit' }, { type: 'done', terminationReason: 'normal' }],
      ],
    });
    const activeRuns = new ActiveRuns();
    const executor = new RunExecutor({
      agent,
      pool: new ProcessPool(() => 1),
      activeRuns,
      createRunId: (() => {
        let n = 0;
        return () => `side-preempt-${++n}`;
      })(),
      now: () => 1000,
      postDoneExitGraceMs: 10,
    });

    const body = await executor.submit({
      scopeId: 'scope-side-preempt',
      policy: policy({ prompt: '/btw body' }),
      sessionMode: 'live',
      liveInputMode: 'side',
    });
    expect(activeRuns.getSide('scope-side-preempt')).toBe(body.handle);

    const exit = await executor.submit({
      scopeId: 'scope-side-preempt',
      policy: policy({ prompt: '/btw out' }),
      sessionMode: 'live',
      liveInputMode: 'side-exit',
      sideConversationConfirmed: true,
    });

    expect(agent.sideRunOptions.map((opts) => opts.liveInputMode)).toEqual(['side', 'side-exit']);
    expect(body.handle.detached).toBe(true);
    expect(body.handle.stopRequested).toBe(false);
    expect(activeRuns.getSide('scope-side-preempt')).toBe(exit.handle);
    await collect(exit.subscribe());
  });

  it('keeps a terminal handle until subscribers drain the final event', async () => {
    const agent = new FakeAgentAdapter({
      events: [{ type: 'done', terminationReason: 'normal' }],
    });
    const activeRuns = new ActiveRuns();
    const executor = new RunExecutor({
      agent,
      pool: new ProcessPool(() => 1),
      activeRuns,
      createRunId: () => 'run-final-delivery',
      now: () => 1000,
      postDoneExitGraceMs: 10,
    });

    const execution = await executor.submit({
      scopeId: 'scope-final-delivery',
      policy: policy(),
    });
    const iterator = execution.subscribe()[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({
      type: 'done',
      terminationReason: 'normal',
    });
    // The stream is terminal, but the batch may still be rendering/sending its
    // final Feishu reply. A lifecycle command must still find this handle.
    expect(activeRuns.get('scope-final-delivery')).toBe(execution.handle);
    expect(activeRuns.interrupt('scope-final-delivery')).toBe(true);
    await execution.handle.stopPromise;
    // Ownership is released only after the subscriber drains the terminal
    // event. A repeated `/stop` during final reply rendering must remain
    // idempotent and must not fall through to durable tmux.
    expect(activeRuns.get('scope-final-delivery')).toBe(execution.handle);
    expect((await iterator.next()).done).toBe(true);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(activeRuns.get('scope-final-delivery')).toBeUndefined();
  });
});

function policy(overrides: Partial<RunPolicyAllow> = {}): RunPolicyAllow {
  return {
    ok: true,
    prompt: 'hello',
    requestedCwd: '/tmp/repo',
    cwdRealpath: '/tmp/repo',
    accessMode: 'workspace',
    sandbox: 'workspace-write',
    permissionMode: 'acceptEdits',
    access: { ok: true, reason: 'allowed-user' },
    attachments: [],
    policyFingerprint: 'fp',
    expiresAt: 2000,
    ...overrides,
  };
}

async function collect(events: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const event of events) out.push(event);
  return out;
}

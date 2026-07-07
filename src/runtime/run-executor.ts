import { randomUUID } from 'node:crypto';
import type { AgentAdapter, AgentEvent, AgentRun } from '../agent/types';
import { ActiveRuns, type RunHandle } from '../bot/active-runs';
import { ProcessPool } from '../bot/process-pool';
import type { RunPolicyAllow } from '../policy/run-policy';
import { log } from '../core/logger';
import { RunRejected, SpawnFailed } from './errors';

export interface RunExecutorDeps {
  agent: AgentAdapter;
  pool: ProcessPool;
  activeRuns: ActiveRuns;
  createRunId?: () => string;
  now?: () => number;
  postDoneExitGraceMs?: number;
}

export interface SubmitRunInput {
  scopeId: string;
  policy: RunPolicyAllow;
  sessionMode?: 'turn' | 'live';
  liveInputMode?: 'command' | 'control';
  sessionId?: string;
  threadId?: string;
  model?: string;
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
  images?: readonly string[];
  stopGraceMs?: number;
  nowait?: boolean;
  observability?: {
    profile: string;
    agent: string;
    source: string;
    stage: string;
  };
}

export interface RunExecution {
  runId: string;
  scopeId: string;
  run: AgentRun;
  handle: RunHandle;
  subscribe(): AsyncIterable<AgentEvent>;
  stop(): Promise<void>;
}

const DEFAULT_POST_DONE_EXIT_GRACE_MS = 2000;

export class RunExecutor {
  private readonly agent: AgentAdapter;
  private readonly pool: ProcessPool;
  private readonly activeRuns: ActiveRuns;
  private readonly createRunId: () => string;
  private readonly now: () => number;
  private readonly postDoneExitGraceMs: number;

  constructor(deps: RunExecutorDeps) {
    this.agent = deps.agent;
    this.pool = deps.pool;
    this.activeRuns = deps.activeRuns;
    this.createRunId = deps.createRunId ?? randomUUID;
    this.now = deps.now ?? Date.now;
    this.postDoneExitGraceMs = deps.postDoneExitGraceMs ?? DEFAULT_POST_DONE_EXIT_GRACE_MS;
  }

  async submit(input: SubmitRunInput): Promise<RunExecution> {
    const submittedAt = this.now();
    if (input.policy.expiresAt <= this.now()) {
      throw new RunRejected('policy-expired', 'run policy expired before spawn');
    }
    if (this.activeRuns.newRunsPaused()) {
      throw new RunRejected(
        'reconnect-in-progress',
        this.activeRuns.newRunsPauseReason() ?? 'new runs are temporarily paused',
      );
    }
    const releaseScope = this.activeRuns.reserve(input.scopeId);
    if (!releaseScope) {
      throw new RunRejected('run-already-active', 'another run is already active for this scope');
    }

    const release = input.nowait ? this.pool.tryAcquire() : await this.pool.acquire();
    if (!release) {
      releaseScope();
      throw new RunRejected('pool-full', 'process pool is full');
    }
    if (this.activeRuns.newRunsPaused()) {
      release();
      releaseScope();
      throw new RunRejected(
        'reconnect-in-progress',
        this.activeRuns.newRunsPauseReason() ?? 'new runs are temporarily paused',
      );
    }

    const runId = this.createRunId();
    const startedAt = this.now();
    const queueWaitMs = startedAt - submittedAt;
    const runOptions = {
      runId,
      scopeId: input.scopeId,
      sessionMode: input.sessionMode,
      liveInputMode: input.liveInputMode,
      prompt: input.policy.prompt,
      cwd: input.policy.cwdRealpath,
      sessionId: input.sessionId,
      threadId: input.threadId,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      images: input.images,
      sandbox: input.policy.sandbox,
      permissionMode: input.policy.permissionMode,
      stopGraceMs: input.stopGraceMs,
    };
    let run: AgentRun;
    try {
      await this.agent.prepareRun?.(runOptions);
    } catch (err) {
      release();
      releaseScope();
      if (err instanceof SpawnFailed) throw err;
      throw new SpawnFailed('agent prepare failed', err, 'agent-prepare-failed');
    }
    if (this.activeRuns.newRunsPaused()) {
      release();
      releaseScope();
      throw new RunRejected(
        'reconnect-in-progress',
        this.activeRuns.newRunsPauseReason() ?? 'new runs are temporarily paused',
      );
    }
    try {
      run = this.agent.run(runOptions);
    } catch (err) {
      release();
      releaseScope();
      throw new SpawnFailed('agent spawn failed', err);
    }
    const dimensions = {
      runId,
      profile: input.observability?.profile ?? 'unknown',
      agent: input.observability?.agent ?? this.agent.id,
      scope: input.scopeId,
      source: input.observability?.source ?? 'unknown',
      stage: input.observability?.stage ?? 'submit',
    };
    log.info('run', 'started', {
      ...dimensions,
      queueWaitMs,
      accessMode: input.policy.accessMode,
      sandbox: input.policy.sandbox,
      permissionMode: input.policy.permissionMode,
    });

    let handle: RunHandle;
    try {
      handle = this.activeRuns.register(input.scopeId, run);
    } catch (err) {
      releaseScope();
      release();
      await run.stop().catch(() => {});
      throw new RunRejected(
        'run-already-active',
        err instanceof Error ? err.message : 'another run is already active for this scope',
      );
    }
    let cleaned = false;
    const cleanup = async (waitForExit: boolean): Promise<void> => {
      if (cleaned) return;
      cleaned = true;
      this.activeRuns.unregister(input.scopeId, run);
      release();
      if (waitForExit) {
        const exited = await run.waitForExit(this.postDoneExitGraceMs);
        if (!exited) {
          log.warn('run', 'post-done-exit-timeout', {
            ...dimensions,
            graceMs: this.postDoneExitGraceMs,
          });
          await run.stop().catch((err) => {
            log.warn('run', 'post-done-stop-failed', {
              ...dimensions,
              err: err instanceof Error ? err.message : String(err),
            });
          });
        }
      }
    };
    const fanout = new EventFanout(observeRunEvents(run.events, {
      dimensions,
      startedAt,
      now: this.now,
    }), async () => {
      await cleanup(!handle.interrupted);
    });

    return {
      runId,
      scopeId: input.scopeId,
      run,
      handle,
      subscribe: () => fanout.subscribe(),
      stop: async () => {
        handle.interrupted = true;
        await run.stop();
        await run.waitForExit(this.postDoneExitGraceMs);
        await cleanup(false);
      },
    };
  }
}

function observeRunEvents(
  events: AsyncIterable<AgentEvent>,
  opts: {
    dimensions: Record<string, unknown>;
    startedAt: number;
    now: () => number;
  },
): AsyncIterable<AgentEvent> {
  return {
    async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
      const iterator = events[Symbol.asyncIterator]();
      let closed = false;
      const close = async (): Promise<void> => {
        if (closed) return;
        closed = true;
        await iterator.return?.();
      };
      try {
        while (true) {
          const next = await iterator.next();
          if (next.done) return;
          const event = next.value;
          if (event.type === 'done') {
            log.info('run', 'completed', {
              ...opts.dimensions,
              result: event.terminationReason,
              durationMs: opts.now() - opts.startedAt,
            });
            await close();
            yield event;
            return;
          }
          if (event.type === 'error') {
            log.warn('run', 'failed', {
              ...opts.dimensions,
              result: event.terminationReason,
              durationMs: opts.now() - opts.startedAt,
              error: event.message,
            });
            await close();
            yield event;
            return;
          }
          yield event;
        }
      } finally {
        await close();
      }
    },
  };
}

class EventFanout {
  private readonly source: AsyncIterable<AgentEvent>;
  private readonly onDone: () => Promise<void>;
  private readonly buffer: AgentEvent[] = [];
  private readonly waiters = new Set<() => void>();
  private sourceIterator: AsyncIterator<AgentEvent> | undefined;
  private started = false;
  private done = false;
  private error: unknown;
  private activeSubscribers = 0;
  private cancelRequested = false;
  private closeSourcePromise: Promise<void> | undefined;

  constructor(source: AsyncIterable<AgentEvent>, onDone: () => Promise<void>) {
    this.source = source;
    this.onDone = onDone;
  }

  subscribe(): AsyncIterable<AgentEvent> {
    return {
      [Symbol.asyncIterator]: () => {
        let index = 0;
        let subscribed = false;
        let closed = false;
        let waiter: (() => void) | undefined;
        const release = (): void => {
          if (closed) return;
          closed = true;
          if (waiter) {
            this.waiters.delete(waiter);
            waiter();
            waiter = undefined;
          }
          if (subscribed) {
            subscribed = false;
            this.activeSubscribers = Math.max(0, this.activeSubscribers - 1);
            if (this.activeSubscribers === 0 && !this.done) {
              this.requestCancel();
            }
          }
        };
        return {
          next: async (): Promise<IteratorResult<AgentEvent>> => {
            if (closed) return { done: true, value: undefined };
            if (!subscribed) {
              subscribed = true;
              this.activeSubscribers += 1;
            }
            this.start();
            if (index < this.buffer.length) {
              return { done: false, value: this.buffer[index++]! };
            }
            if (this.error) throw this.error;
            if (this.done) return { done: true, value: undefined };
            await new Promise<void>((resolve) => {
              waiter = (): void => {
                if (waiter) this.waiters.delete(waiter);
                waiter = undefined;
                resolve();
              };
              this.waiters.add(waiter);
            });
            if (closed) return { done: true, value: undefined };
            if (index < this.buffer.length) {
              return { done: false, value: this.buffer[index++]! };
            }
            if (this.error) throw this.error;
            return { done: true, value: undefined };
          },
          return: async (): Promise<IteratorResult<AgentEvent>> => {
            release();
            return { done: true, value: undefined };
          },
          throw: async (err?: unknown): Promise<IteratorResult<AgentEvent>> => {
            release();
            throw err;
          },
        };
      },
    };
  }

  private start(): void {
    if (this.started) return;
    this.started = true;
    void this.pump();
  }

  private async pump(): Promise<void> {
    try {
      const iterator = this.source[Symbol.asyncIterator]();
      this.sourceIterator = iterator;
      while (!this.cancelRequested) {
        const next = await iterator.next();
        if (next.done) break;
        const event = next.value;
        this.buffer.push(event);
        this.wakeAll();
        if (isTerminalEvent(event)) {
          await this.closeSource();
          break;
        }
      }
    } catch (err) {
      if (!this.cancelRequested) this.error = err;
    } finally {
      await this.closeSource();
      await this.onDone();
      this.done = true;
      this.wakeAll();
    }
  }

  private requestCancel(): void {
    this.cancelRequested = true;
    void this.closeSource();
    this.wakeAll();
  }

  private closeSource(): Promise<void> {
    if (this.closeSourcePromise) return this.closeSourcePromise;
    const iterator = this.sourceIterator;
    if (!iterator) return Promise.resolve();
    this.closeSourcePromise = Promise.resolve(iterator?.return?.()).then(() => undefined);
    return this.closeSourcePromise;
  }

  private wakeAll(): void {
    for (const wake of [...this.waiters]) wake();
  }
}

function isTerminalEvent(event: AgentEvent): boolean {
  return event.type === 'done' || event.type === 'error';
}

import type { AgentRun, AgentRunStopOptions } from '../agent/types';

export interface RunHandle {
  run: AgentRun;
  /** Native side operation currently owning the shared terminal. */
  sideInputMode?: 'side' | 'side-exit';
  interrupted: boolean;
  /** The bridge relay ended, but the underlying agent must keep running. */
  detached: boolean;
  /** A stop request is a one-shot terminal operation, never a retry loop. */
  stopRequested: boolean;
  /** An explicit lifecycle command requested a terminal interrupt. */
  forceStopRequested?: boolean;
  stopPromise?: Promise<void>;
  /** True once the one-shot stop call has entered the agent adapter. */
  stopStarted?: boolean;
  detachPromise?: Promise<void>;
}

export type RunInterruptTarget = 'main' | 'side' | 'auto';

/**
 * Several lifecycle paths can converge on a running turn (for example /stop,
 * the idle watchdog, and run cleanup). A live terminal must receive at most
 * one interrupt request for that turn.
 */
export function requestRunStop(handle: RunHandle, options: AgentRunStopOptions = {}): Promise<void> {
  if (options.force) handle.forceStopRequested = true;
  if (handle.stopPromise) return handle.stopPromise;
  handle.stopRequested = true;
  handle.stopPromise = Promise.resolve().then(() => {
    handle.stopStarted = true;
    return handle.run.stop(handle.forceStopRequested ? { force: true } : undefined);
  });
  return handle.stopPromise;
}

export function requestRunDetach(handle: RunHandle): Promise<void> {
  if (handle.detachPromise) return handle.detachPromise;
  handle.detachPromise = Promise.resolve()
    .then(() => handle.run.detach?.())
    .then(() => undefined);
  return handle.detachPromise;
}

export class ActiveRuns {
  private readonly handles = new Map<string, RunHandle>();
  // A live side conversation multiplexes the same terminal as the main run,
  // so it must not occupy the main scope slot. It still needs its own handle
  // so /stop can cancel the side observer without touching the main task.
  private readonly sideHandles = new Map<string, RunHandle>();
  private readonly sideReleaseWaiters = new Map<string, Set<() => void>>();
  private readonly reservations = new Set<string>();
  // Lifecycle commands can arrive while run-flow/executor is still awaiting
  // media, policy, or a process-pool slot. A generation lets those commands
  // cancel work before an ActiveRuns handle exists without cancelling future
  // messages that arrive after the command.
  // Main and side turns share a terminal but have independent cancellation
  // generations. A side lifecycle command must not invalidate a main turn
  // that is still preparing or streaming in the same scope.
  private readonly stopGenerations = new Map<string, number>();
  private readonly sideStopGenerations = new Map<string, number>();
  // Durable tmux interrupts can outlive bridge-side handles. Keep a small
  // per-scope claim so concurrent/repeated `/stop` commands cannot inject
  // duplicate Ctrl-C bytes while the first fallback is still in flight.
  private readonly durableStops = new Map<string, 'in-flight' | 'requested'>();
  private pauseDepth = 0;
  private pauseReason: string | undefined;

  reserve(chatId: string): (() => void) | undefined {
    if (this.hasAny(chatId) || this.reservations.has(chatId)) return undefined;
    this.reservations.add(chatId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.reservations.delete(chatId);
    };
  }

  register(chatId: string, run: AgentRun): RunHandle {
    if (this.handles.has(chatId)) {
      throw new Error(`run already active for scope: ${chatId}`);
    }
    this.reservations.delete(chatId);
    this.durableStops.delete(this.durableStopKey(chatId, 'main'));
    const handle = createRunHandle(run);
    this.handles.set(chatId, handle);
    return handle;
  }

  registerSide(chatId: string, run: AgentRun, sideInputMode?: 'side' | 'side-exit'): RunHandle {
    if (this.sideHandles.has(chatId)) {
      throw new Error(`side run already active for scope: ${chatId}`);
    }
    const handle = createRunHandle(run, sideInputMode);
    this.durableStops.delete(this.durableStopKey(chatId, 'side'));
    this.sideHandles.set(chatId, handle);
    return handle;
  }

  pauseNewRuns(reason: string): () => void {
    this.pauseDepth++;
    this.pauseReason = reason;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.pauseDepth = Math.max(0, this.pauseDepth - 1);
      if (this.pauseDepth === 0) this.pauseReason = undefined;
    };
  }

  newRunsPaused(): boolean {
    return this.pauseDepth > 0;
  }

  newRunsPauseReason(): string | undefined {
    return this.pauseReason;
  }

  currentStopGeneration(chatId: string, target: RunInterruptTarget = 'main'): number {
    const generations = target === 'side' ? this.sideStopGenerations : this.stopGenerations;
    return generations.get(chatId) ?? 0;
  }

  advanceStopGeneration(chatId: string, target: RunInterruptTarget = 'main'): number {
    const generations = target === 'side' ? this.sideStopGenerations : this.stopGenerations;
    const next = this.currentStopGeneration(chatId, target) + 1;
    generations.set(chatId, next);
    return next;
  }

  isStopGenerationCurrent(
    chatId: string,
    generation: number,
    target: RunInterruptTarget = 'main',
  ): boolean {
    return this.currentStopGeneration(chatId, target) === generation;
  }

  /** Claim one durable tmux interrupt for a scope/plane. */
  beginDurableInterrupt(chatId: string, target: 'main' | 'side' = 'main'): boolean {
    const key = this.durableStopKey(chatId, target);
    if (this.durableStops.has(key)) return false;
    this.durableStops.set(key, 'in-flight');
    return true;
  }

  /** Complete a durable interrupt claim; unsuccessful evidence remains retryable. */
  finishDurableInterrupt(
    chatId: string,
    target: 'main' | 'side',
    sent: boolean,
  ): void {
    const key = this.durableStopKey(chatId, target);
    if (this.durableStops.get(key) !== 'in-flight') return;
    if (sent) this.durableStops.set(key, 'requested');
    else this.durableStops.delete(key);
  }

  get(chatId: string): RunHandle | undefined {
    return this.handles.get(chatId);
  }

  getSide(chatId: string): RunHandle | undefined {
    return this.sideHandles.get(chatId);
  }

  hasAny(chatId: string): boolean {
    return this.handles.has(chatId) || this.sideHandles.has(chatId);
  }

  unregister(chatId: string, run: AgentRun): void {
    const existing = this.handles.get(chatId);
    if (existing?.run === run) this.handles.delete(chatId);
  }

  unregisterSide(chatId: string, run: AgentRun): void {
    const existing = this.sideHandles.get(chatId);
    if (existing?.run !== run) return;
    this.sideHandles.delete(chatId);
    this.notifySideReleased(chatId);
  }

  /** Wait until no side observer owns the shared terminal for this scope. */
  async waitForSideAvailable(chatId: string, timeoutMs = 120_000): Promise<boolean> {
    if (!this.sideHandles.has(chatId)) return true;
    const waiters = this.sideReleaseWaiters.get(chatId) ?? new Set<() => void>();
    this.sideReleaseWaiters.set(chatId, waiters);
    return new Promise<boolean>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onRelease = (): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        waiters.delete(onRelease);
        if (waiters.size === 0) this.sideReleaseWaiters.delete(chatId);
        resolve(!this.sideHandles.has(chatId));
      };
      timer = setTimeout(onRelease, Math.max(0, timeoutMs));
      waiters.add(onRelease);
      // The handle can release between the initial check and registration.
      if (!this.sideHandles.has(chatId)) onRelease();
    });
  }

  snapshot(): RunHandle[] {
    return this.allHandles();
  }

  scopes(): string[] {
    return [...new Set([...this.handles.keys(), ...this.sideHandles.keys()])];
  }

  /**
   * Topic scopes are represented as `${chatId}:${threadId}`. When Feishu
   * drops a thread id from a lifecycle event, allow the command layer to
   * recover an unambiguous active scope instead of reporting a false idle.
   */
  scopesForChat(chatId: string): string[] {
    const prefix = `${chatId}:`;
    return this.scopes().filter((scope) => scope === chatId || scope.startsWith(prefix));
  }

  /**
   * Interrupt the current run for this chat, if any. Returns true if an
   * interrupt was issued. Delivery is one-shot so a persistent live terminal
   * cannot receive duplicate Ctrl-C bytes from cleanup races.
   */
  interrupt(
    chatId: string,
    target: RunInterruptTarget = 'main',
    options: AgentRunStopOptions = { force: true },
  ): boolean {
    const h = target === 'side'
      ? this.sideHandles.get(chatId)
      : target === 'auto'
        ? this.sideHandles.get(chatId) ?? this.handles.get(chatId)
        : this.handles.get(chatId);
    if (!h) return false;
    // Keep the handle visible until its event stream cleanup unregisters it.
    // A repeated `/stop` should be an idempotent acknowledgement, not a cue
    // for the command layer to fall through to the durable tmux interrupt and
    // emit a second Ctrl-C into the same pane.
    if (h.stopRequested) {
      if (options.force) {
        void requestRunStop(h, options).catch(() => {
          /* stop errors are non-fatal */
        });
      }
      return true;
    }
    this.reservations.delete(chatId);
    h.interrupted = true;
    const isSide = this.sideHandles.get(chatId) === h;
    // Keep both main and side handles registered until RunExecutor observes
    // stream cleanup. A stop() promise can resolve before its async generator
    // has drained, and another lifecycle command during that gap would
    // otherwise target the same pane concurrently.
    const stopPromise = requestRunStop(h, options);
    if (isSide) {
      void stopPromise.then(
        () => undefined,
        () => undefined,
      );
    }
    void stopPromise.catch(() => {
      /* stop errors are non-fatal */
    });
    return true;
  }

  interruptMain(chatId: string): boolean {
    return this.interrupt(chatId, 'main');
  }

  interruptSide(chatId: string): boolean {
    return this.interrupt(chatId, 'side');
  }

  detach(chatId: string): boolean {
    const h = this.handles.get(chatId);
    if (!h) return false;
    this.reservations.delete(chatId);
    h.interrupted = true;
    h.detached = true;
    this.handles.delete(chatId);
    void requestRunDetach(h).catch(() => {
      /* detach errors are non-fatal */
    });
    return true;
  }

  detachSide(chatId: string): boolean {
    const h = this.sideHandles.get(chatId);
    if (!h) return false;
    h.interrupted = true;
    h.detached = true;
    this.sideHandles.delete(chatId);
    this.notifySideReleased(chatId);
    void requestRunDetach(h).catch(() => {
      /* detach errors are non-fatal */
    });
    return true;
  }

  /**
   * Release a side relay before a guarded `/btw out` starts. A body relay can
   * be waiting on a slow redraw for a long time; waiting for its normal
   * timeout would make the exit command look stuck. Detach only the bridge
   * observer, never the shared agent process or its main run.
   */
  async detachSideAndWait(chatId: string): Promise<boolean> {
    const handle = this.sideHandles.get(chatId);
    if (!handle) return false;
    const detached = this.detachSide(chatId);
    if (!detached) return false;
    await handle.detachPromise;
    return true;
  }

  async stopAll(): Promise<void> {
    const all = this.allHandles();
    for (const scope of this.scopes()) {
      this.advanceStopGeneration(scope, 'main');
      this.advanceStopGeneration(scope, 'side');
    }
    this.handles.clear();
    this.sideHandles.clear();
    this.durableStops.clear();
    for (const scope of this.sideReleaseWaiters.keys()) this.notifySideReleased(scope);
    this.reservations.clear();
    for (const h of all) h.interrupted = true;
    await Promise.allSettled(all.map((h) => requestRunStop(h)));
  }

  /**
   * Drop bridge-side run ownership during a relay restart without signaling
   * the agent. Managed tmux sessions are durable runtimes: sending Ctrl-C
   * here would destroy an unrelated long-running task merely because the
   * Feishu websocket or bridge binary was restarted.
   */
  async detachAll(): Promise<void> {
    const all = this.allHandles();
    this.handles.clear();
    this.sideHandles.clear();
    this.durableStops.clear();
    for (const scope of this.sideReleaseWaiters.keys()) this.notifySideReleased(scope);
    this.reservations.clear();
    for (const h of all) {
      // Existing renderers already use `interrupted` to suppress stale output.
      // `detached` preserves the crucial distinction: this is not a request to
      // interrupt the agent, so no later cleanup path may call run.stop().
      h.interrupted = true;
      h.detached = true;
    }
    await Promise.allSettled(all.map((h) => requestRunDetach(h)));
  }

  async waitForAll(timeoutMs = 300_000): Promise<void> {
    const all = this.allHandles();
    await Promise.allSettled(all.map((h) => h.run.waitForExit(timeoutMs)));
  }

  private allHandles(): RunHandle[] {
    return [...new Set([...this.handles.values(), ...this.sideHandles.values()])];
  }

  private notifySideReleased(chatId: string): void {
    const waiters = this.sideReleaseWaiters.get(chatId);
    if (!waiters) return;
    for (const resolve of [...waiters]) resolve();
  }

  private durableStopKey(chatId: string, target: 'main' | 'side'): string {
    return `${target}:${chatId}`;
  }
}

function createRunHandle(run: AgentRun, sideInputMode?: 'side' | 'side-exit'): RunHandle {
  return {
    run,
    ...(sideInputMode ? { sideInputMode } : {}),
    interrupted: false,
    detached: false,
    stopRequested: false,
  };
}

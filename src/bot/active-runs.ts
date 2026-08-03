import type { AgentRun } from '../agent/types';

export interface RunHandle {
  run: AgentRun;
  interrupted: boolean;
  /** The bridge relay ended, but the underlying agent must keep running. */
  detached: boolean;
  /** A stop request is a one-shot terminal operation, never a retry loop. */
  stopRequested: boolean;
  stopPromise?: Promise<void>;
}

/**
 * Several lifecycle paths can converge on a running turn (for example /stop,
 * the idle watchdog, and run cleanup). A live terminal must receive at most
 * one interrupt request for that turn.
 */
export function requestRunStop(handle: RunHandle): Promise<void> {
  if (handle.stopPromise) return handle.stopPromise;
  handle.stopRequested = true;
  handle.stopPromise = Promise.resolve().then(() => handle.run.stop());
  return handle.stopPromise;
}

export class ActiveRuns {
  private readonly handles = new Map<string, RunHandle>();
  private readonly reservations = new Set<string>();
  private pauseDepth = 0;
  private pauseReason: string | undefined;

  reserve(chatId: string): (() => void) | undefined {
    if (this.handles.has(chatId) || this.reservations.has(chatId)) return undefined;
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
    const handle: RunHandle = {
      run,
      interrupted: false,
      detached: false,
      stopRequested: false,
    };
    this.handles.set(chatId, handle);
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

  get(chatId: string): RunHandle | undefined {
    return this.handles.get(chatId);
  }

  unregister(chatId: string, run: AgentRun): void {
    const existing = this.handles.get(chatId);
    if (existing?.run === run) this.handles.delete(chatId);
  }

  snapshot(): RunHandle[] {
    return [...this.handles.values()];
  }

  scopes(): string[] {
    return [...this.handles.keys()];
  }

  /**
   * Interrupt the current run for this chat, if any. Returns true if an
   * interrupt was issued. Delivery is one-shot so a persistent live terminal
   * cannot receive duplicate Ctrl-C bytes from cleanup races.
   */
  interrupt(chatId: string): boolean {
    const h = this.handles.get(chatId);
    if (!h) return false;
    this.reservations.delete(chatId);
    h.interrupted = true;
    this.handles.delete(chatId);
    void requestRunStop(h).catch(() => {
      /* stop errors are non-fatal */
    });
    return true;
  }

  async stopAll(): Promise<void> {
    const all = [...this.handles.values()];
    this.handles.clear();
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
    const all = [...this.handles.values()];
    this.handles.clear();
    this.reservations.clear();
    for (const h of all) {
      // Existing renderers already use `interrupted` to suppress stale output.
      // `detached` preserves the crucial distinction: this is not a request to
      // interrupt the agent, so no later cleanup path may call run.stop().
      h.interrupted = true;
      h.detached = true;
    }
  }

  async waitForAll(timeoutMs = 300_000): Promise<void> {
    const all = [...this.handles.values()];
    await Promise.allSettled(all.map((h) => h.run.waitForExit(timeoutMs)));
  }
}

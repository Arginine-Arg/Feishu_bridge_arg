import type { AgentAvailability } from './preflight';
import type { ClaudePermissionMode, CodexSandboxMode } from '../config/permissions';
import type { CodexReasoningEffort } from '../config/schema';
import type { AgentTmuxControl } from './tmux-control';

export type { ClaudePermissionMode } from '../config/permissions';

export type LiveTurnPhase =
  | 'idle'
  | 'starting'
  | 'awaiting-input'
  | 'submitted'
  | 'busy'
  | 'picker'
  | 'streaming'
  | 'settling'
  | 'failed';

/** Options for stopping one agent run. Explicit user stops may force a
 * terminal interrupt even when the last screen frame did not contain a busy
 * marker; watchdog and cleanup paths intentionally use the safe default. */
export interface AgentRunStopOptions {
  force?: boolean;
}

export interface LiveSessionDiagnostics {
  phase: LiveTurnPhase;
  /** True when the persistent terminal is currently in a side conversation. */
  sideConversation?: boolean;
  generation?: string;
  promptPreview?: string;
  inputState: 'empty' | 'draft' | 'submitted' | 'unknown';
  retryCount: number;
  startedAt?: number;
  lastInputAt?: number;
  lastOutputAt?: number;
  lastError?: string;
  terminal?: {
    backend: 'tmux' | 'pty' | 'pipe';
    socketPath?: string;
    sessionName?: string;
    target?: string;
    attachCommand?: string;
    ownership?: 'managed' | 'external';
  };
}

export type AgentEvent =
  | {
      type: 'system';
      sessionId?: string;
      threadId?: string;
      cwd?: string;
      model?: string;
      /** Internal live-terminal lifecycle evidence; never rendered as text. */
      sideConversation?: 'entered' | 'exited';
    }
  | {
      type: 'text';
      delta: string;
      /** Present only for screen-derived native terminal output. */
      source?: 'live-terminal' | 'agent';
      /** Monotonic within one live terminal turn. */
      sequence?: number;
    }
  | { type: 'interactive'; text: string; phase: 'startup' | 'turn'; interaction?: import('./structured/contracts').StructuredInteraction }
  | { type: 'thinking'; delta: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; id: string; output: string; isError: boolean }
  | {
      type: 'usage';
      inputTokens?: number;
      outputTokens?: number;
      cachedInputTokens?: number;
      reasoningOutputTokens?: number;
      costUsd?: number;
    }
  | {
      type: 'done';
      sessionId?: string;
      threadId?: string;
      terminationReason: 'normal' | 'interrupted' | 'timeout';
    }
  | { type: 'error'; message: string; terminationReason: 'failed' | 'interrupted' | 'timeout' };

export const CLAUDE_DEFAULT_PERMISSION_MODE: ClaudePermissionMode = 'bypassPermissions';

export interface AgentRunOptions {
  runId: string;
  scopeId?: string;
  sessionMode?: 'turn' | 'live';
  liveInputMode?: 'command' | 'control' | 'side' | 'side-exit';
  /** Bridge-side evidence that this live terminal is already in side mode. */
  sideConversationConfirmed?: boolean;
  prompt: string;
  cwd?: string;
  sessionId?: string;
  threadId?: string;
  model?: string;
  reasoningEffort?: CodexReasoningEffort;
  images?: readonly string[];
  sandbox?: CodexSandboxMode;
  permissionMode?: ClaudePermissionMode;
  /** Run-scoped capability for asking the bridge to deliver a local file. */
  artifactDelivery?: {
    socketPath: string;
    token: string;
  };
  /**
   * Grace period (ms) between SIGTERM and SIGKILL when stop() is called on
   * the returned run. Lets the agent (and any subprocess it spawned, e.g.
   * lark-cli mid-OAuth) clean up before the kernel reaps the tree.
   * Adapters that don't kill via signals are free to ignore this. Defaults
   * are adapter-specific.
  */
  stopGraceMs?: number;
}

export interface AgentRun {
  readonly runId: string;
  readonly events: AsyncIterable<AgentEvent>;
  stop(options?: AgentRunStopOptions): Promise<void>;
  detach?(): Promise<void>;
  /**
   * Wait up to `timeoutMs` for the agent process to exit on its own.
   * Resolves true if it exited within the window, false if the timer
   * fired first (caller usually wants to fall back to stop()).
   *
   * Use this after a terminal stream event (`done` / `error`): the
   * stream-json `result` line arrives before claude has actually closed
   * stdout — there's a brief telemetry/cleanup tail in between. Calling
   * stop() in that window forces a SIGTERM and the run exits with code
   * 143 instead of 0; waiting it out lets it exit cleanly.
   */
  waitForExit(timeoutMs: number): Promise<boolean>;
}

/**
 * The bridge bot's own IM identity, resolved by the channel after the WS
 * handshake (`/open-apis/bot/v3/info`). Injected into adapters so the agent
 * system prompt can state "this open_id is you" with the real value.
 */
export interface AgentBotIdentity {
  openId: string;
  name?: string;
}

export interface AgentAdapter {
  /** Resolve transport before intake/control handling for this scope. */
  forScope?(scopeId: string): AgentAdapter;
  /** Optional structured control plane; no terminal input or model call. */
  structuredControl?: (scopeId: string, input: string) => Promise<AgentEvent[]>;
  structuredQuestion?: (scopeId: string) => string | undefined;
  structuredReady?: (scopeId: string) => boolean;
  readonly id: string;
  readonly displayName: string;
  isAvailable(): Promise<boolean>;
  checkAvailability?(): Promise<AgentAvailability>;
  prepareRun?(opts: AgentRunOptions): Promise<void>;
  run(opts: AgentRunOptions): AgentRun;
  /**
   * Run a native side conversation against an already-running live session.
   * This is deliberately separate from `run`: it must not replace the main
   * terminal observer or unregister the main scope from ActiveRuns.
   */
  runSide?(opts: AgentRunOptions): AgentRun;
  tmux?: AgentTmuxControl;
  /**
   * Late-bound identity injection: the adapter is constructed before the
   * channel connects, so the channel calls this once botIdentity is known.
   * Adapters that don't bake identity into their prompts may omit it.
   */
  setBotIdentity?(identity: AgentBotIdentity): void;
  shutdown?(): Promise<void>;
}

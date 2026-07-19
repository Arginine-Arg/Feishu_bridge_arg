import type { AgentEvent } from '../agent/types';

export type ToolStatus = 'running' | 'done' | 'error';

export interface ToolEntry {
  id: string;
  name: string;
  input: unknown;
  status: ToolStatus;
  output?: string;
}

export type Block =
  | { kind: 'text'; content: string; streaming: boolean }
  | { kind: 'tool'; tool: ToolEntry };

export type FooterStatus = 'thinking' | 'tool_running' | 'streaming' | null;
export type Terminal = 'running' | 'done' | 'interrupted' | 'error' | 'idle_timeout';

export interface RunState {
  blocks: Block[];
  reasoning: { content: string; active: boolean };
  footer: FooterStatus;
  terminal: Terminal;
  errorMsg?: string;
  /** Set when terminal === 'idle_timeout' — how long claude was idle before
   * the watchdog gave up (so the message can say "N 分钟无响应"). */
  idleTimeoutMinutes?: number;
  /**
   * Wall-clock time (ms epoch) of the most recent reducer transition. The
   * progress-heartbeat tick inside `processAgentStream` uses this to decide
   * whether the streaming card has gone stale and needs a re-render so the
   * user sees the tool's elapsed time continue to tick.
   */
  lastEventAt?: number;
  /**
   * Wall-clock time (ms epoch) of the currently-running tool's tool_use
   * event. Set when a tool opens, cleared when its tool_result arrives
   * (or the run reaches any terminal state). Drives the
   * `currentToolElapsedMs` projection surfaced in the card footer.
   */
  lastToolStartedAt?: number;
  /**
   * Tool's running duration in ms, refreshed by the progress heartbeat
   * inside `processAgentStream`. Undefined when no tool is in flight; the
   * footer/projection code skips the elapsed suffix when this is absent so
   * short tasks render unchanged.
   */
  currentToolElapsedMs?: number;
}

export const initialState: RunState = {
  blocks: [],
  reasoning: { content: '', active: false },
  footer: 'thinking',
  terminal: 'running',
};

function closeStreamingText(blocks: Block[]): Block[] {
  return blocks.map((b) =>
    b.kind === 'text' && b.streaming ? { ...b, streaming: false } : b,
  );
}

/**
 * Stamp `lastEventAt = now` and clear the running-tool fields on terminal
 * transitions. The reducer calls this on every branch so the heartbeat tick
 * always sees an accurate "last touched" timestamp.
 */
function withLiveness(
  state: RunState,
  now: number,
  opts: { clearTool?: boolean } = {},
): RunState {
  const base: RunState = { ...state, lastEventAt: now };
  if (opts.clearTool) {
    delete base.lastToolStartedAt;
    delete base.currentToolElapsedMs;
  }
  return base;
}

export function reduce(state: RunState, evt: AgentEvent): RunState {
  switch (evt.type) {
    case 'text': {
      const last = state.blocks[state.blocks.length - 1];
      if (last && last.kind === 'text' && last.streaming) {
        const next: Block = { ...last, content: last.content + evt.delta };
        return withLiveness(
          {
            ...state,
            blocks: [...state.blocks.slice(0, -1), next],
            reasoning: { ...state.reasoning, active: false },
            footer: 'streaming',
          },
          Date.now(),
        );
      }
      return withLiveness(
        {
          ...state,
          blocks: [...state.blocks, { kind: 'text', content: evt.delta, streaming: true }],
          reasoning: { ...state.reasoning, active: false },
          footer: 'streaming',
        },
        Date.now(),
      );
    }

    case 'thinking': {
      return withLiveness(
        {
          ...state,
          reasoning: { content: state.reasoning.content + evt.delta, active: true },
          footer: 'thinking',
        },
        Date.now(),
      );
    }

    case 'tool_use': {
      const tool: ToolEntry = {
        id: evt.id,
        name: evt.name,
        input: evt.input,
        status: 'running',
      };
      const now = Date.now();
      return {
        ...withLiveness(
          {
            ...state,
            blocks: [...closeStreamingText(state.blocks), { kind: 'tool', tool }],
            reasoning: { ...state.reasoning, active: false },
            footer: 'tool_running',
          },
          now,
        ),
        // Reset any prior tool's elapsed display; the new tool starts the
        // clock fresh. lastToolStartedAt drives currentToolElapsedMs until
        // the matching tool_result clears it.
        lastToolStartedAt: now,
        currentToolElapsedMs: 0,
      };
    }

    case 'tool_result': {
      const blocks = state.blocks.map((b) => {
        if (b.kind !== 'tool' || b.tool.id !== evt.id) return b;
        return {
          ...b,
          tool: {
            ...b.tool,
            status: evt.isError ? ('error' as const) : ('done' as const),
            output: evt.output,
          },
        };
      });
      // Only clear the running-tool fields if THIS result matches the tool
      // we were tracking. Defensive: a stray tool_result without a matching
      // open tool_use should not clobber an in-flight tool's clock.
      const matching = state.blocks.some(
        (b) => b.kind === 'tool' && b.tool.id === evt.id,
      );
      return withLiveness({ ...state, blocks }, Date.now(), {
        clearTool: matching,
      });
    }

    case 'error': {
      const terminal =
        evt.terminationReason === 'interrupted'
          ? 'interrupted'
          : evt.terminationReason === 'timeout'
            ? 'idle_timeout'
            : 'error';
      return withLiveness(
        {
          ...state,
          terminal,
          errorMsg: terminal === 'error' ? evt.message : state.errorMsg,
          footer: null,
        },
        Date.now(),
        { clearTool: true },
      );
    }

    case 'done': {
      const terminal =
        evt.terminationReason === 'interrupted'
          ? 'interrupted'
          : evt.terminationReason === 'timeout'
            ? 'idle_timeout'
            : 'done';
      return withLiveness(
        {
          ...state,
          blocks: closeStreamingText(state.blocks),
          reasoning: { ...state.reasoning, active: false },
          terminal,
          footer: null,
        },
        Date.now(),
        { clearTool: true },
      );
    }

    default:
      return state;
  }
}

export function markInterrupted(state: RunState): RunState {
  return withLiveness(
    {
      ...state,
      blocks: closeStreamingText(state.blocks),
      reasoning: { ...state.reasoning, active: false },
      terminal: 'interrupted',
      footer: null,
    },
    Date.now(),
    { clearTool: true },
  );
}

export function markIdleTimeout(state: RunState, minutes: number): RunState {
  return withLiveness(
    {
      ...state,
      blocks: closeStreamingText(state.blocks),
      reasoning: { ...state.reasoning, active: false },
      terminal: 'idle_timeout',
      footer: null,
      idleTimeoutMinutes: minutes,
    },
    Date.now(),
    { clearTool: true },
  );
}

export function finalizeIfRunning(state: RunState): RunState {
  if (state.terminal !== 'running') return state;
  return withLiveness(
    {
      ...state,
      blocks: closeStreamingText(state.blocks),
      reasoning: { ...state.reasoning, active: false },
      terminal: 'done',
      footer: null,
    },
    Date.now(),
    { clearTool: true },
  );
}

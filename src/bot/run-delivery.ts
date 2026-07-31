import type { AgentEvent } from '../agent/types';
import {
  novelTerminalTextSuffix,
  stripReplayedTerminalSegments,
} from '../agent/terminal-text';

// Keep a bounded terminal ledger for reconciliation. This covers more than
// the live session's own 120K delivery tail without letting a noisy terminal
// consume unbounded memory during a long task.
const LIVE_TRANSCRIPT_WINDOW = 256_000;

/**
 * Serializes outbound updates from event processing and heartbeat ticks. A
 * stream patch must never overtake an earlier patch, otherwise a stale card
 * can replace a newer one after an asynchronous Feishu request completes.
 */
export class SerializedDelivery {
  private tail: Promise<void> = Promise.resolve();

  enqueue(deliver: () => Promise<void>): Promise<void> {
    const task = this.tail.then(deliver);
    // Keep the queue usable after a failed heartbeat while still returning the
    // original rejection to an awaited foreground caller.
    this.tail = task.catch(() => undefined);
    return task;
  }

  async drain(): Promise<void> {
    await this.tail;
  }
}

/**
 * Reduces provider delivery into one semantic event stream for a run.
 * Structured adapters already emit deltas; terminal adapters additionally
 * label their screen-derived chunks so a full redraw cannot be appended as a
 * second copy of the same transcript.
 */
export class RunEventGate {
  private readonly toolUses = new Set<string>();
  private readonly toolResults = new Set<string>();
  private lastLiveSequence = 0;
  private liveTranscript = '';
  private terminalSeen = false;

  accept(event: AgentEvent): AgentEvent | undefined {
    if (this.terminalSeen) return undefined;
    if (event.type === 'tool_use') {
      if (this.toolUses.has(event.id)) return undefined;
      this.toolUses.add(event.id);
      return event;
    }
    if (event.type === 'tool_result') {
      const fingerprint = `${event.id}\u0000${event.isError ? '1' : '0'}\u0000${event.output}`;
      if (this.toolResults.has(fingerprint)) return undefined;
      this.toolResults.add(fingerprint);
      return event;
    }
    if (event.type === 'text' && event.source === 'live-terminal') {
      if (event.sequence !== undefined) {
        if (event.sequence <= this.lastLiveSequence) return undefined;
        this.lastLiveSequence = event.sequence;
      }
      // Reconcile internal redraw copies before calculating the append suffix.
      // Doing this in the opposite order can discard genuine new text that
      // happens to appear immediately before a replayed history block.
      const delta = novelLiveSuffix(
        this.liveTranscript,
        stripReplayedTerminalSegments(this.liveTranscript, event.delta),
      );
      if (!delta) return undefined;
      this.liveTranscript = trimTail(this.liveTranscript + delta, LIVE_TRANSCRIPT_WINDOW);
      return { ...event, delta };
    }
    if (event.type === 'done' || event.type === 'error') this.terminalSeen = true;
    return event;
  }
}

export function novelLiveSuffix(delivered: string, candidate: string): string {
  return novelTerminalTextSuffix(delivered, candidate);
}

function trimTail(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : value.slice(-maxChars);
}

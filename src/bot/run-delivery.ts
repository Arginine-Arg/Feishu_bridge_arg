import type { AgentEvent } from '../agent/types';

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
      const delta = novelLiveSuffix(this.liveTranscript, event.delta);
      if (!delta) return undefined;
      this.liveTranscript = trimTail(this.liveTranscript + delta, LIVE_TRANSCRIPT_WINDOW);
      return { ...event, delta };
    }
    if (event.type === 'done' || event.type === 'error') this.terminalSeen = true;
    return event;
  }
}

export function novelLiveSuffix(delivered: string, candidate: string): string {
  if (!candidate || !delivered) return candidate;
  if (delivered.endsWith(candidate)) return '';

  // A full-screen redraw often contains the entire delivered transcript plus
  // one new suffix. Keep only that suffix, rather than appending the redraw.
  // The first complete occurrence is the prior transcript's position in the
  // redraw. Using the last one could drop valid intervening output when a
  // model naturally repeats an earlier sentence later in its response.
  const fullReplay = candidate.indexOf(delivered);
  if (fullReplay >= 0) return candidate.slice(fullReplay + delivered.length);

  const max = Math.min(delivered.length, candidate.length);
  for (let overlap = max; overlap > 0; overlap -= 1) {
    if (delivered.endsWith(candidate.slice(0, overlap))) return candidate.slice(overlap);
  }
  return candidate;
}

function trimTail(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : value.slice(-maxChars);
}

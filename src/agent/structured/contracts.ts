import type { AgentEvent, AgentRunOptions, LiveSessionDiagnostics } from '../types';

export interface StructuredChoice { label: string; value: string }
export interface StructuredInteraction { id: string; prompt: string; choices: StructuredChoice[] }
export interface StructuredSession {
  readonly id: string;
  readonly endpoint?: string;
  submit(options: AgentRunOptions, emit: (event: AgentEvent) => void, signal: AbortSignal): Promise<void>;
  command(input: string): Promise<AgentEvent[]>;
  answer(id: string, value: string): Promise<void>;
  hasRequest(id: string): boolean;
  freeTextRequest(): string | undefined;
  /**
   * Stop the running work. Returns `false` when the session proved there was
   * nothing to stop, so `/stop` can report honestly instead of claiming
   * success; `void` is accepted for sessions that cannot tell.
   */
  interrupt(): Promise<boolean | void>;
  diagnostics(): LiveSessionDiagnostics;
  snapshot?(): {
    threadId?: string;
    sessionId?: string;
    cwd?: string;
    goal?: string;
    goalActive?: boolean;
    phase?: string;
    lastUserText?: string;
    lastAssistantText?: string;
    lastToolStatus?: string;
  };
  close(): Promise<void>;
}

export function interactionEvent(interaction: StructuredInteraction): AgentEvent {
  return { type: 'interactive', phase: 'turn', text: interaction.prompt, interaction };
}

export function textEvent(delta: string): AgentEvent { return { type: 'text', delta, source: 'agent' }; }

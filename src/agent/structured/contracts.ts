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
  interrupt(): Promise<void>;
  diagnostics(): LiveSessionDiagnostics;
  close(): Promise<void>;
}

export function interactionEvent(interaction: StructuredInteraction): AgentEvent {
  return { type: 'interactive', phase: 'turn', text: interaction.prompt, interaction };
}

export function textEvent(delta: string): AgentEvent { return { type: 'text', delta, source: 'agent' }; }

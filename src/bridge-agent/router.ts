import { createHash } from 'node:crypto';
import { isStructuredLiveInteraction } from '../agent/live-interaction-detection';

export type BridgeInputKind = 'task' | 'native-command' | 'terminal-control';
export type BridgePresentation = 'markdown' | 'card';
export type BridgeOutputKind = 'picker' | 'code' | 'execution-log' | 'final';

export interface BridgeRouteInput {
  userInput: string;
  inputMode?: 'command' | 'control';
}

export interface BridgeRoute {
  stdin: string;
  kind: BridgeInputKind;
  presentation: BridgePresentation;
  inputSha256: string;
  inputMode?: 'command' | 'control';
}

export interface BridgeAgentDecision {
  input_sha256?: unknown;
  kind?: unknown;
  presentation?: unknown;
}

export interface BridgeAgentClassifier {
  classify(input: {
    systemPrompt: string;
    userInput: string;
    inputSha256: string;
  }): Promise<BridgeAgentDecision | undefined>;
}

export interface OpenAiCompatibleBridgeClassifierOptions {
  endpoint: string;
  model: string;
  apiKey: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class OpenAiCompatibleBridgeClassifier implements BridgeAgentClassifier {
  private readonly endpoint: string;
  private readonly model: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: OpenAiCompatibleBridgeClassifierOptions) {
    this.endpoint = opts.endpoint.replace(/\/$/u, '');
    this.model = opts.model;
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? 4_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async classify(input: {
    systemPrompt: string;
    userInput: string;
    inputSha256: string;
  }): Promise<BridgeAgentDecision | undefined> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.endpoint}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          temperature: 0,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: input.systemPrompt },
            {
              role: 'user',
              content: JSON.stringify({
                input_sha256: input.inputSha256,
                user_input: input.userInput,
              }),
            },
          ],
        }),
        signal: controller.signal,
      });
      if (!response.ok) return undefined;
      const body = await response.json() as {
        choices?: Array<{ message?: { content?: unknown } }>;
      };
      const content = body.choices?.[0]?.message?.content;
      if (typeof content !== 'string') return undefined;
      const parsed: unknown = JSON.parse(content);
      return parsed && typeof parsed === 'object' ? parsed as BridgeAgentDecision : undefined;
    } catch {
      return undefined;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export class BridgeAgent {
  private readonly classifier: BridgeAgentClassifier | undefined;

  constructor(classifier?: BridgeAgentClassifier) {
    this.classifier = classifier;
  }

  async route(input: BridgeRouteInput): Promise<BridgeRoute> {
    // Routing is a control-plane operation. It must be immediate, token-free,
    // and incapable of changing a task into a picker based on an auxiliary
    // model's interpretation. Keep the optional classifier API for backward
    // compatibility, but never put user turns on that network path.
    void this.classifier;
    return deterministicRoute(input);
  }

  classifyOutput(text: string): BridgeOutputKind {
    if (looksLikeTerminalPicker(text)) return 'picker';
    if (/```[\s\S]*?```/u.test(text)) return 'code';
    if (/^(?:[›▸•*]\s|\$\s|running\b|executing\b)/imu.test(text)) return 'execution-log';
    return 'final';
  }
}

export function createBridgeAgentFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): BridgeAgent {
  const endpoint = environment.ARG_BRIDGE_AGENT_ENDPOINT?.trim();
  const model = environment.ARG_BRIDGE_AGENT_MODEL?.trim();
  const apiKey = environment.ARG_BRIDGE_AGENT_API_KEY?.trim();
  if (!endpoint || !model || !apiKey) return new BridgeAgent();
  return new BridgeAgent(new OpenAiCompatibleBridgeClassifier({ endpoint, model, apiKey }));
}

function deterministicRoute(input: BridgeRouteInput): BridgeRoute {
  const inputSha256 = sha256(input.userInput);
  const trimmed = input.userInput.trim();
  const kind =
    input.inputMode === 'control'
      ? 'terminal-control'
      : input.inputMode === 'command' || trimmed.startsWith('/')
        ? 'native-command'
        : 'task';
  return {
    stdin: input.userInput,
    kind,
    presentation: kind === 'task' ? 'markdown' : 'card',
    inputSha256,
    ...(input.inputMode ? { inputMode: input.inputMode } : {}),
  };
}

function looksLikeTerminalPicker(text: string): boolean {
  return isStructuredLiveInteraction(text);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

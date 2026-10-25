import { randomUUID } from 'node:crypto';
import type { CodexStructuredSession } from '../structured/codex';
import type {
  SideAgent,
  SideAgentInput,
  SideAgentResult,
  SubagentBackend,
  SubagentRoute,
} from './types';

export interface CodexForkHooks {
  create(cwd: string, signal?: AbortSignal): Promise<CodexStructuredSession>;
  start(session: CodexStructuredSession, task: string, signal?: AbortSignal): Promise<SideAgentResult>;
  send(session: CodexStructuredSession, message: string, signal?: AbortSignal): Promise<SideAgentResult>;
  interrupt(session: CodexStructuredSession, signal?: AbortSignal): Promise<void>;
  close(session: CodexStructuredSession, signal?: AbortSignal): Promise<void>;
  route?(): SubagentRoute;
}

/**
 * Compatibility implementation of the legacy `thread/fork` side path.
 *
 * It exists so the selection layer has a uniform backend contract and explicit
 * fallback semantics. The structured adapter's existing fork handling remains
 * the production path until MixAgents is enabled; both use the same resolved
 * subagent configuration.
 */
export class CodexForkBackend implements SubagentBackend {
  readonly id = 'codex-fork' as const;
  private readonly agents = new Map<string, {
    agent: SideAgent;
    session: CodexStructuredSession;
    first: Promise<SideAgentResult>;
  }>();

  constructor(private readonly hooks: CodexForkHooks) {}

  async listRoutes(signal: AbortSignal): Promise<SubagentRoute[]> {
    if (signal.aborted) throw abortError();
    const route = this.hooks.route?.();
    return [route ?? {
      id: 'codex-fork',
      description: 'Legacy Codex thread fork (same provider as the main thread)',
      provider: 'current',
      model: 'current',
      maxAccess: 'read-only',
      available: true,
      missingEnvironment: [],
      tags: ['fallback', 'same-provider'],
      backend: 'codex-fork',
    }];
  }

  async createOrReuse(input: SideAgentInput): Promise<SideAgent> {
    if (
      input.existing &&
      input.existing.backendId === this.id &&
      input.existing.cwd === input.cwd
    ) {
      return input.existing;
    }
    const session = await this.hooks.create(input.cwd, input.signal);
    const agent: SideAgent = {
      agentId: `fork:${randomUUID()}`,
      route: 'codex-fork',
      provider: 'current',
      model: 'current',
      access: 'read-only',
      cwd: input.cwd,
      scope: input.scope,
      backendId: this.id,
      status: 'running',
      createdAt: Date.now(),
    };
    const first = this.hooks.start(session, input.task, input.signal);
    this.agents.set(agent.agentId, { agent, session, first });
    return agent;
  }

  async wait(agent: SideAgent, signal: AbortSignal): Promise<SideAgentResult> {
    if (signal.aborted) throw abortError();
    const entry = this.agents.get(agent.agentId);
    if (!entry) return { status: 'not_found' };
    const result = await entry.first;
    entry.agent.status = result.status;
    return result;
  }

  async send(
    agent: SideAgent,
    message: string,
    signal: AbortSignal,
  ): Promise<SideAgentResult> {
    const entry = this.agents.get(agent.agentId);
    if (!entry) return { status: 'not_found' };
    if (signal.aborted) throw abortError();
    const result = await this.hooks.send(entry.session, message, signal);
    entry.agent.status = result.status;
    return result;
  }

  async interrupt(agent: SideAgent, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw abortError();
    const entry = this.agents.get(agent.agentId);
    if (!entry) return;
    await this.hooks.interrupt(entry.session, signal);
    entry.agent.status = 'interrupted';
  }

  async close(agent: SideAgent, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw abortError();
    const entry = this.agents.get(agent.agentId);
    if (!entry) return;
    this.agents.delete(agent.agentId);
    await this.hooks.close(entry.session, signal);
  }
}

function abortError(): Error {
  const error = new Error('子代理请求已取消');
  error.name = 'AbortError';
  return error;
}

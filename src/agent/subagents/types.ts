import { createHash } from 'node:crypto';
import type { SubagentAccess } from '../../config/profile-schema';

export type SideAgentStatus =
  | 'starting'
  | 'running'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'not_found'
  | 'timeout'
  | 'closed';

export interface SubagentRoute {
  id: string;
  description?: string;
  provider: string;
  model: string;
  /** Maximum access the route allows; `/btw` requests read-only unless explicitly authorized. */
  maxAccess: SubagentAccess;
  available: boolean;
  missingEnvironment: string[];
  tags: string[];
  backend?: string;
  default?: boolean;
  selectionReason?: string;
  /** Optional immutable route/config revision supplied by the backend. */
  revision?: string;
  /** Optional non-secret hash of provider endpoint/config identity. */
  targetFingerprint?: string;
  /** cc-switch provider ID that produced this automatically generated route. */
  ccSwitchProviderId?: string;
  /** Route origin used for deterministic runtime selection. */
  source?: 'cc-switch' | 'broker-config';
}

export interface SideAgent {
  agentId: string;
  route: string;
  provider: string;
  model: string;
  access: SubagentAccess;
  cwd: string;
  scope: string;
  backendId: string;
  status: SideAgentStatus;
  createdAt: number;
  /** Optional native execution thread exposed by a Broker backend. */
  threadId?: string;
}

export interface SideAgentResult {
  status: SideAgentStatus;
  text?: string;
  error?: string;
}

export type SideAgentProgress =
  | { type: 'text'; text: string; itemId?: string }
  | { type: 'tool_started'; tool: string; itemId?: string }
  | { type: 'tool_completed'; tool: string; itemId?: string }
  | { type: 'notice'; text: string };

export type SideAgentProgressHandler = (event: SideAgentProgress) => void;

export interface SideAgentInput {
  route: SubagentRoute;
  task: string;
  cwd: string;
  scope: string;
  access: SubagentAccess;
  /** Required for every access other than read-only. */
  writeAuthorization?: { workspace: string; task: string };
  signal: AbortSignal;
  existing?: SideAgent;
}

/**
 * Backend contract for `/btw`. `wait` is an explicit extension of the minimum
 * interface so a freshly spawned agent's first turn can be observed without
 * sending its task a second time.
 */
export interface SubagentBackend {
  readonly id: 'mixagents' | 'codex-fork';
  listRoutes(signal: AbortSignal): Promise<SubagentRoute[]>;
  createOrReuse(input: SideAgentInput): Promise<SideAgent>;
  wait(
    agent: SideAgent,
    signal: AbortSignal,
    timeoutMs?: number,
    onProgress?: SideAgentProgressHandler,
  ): Promise<SideAgentResult>;
  send(
    agent: SideAgent,
    message: string,
    signal: AbortSignal,
    timeoutMs?: number,
    onProgress?: SideAgentProgressHandler,
  ): Promise<SideAgentResult>;
  interrupt(agent: SideAgent, signal: AbortSignal): Promise<void>;
  close(agent: SideAgent, signal: AbortSignal): Promise<void>;
  closeBackend?(): Promise<void>;
}

export class SubagentUnavailableError extends Error {
  constructor(
    readonly code:
      | 'mixagents-not-configured'
      | 'mixagents-incompatible'
      | 'mixagents-start-failed'
      | 'route-unavailable'
      | 'workspace-denied'
      | 'write-not-authorized',
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'SubagentUnavailableError';
  }
}

export class SubagentAgentNotFoundError extends Error {
  constructor(readonly agentId: string) {
    super(`子代理已不存在（agentId=${agentId}）；将创建新的 side agent。`);
    this.name = 'SubagentAgentNotFoundError';
  }
}

/**
 * Identity of the effective route. Backends that expose a revision should
 * include it; otherwise all controller-visible identity fields are hashed.
 */
export function subagentRouteFingerprint(route: SubagentRoute): string {
  return createHash('sha256').update(JSON.stringify({
    id: route.id,
    provider: route.provider,
    model: route.model,
    backend: route.backend ?? null,
    revision: route.revision ?? null,
    targetFingerprint: route.targetFingerprint ?? null,
    description: route.description ?? null,
    tags: [...route.tags].sort(),
    maxAccess: route.maxAccess,
  })).digest('hex');
}

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, parse, relative } from 'node:path';
import type { SubagentAccess, SubagentConfig } from '../../config/profile-schema';
import { loadBrokerRouteMap } from '../../integrations/broker-routes';
import { readCcSwitchState } from '../../integrations/cc-switch';
import { writeFileAtomic } from '../../platform/atomic-write';
import {
  mergeRuntimeRoutes,
  MixAgentsBrokerBackend,
  type MixAgentsRuntimeOverrides,
} from './mixagents';
import { redactSecrets } from './mcp-client';
import { selectSubagentRoute } from './registry';
import {
  SubagentAgentNotFoundError,
  SubagentUnavailableError,
  subagentRouteFingerprint,
  type SideAgent,
  type SideAgentResult,
  type SubagentBackend,
  type SubagentRoute,
} from './types';

export const BROKER_TOOL_VERSION = 1;
export const DEFAULT_BROKER_TOOL_NAMESPACE = 'arg_bridge';

const MAX_TASK_BYTES = 128 * 1024;
const MAX_RESULT_BYTES = 64 * 1024;
const MAX_QUEUED_MESSAGES = 16;
const MAX_QUEUED_BYTES = 256 * 1024;
const MAX_IDEMPOTENCY_ENTRIES = 256;
const MAX_WAIT_MS = 60 * 60_000;

export interface DynamicToolFunctionSpec {
  type: 'function';
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  deferLoading?: boolean;
}

export interface DynamicToolNamespaceSpec {
  type: 'namespace';
  name: string;
  description: string;
  tools: DynamicToolFunctionSpec[];
}

export interface DynamicToolCallResult {
  success: boolean;
  text: string;
}

export interface BrokerToolHost {
  readonly specs: DynamicToolNamespaceSpec[];
  call(tool: string, args: unknown, signal?: AbortSignal): Promise<DynamicToolCallResult>;
  setWriteAuthorization?(authorization: WriteAuthorization | undefined): void;
  close(): Promise<void>;
}

export interface WriteAuthorization {
  workspace: string;
  task: string;
}

export interface BrokerWorkerProjection {
  logical_name: string;
  logical_path: string;
  agent_id: string;
  thread_id: string | null;
  route: string;
  route_fingerprint: string;
  provider: string;
  model: string;
  access: SubagentAccess;
  workspace: string;
  status: string;
  result: string | null;
  error: string | null;
  updated_at: string;
}

interface BrokerWorkerRecord {
  logicalName: string;
  logicalPath: string;
  agent: SideAgent;
  route: SubagentRoute;
  routeFingerprint: string;
  access: SubagentAccess;
  workspace: string;
  scope: string;
  task: string;
  result?: string;
  error?: string;
  updatedAt: number;
  idempotencyKeys: string[];
  /** Plaintext messages accepted by send_message and delivered by the next followup_task. */
  queuedMessages: string[];
  backend?: SubagentBackend;
}

interface PersistedState {
  version: 1;
  workers: BrokerWorkerRecord[];
  completedCalls: Record<string, {
    tool: string;
    response: DynamicToolCallResult;
    createdAt: number;
  }>;
}

export interface BrokerToolControllerOptions {
  threadId: string;
  cwd: string;
  scope: string;
  stateFile: string;
  env?: NodeJS.ProcessEnv;
  namespace?: string;
  getConfig(): Promise<SubagentConfig>;
  backendFactory?: (config: SubagentConfig, env: NodeJS.ProcessEnv) => SubagentBackend;
  /** Re-resolved before every backend operation so cc-switch changes fail closed. */
  runtimeResolver?: () => Promise<MixAgentsRuntimeOverrides | undefined>;
  /** Test seam. Production resolves routes from cc-switch and Broker MCP. */
  routeResolver?: (input: {
    access: SubagentAccess;
    requestedRoute?: string;
    signal: AbortSignal;
  }) => Promise<{ backend: SubagentBackend; route: SubagentRoute; routes: SubagentRoute[] }>;
  onEvent?: (event: 'worker_started' | 'worker_completed' | 'worker_failed', worker: BrokerWorkerProjection) => void;
}

/**
 * Bridge-owned dynamic tool surface for one Codex thread.
 *
 * Every task crosses the MixAgents MCP boundary as ordinary plaintext input.
 * A native Codex child thread is never created, so provider-specific
 * `agent_message.encrypted_content` cannot hide the task from the worker.
 */
export class BrokerToolController implements BrokerToolHost {
  readonly specs: DynamicToolNamespaceSpec[];
  private workers = new Map<string, BrokerWorkerRecord>();
  private aliases = new Map<string, string>();
  private completedCalls = new Map<string, PersistedState['completedCalls'][string]>();
  private inFlightCalls = new Map<string, Promise<DynamicToolCallResult>>();
  private backend?: SubagentBackend;
  private backendConfigKey?: string;
  private currentRuntime?: MixAgentsRuntimeOverrides;
  private writeChain = Promise.resolve();
  private workerTimers = new Map<string, NodeJS.Timeout>();
  private restoredTimeoutsArmed = false;
  private readonly env: NodeJS.ProcessEnv;
  private readonly namespace: string;
  private closed = false;
  private writeAuthorization?: WriteAuthorization;

  constructor(private readonly options: BrokerToolControllerOptions) {
    this.env = options.env ?? process.env;
    this.namespace = options.namespace ?? DEFAULT_BROKER_TOOL_NAMESPACE;
    this.specs = brokerToolSpecs(this.namespace);
    this.loadState();
  }

  static instructions(namespace = DEFAULT_BROKER_TOOL_NAMESPACE): string {
    return [
      'Bridge-managed multi-agent policy:',
      `- Delegate through the dynamic tools in the "${namespace}" namespace. Native Codex collaboration tools are not the authoritative delegation path for this Bridge thread.`,
      `- Use ${namespace}.spawn_agent to create independent workers, ${namespace}.followup_task to send a new task to an existing worker, and ${namespace}.wait_agent to collect its result mailbox.`,
      '- Do not report delegated work as complete until wait_agent has returned the relevant worker result or an explicit terminal status.',
      `- Use ${namespace}.list_agents / ${namespace}.interrupt_agent / ${namespace}.close_agent to inspect or stop workers, and ${namespace}.list_routes before choosing a non-default route.`,
      '- Task text passed to spawn_agent or followup_task is delivered as ordinary user input. Do not depend on native agent_message, encrypted_content, or a Codex child thread.',
      `- ${namespace}.send_message is queue-only: it stores plaintext locally and returns without waking the worker. The next ${namespace}.followup_task delivers the queued text and the new task together.`,
      '- Workers are read-only unless this profile enables write workers AND the user authorizes the exact task with `arg-bridge-write --workspace <canonical-path> --task <task>` for this turn. Tool arguments cannot self-grant write access.',
    ].join('\n');
  }

  async call(tool: string, args: unknown, signal?: AbortSignal): Promise<DynamicToolCallResult> {
    if (this.closed) return failure('Broker tool controller is closed');
    if (signal?.aborted) return failure('Broker tool call aborted');
    try {
      const record = isRecord(args) ? args : {};
      const idempotencyKey = optionalString(record.idempotency_key, 'idempotency_key', 200);
      if (idempotencyKey) {
        const cached = this.completedCalls.get(idempotencyKey);
        if (cached) {
          return cached.tool === tool
            ? cached.response
            : failure(`idempotency_key ${idempotencyKey} was already used by ${cached.tool}`);
        }
        const running = this.inFlightCalls.get(`${tool}\0${idempotencyKey}`);
        if (running) return await running;
      }

      const operation = this.dispatch(tool, record, signal ?? neverAbortSignal());
      if (!idempotencyKey) return await operation;
      const operationKey = `${tool}\0${idempotencyKey}`;
      this.inFlightCalls.set(operationKey, operation);
      try {
        const response = await operation;
        this.completedCalls.set(idempotencyKey, {
          tool,
          response,
          createdAt: Date.now(),
        });
        this.pruneIdempotency();
        await this.persist();
        return response;
      } finally {
        this.inFlightCalls.delete(operationKey);
      }
    } catch (error) {
      return failure(safeError(error));
    }
  }

  projection(): BrokerWorkerProjection[] {
    return [...this.workers.values()]
      .sort((a, b) => a.logicalPath.localeCompare(b.logicalPath))
      .map(worker => projectWorker(worker));
  }

  setWriteAuthorization(authorization: WriteAuthorization | undefined): void {
    this.writeAuthorization = authorization;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const timer of this.workerTimers.values()) clearTimeout(timer);
    this.workerTimers.clear();
    await this.backend?.closeBackend?.().catch(() => {});
    await this.writeChain.catch(() => {});
  }

  private dispatch(
    tool: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<DynamicToolCallResult> {
    switch (tool) {
      case 'spawn_agent':
        return this.spawn(args, signal);
      case 'followup_task':
        return this.followup(args, signal);
      case 'send_message':
        return this.sendMessage(args, signal);
      case 'wait_agent':
        return this.wait(args, signal);
      case 'list_agents':
        return Promise.resolve(this.list(args));
      case 'list_routes':
        return this.listRoutes(signal);
      case 'interrupt_agent':
        return this.interrupt(args, signal, false);
      case 'close_agent':
        return this.interrupt(args, signal, true);
      default:
        return Promise.resolve(failure(`Unknown Broker tool: ${tool}`));
    }
  }

  private async spawn(
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<DynamicToolCallResult> {
    const config = await this.requireConfig();
    const task = requiredString(args.task, 'task', MAX_TASK_BYTES);
    const access = parseAccess(args.access);
    if (access === 'workspace-write') {
      if (!config.allowWriteWorkers) {
        throw new SubagentUnavailableError(
          'write-not-authorized',
          'workspace-write worker 未在 profile 中启用；默认只允许 read-only。',
        );
      }
    }
    if (this.runningCount() >= config.maxConcurrentWorkers) {
      return failure(`Broker worker concurrency limit reached (${config.maxConcurrentWorkers})`);
    }
    const requestedName = optionalString(args.name, 'name', 64) ?? this.nextName();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(requestedName)) {
      return failure('name must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}');
    }
    const existing = this.workers.get(workerKey(requestedName));
    if (existing) return failure(`Broker worker already exists: ${existing.logicalPath}`);

    const workspace = await canonicalWorkspace(optionalString(args.workspace, 'workspace', 4096), this.options.cwd);
    if (access === 'read-only') {
      const parentWorkspace = await canonicalWorkspace(undefined, this.options.cwd);
      const rel = relative(parentWorkspace, workspace);
      if (rel.startsWith('..') || isAbsolute(rel)) {
        throw new SubagentUnavailableError(
          'workspace-denied',
          'read-only workers may only access the parent workspace or a subdirectory of it.',
        );
      }
    }
    if (access === 'workspace-write') {
      await assertWriteAuthorization(this.writeAuthorization, task, workspace);
    }
    const requestedRoute = optionalString(args.route, 'route', 64);
    const resolved = await this.resolveRoute(access, requestedRoute, signal);
    const worker = await this.createWorker({
      name: requestedName,
      task,
      access,
      workspace,
      resolved,
      signal,
    });
    this.options.onEvent?.('worker_started', projectWorker(worker));
    return success(JSON.stringify({
      logical_name: worker.logicalName,
      logical_path: worker.logicalPath,
      agent_id: worker.agent.agentId,
      thread_id: worker.agent.threadId ?? null,
      route: worker.route.id,
      route_fingerprint: worker.routeFingerprint,
      provider: worker.route.provider,
      model: worker.route.model,
      access: worker.access,
      status: worker.agent.status,
      mailbox: `Call wait_agent with this logical_path or agent_id to collect the result.`,
    }, null, 2));
  }

  private async followup(
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<DynamicToolCallResult> {
    const task = requiredString(args.task, 'task', MAX_TASK_BYTES);
    const target = await this.resolveWorker(args);
    const config = await this.requireConfig();
    const requestedRoute = optionalString(args.route, 'route', 64);
    const resolved = await this.resolveRoute(target.access, requestedRoute, signal);
    const delivery = [...target.queuedMessages, task].join('\n\n');
    if (Buffer.byteLength(delivery, 'utf8') > MAX_TASK_BYTES) {
      return failure(`followup_task combined task is larger than ${MAX_TASK_BYTES} bytes`);
    }
    const nextFingerprint = subagentRouteFingerprint(resolved.route);
    if (nextFingerprint !== target.routeFingerprint) {
      await this.closeRecord(target);
      const replacement = await this.createWorker({
        name: target.logicalName,
        task: delivery,
        access: target.access,
        workspace: target.workspace,
        resolved,
        signal,
      });
      return success(JSON.stringify({
        recreated: true,
        reason: 'route/provider/model fingerprint changed; the old Broker agent was closed',
        ...workerInvocation(replacement),
      }, null, 2));
    }
    if (target.access === 'workspace-write') {
      if (!config.allowWriteWorkers) {
        return failure('workspace-write workers are disabled by the current profile');
      }
      await assertWriteAuthorization(this.writeAuthorization, delivery, target.workspace);
    }
    try {
      target.agent = { ...target.agent, status: 'running' };
      target.task = delivery;
      target.result = undefined;
      target.error = undefined;
      target.updatedAt = Date.now();
      await this.persist();
      const result = await resolved.backend.send(target.agent, delivery, signal);
      target.queuedMessages = [];
      this.applyResult(target, result);
      await this.persist();
      this.options.onEvent?.(
        result.status === 'completed' ? 'worker_completed' : 'worker_failed',
        projectWorker(target),
      );
      return success(JSON.stringify({
        recreated: false,
        ...workerInvocation(target),
        mailbox: result.text ?? null,
      }, null, 2));
    } catch (error) {
      if (error instanceof SubagentAgentNotFoundError) {
        this.workers.delete(workerKey(target.logicalName));
        this.rebuildAliases();
        const replacement = await this.createWorker({
          name: target.logicalName,
          task: delivery,
          access: target.access,
          workspace: target.workspace,
          resolved,
          signal,
        });
        return success(JSON.stringify({
          recreated: true,
          reason: 'agent_not_found; the missing Broker agent identity was not reused',
          ...workerInvocation(replacement),
        }, null, 2));
      }
      throw error;
    }
  }

  private async sendMessage(
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<DynamicToolCallResult> {
    if (signal.aborted) throw new Error('send_message aborted');
    const target = await this.resolveWorker(args);
    const message = requiredString(args.message, 'message', MAX_TASK_BYTES);
    if (target.queuedMessages.length >= MAX_QUEUED_MESSAGES) {
      return failure(`send_message queue limit reached (${MAX_QUEUED_MESSAGES})`);
    }
    const queuedBytes = target.queuedMessages.reduce(
      (total, item) => total + Buffer.byteLength(item, 'utf8'),
      0,
    );
    if (queuedBytes + Buffer.byteLength(message, 'utf8') > MAX_QUEUED_BYTES) {
      return failure(`send_message queue exceeds ${MAX_QUEUED_BYTES} bytes`);
    }
    target.queuedMessages.push(message);
    target.updatedAt = Date.now();
    await this.persist();
    return success(JSON.stringify({
      logical_name: target.logicalName,
      logical_path: target.logicalPath,
      agent_id: target.agent.agentId,
      status: 'queued',
      queued_messages: target.queuedMessages.length,
      mailbox: 'Use followup_task to trigger the worker turn; queued text is sent as ordinary input and cleared only after send succeeds.',
    }, null, 2));
  }

  private async wait(
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<DynamicToolCallResult> {
    const targets = this.resolveTargets(args);
    if (targets.length === 0) return failure('wait_agent requires logical_names or agent_ids');
    const requestedTimeout = numberValue(args.timeout_ms, 1, MAX_WAIT_MS)
      ?? (await this.requireConfig()).workerTimeoutMs;
    const config = await this.requireConfig();
    const backend = await this.ensureBackend(config);
    const timeoutSignal = AbortSignal.timeout(requestedTimeout);
    const combined = AbortSignal.any([signal, timeoutSignal]);
    const results = await Promise.all(targets.map(async target => {
      try {
        const result = await (target.backend ?? backend).wait(
          target.agent,
          combined,
          requestedTimeout,
        );
        this.applyResult(target, result);
        this.options.onEvent?.(
          result.status === 'completed' ? 'worker_completed' : 'worker_failed',
          projectWorker(target),
        );
        return {
          logical_path: target.logicalPath,
          agent_id: target.agent.agentId,
          ...result,
        };
      } catch (error) {
        if (error instanceof SubagentAgentNotFoundError) {
          target.agent.status = 'not_found';
          target.error = 'agent_not_found';
          return {
            logical_path: target.logicalPath,
            agent_id: target.agent.agentId,
            status: 'not_found',
            error: target.error,
          };
        }
        if (combined.aborted) {
          target.agent.status = 'timeout';
          target.error = 'wait_agent timed out or was aborted';
          return {
            logical_path: target.logicalPath,
            agent_id: target.agent.agentId,
            status: 'timeout',
            error: target.error,
          };
        }
        throw error;
      }
    }));
    await this.persist();
    return success(JSON.stringify({ agents: results }, null, 2));
  }

  private list(args: Record<string, unknown>): DynamicToolCallResult {
    const prefix = optionalString(args.path_prefix, 'path_prefix', 512);
    const workers = this.projection().filter(worker =>
      !prefix || worker.logical_path.startsWith(prefix)
    );
    return success(JSON.stringify({ agents: workers }, null, 2));
  }

  private async listRoutes(signal: AbortSignal): Promise<DynamicToolCallResult> {
    const config = await this.requireConfig();
    const backend = await this.ensureBackend(config);
    const routes = await backend.listRoutes(signal);
    const visibleRoutes = mergeRuntimeRoutes(routes, this.currentRuntime?.route);
    const ccSwitch = await readCcSwitchState(this.env);
    return success(JSON.stringify({
      configured_main_provider: ccSwitch.currentProviderCodex ?? null,
      runtime_recovery: backend instanceof MixAgentsBrokerBackend
        ? backend.recoveryNotice ?? null
        : null,
      routes: visibleRoutes.map(route => ({
        id: route.id,
        provider: route.provider,
        model: route.model,
        max_access: route.maxAccess,
        available: route.available,
        missing_environment: route.missingEnvironment,
        tags: route.tags,
        revision: route.revision ?? null,
        target_fingerprint: route.targetFingerprint ?? null,
      })),
    }, null, 2));
  }

  private async interrupt(
    args: Record<string, unknown>,
    signal: AbortSignal,
    close: boolean,
  ): Promise<DynamicToolCallResult> {
    const targets = this.resolveTargets(args);
    if (targets.length === 0) return failure(`${close ? 'close_agent' : 'interrupt_agent'} requires a target`);
    const config = await this.requireConfig();
    const defaultBackend = await this.ensureBackend(config);
    const results: Array<Record<string, unknown>> = [];
    for (const target of targets) {
      const backend = target.backend ?? defaultBackend;
      try {
        if (close) await backend.close(target.agent, signal);
        else await backend.interrupt(target.agent, signal);
        target.agent.status = close ? 'closed' : 'interrupted';
        target.updatedAt = Date.now();
        results.push({
          logical_path: target.logicalPath,
          agent_id: target.agent.agentId,
          status: target.agent.status,
        });
      } catch (error) {
        results.push({
          logical_path: target.logicalPath,
          agent_id: target.agent.agentId,
          error: safeError(error),
        });
      }
    }
    await this.persist();
    return success(JSON.stringify({ agents: results }, null, 2));
  }

  private async createWorker(input: {
    name: string;
    task: string;
    access: SubagentAccess;
    workspace: string;
    resolved: { backend: SubagentBackend; route: SubagentRoute };
    signal: AbortSignal;
  }): Promise<BrokerWorkerRecord> {
    const agent = await input.resolved.backend.createOrReuse({
      route: input.resolved.route,
      task: input.task,
      cwd: input.workspace,
      scope: `${this.options.scope}:${input.name}`,
      access: input.access,
      ...(input.access === 'workspace-write' && this.writeAuthorization
        ? { writeAuthorization: this.writeAuthorization }
        : {}),
      signal: input.signal,
    });
    const record: BrokerWorkerRecord = {
      logicalName: input.name,
      logicalPath: `/root/${input.name}`,
      agent,
      route: input.resolved.route,
      routeFingerprint: subagentRouteFingerprint(input.resolved.route),
      access: input.access,
      backend: input.resolved.backend,
      workspace: input.workspace,
      scope: this.options.scope,
      task: input.task,
      updatedAt: Date.now(),
      idempotencyKeys: [],
      queuedMessages: [],
    };
    this.workers.set(workerKey(input.name), record);
    this.rebuildAliases();
    this.armWorkerTimeout(record, await this.requireConfig());
    await this.persist();
    return record;
  }

  private async resolveRoute(
    access: SubagentAccess,
    requestedRoute: string | undefined,
    signal: AbortSignal,
  ): Promise<{ backend: SubagentBackend; route: SubagentRoute; routes: SubagentRoute[] }> {
    if (this.options.routeResolver) {
      const resolved = await this.options.routeResolver({
        access,
        ...(requestedRoute ? { requestedRoute } : {}),
        signal,
      });
      this.backend = resolved.backend;
      this.backendConfigKey = 'injected-route-resolver';
      return resolved;
    }
    const config = await this.requireConfig();
    const backend = await this.ensureBackend(config);
    const [routes, ccSwitch, routeMap] = await Promise.all([
      backend.listRoutes(signal),
      readCcSwitchState(this.env),
      config.routeMode === 'manual'
        ? loadBrokerRouteMap(this.env)
        : Promise.resolve({ path: '', config: undefined }),
    ]);
    if ('error' in routeMap && routeMap.error) throw new Error(routeMap.error);
    const visibleRoutes = mergeRuntimeRoutes(routes, this.currentRuntime?.route);
    const selection = selectSubagentRoute({
      config,
      ccSwitch,
      routeMap: routeMap.config,
      routes: visibleRoutes,
      requestedRoute,
      access,
    });
    if (!selection.route) {
      throw new SubagentUnavailableError('route-unavailable', selection.error ?? 'No Broker route available', {
        access,
      });
    }
    if (!selection.route.available) {
      throw new SubagentUnavailableError(
        'route-unavailable',
        `Broker route ${selection.route.id} is unavailable` +
          (selection.route.missingEnvironment.length
            ? `; missing environment names: ${selection.route.missingEnvironment.join(', ')}`
            : ''),
      );
    }
    return { backend, route: selection.route, routes: visibleRoutes };
  }

  private async ensureBackend(config: SubagentConfig): Promise<SubagentBackend> {
    if (!config.enabled || config.mode === 'off' || config.mode === 'fork') {
      throw new SubagentUnavailableError(
        'mixagents-not-configured',
        `Broker model tools are unavailable because subagents.mode=${config.mode}.`,
      );
    }
    const key = backendConfigKey(config);
    const runtime = await this.options.runtimeResolver?.();
    this.currentRuntime = runtime;
    const runtimeKey = runtime?.fingerprint ?? 'broker-config';
    if (this.options.routeResolver && this.backend) return this.backend;
    const combinedKey = `${key}:${runtimeKey}`;
    if (this.backend && this.backendConfigKey === combinedKey) return this.backend;
    if (this.backend) await this.backend.closeBackend?.().catch(() => {});
    this.backend = this.options.backendFactory
      ? this.options.backendFactory(config, this.env)
      : new MixAgentsBrokerBackend(config, this.env, runtime);
    this.backendConfigKey = combinedKey;
    return this.backend;
  }

  private async requireConfig(): Promise<SubagentConfig> {
    const config = await this.options.getConfig();
    if (!config.modelTools) {
      throw new SubagentUnavailableError(
        'mixagents-not-configured',
        'Broker model tools are disabled in the current profile.',
      );
    }
    if (!this.restoredTimeoutsArmed) {
      this.restoredTimeoutsArmed = true;
      for (const worker of this.workers.values()) {
        if (worker.agent.status !== 'running' && worker.agent.status !== 'starting') continue;
        const elapsed = Math.max(0, Date.now() - worker.updatedAt);
        const remaining = config.workerTimeoutMs - elapsed;
        if (remaining <= 0) {
          worker.agent.status = 'timeout';
          worker.error = `worker timed out while Bridge was disconnected`;
          worker.updatedAt = Date.now();
          continue;
        }
        this.armWorkerTimeout(worker, config, remaining);
      }
      await this.persist().catch(() => {});
    }
    return config;
  }

  private resolveTargets(args: Record<string, unknown>): BrokerWorkerRecord[] {
    const single = this.findTarget(args);
    if (single) return [single];
    const names = stringArray(args.logical_names, 'logical_names', 32);
    const ids = stringArray(args.agent_ids, 'agent_ids', 32);
    const records: BrokerWorkerRecord[] = [];
    for (const value of [...names, ...ids]) {
      const key = this.aliases.get(value);
      const record = key ? this.workers.get(key) : undefined;
      if (record && !records.includes(record)) records.push(record);
    }
    if (records.length === 0 && names.length === 0 && ids.length === 0) {
      return [...this.workers.values()].filter(worker =>
        worker.agent.status === 'running' || worker.agent.status === 'starting'
      );
    }
    return records;
  }

  private async resolveWorker(args: Record<string, unknown>): Promise<BrokerWorkerRecord> {
    const worker = this.findTarget(args);
    if (!worker) {
      throw new Error('followup_task requires an existing logical_name, logical_path, or agent_id');
    }
    return worker;
  }

  private findTarget(args: Record<string, unknown>): BrokerWorkerRecord | undefined {
    for (const field of ['logical_path', 'logical_name', 'agent_id'] as const) {
      const value = optionalString(args[field], field, 512);
      if (!value) continue;
      const key = this.aliases.get(value);
      if (key) return this.workers.get(key);
    }
    return undefined;
  }

  private nextName(): string {
    let index = 1;
    while (this.workers.has(workerKey(`agent-${index}`))) index += 1;
    return `agent-${index}`;
  }

  private runningCount(): number {
    return [...this.workers.values()].filter(worker =>
      worker.agent.status === 'starting' || worker.agent.status === 'running'
    ).length;
  }

  private applyResult(record: BrokerWorkerRecord, result: SideAgentResult): void {
    record.agent.status = result.status;
    record.updatedAt = Date.now();
    if (result.text) record.result = truncate(redactSecrets(result.text), MAX_RESULT_BYTES);
    if (result.error) record.error = truncate(redactSecrets(result.error), 8_000);
    if (result.status !== 'running' && result.status !== 'starting') {
      const timer = this.workerTimers.get(record.logicalPath);
      if (timer) clearTimeout(timer);
      this.workerTimers.delete(record.logicalPath);
    }
  }

  private armWorkerTimeout(
    record: BrokerWorkerRecord,
    config: SubagentConfig,
    delayMs = config.workerTimeoutMs,
  ): void {
    const previous = this.workerTimers.get(record.logicalPath);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      if (
        record.agent.status !== 'running' &&
        record.agent.status !== 'starting'
      ) return;
      void (record.backend ?? this.backend)
        ?.interrupt(record.agent, AbortSignal.timeout(30_000))
        .catch(() => {});
      record.agent.status = 'timeout';
      record.error = `worker timed out after ${config.workerTimeoutMs}ms`;
      record.updatedAt = Date.now();
      this.options.onEvent?.('worker_failed', projectWorker(record));
      void this.persist();
    }, delayMs);
    timer.unref?.();
    this.workerTimers.set(record.logicalPath, timer);
  }

  private async closeRecord(record: BrokerWorkerRecord): Promise<void> {
    const timer = this.workerTimers.get(record.logicalPath);
    if (timer) clearTimeout(timer);
    this.workerTimers.delete(record.logicalPath);
    const config = await this.requireConfig();
    const backend = record.backend ?? await this.ensureBackend(config);
    await backend.interrupt(record.agent, AbortSignal.timeout(30_000)).catch(() => {});
    await backend.close(record.agent, AbortSignal.timeout(30_000)).catch(() => {});
    this.workers.delete(workerKey(record.logicalName));
    this.rebuildAliases();
    await this.persist();
  }

  private rebuildAliases(): void {
    this.aliases.clear();
    for (const [key, worker] of this.workers) {
      this.aliases.set(key, key);
      this.aliases.set(worker.logicalPath, key);
      this.aliases.set(worker.agent.agentId, key);
    }
  }

  private pruneIdempotency(): void {
    while (this.completedCalls.size > MAX_IDEMPOTENCY_ENTRIES) {
      let oldestKey: string | undefined;
      let oldest = Number.POSITIVE_INFINITY;
      for (const [key, value] of this.completedCalls) {
        if (value.createdAt < oldest) {
          oldest = value.createdAt;
          oldestKey = key;
        }
      }
      if (!oldestKey) break;
      this.completedCalls.delete(oldestKey);
    }
  }

  private loadState(): void {
    let parsed: PersistedState;
    try {
      parsed = JSON.parse(
        readStateFile(this.options.stateFile) || '{}',
      ) as PersistedState;
    } catch {
      return;
    }
    if (parsed.version !== 1) return;
    for (const worker of parsed.workers ?? []) {
      if (
        !worker?.logicalName ||
        !worker.logicalPath ||
        !worker.agent?.agentId ||
        !worker.route?.id ||
        !worker.workspace
      ) continue;
      this.workers.set(workerKey(worker.logicalName), {
        ...worker,
        idempotencyKeys: Array.isArray(worker.idempotencyKeys) ? worker.idempotencyKeys : [],
        queuedMessages: Array.isArray(worker.queuedMessages)
          ? worker.queuedMessages.filter(message => typeof message === 'string')
          : [],
      });
    }
    for (const [key, value] of Object.entries(parsed.completedCalls ?? {})) {
      if (value?.response && typeof value.response.text === 'string') {
        this.completedCalls.set(key, value);
      }
    }
    this.rebuildAliases();
  }

  private async persist(): Promise<void> {
    const body: PersistedState = {
      version: 1,
      workers: [...this.workers.values()].map(({ backend: _backend, ...worker }) => worker),
      completedCalls: Object.fromEntries(this.completedCalls),
    };
    const snapshot = `${JSON.stringify(body, null, 2)}\n`;
    this.writeChain = this.writeChain
      .catch(() => {})
      .then(async () => {
        await writeFileAtomic(this.options.stateFile, snapshot, { mode: 0o600 });
      });
    await this.writeChain;
  }
}

export function brokerToolSpecs(
  namespace = DEFAULT_BROKER_TOOL_NAMESPACE,
): DynamicToolNamespaceSpec[] {
  const target = {
    type: 'object',
    properties: {
      logical_name: { type: 'string', description: 'Stable logical worker name.' },
      logical_path: { type: 'string', description: 'Stable logical path such as /root/reviewer.' },
      agent_id: { type: 'string', description: 'Broker agent ID returned by spawn_agent.' },
    },
    additionalProperties: false,
  };
  return [{
    type: 'namespace',
    name: namespace,
    description: 'Bridge-owned cross-provider subagent tools. Task text is sent as ordinary user input.',
    tools: [
      {
        type: 'function',
        name: 'spawn_agent',
        description: 'Spawn an independent Broker worker. The task is ordinary plaintext user input. Defaults to read-only.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Stable worker name; unique within this parent thread.' },
            task: { type: 'string', description: 'Task body delivered as ordinary user input to the worker.' },
            route: { type: 'string', description: 'Optional explicit Broker route ID.' },
            access: { enum: ['read-only', 'workspace-write'], type: 'string' },
            workspace: { type: 'string', description: 'Optional workspace; defaults to the parent cwd.' },
            idempotency_key: { type: 'string' },
          },
          required: ['task'],
          additionalProperties: false,
        },
      },
      {
        type: 'function',
        name: 'followup_task',
        description: 'Trigger a new worker turn and return its result mailbox. Plaintext task input; no native agent_message is used.',
        inputSchema: {
          type: 'object',
          properties: {
            ...target.properties,
            task: { type: 'string' },
            route: { type: 'string' },
            idempotency_key: { type: 'string' },
          },
          required: ['task'],
          additionalProperties: false,
        },
      },
      {
        type: 'function',
        name: 'send_message',
        description: 'Queue plaintext locally without waking the worker; the next followup_task delivers it.',
        inputSchema: {
          type: 'object',
          properties: { ...target.properties, message: { type: 'string' } },
          required: ['message'],
          additionalProperties: false,
        },
      },
      {
        type: 'function',
        name: 'wait_agent',
        description: 'Collect one or more worker result mailboxes.',
        inputSchema: {
          type: 'object',
          properties: {
            logical_names: { type: 'array', items: { type: 'string' }, maxItems: 32 },
            agent_ids: { type: 'array', items: { type: 'string' }, maxItems: 32 },
            timeout_ms: { type: 'integer', minimum: 1, maximum: MAX_WAIT_MS },
          },
          additionalProperties: false,
        },
      },
      {
        type: 'function',
        name: 'list_agents',
        description: 'List logical path, Broker agent ID, app-server thread ID, route, access, status, and mailbox summary.',
        inputSchema: {
          type: 'object',
          properties: { path_prefix: { type: 'string' } },
          additionalProperties: false,
        },
      },
      {
        type: 'function',
        name: 'list_routes',
        description: 'List available Broker routes and non-secret availability details.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      },
      {
        type: 'function',
        name: 'interrupt_agent',
        description: 'Interrupt one or more workers.',
        inputSchema: {
          type: 'object',
          properties: target.properties,
          additionalProperties: false,
        },
      },
      {
        type: 'function',
        name: 'close_agent',
        description: 'Close one or more workers.',
        inputSchema: {
          type: 'object',
          properties: target.properties,
          additionalProperties: false,
        },
      },
    ],
  }];
}

export function brokerCodexThreadConfig(
  config: SubagentConfig,
): Record<string, unknown> | undefined {
  if (
    !config.enabled ||
    !config.modelTools ||
    (config.mode !== 'auto' && config.mode !== 'broker')
  ) {
    return undefined;
  }
  return {
    features: {
      multi_agent_v2: {
        enabled: true,
        ...(config.nativeToolPolicy === 'shadow' ? { disable_native_tools: true } : {}),
        root_agent_usage_hint_text: BrokerToolController.instructions(config.toolNamespace),
      },
    },
  };
}

function workerInvocation(worker: BrokerWorkerRecord): Record<string, unknown> {
  return {
    logical_name: worker.logicalName,
    logical_path: worker.logicalPath,
    agent_id: worker.agent.agentId,
    thread_id: worker.agent.threadId ?? null,
    route: worker.route.id,
    route_fingerprint: worker.routeFingerprint,
    provider: worker.route.provider,
    model: worker.route.model,
    access: worker.access,
    status: worker.agent.status,
  };
}

function projectWorker(worker: BrokerWorkerRecord): BrokerWorkerProjection {
  return {
    logical_name: worker.logicalName,
    logical_path: worker.logicalPath,
    agent_id: worker.agent.agentId,
    thread_id: worker.agent.threadId ?? null,
    route: worker.route.id,
    route_fingerprint: worker.routeFingerprint,
    provider: worker.route.provider,
    model: worker.route.model,
    access: worker.access,
    workspace: worker.workspace,
    status: worker.agent.status,
    result: worker.result ?? null,
    error: worker.error ?? null,
    updated_at: new Date(worker.updatedAt).toISOString(),
  };
}

function workerKey(logicalName: string): string {
  return logicalName;
}

function parseAccess(value: unknown): SubagentAccess {
  if (value === undefined || value === null || value === 'read-only') return 'read-only';
  if (value === 'workspace-write') return 'workspace-write';
  throw new Error('access must be read-only or workspace-write');
}

async function canonicalWorkspace(requested: string | undefined, fallback: string): Promise<string> {
  const value = requested ?? fallback;
  if (!isAbsolute(value)) throw new Error('workspace must be an absolute path');
  const canonical = await realpath(value).catch(() => undefined);
  if (!canonical) throw new Error(`workspace does not exist: ${value}`);
  const info = await lstat(canonical);
  if (!info.isDirectory()) throw new Error('workspace must be a directory');
  if (canonical === parse(canonical).root) throw new Error('workspace cannot be a filesystem root');
  return canonical;
}

async function assertWriteAuthorization(
  authorization: WriteAuthorization | undefined,
  task: string,
  workspace: string,
): Promise<void> {
  if (!authorization) {
    throw new SubagentUnavailableError(
      'write-not-authorized',
      'workspace-write requires `arg-bridge-write --workspace <path> --task <task>` before the model turn.',
    );
  }
  const authorizedWorkspace = requiredString(
    authorization.workspace,
    'write_authorization.workspace',
    4096,
  );
  const authorizedTask = requiredString(
    authorization.task,
    'write_authorization.task',
    MAX_TASK_BYTES,
  );
  const canonical = await realpath(authorizedWorkspace).catch(() => undefined);
  if (canonical !== workspace || authorizedTask !== task) {
    throw new SubagentUnavailableError(
      'write-not-authorized',
      'workspace-write authorization must exactly match the canonical workspace and task.',
    );
  }
}

function requiredString(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  if (Buffer.byteLength(value, 'utf8') > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes`);
  return value;
}

function optionalString(value: unknown, label: string, maxBytes: number): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return requiredString(value, label, maxBytes);
}

function stringArray(value: unknown, label: string, maximum: number): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > maximum || value.some(item => typeof item !== 'string')) {
    throw new Error(`${label} must be an array of at most ${maximum} strings`);
  }
  return [...new Set(value.map(item => item.trim()).filter(Boolean))];
}

function numberValue(value: unknown, minimum: number, maximum: number): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`numeric value must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function backendConfigKey(config: SubagentConfig): string {
  return createHash('sha256').update(JSON.stringify(config.mixagents ?? {})).digest('hex');
}

function safeError(error: unknown): string {
  return truncate(redactSecrets(error instanceof Error ? error.message : String(error)), 8_000);
}

function truncate(value: string, maximum: number): string {
  return Buffer.byteLength(value, 'utf8') <= maximum
    ? value
    : `${value.slice(0, maximum)}…[truncated]`;
}

function success(text: string): DynamicToolCallResult {
  return { success: true, text };
}

function failure(text: string): DynamicToolCallResult {
  return { success: false, text };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function neverAbortSignal(): AbortSignal {
  return new AbortController().signal;
}

function readStateFile(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

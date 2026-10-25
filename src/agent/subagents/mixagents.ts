import type { SubagentConfig, SubagentMixAgentsConfig } from '../../config/profile-schema';
import { McpStdioClient, McpToolError, redactSecrets } from './mcp-client';
import {
  SubagentAgentNotFoundError,
  SubagentUnavailableError,
  type SideAgent,
  type SideAgentInput,
  type SideAgentResult,
  type SubagentBackend,
  type SubagentRoute,
} from './types';

const REQUIRED_TOOLS = [
  'routes',
  'spawn_agent',
  'send',
  'wait_agent',
  'interrupt_agent',
  'list_agents',
] as const;

const WAIT_REQUEST_MS = 120_000;
const DEFAULT_TOTAL_WAIT_MS = 15 * 60_000;

export interface MixAgentsLaunchConfig {
  command: string;
  args: string[];
  cwd?: string;
  credentialMode?: 'inherit-env' | 'mixagents-managed';
  credentialProvider?: string;
  credentialEnvKeys?: string[];
}

/**
 * Optional MixAgents Broker backend over its official STDIO MCP server.
 *
 * The production integration surface is the MCP contract (six tools), not an
 * installed plugin's cache path. The command/args come from the profile, an
 * explicit environment descriptor, or a published executable; arg-bridge never
 * guesses where a Codex plugin cache lives.
 */
export class MixAgentsBrokerBackend implements SubagentBackend {
  readonly id = 'mixagents' as const;
  private client?: McpStdioClient;
  private readonly launch: MixAgentsLaunchConfig;
  private readonly env: NodeJS.ProcessEnv;
  private readonly timeoutMs: number;

  constructor(
    private readonly config: SubagentConfig,
    env: NodeJS.ProcessEnv = process.env,
  ) {
    this.env = env;
    const launch = resolveMixAgentsLaunchConfig(config, env);
    if (!launch) {
      throw new SubagentUnavailableError(
        'mixagents-not-configured',
        'MixAgents 未配置。请安装官方 mixagents-broker MCP server，并在 `arg-bridge settings` 中填写 MCP 命令，' +
          '或设置 ARG_BRIDGE_MIXAGENTS_MCP（JSON）。',
      );
    }
    this.launch = launch;
    this.timeoutMs = 30_000;
  }

  async listRoutes(signal: AbortSignal): Promise<SubagentRoute[]> {
    if (signal.aborted) throw abortError();
    const client = await this.ensureClient();
    const result = await client.callTool('routes', {}, { timeoutMs: 30_000, signal });
    const raw = Array.isArray(result.routes) ? result.routes : [];
    return raw.flatMap((entry): SubagentRoute[] => {
      if (!isRecord(entry)) return [];
      const id = stringValue(entry.id);
      const provider = stringValue(entry.provider);
      const model = stringValue(entry.model);
      if (!id || !provider || !model) return [];
      const maxAccess = entry.maxAccess === 'workspace-write' ? 'workspace-write' : 'read-only';
      return [{
        id,
        ...(stringValue(entry.description) ? { description: stringValue(entry.description) } : {}),
        provider,
        model,
        maxAccess,
        available: entry.available !== false,
        missingEnvironment: stringArray(entry.missingEnvironment),
        tags: stringArray(entry.tags),
        ...(stringValue(entry.backend) ? { backend: stringValue(entry.backend) } : {}),
        default: entry.default === true,
        ...(stringValue(entry.selectionReason)
          ? { selectionReason: stringValue(entry.selectionReason) }
          : {}),
        ...(stringValue(entry.revision) ? { revision: stringValue(entry.revision) } : {}),
        ...(stringValue(entry.targetFingerprint)
          ? { targetFingerprint: stringValue(entry.targetFingerprint) }
          : {}),
      }];
    });
  }

  get serverVersion(): string | undefined {
    return this.client?.serverVersion;
  }

  get launchConfig(): Readonly<MixAgentsLaunchConfig> {
    return this.launch;
  }

  async createOrReuse(input: SideAgentInput): Promise<SideAgent> {
    if (input.access !== 'read-only') {
      const authorization = input.writeAuthorization;
      if (
        !authorization ||
        authorization.workspace !== input.cwd ||
        authorization.task !== input.task
      ) {
        throw new SubagentUnavailableError(
          'write-not-authorized',
          'workspace-write 子代理必须由用户针对该任务和该 workspace 明确授权；/btw 默认只读。',
        );
      }
    }
    if (
      input.existing &&
      input.existing.route === input.route.id &&
      input.existing.cwd === input.cwd &&
      input.existing.access === input.access
    ) {
      return input.existing;
    }
    const client = await this.ensureClient();
    const result = await client.callTool('spawn_agent', {
      route: input.route.id,
      task: input.task,
      cwd: input.cwd,
      access: input.access,
    }, { signal: input.signal, timeoutMs: 60_000 }).catch(error => {
      throw translateToolError(error, input.cwd);
    });
    const agent = agentFromSnapshot(result, {
      route: input.route.id,
      cwd: input.cwd,
      scope: input.scope,
      access: input.access,
    });
    return agent;
  }

  async wait(
    agent: SideAgent,
    signal: AbortSignal,
    timeoutMs = DEFAULT_TOTAL_WAIT_MS,
  ): Promise<SideAgentResult> {
    const client = await this.ensureClient();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (signal.aborted) throw abortError();
      const remaining = Math.max(1, Math.min(WAIT_REQUEST_MS, deadline - Date.now()));
      const result = await client.callTool('wait_agent', {
        agentIds: [agent.agentId],
        timeoutMs: remaining,
      }, { signal, timeoutMs: remaining + 10_000 }).catch(error => {
        throw translateToolError(error, agent.cwd);
      });
      const snapshot = firstAgent(result);
      if (!snapshot) continue;
      const status = snapshot.status;
      if (status === 'completed') return { status, text: stringValue(snapshot.output) };
      if (status === 'failed') {
        return { status, error: redactSecrets(stringValue(snapshot.error) ?? '子代理执行失败') };
      }
      if (status === 'interrupted') return { status };
      if (status === 'not_found') throw new SubagentAgentNotFoundError(agent.agentId);
      // starting/running: wait_agent timed out; loop until the total deadline.
    }
    return { status: 'timeout', error: '子代理等待超时' };
  }

  async send(
    agent: SideAgent,
    message: string,
    signal: AbortSignal,
  ): Promise<SideAgentResult> {
    const client = await this.ensureClient();
    try {
      await client.callTool('send', {
        agentId: agent.agentId,
        message,
      }, { signal, timeoutMs: 60_000 });
    } catch (error) {
      throw translateToolError(error, agent.cwd);
    }
    return this.wait(agent, signal);
  }

  async interrupt(agent: SideAgent, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw abortError();
    const client = await this.ensureClient();
    await client.callTool('interrupt_agent', { agentId: agent.agentId }, { timeoutMs: 30_000, signal })
      .catch(() => {
        // Interrupt is best effort; a missing agent needs no further cleanup.
      });
  }

  async close(agent: SideAgent, signal: AbortSignal): Promise<void> {
    await this.interrupt(agent, signal);
  }

  async closeBackend(): Promise<void> {
    this.client?.close();
    this.client = undefined;
  }

  private async ensureClient(): Promise<McpStdioClient> {
    if (this.client) return this.client;
    if (this.launch.credentialMode === 'mixagents-managed') {
      if (!this.launch.credentialProvider?.trim()) {
        throw new SubagentUnavailableError(
          'mixagents-not-configured',
          'MixAgents 托管凭据模式需要 opaque credentialProvider 引用；bridge 不读取或导出 cc-switch secret。',
        );
      }
    } else {
      const missing = (this.launch.credentialEnvKeys ?? [])
        .filter(key => !this.env[key]?.trim());
      if (missing.length > 0) {
        throw new SubagentUnavailableError(
          'mixagents-not-configured',
          `MixAgents 缺少环境变量：${missing.join(', ')}（只显示名称，不显示值）`,
          { missingEnvironment: missing },
        );
      }
    }
    try {
      const childEnv: NodeJS.ProcessEnv = { ...this.env };
      if (this.launch.credentialMode === 'mixagents-managed') {
        childEnv.MIXAGENTS_CREDENTIAL_PROVIDER = this.launch.credentialProvider;
        childEnv.MIXAGENTS_CREDENTIAL_SOURCE = 'cc-switch';
      }
      this.client = await McpStdioClient.start({
        command: this.launch.command,
        args: this.launch.args,
        ...(this.launch.cwd ? { cwd: this.launch.cwd } : {}),
        env: childEnv,
      });
    } catch (error) {
      throw new SubagentUnavailableError(
        'mixagents-start-failed',
        `MixAgents MCP server 启动失败：${redactSecrets(errorMessage(error))}`,
      );
    }
    const tools = await this.client.listTools().catch(error => {
      this.client?.close();
      this.client = undefined;
      throw error;
    });
    const names = new Set(tools.map(tool => tool.name));
    const missingTools = REQUIRED_TOOLS.filter(tool => !names.has(tool));
    if (missingTools.length > 0) {
      const serverVersion = this.client?.serverVersion ?? null;
      this.client.close();
      this.client = undefined;
      throw new SubagentUnavailableError(
        'mixagents-incompatible',
        `MixAgents MCP 版本不兼容（缺少工具：${missingTools.join(', ')}）；请升级 mixagents-broker。`,
        { serverVersion },
      );
    }
    return this.client;
  }
}

/** Resolve the official MCP launch command without scanning plugin caches. */
export function resolveMixAgentsLaunchConfig(
  config: SubagentConfig,
  env: NodeJS.ProcessEnv = process.env,
): MixAgentsLaunchConfig | undefined {
  const explicit = config.mixagents;
  if (explicit?.mcpCommand?.trim()) {
    return {
      command: explicit.mcpCommand.trim(),
      args: explicit.mcpArgs ?? [],
      ...(explicit.mcpCwd ? { cwd: explicit.mcpCwd } : {}),
      ...(explicit.credentialMode ? { credentialMode: explicit.credentialMode } : {}),
      ...(explicit.credentialProvider ? { credentialProvider: explicit.credentialProvider } : {}),
      ...(explicit.credentialEnvKeys ? { credentialEnvKeys: explicit.credentialEnvKeys } : {}),
    };
  }
  const descriptor = env.ARG_BRIDGE_MIXAGENTS_MCP;
  if (descriptor?.trim()) {
    try {
      const parsed: unknown = JSON.parse(descriptor);
      if (!isRecord(parsed) || typeof parsed.command !== 'string' || !parsed.command.trim()) {
        return undefined;
      }
      return {
        command: parsed.command.trim(),
        args: stringArray(parsed.args),
        ...(stringValue(parsed.cwd) ? { cwd: stringValue(parsed.cwd) } : {}),
        ...(parsed.credentialMode === 'mixagents-managed' || parsed.credentialMode === 'inherit-env'
          ? { credentialMode: parsed.credentialMode }
          : {}),
        ...(stringValue(parsed.credentialProvider)
          ? { credentialProvider: stringValue(parsed.credentialProvider) }
          : {}),
        ...(stringArray(parsed.credentialEnvKeys).length > 0
          ? { credentialEnvKeys: stringArray(parsed.credentialEnvKeys) }
          : {}),
      };
    } catch {
      return undefined;
    }
  }
  // A published executable is a stable entry point. The current 0.1.1 package
  // is private, so absence is reported rather than reaching into a cache.
  if (env.MIXAGENTS_BROKER_MCP_COMMAND?.trim()) {
    return {
      command: env.MIXAGENTS_BROKER_MCP_COMMAND.trim(),
      args: splitArgs(env.MIXAGENTS_BROKER_MCP_ARGS),
    };
  }
  return undefined;
}

export function applyMixAgentsConfig(
  config: SubagentConfig,
  patch: Partial<SubagentMixAgentsConfig>,
): SubagentConfig {
  return {
    ...config,
    mixagents: {
      ...config.mixagents,
      ...patch,
    },
  };
}

function agentFromSnapshot(
  value: Record<string, unknown>,
  fallback: { route: string; cwd: string; scope: string; access: SubagentRoute['maxAccess'] },
): SideAgent {
  const agentId = stringValue(value.agentId);
  if (!agentId) {
    throw new SubagentUnavailableError(
      'mixagents-start-failed',
      'MixAgents spawn_agent 未返回 agentId',
    );
  }
  return {
    agentId,
    route: stringValue(value.route) ?? fallback.route,
    provider: stringValue(value.provider) ?? 'unknown',
    model: stringValue(value.model) ?? 'unknown',
    access: fallback.access,
    cwd: fallback.cwd,
    scope: fallback.scope,
    backendId: 'mixagents',
    status: sideStatus(value.status),
    createdAt: Date.now(),
  };
}

function firstAgent(value: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!Array.isArray(value.agents)) return undefined;
  return value.agents.find(isRecord);
}

function sideStatus(value: unknown): SideAgent['status'] {
  return value === 'starting' ||
    value === 'running' ||
    value === 'completed' ||
    value === 'failed' ||
    value === 'interrupted' ||
    value === 'not_found'
    ? value
    : 'running';
}

function translateToolError(error: unknown, cwd: string): Error {
  if (error instanceof SubagentAgentNotFoundError) return error;
  if (error instanceof McpToolError) {
    if (error.code === 'runtime_not_found' || error.code === 'agent_not_found') {
      return new SubagentAgentNotFoundError('unknown');
    }
    if (error.code === 'workspace_root_required' || error.code === 'workspace_denied') {
      return new SubagentUnavailableError(
        'workspace-denied',
        `MixAgents 未授权 workspace：${cwd}。请把该 canonical 路径加入 ~/.config/mixagents/broker.json 的 workspaceRoots。`,
        { workspace: cwd, code: error.code },
      );
    }
    if (error.code === 'route_not_found') {
      return new SubagentUnavailableError('route-unavailable', `MixAgents route 不存在：${error.message}`);
    }
    return new SubagentUnavailableError('route-unavailable', redactSecrets(error.message));
  }
  if (error instanceof Error) {
    const safe = new Error(redactSecrets(error.message), { cause: error.cause });
    safe.name = error.name;
    return safe;
  }
  return new Error(redactSecrets(String(error)));
}

function abortError(): Error {
  const error = new Error('子代理请求已取消');
  error.name = 'AbortError';
  return error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function splitArgs(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return stringArray(parsed);
  } catch {
    return value.split(/\s+/u).filter(Boolean);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

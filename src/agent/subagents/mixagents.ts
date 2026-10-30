import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SubagentConfig, SubagentMixAgentsConfig } from '../../config/profile-schema';
import { McpStdioClient, McpToolError, redactSecrets } from './mcp-client';
import {
  SubagentAgentNotFoundError,
  SubagentUnavailableError,
  type SideAgent,
  type SideAgentInput,
  type SideAgentProgressHandler,
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
const require = createRequire(import.meta.url);

export interface MixAgentsLaunchConfig {
  command: string;
  args: string[];
  cwd?: string;
  credentialMode?: 'inherit-env' | 'mixagents-managed';
  credentialProvider?: string;
  credentialEnvKeys?: string[];
}

export interface MixAgentsRuntimeOverrides {
  brokerConfigPath: string;
  credentials: Record<string, string>;
  fingerprint: string;
  /** The route generated from the same cc-switch snapshot as the config/key. */
  route?: SubagentRoute;
}

export interface MixAgentsBrokerBackendOptions {
  /** Test seam; production resolves the bundled compatible MCP entrypoint. */
  recoveryLaunch?: MixAgentsLaunchConfig;
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
  private launch: MixAgentsLaunchConfig;
  private readonly env: NodeJS.ProcessEnv;
  private readonly timeoutMs: number;
  private runtimeRecoveryNotice?: string;
  private launchReplacementNotice?: string;
  private supportsProgressEvents = false;

  constructor(
    private readonly config: SubagentConfig,
    env: NodeJS.ProcessEnv = process.env,
    private readonly runtime?: MixAgentsRuntimeOverrides,
    private readonly options: MixAgentsBrokerBackendOptions = {},
  ) {
    this.env = env;
    const configuredLaunch = resolveMixAgentsLaunchConfig(config, env);
    // Older settings commonly retained a mixagents-broker-mcp wrapper even
    // after arg-bridge started generating a 0.1.1 cc-switch runtime. Those
    // wrappers can load a different broker config, so every /btw would first
    // fail and then recover through the bundled server. The generated runtime
    // schema is versioned with the bundled package; use it directly.
    const bundledLaunch = runtime ? resolveBundledMixAgentsLaunchConfig() : undefined;
    // Older profiles and generated helper scripts often point at a wrapper
    // named mixagents-broker[-mcp], including .js/.mjs launchers and `node`
    // commands whose argument points at that package. Those wrappers can load
    // a different broker config, so a generated cc-switch runtime should use
    // the bridge-bundled Broker directly. Custom/non-wrapper MCP commands
    // remain authoritative.
    const replaceConfiguredLaunch = Boolean(
      configuredLaunch &&
      bundledLaunch &&
      !sameLaunch(configuredLaunch, bundledLaunch) &&
      (
        isGeneratedRuntimeBrokerLaunch(configuredLaunch) ||
        isMissingKnownLegacyBrokerLaunch(configuredLaunch)
      ),
    );
    const launch = replaceConfiguredLaunch ? bundledLaunch : configuredLaunch;
    if (replaceConfiguredLaunch && isMissingKnownLegacyBrokerLaunch(configuredLaunch!)) {
      this.launchReplacementNotice =
        '配置文件中的旧 MixAgents npm Broker 路径已失效，已自动改用随包 vendored Broker；provider/model/route 均未改变。';
    }
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
    this.runtimeRecoveryNotice = undefined;
    try {
      const routes = await this.listRoutesOnce(signal);
      return mergeRuntimeRoutes(routes, this.runtime?.route);
    } catch (error) {
      if (!this.runtime?.route || !isRecoverableRuntimeRouteError(error)) throw error;

      // A long-lived or externally configured MCP process can survive with an
      // older environment snapshot. Restart it before treating the selected
      // cc-switch provider as unavailable.
      this.resetClient();
      try {
        const restarted = await this.listRoutesOnce(signal);
        const routes = mergeRuntimeRoutes(restarted, this.runtime.route);
        this.runtimeRecoveryNotice =
          'MixAgents runtime 未加载当前 cc-switch route，已自动重启 Broker，并继续使用 settings 指定的 provider。';
        return routes;
      } catch (retryError) {
        if (!isRecoverableRuntimeRouteError(retryError)) throw retryError;
        const recoveryLaunch = this.options.recoveryLaunch ?? resolveBundledMixAgentsLaunchConfig();
        if (!recoveryLaunch || sameLaunch(this.launch, recoveryLaunch)) throw retryError;

        // Explicit/profile MCP commands remain the first choice. If that
        // server still ignores the generated runtime config, use the exact
        // version shipped with arg-bridge rather than changing provider.
        this.launch = recoveryLaunch;
        this.resetClient();
        const compatibleRoutes = await this.listRoutesOnce(signal);
        const routes = mergeRuntimeRoutes(compatibleRoutes, this.runtime.route);
        this.runtimeRecoveryNotice =
          'MixAgents runtime 未加载当前 cc-switch route，已切换至随 arg-bridge 安装的兼容 Broker，并继续使用 settings 指定的 provider。';
        return routes;
      }
    }
  }

  get recoveryNotice(): string | undefined {
    return this.runtimeRecoveryNotice ?? this.launchReplacementNotice;
  }

  private async listRoutesOnce(signal: AbortSignal): Promise<SubagentRoute[]> {
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
        ...(stringValue(entry.ccSwitchProviderId)
          ? { ccSwitchProviderId: stringValue(entry.ccSwitchProviderId) }
          : {}),
        ...(entry.source === 'cc-switch' || entry.source === 'broker-config'
          ? { source: entry.source }
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

  get runtimeFingerprint(): string | undefined {
    return this.runtime?.fingerprint;
  }

  get progressEventsEnabled(): boolean {
    return this.supportsProgressEvents;
  }

  async createOrReuse(input: SideAgentInput): Promise<SideAgent> {
    if (input.access !== 'read-only') {
      if (input.route.maxAccess !== 'workspace-write') {
        throw new SubagentUnavailableError(
          'route-unavailable',
          `MixAgents route ${input.route.id} 不支持 workspace-write。`,
        );
      }
      const authorization = input.writeAuthorization;
      if (
        !authorization ||
        authorization.workspace !== input.cwd ||
        authorization.task !== input.task
      ) {
        throw new SubagentUnavailableError(
          'write-not-authorized',
          'workspace-write 子代理必须由用户针对该任务和该 workspace 明确授权。',
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
    onProgress?: SideAgentProgressHandler,
    cursor = 0,
  ): Promise<SideAgentResult> {
    return this.waitInternal(agent, signal, timeoutMs, onProgress, cursor);
  }

  private async waitInternal(
    agent: SideAgent,
    signal: AbortSignal,
    timeoutMs: number,
    onProgress: SideAgentProgressHandler | undefined,
    initialCursor: number,
  ): Promise<SideAgentResult> {
    const client = await this.ensureClient();
    const deadline = Date.now() + timeoutMs;
    let cursor = initialCursor;
    let cursorGapReported = false;
    while (Date.now() < deadline) {
      if (signal.aborted) throw abortError();
      const remaining = Math.max(1, deadline - Date.now());
      if (this.supportsProgressEvents) {
        try {
          const waitMs = Math.min(5_000, remaining);
          const progress = await client.callTool('read_agent_events', {
            agentId: agent.agentId,
            cursor,
            maxEvents: 200,
            waitMs,
          }, { signal, timeoutMs: waitMs + 10_000 });
          const nextCursor = numberValue(progress.nextCursor);
          if (nextCursor !== undefined) cursor = nextCursor;
          if (progress.cursorExpired === true && !cursorGapReported) {
            cursorGapReported = true;
            onProgress?.({
              type: 'notice',
              text: 'MixAgents 进度缓冲区已截断；后续只显示仍可读取的新事件，最终结果不受影响。',
            });
          }
          this.emitProgressEvents(progress, onProgress);
          const status = stringValue(progress.status);
          if (status === 'not_found') throw new SubagentAgentNotFoundError(agent.agentId);
          if (status !== 'completed' && status !== 'failed' && status !== 'interrupted') {
            continue;
          }
        } catch (error) {
          if (error instanceof SubagentAgentNotFoundError) throw error;
          if (signal.aborted) throw abortError();
          this.supportsProgressEvents = false;
          onProgress?.({
            type: 'notice',
            text: `MixAgents 进度流不可用，已退回终态 mailbox：${redactSecrets(errorMessage(error))}`,
          });
        }
      }
      const waitBudget = Math.max(1, Math.min(WAIT_REQUEST_MS, deadline - Date.now()));
      const result = await client.callTool('wait_agent', {
        agentIds: [agent.agentId],
        timeoutMs: waitBudget,
      }, { signal, timeoutMs: waitBudget + 10_000 }).catch(error => {
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
    timeoutMs = DEFAULT_TOTAL_WAIT_MS,
    onProgress?: SideAgentProgressHandler,
  ): Promise<SideAgentResult> {
    const client = await this.ensureClient();
    let cursor = 0;
    let hasPreSendCursor = false;
    if (this.supportsProgressEvents) {
      const current = await client.callTool('read_agent_events', {
        agentId: agent.agentId,
        cursor: 0,
        maxEvents: 0,
        waitMs: 0,
      }, { signal, timeoutMs: 10_000 }).catch(error => {
        if (signal.aborted) throw abortError();
        this.supportsProgressEvents = false;
        onProgress?.({
          type: 'notice',
          text: `MixAgents 无法建立本轮进度 cursor，已退回终态 mailbox：${redactSecrets(errorMessage(error))}`,
        });
        return undefined;
      });
      const currentCursor = numberValue(current?.eventCursor);
      if (currentCursor !== undefined) {
        cursor = currentCursor;
        hasPreSendCursor = true;
      } else {
        this.supportsProgressEvents = false;
        onProgress?.({
          type: 'notice',
          text: 'MixAgents 进度 cursor 格式无效，已退回终态 mailbox。',
        });
      }
    }
    try {
      const sent = await client.callTool('send', {
        agentId: agent.agentId,
        message,
      }, { signal, timeoutMs: 60_000 });
      if (this.supportsProgressEvents && !hasPreSendCursor) {
        cursor = numberValue(sent.eventCursor) ?? cursor;
      }
    } catch (error) {
      throw translateToolError(error, agent.cwd);
    }
    return this.waitInternal(agent, signal, timeoutMs, onProgress, cursor);
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
    this.resetClient();
  }

  private async ensureClient(): Promise<McpStdioClient> {
    if (this.client) return this.client;
    if (this.runtime) {
      validateRuntimeOverrides(this.runtime);
    } else if (this.launch.credentialMode === 'mixagents-managed') {
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
      if (this.runtime) {
        childEnv.MIXAGENTS_BROKER_CONFIG = this.runtime.brokerConfigPath;
        childEnv.MIXAGENTS_BROKER_CREDENTIALS_JSON = JSON.stringify(this.runtime.credentials);
        applyRuntimeCredentialOverrides(childEnv, this.runtime.credentials);
        if (this.runtime.route?.tags.includes('third-party')) {
          stripLoopbackProxyEnvironment(childEnv);
        }
      } else if (this.launch.credentialMode === 'mixagents-managed') {
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
    this.supportsProgressEvents = names.has('read_agent_events');
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
    if (
      this.runtime &&
      isKnownOlderServerVersion(this.client.serverVersion, '0.1.1')
    ) {
      const serverVersion = this.client.serverVersion;
      this.client.close();
      this.client = undefined;
      throw new SubagentUnavailableError(
        'mixagents-incompatible',
        `MixAgents ${serverVersion} 不支持自动 cc-switch runtime route，至少需要 0.1.1。`,
        { serverVersion, recovery: 'runtime-server' },
      );
    }
    return this.client;
  }

  private resetClient(): void {
    this.client?.close();
    this.client = undefined;
    this.supportsProgressEvents = false;
  }

  private emitProgressEvents(
    value: Record<string, unknown>,
    onProgress: SideAgentProgressHandler | undefined,
  ): void {
    if (!onProgress || !Array.isArray(value.events)) return;
    for (const raw of value.events) {
      if (!isRecord(raw)) continue;
      const type = stringValue(raw.type);
      const itemId = stringValue(raw.itemId);
      if (type === 'text_delta' && typeof raw.text === 'string' && raw.text) {
        const cursor = numberValue(raw.seq);
        onProgress({
          type: 'text',
          text: raw.text,
          ...(itemId ? { itemId } : {}),
          ...(cursor !== undefined ? { cursor } : {}),
        });
      } else if (type === 'tool_started' || type === 'tool_completed') {
        const tool = stringValue(raw.tool);
        if (tool) {
          const cursor = numberValue(raw.seq);
          onProgress({
            type,
            tool,
            ...(itemId ? { itemId } : {}),
            ...(cursor !== undefined ? { cursor } : {}),
          });
        }
      }
    }
  }
}

function validateRuntimeOverrides(runtime: MixAgentsRuntimeOverrides): void {
  if (!isAbsolute(runtime.brokerConfigPath) || !runtime.fingerprint.trim()) {
    throw new SubagentUnavailableError(
      'mixagents-not-configured',
      '自动 cc-switch Broker runtime 配置无效',
    );
  }
  for (const [name, value] of Object.entries(runtime.credentials)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) || !value) {
      throw new SubagentUnavailableError(
        'mixagents-not-configured',
        '自动 cc-switch Broker 凭据字段无效（只显示字段名）',
        { environmentNames: Object.keys(runtime.credentials) },
      );
    }
  }
}

/**
 * MixAgents 0.1.1 only fills credentials that are absent from its inherited
 * environment. That lets a main-session OPENAI_API_KEY win over the key
 * resolved for the selected subagent provider. Apply the selected credentials
 * explicitly so both `/btw` and model-visible workers use the same snapshot.
 */
export function applyRuntimeCredentialOverrides(
  target: NodeJS.ProcessEnv,
  credentials: Record<string, string>,
): NodeJS.ProcessEnv {
  for (const [name, value] of Object.entries(credentials)) {
    for (const existing of Object.keys(target)) {
      if (existing.toLowerCase() === name.toLowerCase()) delete target[existing];
    }
    target[name] = value;
  }
  return target;
}

function stripLoopbackProxyEnvironment(env: NodeJS.ProcessEnv): void {
  for (const key of [
    'http_proxy',
    'https_proxy',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'all_proxy',
    'ALL_PROXY',
  ]) {
    const value = env[key];
    if (!value) continue;
    try {
      const host = new URL(value.includes('://') ? value : `http://${value}`).hostname.toLowerCase();
      if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
        delete env[key];
      }
    } catch {
      delete env[key];
    }
  }
}

/**
 * MixAgents 0.1.1 intentionally returns only its public RouteView fields.
 * cc-switch identity, revision, and source are generated by ArgBridge and
 * therefore have to be merged onto the matching MCP route. Availability and
 * missingEnvironment must come from MixAgents, not from the generated copy.
 */
export function mergeRuntimeRoutes(
  routes: SubagentRoute[],
  runtimeRoute: SubagentRoute | undefined,
): SubagentRoute[] {
  if (!runtimeRoute) return routes;
  const actual = routes.find(route => route.id === runtimeRoute.id);
  if (!actual) {
    throw new SubagentUnavailableError(
      'route-unavailable',
      `MixAgents 没有返回 cc-switch runtime 生成的 route ${runtimeRoute.id}；` +
        '为避免把任务发给错误模型，已停止 subagent。',
      {
        expectedRoute: runtimeRoute.id,
        returnedRoutes: routes.map(route => route.id),
        recovery: 'runtime-route',
      },
    );
  }
  if (
    actual.provider !== runtimeRoute.provider ||
    actual.model !== runtimeRoute.model
  ) {
    throw new SubagentUnavailableError(
      'route-unavailable',
      `MixAgents route ${runtimeRoute.id} 与 cc-switch 配置不匹配：` +
        `expected=${runtimeRoute.provider}/${runtimeRoute.model} ` +
        `actual=${actual.provider}/${actual.model}`,
      { recovery: 'runtime-route' },
    );
  }
  return routes.map(route => route.id !== runtimeRoute.id
    ? route
    : {
        ...route,
        ...(runtimeRoute.description ? { description: runtimeRoute.description } : {}),
        tags: [...new Set([...route.tags, ...runtimeRoute.tags])],
        ...(runtimeRoute.revision ? { revision: runtimeRoute.revision } : {}),
        ...(runtimeRoute.targetFingerprint
          ? { targetFingerprint: runtimeRoute.targetFingerprint }
          : {}),
        ...(runtimeRoute.ccSwitchProviderId
          ? { ccSwitchProviderId: runtimeRoute.ccSwitchProviderId }
          : {}),
        ...(runtimeRoute.source ? { source: runtimeRoute.source } : {}),
      });
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
  return resolveBundledMixAgentsLaunchConfig();
}

/** Stable package entrypoint shipped as arg-bridge's optional dependency. */
export function resolveBundledMixAgentsLaunchConfig(): MixAgentsLaunchConfig | undefined {
  const server = [
    new URL('../../../vendor/mixagents-broker/plugin/mixagents-broker/dist/server.js', import.meta.url),
    new URL('../vendor/mixagents-broker/plugin/mixagents-broker/dist/server.js', import.meta.url),
  ]
    .map(candidate => fileURLToPath(candidate))
    .find(candidate => existsSync(candidate));
  return server
    ? {
        command: process.execPath,
        args: [server],
      }
    : undefined;
}

/** Legacy npm path retained for pre-1.11 long-running processes. */
export function resolveLegacyInstalledMixAgentsLaunchConfig(): MixAgentsLaunchConfig | undefined {
  if (!supportsLegacyInstalledMixAgentsBroker()) return undefined;
  try {
    const server = require.resolve('mixagents-broker/dist/server.js');
    return existsSync(server)
      ? { command: process.execPath, args: [server] }
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * mixagents-broker@0.1.1 declares Node >=22.19. npm correctly omits that
 * optional compatibility dependency on Node 20, where the vendored Broker is
 * the only supported runtime.
 */
export function supportsLegacyInstalledMixAgentsBroker(
  version = process.versions.node,
): boolean {
  const match = /^(\d+)\.(\d+)/u.exec(version);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 22 || (major === 22 && minor >= 19);
}

function isGeneratedRuntimeBrokerLaunch(launch: MixAgentsLaunchConfig): boolean {
  const candidates = [launch.command, ...launch.args]
    .map(value => basename(value).toLowerCase())
    .filter(Boolean);
  return candidates.some(value =>
    /^(?:mixagents-broker(?:-mcp)?|arg-bridge-mixagents-(?:mcp|broker(?:-mcp)?))(?:\.(?:mjs|cjs|js|cmd|exe))?$/u.test(value)
  );
}

function isMissingKnownLegacyBrokerLaunch(launch: MixAgentsLaunchConfig): boolean {
  return [launch.command, ...launch.args].some(value =>
    isAbsolute(value) &&
    /[\\/]node_modules[\\/]mixagents-broker[\\/]dist[\\/]server\.js$/u.test(value) &&
    !existsSync(value)
  );
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
    ...(stringValue(value.threadId) ?? stringValue(value.thread_id)
      ? { threadId: stringValue(value.threadId) ?? stringValue(value.thread_id) }
      : {}),
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
    value === 'not_found' ||
    value === 'timeout' ||
    value === 'closed'
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

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
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

function isRecoverableRuntimeRouteError(error: unknown): boolean {
  return error instanceof SubagentUnavailableError &&
    (error.code === 'mixagents-incompatible' ||
      error.details?.recovery === 'runtime-route' ||
      error.details?.recovery === 'runtime-server');
}

function sameLaunch(left: MixAgentsLaunchConfig, right: MixAgentsLaunchConfig): boolean {
  return left.command === right.command &&
    left.args.length === right.args.length &&
    left.args.every((arg, index) => arg === right.args[index]);
}

function isKnownOlderServerVersion(actual: string | undefined, minimum: string): boolean {
  if (!actual) return false;
  const left = numericVersion(actual);
  const right = numericVersion(minimum);
  if (!left || !right) return false;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    if (a !== b) return a < b;
  }
  return false;
}

function numericVersion(value: string): number[] | undefined {
  const match = value.trim().match(/^(\d+)\.(\d+)\.(\d+)/u);
  return match ? match.slice(1).map(Number) : undefined;
}

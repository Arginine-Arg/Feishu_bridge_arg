import {
  DEFAULT_SUBAGENT_CONFIG,
  type SubagentAccess,
  type SubagentConfig,
} from '../../config/profile-schema';
import { loadBrokerRouteMap, resolveRouteForProvider, type BrokerRouteMap } from '../../integrations/broker-routes';
import { readCcSwitchState, type CcSwitchState } from '../../integrations/cc-switch';
import {
  CcSwitchProviderError,
  materializeCcSwitchBrokerRuntime,
} from '../../integrations/cc-switch-provider';
import { log } from '../../core/logger';
import {
  mergeRuntimeRoutes,
  MixAgentsBrokerBackend,
  type MixAgentsRuntimeOverrides,
} from './mixagents';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  SubagentUnavailableError,
  type SubagentBackend,
  type SubagentRoute,
} from './types';

export interface ResolveSubagentInput {
  subagents?: SubagentConfig;
  env?: NodeJS.ProcessEnv;
  cwd: string;
  /** Explicit per-command route (highest priority). */
  requestedRoute?: string;
  /** Access requested for the worker. /btw always supplies read-only. */
  access?: SubagentAccess;
  /** Profile-scoped structured state directory for generated runtime files. */
  stateDir?: string;
  codexHome?: string;
  codexBin?: string;
  parentProviderId?: string;
  /** Selects role-specific runtime policy without changing the provider. */
  runtimeRole?: 'side' | 'worker' | 'reviewer';
  signal: AbortSignal;
}

export interface ResolvedSubagents {
  kind: 'mixagents' | 'fork' | 'off';
  config: SubagentConfig;
  backend?: SubagentBackend;
  route?: SubagentRoute;
  routes: SubagentRoute[];
  ccSwitch: CcSwitchState;
  routeMap?: BrokerRouteMap;
  notice?: string;
  error?: string;
}

/**
 * Resolve the subagent backend and route for THIS /btw. Nothing is cached
 * across calls: cc-switch settings and Broker routes are re-read every time.
 */
export async function resolveSubagents(input: ResolveSubagentInput): Promise<ResolvedSubagents> {
  const env = input.env ?? process.env;
  const config = input.subagents ?? DEFAULT_SUBAGENT_CONFIG;
  const ccSwitch = await readCcSwitchState(env);
  const routeState = await loadBrokerRouteMap(env);
  const base = {
    config,
    ccSwitch,
    ...(routeState.config ? { routeMap: routeState.config } : {}),
  };
  if (!config.enabled || config.mode === 'off') {
    return { ...base, kind: 'off', routes: [] };
  }
  if (config.mode === 'fork') {
    return { ...base, kind: 'fork', routes: [] };
  }

  let backend: MixAgentsBrokerBackend | undefined;
  let routes: SubagentRoute[] = [];
  let runtime: MixAgentsRuntimeOverrides | undefined;
  try {
    if (
      config.routeMode === 'follow-cc-switch' &&
      (input.stateDir || input.parentProviderId || config.ccSwitchProviderId)
    ) {
      const generated = await materializeCcSwitchBrokerRuntime({
        env,
        ...(input.codexHome ? { codexHome: input.codexHome } : {}),
        ...(input.parentProviderId ? { parentProviderId: input.parentProviderId } : {}),
        ...(config.ccSwitchProviderId ? { providerId: config.ccSwitchProviderId } : {}),
        cwd: input.cwd,
        codexBin: input.codexBin ?? env.CODEX_BINARY?.trim() ?? 'codex',
        stateDir: input.stateDir ?? defaultGeneratedRuntimeDir(env),
        runtimePolicy: {
          role: input.runtimeRole ?? 'worker',
          webSearch: config.webSearch,
          sideReasoningEffort: config.sideReasoningEffort,
        },
      });
      runtime = {
        brokerConfigPath: generated.brokerConfigPath,
        credentials: generated.credentials,
        fingerprint: generated.fingerprint,
        route: generated.route,
      };
    }
    backend = new MixAgentsBrokerBackend(config, env, runtime);
    routes = await backend.listRoutes(input.signal);
    routes = mergeRuntimeRoutes(routes, runtime?.route);
  } catch (error) {
    const message = errorMessage(error);
    await backend?.closeBackend?.().catch(() => {});
    const unavailable = error instanceof SubagentUnavailableError
      ? error
      : new SubagentUnavailableError(
          'mixagents-start-failed',
          `MixAgents 启动或路由读取失败：${message}`,
        );
    if (canAutoForkFallback(input, config)) {
      return forkFallback(base, [], message);
    }
    if (
      config.routeMode === 'follow-cc-switch' &&
      (input.stateDir || input.parentProviderId || config.ccSwitchProviderId)
    ) {
      await backend?.closeBackend?.().catch(() => {});
      throw new SubagentUnavailableError(
        'mixagents-not-configured',
        `当前 cc-switch provider 的 Broker runtime 不可用：${message}`,
        error instanceof CcSwitchProviderError ? { code: error.code } : undefined,
      );
    }
    if (config.mode === 'broker') throw unavailable;
    if (
      !config.allowForkFallback ||
      config.routeMode === 'manual' ||
      input.requestedRoute
    ) {
      throw new SubagentUnavailableError(
        'mixagents-not-configured',
        `MixAgents 不可用，且已禁用 fork fallback：${message}`,
      );
    }
    return forkFallback(base, [], message);
  }

  const selection = selectSubagentRoute({
    config,
    ccSwitch,
    routeMap: routeState.config,
    routes,
    requestedRoute: input.requestedRoute,
    access: input.access,
  });
  if (!selection.route) {
    const message = selection.error ?? '没有可用的 MixAgents read route';
    if (canAutoForkFallback(input, config)) {
      await backend?.closeBackend?.().catch(() => {});
      return forkFallback(base, routes, message);
    }
    if (
      config.mode === 'broker' ||
      config.routeMode === 'manual' ||
      input.requestedRoute ||
      (config.routeMode === 'follow-cc-switch' &&
        (input.stateDir || input.parentProviderId || config.ccSwitchProviderId))
    ) {
      await backend?.closeBackend?.().catch(() => {});
      throw new SubagentUnavailableError('route-unavailable', message, {
        routes: routes.map(route => ({ id: route.id, available: route.available })),
      });
    }
    if (!config.allowForkFallback) {
      await backend?.closeBackend?.().catch(() => {});
      throw new SubagentUnavailableError('route-unavailable', message);
    }
    await backend.closeBackend?.().catch(() => {});
    return forkFallback(base, routes, message);
  }
  if (!selection.route.available) {
    const missing = selection.route.missingEnvironment.length > 0
      ? `（缺少环境变量：${selection.route.missingEnvironment.join(', ')}）`
      : '';
    const message = `MixAgents route ${selection.route.id} 不可用${missing}`;
    await backend.closeBackend?.().catch(() => {});
    if (canAutoForkFallback(input, config)) {
      return forkFallback(base, routes, message);
    }
    throw new SubagentUnavailableError('route-unavailable', message);
  }
  return {
    ...base,
    kind: 'mixagents',
    backend,
    route: selection.route,
    routes,
    ...(backend.recoveryNotice ? { notice: backend.recoveryNotice } : {}),
  };
}

function canAutoForkFallback(
  input: ResolveSubagentInput,
  config: SubagentConfig,
): boolean {
  return (
    config.mode === 'auto' &&
    config.routeMode === 'follow-cc-switch' &&
    config.allowForkFallback &&
    !input.requestedRoute
  );
}

function forkFallback(
  base: Pick<ResolvedSubagents, 'config' | 'ccSwitch' | 'routeMap'>,
  routes: SubagentRoute[],
  reason: string,
): ResolvedSubagents {
  log.warn('agent', 'subagent-fallback-main-codex', { reason });
  return {
    ...base,
    kind: 'fork',
    routes,
    notice:
      '子代理设置指定的 MixAgents provider 不可用，已回退到主 Codex session 的 provider/model（只读 thread/fork）：' +
      reason,
    error: reason,
  };
}

function defaultGeneratedRuntimeDir(env: NodeJS.ProcessEnv): string {
  const stateHome = env.XDG_STATE_HOME?.trim() || join(homedir(), '.local', 'state');
  return join(stateHome, 'arg-bridge', 'cc-switch-runtime');
}

export function selectSubagentRoute(input: {
  config: SubagentConfig;
  ccSwitch: CcSwitchState;
  routeMap: BrokerRouteMap | undefined;
  routes: SubagentRoute[];
  requestedRoute?: string;
  access?: SubagentAccess;
}): { route?: SubagentRoute; error?: string } {
  const access = input.access ?? 'read-only';
  if (input.requestedRoute) {
    const route = input.routes.find(item => item.id === input.requestedRoute);
    return route && (access === 'read-only' || route.maxAccess === 'workspace-write')
      ? { route }
      : { error: `显式指定的 MixAgents route 不存在：${input.requestedRoute}` };
  }
  if (input.config.routeMode === 'manual') {
    const configured = access === 'workspace-write'
      ? input.config.writeRoute
      : input.config.readRoute;
    if (!configured) {
      return {
        error: access === 'workspace-write'
          ? 'routeMode=manual 但未配置 subagents.writeRoute'
          : 'routeMode=manual 但未配置 subagents.readRoute',
      };
    }
    const route = input.routes.find(item => item.id === configured);
    return route && (access === 'read-only' || route.maxAccess === 'workspace-write')
      ? { route }
      : { error: `手动配置的 MixAgents ${access} route 不存在或不支持该权限：${configured}` };
  }
  const expectedProvider = input.config.ccSwitchProviderId ??
    input.ccSwitch.currentProviderCodex;
  const automatic = input.routes.find(route =>
    route.source === 'cc-switch' &&
    (!expectedProvider || route.ccSwitchProviderId === expectedProvider) &&
    (access === 'read-only' || route.maxAccess === 'workspace-write')
  );
  if (automatic) return { route: automatic };
  const mapped = resolveRouteForProvider(
    input.routeMap,
    input.config.ccSwitchProviderId ?? input.ccSwitch.currentProviderCodex,
    access,
  );
  if (!mapped.routeId) {
    return {
      error: expectedProvider
        ? `cc-switch provider ${expectedProvider} 没有 ${access} route 映射`
        : access === 'workspace-write'
          ? '无法确定 cc-switch 当前 provider，且没有 defaultWriteRoute'
          : '无法确定 cc-switch 当前 provider，且没有 defaultReadRoute',
    };
  }
  const route = input.routes.find(item => item.id === mapped.routeId);
  return route && (access === 'read-only' || route.maxAccess === 'workspace-write')
    ? { route }
    : { error: `${access} route 映射指向不存在或不兼容的 MixAgents route：${mapped.routeId}` };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

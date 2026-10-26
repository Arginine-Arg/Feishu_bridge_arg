import {
  DEFAULT_SUBAGENT_CONFIG,
  type SubagentAccess,
  type SubagentConfig,
} from '../../config/profile-schema';
import { loadBrokerRouteMap, resolveRouteForProvider, type BrokerRouteMap } from '../../integrations/broker-routes';
import { readCcSwitchState, type CcSwitchState } from '../../integrations/cc-switch';
import { log } from '../../core/logger';
import { MixAgentsBrokerBackend } from './mixagents';
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
  try {
    backend = new MixAgentsBrokerBackend(config, env);
    routes = await backend.listRoutes(input.signal);
  } catch (error) {
    const message = errorMessage(error);
    const unavailable = error instanceof SubagentUnavailableError
      ? error
      : new SubagentUnavailableError(
          'mixagents-start-failed',
          `MixAgents 启动或路由读取失败：${message}`,
        );
    if (config.mode === 'broker') throw unavailable;
    if (!config.allowForkFallback) {
      throw new SubagentUnavailableError(
        'mixagents-not-configured',
        `MixAgents 不可用，且已禁用 fork fallback：${message}`,
      );
    }
    log.warn('agent', 'subagent-fallback-fork', { reason: message });
    return {
      ...base,
      kind: 'fork',
      routes: [],
      notice: `MixAgents 不可用，已降级到 Codex fork：${message}`,
      error: message,
    };
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
    if (config.mode === 'broker' || config.routeMode === 'manual' || input.requestedRoute) {
      throw new SubagentUnavailableError('route-unavailable', message, {
        routes: routes.map(route => ({ id: route.id, available: route.available })),
      });
    }
    if (!config.allowForkFallback) {
      throw new SubagentUnavailableError('route-unavailable', message);
    }
    await backend.closeBackend?.();
    log.warn('agent', 'subagent-fallback-fork', { reason: message });
    return {
      ...base,
      kind: 'fork',
      routes,
      notice: `MixAgents 没有可用 route，已降级到 Codex fork：${message}`,
      error: message,
    };
  }
  if (!selection.route.available) {
    const missing = selection.route.missingEnvironment.length > 0
      ? `（缺少环境变量：${selection.route.missingEnvironment.join(', ')}）`
      : '';
    const message = `MixAgents route ${selection.route.id} 不可用${missing}`;
    if (
      config.mode === 'auto' &&
      config.routeMode === 'follow-cc-switch' &&
      !input.requestedRoute &&
      config.allowForkFallback
    ) {
      await backend.closeBackend?.();
      log.warn('agent', 'subagent-fallback-fork', { reason: message });
      return {
        ...base,
        kind: 'fork',
        routes,
        notice: `${message}，已降级到 Codex fork`,
        error: message,
      };
    }
    throw new SubagentUnavailableError('route-unavailable', message);
  }
  return {
    ...base,
    kind: 'mixagents',
    backend,
    route: selection.route,
    routes,
  };
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
  const mapped = resolveRouteForProvider(
    input.routeMap,
    input.ccSwitch.currentProviderCodex,
    access,
  );
  if (!mapped.routeId) {
    return {
      error: input.ccSwitch.currentProviderCodex
        ? `cc-switch 当前 provider ${input.ccSwitch.currentProviderCodex} 没有 ${access} route 映射`
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

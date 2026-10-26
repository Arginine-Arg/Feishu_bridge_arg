import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { SubagentConfig } from '../../config/profile-schema';
import {
  loadBrokerRouteMap,
  type BrokerRouteMap,
} from '../../integrations/broker-routes';
import { readCcSwitchState, type CcSwitchState } from '../../integrations/cc-switch';
import { redactSecrets } from './mcp-client';
import {
  MixAgentsBrokerBackend,
  resolveMixAgentsLaunchConfig,
} from './mixagents';
import { selectSubagentRoute } from './registry';
import {
  SubagentUnavailableError,
  type SubagentRoute,
} from './types';

export interface SubagentDiagnostics {
  configuredMode: SubagentConfig['mode'];
  enabled: boolean;
  routeMode: SubagentConfig['routeMode'];
  modelTools: {
    configured: boolean;
    namespace: string;
    nativeToolPolicy: SubagentConfig['nativeToolPolicy'];
    brokerWired: boolean;
    degradedReason?: string;
  };
  limits: {
    maxConcurrentWorkers: number;
    workerTimeoutMs: number;
    allowWriteWorkers: boolean;
  };
  launchConfigured: boolean;
  launchCommand?: string;
  packageVersion?: string;
  toolContract: 'compatible' | 'incompatible' | 'unknown';
  mcpStart: 'not-configured' | 'started' | 'failed';
  credentials: {
    mode: 'inherit-env' | 'mixagents-managed';
    status: 'present' | 'missing' | 'delegated-unverified' | 'not-declared';
    providerReference: string | null;
    missingEnvironment: string[];
  };
  routeGeneration: 'not-tested';
  mcp: {
    status: 'disabled' | 'not-configured' | 'available' | 'unavailable';
    error?: string;
  };
  ccSwitch: {
    currentProviderCodex: string | null;
    currentProviderName: string | null;
    providers: Array<{ id: string; name: string; current: boolean }>;
    settingsPath: string;
    error?: string;
  };
  routeMap: {
    path: string;
    loaded: boolean;
    error?: string;
  };
  brokerConfigPath: string;
  selectedRoute: {
    id: string | null;
    source?: 'explicit' | 'manual' | 'cc-switch' | 'default';
    error?: string;
  };
  selectedWriteRoute: {
    id: string | null;
    source?: 'explicit' | 'manual' | 'cc-switch' | 'default';
    error?: string;
  };
  readRoutes: Array<{
    id: string;
    provider: string;
    model: string;
    access: 'read-only';
    maxAccess: SubagentRoute['maxAccess'];
    description?: string;
    revision?: string;
    tags: string[];
    available: boolean;
    missingEnvironment: string[];
  }>;
  writeRoutes: Array<{
    id: string;
    provider: string;
    model: string;
    access: 'workspace-write';
    available: boolean;
    notice: string;
  }>;
  nextCommands: string[];
}

export async function collectSubagentDiagnostics(input: {
  config: SubagentConfig;
  env?: NodeJS.ProcessEnv;
  cwd: string;
  requestedRoute?: string;
  signal?: AbortSignal;
}): Promise<SubagentDiagnostics> {
  const env = input.env ?? process.env;
  const signal = input.signal ?? new AbortController().signal;
  const [ccSwitch, routeMapState] = await Promise.all([
    readCcSwitchState(env),
    loadBrokerRouteMap(env),
  ]);
  const currentProviderName = ccSwitch.providers.find(provider =>
    provider.id === ccSwitch.currentProviderCodex || provider.current
  )?.name ?? null;
  const base: SubagentDiagnostics = {
    configuredMode: input.config.mode,
    enabled: input.config.enabled,
    routeMode: input.config.routeMode,
    modelTools: {
      configured: input.config.modelTools,
      namespace: input.config.toolNamespace,
      nativeToolPolicy: input.config.nativeToolPolicy,
      brokerWired:
        input.config.modelTools &&
        input.config.nativeToolPolicy === 'shadow' &&
        input.config.enabled &&
        (input.config.mode === 'auto' || input.config.mode === 'broker'),
      ...(!input.config.modelTools
        ? { degradedReason: 'modelTools=false; native collaboration remains visible' }
        : input.config.nativeToolPolicy !== 'shadow'
          ? { degradedReason: 'nativeToolPolicy=preserve; native collaboration may bypass Broker' }
          : {}),
    },
    limits: {
      maxConcurrentWorkers: input.config.maxConcurrentWorkers,
      workerTimeoutMs: input.config.workerTimeoutMs,
      allowWriteWorkers: input.config.allowWriteWorkers,
    },
    launchConfigured: Boolean(resolveMixAgentsLaunchConfig(input.config, env)),
    toolContract: 'unknown',
    mcpStart: 'not-configured',
    credentials: describeCredentialState(input.config, env),
    routeGeneration: 'not-tested',
    mcp: {
      status: !input.config.enabled || input.config.mode === 'off'
        ? 'disabled'
        : 'not-configured',
    },
    ccSwitch: {
      currentProviderCodex: ccSwitch.currentProviderCodex ?? null,
      currentProviderName,
      providers: ccSwitch.providers.map(provider => ({
        id: provider.id,
        name: provider.name,
        current: provider.current,
      })),
      settingsPath: ccSwitch.settingsPath,
      ...(ccSwitch.error ? { error: redactSecrets(ccSwitch.error) } : {}),
    },
    routeMap: {
      path: routeMapState.path,
      loaded: Boolean(routeMapState.config),
      ...(routeMapState.error ? { error: redactSecrets(routeMapState.error) } : {}),
    },
    brokerConfigPath: env.MIXAGENTS_BROKER_CONFIG?.trim()
      || join(env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config'), 'mixagents', 'broker.json'),
    selectedRoute: { id: null },
    selectedWriteRoute: { id: null },
    readRoutes: [],
    writeRoutes: [],
    nextCommands: [
      'arg-bridge doctor --json',
      'arg-bridge restart --profile <profile>',
      'codex plugin marketplace add Utopia-V/mixagents',
      'codex plugin add mixagents-broker@mixagents',
    ],
  };
  if (!input.config.enabled || input.config.mode === 'fork' || input.config.mode === 'off') {
    return base;
  }
  const launch = resolveMixAgentsLaunchConfig(input.config, env);
  if (!launch) return base;
  const backend = new MixAgentsBrokerBackend(input.config, env);
  try {
    const routes = await backend.listRoutes(signal);
    const selection = selectSubagentRoute({
      config: input.config,
      ccSwitch,
      routeMap: routeMapState.config,
      routes,
      requestedRoute: input.requestedRoute,
    });
    const writeSelection = selectSubagentRoute({
      config: input.config,
      ccSwitch,
      routeMap: routeMapState.config,
      routes,
      access: 'workspace-write',
    });
    return {
      ...base,
      launchCommand: basename(launch.command),
      ...(backend.serverVersion ? { packageVersion: backend.serverVersion } : {}),
      toolContract: 'compatible',
      mcpStart: 'started',
      mcp: { status: 'available' },
      selectedRoute: {
        id: selection.route?.id ?? null,
        ...(input.requestedRoute
          ? { source: 'explicit' as const }
          : selection.route
            ? { source: routeSelectionSource(input.config, ccSwitch, routeMapState.config) }
            : {}),
        ...(selection.error ? { error: redactSecrets(selection.error) } : {}),
      },
      selectedWriteRoute: {
        id: writeSelection.route?.id ?? null,
        ...(writeSelection.route
          ? { source: routeSelectionSource(input.config, ccSwitch, routeMapState.config, 'workspace-write') }
          : {}),
        ...(writeSelection.error ? { error: redactSecrets(writeSelection.error) } : {}),
      },
      readRoutes: routes.map(route => ({
        id: route.id,
        provider: route.provider,
        model: route.model,
        access: 'read-only' as const,
        maxAccess: route.maxAccess,
        ...(route.description ? { description: route.description } : {}),
        ...(route.revision ? { revision: route.revision } : {}),
        tags: route.tags,
        available: route.available,
        missingEnvironment: route.missingEnvironment,
      })),
      writeRoutes: routes
        .filter(route => route.maxAccess === 'workspace-write')
        .map(route => ({
          id: route.id,
          provider: route.provider,
          model: route.model,
          access: 'workspace-write' as const,
          available: route.available,
          notice: '不用于 /btw；必须由用户针对具体任务和 workspace 逐次授权',
        })),
    };
  } catch (error) {
    return {
      ...base,
      launchCommand: basename(launch.command),
      ...(backend.serverVersion ? { packageVersion: backend.serverVersion } : {}),
      toolContract: error instanceof SubagentUnavailableError &&
        error.code === 'mixagents-incompatible'
        ? 'incompatible'
        : 'unknown',
      mcpStart: error instanceof SubagentUnavailableError &&
        error.code === 'mixagents-incompatible'
        ? 'started'
        : error instanceof SubagentUnavailableError &&
            error.code === 'mixagents-start-failed'
          ? 'failed'
          : 'not-configured',
      mcp: {
        status: 'unavailable',
        error: redactSecrets(error instanceof Error ? error.message : String(error)),
      },
    };
  } finally {
    await backend.closeBackend?.().catch(() => {});
  }
}

function describeCredentialState(
  config: SubagentConfig,
  env: NodeJS.ProcessEnv,
): SubagentDiagnostics['credentials'] {
  const mixagents = config.mixagents;
  const mode = mixagents?.credentialMode ?? 'inherit-env';
  const providerReference = mixagents?.credentialProvider ?? null;
  if (mode === 'mixagents-managed') {
    return {
      mode,
      status: providerReference ? 'delegated-unverified' : 'missing',
      providerReference,
      missingEnvironment: [],
    };
  }
  const expected = mixagents?.credentialEnvKeys ?? [];
  const missingEnvironment = expected.filter(key => !env[key]?.trim());
  return {
    mode,
    status: expected.length === 0
      ? 'not-declared'
      : missingEnvironment.length > 0
        ? 'missing'
        : 'present',
    providerReference,
    missingEnvironment,
  };
}

function routeSelectionSource(
  config: SubagentConfig,
  ccSwitch: CcSwitchState,
  map: BrokerRouteMap | undefined,
  access: 'read-only' | 'workspace-write' = 'read-only',
): 'manual' | 'cc-switch' | 'default' {
  if (config.routeMode === 'manual') return 'manual';
  const mapped = access === 'workspace-write'
    ? map?.providers[ccSwitch.currentProviderCodex ?? '']?.writeRoute
    : map?.providers[ccSwitch.currentProviderCodex ?? '']?.readRoute;
  if (ccSwitch.currentProviderCodex && mapped) {
    return 'cc-switch';
  }
  return 'default';
}

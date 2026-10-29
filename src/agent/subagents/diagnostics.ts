import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import type { SubagentConfig } from '../../config/profile-schema';
import {
  loadBrokerRouteMap,
  type BrokerRouteMap,
} from '../../integrations/broker-routes';
import { readCcSwitchState, type CcSwitchState } from '../../integrations/cc-switch';
import {
  materializeCcSwitchBrokerRuntime,
  readCcSwitchProviderCatalog,
  resolveCurrentCcSwitchCodexProvider,
  type CcSwitchProviderSummary,
} from '../../integrations/cc-switch-provider';
import { processAlive, readHostRegistry } from '../structured/host-registry';
import { redactSecrets } from './mcp-client';
import {
  mergeRuntimeRoutes,
  MixAgentsBrokerBackend,
  resolveBundledMixAgentsLaunchConfig,
  resolveLegacyInstalledMixAgentsLaunchConfig,
  resolveMixAgentsLaunchConfig,
  supportsLegacyInstalledMixAgentsBroker,
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
    configuredForNewThreads: boolean;
    degradedReason?: string;
  };
  limits: {
    maxConcurrentWorkers: number;
    workerTimeoutMs: number;
    sideTimeoutMs: number;
    sideReasoningEffort: SubagentConfig['sideReasoningEffort'];
    allowWriteWorkers: boolean;
  };
  webSearch: {
    mode: SubagentConfig['webSearch'];
    providerSupported: boolean | null;
    effective: 'enabled' | 'disabled' | 'unknown';
    reason: string;
  };
  launchConfigured: boolean;
  launchCommand?: string;
  launchCompatibility: {
    vendor: 'present' | 'missing';
    legacyNpm: 'present' | 'missing';
    legacyNpmRuntime: 'supported' | 'unsupported';
    purpose: 'new-runtime-plus-running-process-compatibility';
  };
  packageVersion?: string;
  progress: {
    mode: 'events-v1' | 'heartbeat-only' | 'unknown';
    tool?: 'read_agent_events';
  };
  toolContract: 'compatible' | 'incompatible' | 'unknown';
  mcpStart: 'not-configured' | 'started' | 'failed';
  credentials: {
    mode: 'inherit-env' | 'mixagents-managed' | 'cc-switch-auto';
    status: 'present' | 'missing' | 'oauth-only' | 'delegated-unverified' | 'not-declared';
    providerReference: string | null;
    missingEnvironment: string[];
    sourcePath?: string;
    fingerprint?: string;
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
    provider?: CcSwitchProviderSummary;
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
  runtime: {
    profileScopedStateDir: string | null;
    brokerThreadMarkers: Array<{
      threadId: string;
      namespace: string;
      version: number;
      createdAt: number;
    }>;
    appServerHosts: number;
    liveAppServerHosts: number;
    namespaceBound: boolean;
    liveIdentifiedAppServerHosts: number;
  };
  nextCommands: string[];
}

export async function collectSubagentDiagnostics(input: {
  config: SubagentConfig;
  env?: NodeJS.ProcessEnv;
  cwd: string;
  requestedRoute?: string;
  signal?: AbortSignal;
  stateDir?: string;
  codexHome?: string;
  codexBin?: string;
  parentProviderId?: string;
}): Promise<SubagentDiagnostics> {
  const env = input.env ?? process.env;
  const signal = input.signal ?? new AbortController().signal;
  const [ccSwitch, routeMapState, catalog, providerResolution, structuredRuntime] = await Promise.all([
    readCcSwitchState(env),
    loadBrokerRouteMap(env),
    readCcSwitchProviderCatalog(env)
      .catch(() => undefined),
    resolveCurrentCcSwitchCodexProvider({
      env,
      ...(input.codexHome ? { codexHome: input.codexHome } : {}),
      ...(input.parentProviderId ? { parentProviderId: input.parentProviderId } : {}),
      ...(input.config.ccSwitchProviderId
        ? { providerId: input.config.ccSwitchProviderId }
        : {}),
    })
      .then(result => ({ result }))
      .catch(error => ({ error })),
    inspectStructuredRuntime(input.stateDir, input.config.toolNamespace),
  ]);
  const configuredForNewThreads =
    input.config.modelTools &&
    input.config.nativeToolPolicy === 'shadow' &&
    input.config.enabled &&
    (input.config.mode === 'auto' || input.config.mode === 'broker');
  const marker = structuredRuntime.brokerThreadMarkers.find(item =>
    item.namespace === input.config.toolNamespace
  );
  const providerList = catalog?.providers.length
    ? catalog.providers
    : ccSwitch.providers;
  const currentProviderCodex = catalog?.currentProviderId ??
    providerList.find(provider => provider.current)?.id ??
    ccSwitch.currentProviderCodex ??
    null;
  const currentProviderName = providerList.find(provider =>
    provider.id === currentProviderCodex || provider.current
  )?.name ?? ccSwitch.providers.find(provider =>
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
      configuredForNewThreads,
      // A marker alone is not proof that the current thread can execute a
      // worker. The live route preflight below must also succeed.
      brokerWired: false,
      ...(!input.config.modelTools
        ? { degradedReason: 'modelTools=false; native collaboration remains visible' }
        : input.config.nativeToolPolicy !== 'shadow'
          ? { degradedReason: 'nativeToolPolicy=preserve; native collaboration may bypass Broker' }
          : !configuredForNewThreads
            ? { degradedReason: `subagents.mode=${input.config.mode}` }
            : !marker
              ? { degradedReason: 'configured for new threads, but no broker-thread marker exists in this profile' }
              : structuredRuntime.liveIdentifiedAppServerHosts === 0
                ? { degradedReason: 'broker-thread marker exists, but no live identified App Server host is bound to this profile' }
                : input.config.routeMode === 'follow-cc-switch' &&
                    !('result' in providerResolution)
                  ? { degradedReason: 'cc-switch provider/runtime preflight failed; Broker tools are not bound' }
          : {}),
    },
    limits: {
      maxConcurrentWorkers: input.config.maxConcurrentWorkers,
      workerTimeoutMs: input.config.workerTimeoutMs,
      sideTimeoutMs: input.config.sideTimeoutMs,
      sideReasoningEffort: input.config.sideReasoningEffort,
      allowWriteWorkers: input.config.allowWriteWorkers,
    },
    webSearch: {
      mode: input.config.webSearch,
      providerSupported: null,
      effective: input.config.webSearch === 'disabled' ? 'disabled' : 'unknown',
      reason: 'no generated cc-switch runtime has been inspected',
    },
    launchConfigured: Boolean(resolveMixAgentsLaunchConfig(input.config, env)),
    launchCompatibility: {
      vendor: resolveBundledMixAgentsLaunchConfig() ? 'present' : 'missing',
      legacyNpm: resolveLegacyInstalledMixAgentsLaunchConfig() ? 'present' : 'missing',
      legacyNpmRuntime: supportsLegacyInstalledMixAgentsBroker() ? 'supported' : 'unsupported',
      purpose: 'new-runtime-plus-running-process-compatibility',
    },
    progress: { mode: 'unknown' },
    toolContract: 'unknown',
    mcpStart: 'not-configured',
    credentials: describeCredentialState(
      input.config,
      env,
      'result' in providerResolution ? providerResolution.result.summary : undefined,
    ),
    routeGeneration: 'not-tested',
    mcp: {
      status: !input.config.enabled || input.config.mode === 'off'
        ? 'disabled'
        : 'not-configured',
    },
    ccSwitch: {
      currentProviderCodex,
      currentProviderName,
      providers: providerList.map(provider => ({
        id: provider.id,
        name: provider.name,
        current: provider.current || provider.id === currentProviderCodex,
      })),
      ...('result' in providerResolution
        ? { provider: providerResolution.result.summary }
        : {}),
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
    runtime: {
      profileScopedStateDir: input.stateDir ?? null,
      brokerThreadMarkers: structuredRuntime.brokerThreadMarkers,
      appServerHosts: structuredRuntime.appServerHosts,
      liveAppServerHosts: structuredRuntime.liveAppServerHosts,
      namespaceBound: Boolean(marker),
      liveIdentifiedAppServerHosts: structuredRuntime.liveIdentifiedAppServerHosts,
    },
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
  if (!launch) {
    return {
      ...base,
      modelTools: {
        ...base.modelTools,
        degradedReason: 'MixAgents MCP launch is not configured or discoverable',
      },
    };
  }
  let brokerRuntime: {
    brokerConfigPath: string;
    credentials: Record<string, string>;
    fingerprint: string;
    route?: SubagentRoute;
    webSearch?: {
      mode: SubagentConfig['webSearch'];
      providerSupported: boolean | null;
      effective: 'enabled' | 'disabled';
      reason: string;
    };
  } | undefined;
  if (input.config.routeMode === 'follow-cc-switch') {
    if ('error' in providerResolution) {
      return {
        ...base,
        launchCommand: basename(launch.command),
        mcpStart: 'not-configured',
        mcp: {
          status: 'unavailable',
          error: redactSecrets(errorMessage(providerResolution.error)),
        },
        credentials: describeCredentialState(input.config, env),
      };
    }
    if (!input.stateDir) {
      return {
        ...base,
        launchCommand: basename(launch.command),
        mcpStart: 'not-configured',
        mcp: {
          status: 'unavailable',
          error: 'profile-scoped structured state directory is unavailable',
        },
      };
    }
    try {
      const generated = await materializeCcSwitchBrokerRuntime({
        env,
        ...(input.codexHome ? { codexHome: input.codexHome } : {}),
        ...(input.parentProviderId ? { parentProviderId: input.parentProviderId } : {}),
        ...(input.config.ccSwitchProviderId
          ? { providerId: input.config.ccSwitchProviderId }
          : {}),
        cwd: input.cwd,
        codexBin: input.codexBin ?? env.CODEX_BINARY?.trim() ?? 'codex',
        stateDir: input.stateDir,
        runtimePolicy: {
          role: 'side',
          webSearch: input.config.webSearch,
          sideReasoningEffort: input.config.sideReasoningEffort,
        },
      });
      brokerRuntime = {
        brokerConfigPath: generated.brokerConfigPath,
        credentials: generated.credentials,
        fingerprint: generated.fingerprint,
        route: generated.route,
        webSearch: generated.webSearch,
      };
    } catch (error) {
      return {
        ...base,
        launchCommand: basename(launch.command),
        mcpStart: 'not-configured',
        mcp: {
          status: 'unavailable',
          error: redactSecrets(errorMessage(error)),
        },
      };
    }
  }
  const backend = new MixAgentsBrokerBackend(input.config, env, brokerRuntime);
  try {
    const routes = await backend.listRoutes(signal);
    const visibleRoutes = mergeRuntimeRoutes(routes, brokerRuntime?.route);
    const selection = selectSubagentRoute({
      config: input.config,
      ccSwitch,
      routeMap: routeMapState.config,
      routes: visibleRoutes,
      requestedRoute: input.requestedRoute,
    });
    const writeSelection = selectSubagentRoute({
      config: input.config,
      ccSwitch,
      routeMap: routeMapState.config,
      routes: visibleRoutes,
      access: 'workspace-write',
    });
    return {
      ...base,
      ...(brokerRuntime ? { brokerConfigPath: brokerRuntime.brokerConfigPath } : {}),
      ...(brokerRuntime?.webSearch
        ? {
            webSearch: brokerRuntime.webSearch,
          }
        : {}),
      launchCommand: basename(launch.command),
      ...(backend.serverVersion ? { packageVersion: backend.serverVersion } : {}),
      progress: backend.progressEventsEnabled
        ? { mode: 'events-v1', tool: 'read_agent_events' }
        : { mode: 'heartbeat-only' },
      toolContract: 'compatible',
      mcpStart: 'started',
      mcp: { status: 'available' },
      modelTools: {
        ...base.modelTools,
        brokerWired: configuredForNewThreads &&
          Boolean(marker) &&
          structuredRuntime.liveIdentifiedAppServerHosts > 0 &&
          Boolean(selection.route),
      },
      selectedRoute: {
        id: selection.route?.id ?? null,
        ...(input.requestedRoute
          ? { source: 'explicit' as const }
          : selection.route
            ? {
                source: selection.route.source === 'cc-switch'
                  ? 'cc-switch' as const
                  : routeSelectionSource(input.config, ccSwitch, routeMapState.config),
              }
            : {}),
        ...(selection.error ? { error: redactSecrets(selection.error) } : {}),
      },
      selectedWriteRoute: {
        id: writeSelection.route?.id ?? null,
        ...(writeSelection.route
          ? {
              source: writeSelection.route.source === 'cc-switch'
                ? 'cc-switch' as const
                : routeSelectionSource(input.config, ccSwitch, routeMapState.config, 'workspace-write'),
            }
          : {}),
        ...(writeSelection.error ? { error: redactSecrets(writeSelection.error) } : {}),
      },
      readRoutes: visibleRoutes.map(route => ({
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
      writeRoutes: visibleRoutes
        .filter(route => route.maxAccess === 'workspace-write')
        .map(route => ({
          id: route.id,
          provider: route.provider,
          model: route.model,
          access: 'workspace-write' as const,
          available: route.available,
          notice: '可用于 /btw --write；必须由用户针对具体任务和 workspace 逐次授权',
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
      modelTools: {
        ...base.modelTools,
        degradedReason: redactSecrets(error instanceof Error ? error.message : String(error)),
      },
    };
  } finally {
    await backend.closeBackend?.().catch(() => {});
  }
}

function describeCredentialState(
  config: SubagentConfig,
  env: NodeJS.ProcessEnv,
  provider?: CcSwitchProviderSummary,
): SubagentDiagnostics['credentials'] {
  if (config.routeMode === 'follow-cc-switch' && provider) {
    return {
      mode: 'cc-switch-auto',
      status: provider.credential.status,
      providerReference: provider.id,
      missingEnvironment: provider.credential.status === 'present'
        ? []
        : [...(provider.envKey ? [provider.envKey] : []), ...Object.values(provider.envHttpHeaders)],
      ...(provider.credential.sourcePath
        ? { sourcePath: provider.credential.sourcePath }
        : {}),
      ...(provider.credential.fingerprint
        ? { fingerprint: provider.credential.fingerprint }
        : {}),
    };
  }
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
    ? map?.providers[config.ccSwitchProviderId ?? ccSwitch.currentProviderCodex ?? '']?.writeRoute
    : map?.providers[config.ccSwitchProviderId ?? ccSwitch.currentProviderCodex ?? '']?.readRoute;
  if ((config.ccSwitchProviderId ?? ccSwitch.currentProviderCodex) && mapped) {
    return 'cc-switch';
  }
  return 'default';
}

async function inspectStructuredRuntime(
  stateDir: string | undefined,
  _namespace: string,
): Promise<{
  brokerThreadMarkers: SubagentDiagnostics['runtime']['brokerThreadMarkers'];
  appServerHosts: number;
  liveAppServerHosts: number;
  liveIdentifiedAppServerHosts: number;
}> {
  if (!stateDir) {
    return {
      brokerThreadMarkers: [],
      appServerHosts: 0,
      liveAppServerHosts: 0,
      liveIdentifiedAppServerHosts: 0,
    };
  }
  let markers: SubagentDiagnostics['runtime']['brokerThreadMarkers'] = [];
  try {
    const parsed: unknown = JSON.parse(await readFile(join(stateDir, 'broker-threads.json'), 'utf8'));
    if (isRecord(parsed) && parsed.version === 1 && isRecord(parsed.threads)) {
      markers = Object.entries(parsed.threads).flatMap(([threadId, value]) => {
        if (!isRecord(value)) return [];
        const namespace = stringValue(value.namespace);
        const version = typeof value.version === 'number' ? value.version : 0;
        const createdAt = typeof value.createdAt === 'number' ? value.createdAt : 0;
        return namespace
          ? [{ threadId, namespace, version, createdAt }]
          : [];
      });
    }
  } catch {
    // No marker file means no runtime binding, not a configuration reset.
  }
  const hosts = await readHostRegistry(dirname(stateDir));
  return {
    brokerThreadMarkers: markers,
    appServerHosts: hosts.length,
    liveAppServerHosts: hosts.filter(host => processAlive(host.pid)).length,
    liveIdentifiedAppServerHosts: hosts.filter(host =>
      processAlive(host.pid) && Boolean(host.runtimeIdentity)
    ).length,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

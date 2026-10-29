import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { DEFAULT_SUBAGENT_CONFIG } from '../../config/profile-schema';
import { resolveAppPaths } from '../../config/app-paths';
import { loadRootConfig } from '../../config/profile-store';
import { resolveSubagents } from '../../agent/subagents/registry';
import {
  formatSettings,
  loadSettingsSnapshot,
  type SettingsOptions,
  type SettingsSnapshot,
} from './settings';

export interface DoctorOptions extends SettingsOptions {}
export interface DoctorOptionsWithProbe extends DoctorOptions {
  probeRoute?: string;
}

export interface DoctorReport {
  version: 1;
  status: 'ok' | 'degraded' | 'error';
  profile: string;
  ccSwitchProvider: string | null;
  ccSwitchProviderDetails:
    NonNullable<SettingsSnapshot['subagents']['diagnostics']['ccSwitch']['provider']> | null;
  mainProvider: SettingsSnapshot['mainProvider'];
  mixagents: {
    configuredMode: string;
    mcpStatus: string;
    packageVersion: string | null;
    launchConfigured: boolean;
    launchCompatibility: SettingsSnapshot['subagents']['diagnostics']['launchCompatibility'];
    mcpStart: string;
    toolContract: string;
    credentials: {
      mode: string;
      status: string;
      providerReference: string | null;
      missingEnvironment: string[];
    };
    routeGeneration: 'not-tested';
    routeConfigPath: string;
    brokerConfigPath: string;
    selectedRoute: string | null;
    selectedWriteRoute: string | null;
    readRoutes: Array<{
      id: string;
      provider: string;
      model: string;
      available: boolean;
      missingEnvironment: string[];
    }>;
    modelTools: SettingsSnapshot['subagents']['diagnostics']['modelTools'];
    limits: SettingsSnapshot['subagents']['diagnostics']['limits'];
    webSearch: SettingsSnapshot['subagents']['diagnostics']['webSearch'];
  };
  nativeCollaboration: {
    brokerShadowConfigured: boolean;
    nativeBypassPossible: boolean;
    trustedBrokerInterceptionHook: 'not-installed-or-unverified';
    hookCanBlockOrRewrite: boolean;
    hookCanReplaceTool: false;
    brokerDynamicToolsAvailableOnNewThreads: boolean;
    existingThreadsWithoutMarker: 'fail-closed';
    directCodexTuiCoverage: 'requires-trusted-hook';
  };
  runtimeBinding: SettingsSnapshot['subagents']['diagnostics']['runtime'] & {
    configuredForNewThreads: boolean;
    match: 'bound' | 'not-bound' | 'stale-hosts' | 'no-marker';
  };
  workerRuntime: {
    startupVerification: 'not-run-by-default';
    command: string;
  };
  rsiFeedbackLoop: {
    configured: boolean;
    maxRepairRounds: number;
    repairTimeoutMs: number;
    reviewerRequired: true;
  };
  rsi: SettingsSnapshot['rsi']['status'];
  probe?: {
    requestedRoute: string;
    status: 'pass' | 'fail';
    route?: string;
    provider?: string;
    model?: string;
    access: 'read-only';
    outputHash?: string;
    error?: string;
    errorClass?: 'auth' | 'balance' | 'rate-limit' | 'timeout' | 'unknown' | 'aborted';
    note: 'explicit-paid-request; no fallback or replay';
  };
  checks: Array<{
    id: string;
    status: 'pass' | 'warn' | 'fail';
    message: string;
  }>;
}

export async function runDoctor(options: DoctorOptionsWithProbe = {}): Promise<void> {
  const report = await loadDoctorReport(options);
  if (options.json || !process.stdout.isTTY) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    const snapshot = await loadSettingsSnapshot(options);
    process.stdout.write(`${formatSettings(snapshot)}\n`);
    process.stdout.write(
      `\nDoctor: ${report.status}\n${report.checks
        .map(check => `- [${check.status}] ${check.id}: ${check.message}`)
        .join('\n')}\n`,
    );
  }
  if (report.status === 'error') process.exitCode = 1;
}

export async function loadDoctorReport(options: DoctorOptionsWithProbe = {}): Promise<DoctorReport> {
  const snapshot = await loadSettingsSnapshot(options);
  const diagnostics = snapshot.subagents.diagnostics;
  const explicitBroker = snapshot.subagents.config.mode === 'broker';
  const brokerToolsDisabled =
    !snapshot.subagents.config.enabled ||
    snapshot.subagents.config.mode === 'off' ||
    snapshot.subagents.config.mode === 'fork';
  const checks: DoctorReport['checks'] = [];
  checks.push({
    id: 'profile',
    status: 'pass',
    message: `profile=${snapshot.profile} agentKind=${snapshot.agentKind}`,
  });
  checks.push({
    id: 'broker-model-tools',
    status: brokerToolsDisabled
      ? 'pass'
      : diagnostics.modelTools.brokerWired
        ? 'pass'
        : 'fail',
    message: brokerToolsDisabled
      ? `Broker dynamic tools disabled by subagents.mode=${snapshot.subagents.config.mode}`
      : diagnostics.modelTools.brokerWired
      ? `Broker dynamic tools configured; namespace=${diagnostics.modelTools.namespace}; native=${diagnostics.modelTools.nativeToolPolicy}`
      : diagnostics.modelTools.degradedReason ??
        'configured Broker tools are not bound to any current App Server thread',
  });
  checks.push({
    id: 'native-collaboration',
    status: brokerToolsDisabled || diagnostics.modelTools.brokerWired ? 'pass' : 'warn',
    message: brokerToolsDisabled
      ? `Bridge Broker orchestration disabled by subagents.mode=${snapshot.subagents.config.mode}`
      : diagnostics.modelTools.brokerWired
        ? 'Bridge-managed new threads disable native collaboration tools; old unmarked threads fail closed'
        : 'native collaboration is preserved and may bypass Broker; encrypted agent_message failures remain possible',
  });
  const providerDetails = diagnostics.ccSwitch.provider;
  checks.push({
    id: 'cc-switch-provider',
    status: providerDetails
      ? providerDetails.credential.status === 'present'
        ? 'pass'
        : providerDetails.credential.status === 'oauth-only'
          ? 'fail'
          : explicitBroker
            ? 'fail'
            : 'warn'
      : snapshot.subagents.config.routeMode === 'follow-cc-switch'
        ? brokerToolsDisabled ? 'pass' : 'fail'
        : diagnostics.mcp.status === 'available'
          ? 'pass'
          : 'warn',
    message: providerDetails
      ? `id=${providerDetails.id} name=${providerDetails.name} model=${providerDetails.model}` +
        ` codexProvider=${providerDetails.codexProviderId}` +
        ` host=${providerDetails.baseUrlHost ?? 'unknown'}` +
        ` wire=${providerDetails.wireApi}` +
        ` key=${providerDetails.credential.status}` +
        ` keyPath=${providerDetails.credential.sourcePath ?? '(none)'}` +
        ` keyFingerprint=${providerDetails.credential.fingerprint ?? '(none)'}`
      : 'cc-switch provider 完整配置尚未解析',
  });
  const markerMatch: DoctorReport['runtimeBinding']['match'] =
    diagnostics.runtime.namespaceBound &&
      diagnostics.runtime.liveIdentifiedAppServerHosts > 0
      ? 'bound'
      : diagnostics.runtime.namespaceBound
        ? 'stale-hosts'
        : diagnostics.runtime.appServerHosts > 0
          ? 'not-bound'
          : 'no-marker';
  checks.push({
    id: 'runtime-binding',
    status: brokerToolsDisabled || markerMatch === 'bound' ? 'pass' : 'fail',
    message: `markers=${diagnostics.runtime.brokerThreadMarkers.length}` +
      ` namespaceBound=${diagnostics.runtime.namespaceBound}` +
      ` hosts=${diagnostics.runtime.appServerHosts}` +
      ` liveHosts=${diagnostics.runtime.liveAppServerHosts}` +
      ` liveIdentifiedHosts=${diagnostics.runtime.liveIdentifiedAppServerHosts}` +
      ` state=${diagnostics.runtime.profileScopedStateDir ?? '(none)'}` +
      ` match=${markerMatch}`,
  });
  checks.push({
    id: 'main-provider',
    status: snapshot.mainProvider.pendingSwitch === 'pending-next-turn' ? 'warn' : 'pass',
    message: `ccSwitch=${snapshot.mainProvider.configuredCcSwitchProviderId ?? 'unknown'} ` +
      `codexProvider=${snapshot.mainProvider.configuredCodexProviderId ?? 'unknown'} ` +
      `running=${snapshot.mainProvider.running.length} switch=${snapshot.mainProvider.pendingSwitch}`,
  });
  checks.push({
    id: 'write-route',
    status: diagnostics.selectedWriteRoute.id && diagnostics.limits.allowWriteWorkers
      ? 'pass'
      : 'warn',
    message: diagnostics.selectedWriteRoute.id
      ? `selected=${diagnostics.selectedWriteRoute.id} explicitTaskWorkspaceAuthorization=${diagnostics.limits.allowWriteWorkers}`
      : diagnostics.limits.allowWriteWorkers
        ? 'workspace-write workers enabled but no write route is wired'
        : 'workspace-write workers disabled by default',
  });
  checks.push(diagnostics.ccSwitch.currentProviderCodex
    ? {
        id: 'cc-switch',
        status: 'pass',
        message: `currentProviderCodex=${diagnostics.ccSwitch.currentProviderCodex}`,
      }
    : {
        id: 'cc-switch',
        status: 'warn',
        message: `未识别当前 Codex provider；settings=${diagnostics.ccSwitch.settingsPath}`,
      });
  if (diagnostics.mcp.status === 'available') {
    checks.push({
      id: 'mixagents-mcp',
      status: 'pass',
      message: `六工具 MCP 契约可用，serverVersion=${diagnostics.packageVersion ?? 'unknown'}`,
    });
  } else if (!snapshot.subagents.config.enabled || snapshot.subagents.config.mode === 'fork') {
    checks.push({
      id: 'mixagents-mcp',
      status: explicitBroker ? 'fail' : 'warn',
      message: `MixAgents 未启用（mode=${snapshot.subagents.config.mode}）`,
    });
  } else {
    checks.push({
      id: 'mixagents-mcp',
      status: explicitBroker ? 'fail' : 'warn',
      message: diagnostics.mcp.error ?? `MixAgents MCP ${diagnostics.mcp.status}`,
    });
  }
  checks.push({
    id: 'credential-delegation',
    status: diagnostics.credentials.status === 'present'
      ? 'pass'
      : diagnostics.credentials.status === 'delegated-unverified'
        ? 'warn'
        : diagnostics.credentials.mode === 'mixagents-managed'
          ? 'fail'
          : snapshot.subagents.config.routeMode === 'follow-cc-switch'
            ? 'fail'
            : 'warn',
    message: diagnostics.credentials.mode === 'mixagents-managed'
      ? `MixAgents managed；bridge 只传 providerRef=${diagnostics.credentials.providerReference ?? '(missing)'}`
      : diagnostics.credentials.mode === 'cc-switch-auto'
        ? `cc-switch auto；provider=${diagnostics.credentials.providerReference ?? '(unknown)'}` +
          ` source=${diagnostics.credentials.sourcePath ?? '(unknown)'}` +
          ` fingerprint=${diagnostics.credentials.fingerprint ?? '(none)'}` +
          ` missing=${diagnostics.credentials.missingEnvironment.join(',') || 'none'}`
        : `inherit-env；present/missing only: ${
            diagnostics.credentials.missingEnvironment.join(',') || 'none missing'
          }`,
  });
  checks.push({
    id: 'mixagents-launch-compatibility',
    status: diagnostics.launchCompatibility.vendor === 'missing'
      ? 'fail'
      : diagnostics.launchCompatibility.legacyNpm === 'missing' &&
          diagnostics.launchCompatibility.legacyNpmRuntime === 'supported'
        ? 'warn'
        : 'pass',
    message:
      `vendor=${diagnostics.launchCompatibility.vendor} ` +
      `legacyNpm=${diagnostics.launchCompatibility.legacyNpm} ` +
      `legacyNpmRuntime=${diagnostics.launchCompatibility.legacyNpmRuntime}` +
      (diagnostics.launchCompatibility.legacyNpm === 'missing'
        ? diagnostics.launchCompatibility.legacyNpmRuntime === 'supported'
          ? '；新进程可用，但升级前仍在运行且依赖旧 node_modules 路径的进程需要重启'
          : '；当前 Node 版本低于旧 npm Broker 要求的 22.19，npm 已按 engine 正确跳过该可选依赖；新进程仍使用 vendored Broker'
        : ''),
  });
  checks.push({
    id: 'web-search',
    status: diagnostics.webSearch.mode === 'native' &&
        diagnostics.webSearch.providerSupported !== true
      ? 'warn'
      : 'pass',
    message: `mode=${diagnostics.webSearch.mode}` +
      ` providerSupported=${diagnostics.webSearch.providerSupported ?? 'unknown'}` +
      ` effective=${diagnostics.webSearch.effective}` +
      ` reason=${diagnostics.webSearch.reason}`,
  });
  checks.push({
    id: 'rsi-feedback-loop',
    status: snapshot.rsi.config.mode === 'off'
      ? 'pass'
      : snapshot.rsi.config.maxRepairRounds > 0
        ? 'pass'
        : 'warn',
    message: snapshot.rsi.config.mode === 'off'
      ? 'disabled'
      : `maxRepairRounds=${snapshot.rsi.config.maxRepairRounds} timeoutMs=${snapshot.rsi.config.repairTimeoutMs}; reviewer is required for a pass`,
  });
  checks.push({
    id: 'worker-startup',
    status: 'warn',
    message: options.probeRoute
      ? 'explicit route probe covers worker startup; ordinary doctor remains non-paid'
      : 'not-run-by-default; use explicit `doctor --probe-route <id>` or E2E test',
  });
  checks.push({
    id: 'route-generation',
    status: diagnostics.selectedRoute.id ? 'pass' : 'warn',
    message: diagnostics.selectedRoute.id
      ? 'route 已在离线阶段解析；doctor 不会产生付费请求，真实生成需显式 probe'
      : 'route 尚未解析；doctor 不会产生付费请求，真实生成需显式 `doctor --probe-route <id>`',
  });
  if (diagnostics.routeMap.error) {
    checks.push({
      id: 'broker-routes',
      status: explicitBroker ? 'fail' : 'warn',
      message: diagnostics.routeMap.error,
    });
  } else {
    checks.push({
      id: 'broker-routes',
      status: diagnostics.routeMap.loaded ||
        snapshot.subagents.config.routeMode === 'follow-cc-switch'
        ? 'pass'
        : 'warn',
      message: diagnostics.routeMap.loaded
        ? `route map loaded: ${diagnostics.routeMap.path}`
        : snapshot.subagents.config.routeMode === 'follow-cc-switch'
          ? 'auto 模式使用 cc-switch 自动生成 route；broker-routes.json 不需要手工创建'
          : `route map 尚未创建：${diagnostics.routeMap.path}`,
    });
  }
  checks.push({
    id: 'read-route',
    status: diagnostics.selectedRoute.id
      ? 'pass'
      : brokerToolsDisabled
        ? 'pass'
      : explicitBroker ||
          snapshot.subagents.config.routeMode === 'manual' ||
          snapshot.subagents.config.routeMode === 'follow-cc-switch'
        ? 'fail'
        : 'warn',
    message: diagnostics.selectedRoute.id
      ? `selected=${diagnostics.selectedRoute.id} source=${diagnostics.selectedRoute.source ?? 'unknown'}`
      : diagnostics.selectedRoute.error ??
        '没有选中 read route；请检查当前 cc-switch provider 的 Broker 配置和凭据',
  });
  const unavailableRead = diagnostics.readRoutes.filter(route => !route.available);
  for (const route of unavailableRead) {
    checks.push({
      id: `route:${route.id}`,
      status: 'warn',
      message: `route 不可用；missing env names=${
        route.missingEnvironment.join(',') || '(not reported)'
      }`,
    });
  }
  checks.push({
    id: 'rsi',
    status: snapshot.rsi.config.mode === 'off'
      ? 'pass'
      : snapshot.rsi.status.error
        ? 'fail'
        : !snapshot.rsi.status.initialized
          ? 'warn'
          : snapshot.rsi.status.validator === 'missing' &&
              snapshot.rsi.status.runner === 'missing'
            ? 'fail'
            : snapshot.rsi.status.validator !== 'available'
              ? 'warn'
              : 'pass',
    message: snapshot.rsi.status.error
      ?? (snapshot.rsi.status.initialized
        ? `initialized root=${snapshot.rsi.status.projectRoot} runner=${snapshot.rsi.status.runner} ` +
          `validator=${snapshot.rsi.status.validator}`
        : snapshot.rsi.config.mode === 'off'
          ? 'disabled'
          : '未发现已初始化项目；不会自动 init'),
  });
  let probe: DoctorReport['probe'];
  if (options.probeRoute) {
    probe = await probeSubagentRoute(options, options.probeRoute);
    const probeCheck = {
      id: 'route-generation',
      status: probe.status === 'pass' ? 'pass' as const : 'fail' as const,
      message: probe.status === 'pass'
        ? `explicit probe route=${probe.route} provider=${probe.provider} model=${probe.model} access=read-only`
        : `explicit probe failed (${probe.errorClass ?? 'unknown'}): ${probe.error}`,
    };
    const index = checks.findIndex(check => check.id === 'route-generation');
    if (index >= 0) checks[index] = probeCheck;
    else checks.push(probeCheck);
    if (probe.status === 'pass' && diagnostics.credentials.status === 'delegated-unverified') {
      const credentialIndex = checks.findIndex(check => check.id === 'credential-delegation');
      if (credentialIndex >= 0) {
        checks[credentialIndex] = {
          id: 'credential-delegation',
          status: 'pass',
          message: `MixAgents managed credential reference resolved successfully in explicit probe ` +
            `(providerRef=${diagnostics.credentials.providerReference ?? 'missing'})`,
        };
      }
    }
  }
  const hasFail = checks.some(check => check.status === 'fail');
  const hasWarn = checks.some(check => check.status === 'warn');
  return {
    version: 1,
    status: hasFail ? 'error' : hasWarn ? 'degraded' : 'ok',
    profile: snapshot.profile,
    ccSwitchProvider: snapshot.ccSwitch.currentProviderCodex,
    ccSwitchProviderDetails: diagnostics.ccSwitch.provider ?? null,
    mainProvider: snapshot.mainProvider,
    mixagents: {
      configuredMode: snapshot.subagents.config.mode,
      mcpStatus: diagnostics.mcp.status,
      packageVersion: diagnostics.packageVersion ?? null,
      launchConfigured: diagnostics.launchConfigured,
      launchCompatibility: diagnostics.launchCompatibility,
      mcpStart: diagnostics.mcpStart,
      toolContract: diagnostics.toolContract,
      credentials: diagnostics.credentials,
      routeGeneration: diagnostics.routeGeneration,
      routeConfigPath: diagnostics.routeMap.path,
      brokerConfigPath: diagnostics.brokerConfigPath,
      selectedRoute: diagnostics.selectedRoute.id,
      selectedWriteRoute: diagnostics.selectedWriteRoute.id,
      readRoutes: diagnostics.readRoutes.map(route => ({
        id: route.id,
        provider: route.provider,
        model: route.model,
        available: route.available,
        missingEnvironment: route.missingEnvironment,
      })),
      modelTools: diagnostics.modelTools,
      limits: diagnostics.limits,
      webSearch: diagnostics.webSearch,
    },
    nativeCollaboration: {
      brokerShadowConfigured:
        diagnostics.modelTools.configured &&
        diagnostics.modelTools.nativeToolPolicy === 'shadow',
      nativeBypassPossible: !diagnostics.modelTools.brokerWired,
      trustedBrokerInterceptionHook: 'not-installed-or-unverified',
      hookCanBlockOrRewrite: diagnostics.modelTools.brokerWired,
      hookCanReplaceTool: false,
      brokerDynamicToolsAvailableOnNewThreads: diagnostics.modelTools.brokerWired,
      existingThreadsWithoutMarker: 'fail-closed',
      directCodexTuiCoverage: 'requires-trusted-hook',
    },
    runtimeBinding: {
      ...diagnostics.runtime,
      configuredForNewThreads: diagnostics.modelTools.configuredForNewThreads,
      match: markerMatch,
    },
    workerRuntime: {
      startupVerification: 'not-run-by-default',
      command: `arg-bridge doctor --profile ${snapshot.profile} --json --probe-route <read-route>`,
    },
    rsiFeedbackLoop: {
      configured: snapshot.rsi.config.mode !== 'off' && snapshot.rsi.config.maxRepairRounds > 0,
      maxRepairRounds: snapshot.rsi.config.maxRepairRounds,
      repairTimeoutMs: snapshot.rsi.config.repairTimeoutMs,
      reviewerRequired: true,
    },
    rsi: snapshot.rsi.status,
    ...(probe ? { probe } : {}),
    checks,
  };
}

async function probeSubagentRoute(
  options: DoctorOptionsWithProbe,
  requestedRoute: string,
): Promise<NonNullable<DoctorReport['probe']>> {
  const env = options.env ?? process.env;
  const paths = resolveAppPaths({
    rootDir: env.LARK_CHANNEL_HOME,
    profile: options.profile,
  });
  const root = await loadRootConfig(paths.configFile);
  const profileName = options.profile ?? root?.activeProfile;
  const profile = profileName ? root?.profiles[profileName] : undefined;
  if (!root || !profile || !profileName) {
    return {
      requestedRoute,
      status: 'fail',
      access: 'read-only',
      error: `profile 不存在：${profileName ?? '(active-profile)'}`,
      errorClass: 'unknown',
      note: 'explicit-paid-request; no fallback or replay',
    };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 180_000);
  timer.unref?.();
  let backend: Awaited<ReturnType<typeof resolveSubagents>>['backend'];
  try {
    const resolved = await resolveSubagents({
      subagents: {
        ...(profile.subagents ?? DEFAULT_SUBAGENT_CONFIG),
        enabled: true,
        mode: 'broker',
        allowForkFallback: false,
      },
      env,
      cwd: options.cwd ?? profile.workspaces.default ?? process.cwd(),
      stateDir: join(paths.profileDir, 'structured'),
      codexBin: profile.codex?.binaryPath ?? 'codex',
      ...(profile.codex?.codexHome
        ? { codexHome: profile.codex.codexHome }
        : profile.codex?.inheritCodexHome === false
          ? { codexHome: join(paths.profileDir, 'codex-home') }
          : {}),
      requestedRoute,
      signal: controller.signal,
    });
    backend = resolved.backend;
    if (resolved.kind !== 'mixagents' || !backend || !resolved.route) {
      throw new Error('显式 probe 没有解析到 MixAgents route；不会降级或重放');
    }
    const agent = await backend.createOrReuse({
      route: resolved.route,
      task: 'Reply exactly ARG_BRIDGE_SUBAGENT_PROBE_OK. Do not use tools and do not modify files.',
      cwd: options.cwd ?? profile.workspaces.default ?? process.cwd(),
      scope: `doctor-probe:${requestedRoute}`,
      access: 'read-only',
      signal: controller.signal,
    });
    try {
      const result = await backend.wait(agent, controller.signal);
      if (result.status !== 'completed') {
        throw new Error(result.error ?? `probe status=${result.status}`);
      }
      return {
        requestedRoute,
        status: 'pass',
        route: resolved.route.id,
        provider: resolved.route.provider,
        model: resolved.route.model,
        access: 'read-only',
        ...(result.text
          ? { outputHash: createHash('sha256').update(result.text).digest('hex') }
          : {}),
        note: 'explicit-paid-request; no fallback or replay',
      };
    } finally {
      await backend.close(agent, controller.signal).catch(() => {});
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      requestedRoute,
      status: 'fail',
      access: 'read-only',
      error: message,
      errorClass: classifyProbeError(message, controller.signal.aborted),
      note: 'explicit-paid-request; no fallback or replay',
    };
  } finally {
    clearTimeout(timer);
    await backend?.closeBackend?.().catch(() => {});
  }
}

function classifyProbeError(
  message: string,
  aborted: boolean,
): NonNullable<DoctorReport['probe']>['errorClass'] {
  if (aborted || /abort|timed out|timeout/i.test(message)) return 'timeout';
  if (/\b401\b|unauthori[sz]ed|invalid api key/i.test(message)) return 'auth';
  if (/\b402\b|insufficient balance|quota/i.test(message)) return 'balance';
  if (/\b429\b|rate limit|too many requests/i.test(message)) return 'rate-limit';
  return 'unknown';
}

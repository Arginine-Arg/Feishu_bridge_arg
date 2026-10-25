import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, parse, resolve } from 'node:path';
import * as p from '@clack/prompts';
import {
  collectSubagentDiagnostics,
  type SubagentDiagnostics,
} from '../../agent/subagents/diagnostics';
import {
  DEFAULT_RSI_CONFIG,
  DEFAULT_SUBAGENT_CONFIG,
  type RsiConfig,
  type SubagentConfig,
  type SubagentMode,
  type SubagentRouteMode,
} from '../../config/profile-schema';
import { resolveAppPaths } from '../../config/app-paths';
import {
  loadRootConfig,
  saveRootConfig,
  withConfigFileLock,
} from '../../config/profile-store';
import { discoverProjectRsi, projectRsiStatus } from '../../integrations/project-rsi';
import {
  resolveCodexActiveConfigIdentity,
  type CodexActiveConfigIdentity,
} from '../../agent/codex/provider';
import { defaultCodexHome } from '../../agent/codex/credentials';
import {
  processAlive,
  readHostRegistry,
  type CodexHostRuntimeIdentity,
} from '../../agent/structured/host-registry';

export interface SettingsOptions {
  profile?: string;
  json?: boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface SettingsSnapshot {
  version: 1;
  profile: string;
  agentKind: 'codex' | 'claude';
  workspace: string;
  ccSwitch: SubagentDiagnostics['ccSwitch'];
  mainProvider: {
    configuredCcSwitchProviderId: string | null;
    configuredCodexProviderId: string | null;
    configuredModel: string | null;
    running: CodexHostRuntimeIdentity[];
    runningUnknown: number;
    pendingSwitch: 'in-sync' | 'pending-next-turn' | 'not-running' | 'unknown';
    safeSwitchPoint: 'next-idle-turn-or-profile-restart';
  };
  subagents: {
    config: SubagentConfig;
    diagnostics: SubagentDiagnostics;
  };
  rsi: {
    config: RsiConfig;
    status: Awaited<ReturnType<typeof projectRsiStatus>>;
  };
  nextCommands: string[];
}

/**
 * Read every value at invocation time. This command is safe for old sessions:
 * it only edits the profile file and the next `/btw` re-reads it.
 */
export async function runSettings(options: SettingsOptions = {}): Promise<void> {
  const snapshot = await loadSettingsSnapshot(options);
  if (options.json || !process.stdin.isTTY || !process.stdout.isTTY) {
    process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
    return;
  }
  p.intro(`arg-bridge settings · profile=${snapshot.profile}`);
  p.note(formatSnapshot(snapshot), '当前状态');
  const settingsEnv = options.env ?? process.env;
  const paths = resolveAppPaths({
    rootDir: settingsEnv.LARK_CHANNEL_HOME,
    profile: snapshot.profile,
  });
  const rawRoot = await loadRootConfig(paths.configFile);
  const rawProfile = rawRoot?.profiles[snapshot.profile];
  if (!rawRoot || !rawProfile) throw new Error(`profile 不存在：${snapshot.profile}`);
  const selectedMode = await p.select<SubagentMode>({
    message: '子代理 /btw 模式',
    initialValue: snapshot.subagents.config.mode,
    options: [
      { value: 'auto', label: 'auto', hint: '优先 MixAgents；不可用时按设置 fork' },
      { value: 'broker', label: 'broker', hint: '必须使用 MixAgents，失败时明确报错' },
      { value: 'fork', label: 'fork', hint: '沿用 Codex thread/fork，兼容降级' },
      { value: 'off', label: 'off', hint: '禁用 /btw 子代理' },
    ],
  });
  assertPrompt(selectedMode);
  const routeMode = await p.select<SubagentRouteMode>({
    message: 'MixAgents read route 选择方式',
    initialValue: snapshot.subagents.config.routeMode,
    options: [
      { value: 'follow-cc-switch', label: 'follow-cc-switch', hint: '每次 /btw 重新读取 cc-switch' },
      { value: 'manual', label: 'manual', hint: '固定使用一个 Broker route' },
    ],
  });
  assertPrompt(routeMode);
  let readRoute = snapshot.subagents.config.readRoute;
  if (routeMode === 'manual') {
    const routeOptions = snapshot.subagents.diagnostics.readRoutes
      .filter(route => route.available)
      .map(route => ({
        value: route.id,
        label: `${route.id} · ${route.provider}/${route.model}`,
        hint: route.maxAccess,
      }));
    if (routeOptions.length === 0) {
      const entered = await p.text({
        message: '没有发现可用 route。输入 route id（留空保持当前值）',
        initialValue: readRoute ?? '',
        placeholder: 'route-id',
      });
      assertPrompt(entered);
      readRoute = entered.trim() || null;
    } else {
      const selected = await p.select<string>({
        message: '固定 read route',
        initialValue: readRoute && routeOptions.some(route => route.value === readRoute)
          ? readRoute
          : routeOptions[0]!.value,
        options: routeOptions,
      });
      assertPrompt(selected);
      readRoute = selected;
    }
  }
  const allowForkFallback = await p.confirm({
    message: 'auto 模式下，MixAgents 不可用时允许降级到 Codex fork？',
    initialValue: snapshot.subagents.config.allowForkFallback,
  });
  assertPrompt(allowForkFallback);
  const includeProgressSnapshot = await p.confirm({
    message: '/btw 是否携带最多 2400 字符、已脱敏的主任务进度快照？',
    initialValue: snapshot.subagents.config.includeProgressSnapshot,
  });
  assertPrompt(includeProgressSnapshot);

  const currentMcp = rawProfile.subagents?.mixagents;
  const mcpCommand = await p.text({
    message: 'MixAgents MCP executable（留空保持当前值；不得把 token 写入参数）',
    initialValue: currentMcp?.mcpCommand ?? '',
    placeholder: 'mixagents-broker',
  });
  assertPrompt(mcpCommand);
  const mcpArgsText = await p.text({
    message: '替换 MCP 参数 JSON 数组（留空保持现值且不回显；输入 [] 清空）',
    initialValue: '',
    placeholder: '留空保持',
  });
  assertPrompt(mcpArgsText);
  const mcpArgs = mcpArgsText.trim()
    ? parseStringArray(mcpArgsText, 'MCP 参数')
    : (currentMcp?.mcpArgs ?? []);
  const credentialMode = await p.select<'inherit-env' | 'mixagents-managed'>({
    message: 'Broker 凭据由谁解析？',
    initialValue: currentMcp?.credentialMode ?? 'inherit-env',
    options: [
      {
        value: 'mixagents-managed',
        label: 'MixAgents managed',
        hint: 'Bridge 只传 provider 引用；由 MixAgents/可信 helper 读取 cc-switch 凭据',
      },
      {
        value: 'inherit-env',
        label: 'inherit-env',
        hint: 'MCP 服务从已安全注入的父进程环境读取；Bridge 只检查变量名',
      },
    ],
  });
  assertPrompt(credentialMode);
  const credentialProvider = await p.text({
    message: 'managed 模式的 opaque provider 引用（inherit-env 可留空）',
    initialValue: currentMcp?.credentialProvider
      ?? snapshot.ccSwitch.currentProviderCodex
      ?? '',
    placeholder: 'cc-switch-provider-id',
  });
  assertPrompt(credentialProvider);
  if (
    credentialProvider.trim() &&
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(credentialProvider.trim())
  ) {
    throw new Error('credential provider 必须是 opaque ID，不得包含 URL、空白或凭据材料');
  }
  const credentialEnvKeys = await p.text({
    message: 'MCP 所需环境变量名，逗号分隔（只保存名称）',
    initialValue: (currentMcp?.credentialEnvKeys ?? []).join(', '),
    placeholder: 'MIXAGENTS_BROKER_CREDENTIALS_JSON',
  });
  assertPrompt(credentialEnvKeys);

  const rsiMode = await p.select<RsiConfig['mode']>({
    message: 'Project RSI 完成门禁',
    initialValue: snapshot.rsi.config.mode,
    options: [
      { value: 'auto', label: 'auto', hint: '持久修改/高影响结论必须有 fresh receipt' },
      { value: 'off', label: 'off', hint: '关闭 bridge 侧门禁；项目 hook 不受影响' },
    ],
  });
  assertPrompt(rsiMode);
  const projectRootText = await p.text({
    message: 'Project RSI 项目 canonical root（留空自动向上发现；不会自动 init）',
    initialValue: snapshot.rsi.config.projectRoot ?? '',
    placeholder: '/absolute/project/root',
  });
  assertPrompt(projectRootText);
  const projectRoot = projectRootText.trim()
    ? await validatedRsiRoot(projectRootText.trim())
    : null;
  const reviewerRouteMode = await p.select<SubagentRouteMode>({
    message: 'RSI reviewer route 选择方式',
    initialValue: snapshot.rsi.config.reviewerRouteMode,
    options: [
      { value: 'follow-cc-switch', label: 'follow-cc-switch' },
      { value: 'manual', label: 'manual' },
    ],
  });
  assertPrompt(reviewerRouteMode);
  let reviewerRoute = snapshot.rsi.config.reviewerRoute;
  if (reviewerRouteMode === 'manual' && snapshot.subagents.diagnostics.readRoutes.length > 0) {
    const selected = await p.select<string>({
      message: 'RSI reviewer read route',
      initialValue: reviewerRoute ?? snapshot.subagents.diagnostics.readRoutes[0]!.id,
      options: snapshot.subagents.diagnostics.readRoutes.map(route => ({
        value: route.id,
        label: `${route.id} · ${route.provider}/${route.model}`,
        hint: route.available ? 'read-only' : 'unavailable',
      })),
    });
    assertPrompt(selected);
    reviewerRoute = selected;
  }

  const save = await p.confirm({
    message: '保存到当前 profile？下一条 /btw 会立即使用新设置，无需重建旧会话。',
    initialValue: true,
  });
  assertPrompt(save);
  if (!save) {
    p.outro('未修改 profile。');
    return;
  }
  await withConfigFileLock(paths.configFile, async () => {
    const root = await loadRootConfig(paths.configFile);
    if (!root) throw new Error(`配置不存在：${paths.configFile}`);
    const profile = root.profiles[snapshot.profile];
    if (!profile) throw new Error(`profile 不存在：${snapshot.profile}`);
    const normalizedKeys = credentialEnvKeys
      .split(',')
      .map(value => value.trim())
      .filter(Boolean);
    const nextMcp = (mcpCommand.trim() || currentMcp?.mcpCommand)
      ? {
          ...currentMcp,
          mcpCommand: mcpCommand.trim() || currentMcp!.mcpCommand!,
          ...(mcpArgs.length > 0 ? { mcpArgs } : { mcpArgs: undefined }),
          credentialMode,
          ...(credentialProvider.trim()
            ? { credentialProvider: credentialProvider.trim() }
            : { credentialProvider: undefined }),
          ...(normalizedKeys.length > 0
            ? { credentialEnvKeys: normalizedKeys }
            : { credentialEnvKeys: undefined }),
        }
      : undefined;
    root.profiles[snapshot.profile] = {
      ...profile,
      subagents: {
        ...DEFAULT_SUBAGENT_CONFIG,
        ...profile.subagents,
        enabled: selectedMode !== 'off',
        mode: selectedMode,
        routeMode,
        readRoute,
        allowForkFallback,
        includeProgressSnapshot,
        ...(nextMcp ? { mixagents: nextMcp } : {}),
      },
      rsi: {
        ...DEFAULT_RSI_CONFIG,
        ...profile.rsi,
        mode: rsiMode,
        projectRoot,
        reviewerRouteMode,
        reviewerRoute,
      },
    };
    await saveRootConfig(root, paths.configFile);
  });
  p.outro('已保存。下一条 /btw 会重新解析 cc-switch、Broker routes 和本设置。');
}

export async function loadSettingsSnapshot(
  options: SettingsOptions = {},
): Promise<SettingsSnapshot> {
  const env = options.env ?? process.env;
  const paths = resolveAppPaths({
    rootDir: env.LARK_CHANNEL_HOME,
    profile: options.profile,
  });
  const root = await loadRootConfig(paths.configFile);
  if (!root) throw new Error(`配置不存在：${paths.configFile}`);
  const profileName = options.profile ?? root.activeProfile;
  const profile = root.profiles[profileName];
  if (!profile) throw new Error(`profile 不存在：${profileName}`);
  const cwd = resolve(options.cwd ?? profile.workspaces.default ?? process.cwd());
  const subagentConfig = profile.subagents ?? DEFAULT_SUBAGENT_CONFIG;
  const rsiConfig = profile.rsi ?? DEFAULT_RSI_CONFIG;
  const codexHome = profile.codex?.codexHome
    ?? (profile.codex?.inheritCodexHome === false ? `${paths.profileDir}/codex-home` : defaultCodexHome());
  const [diagnostics, rsiStatus, configuredCodexIdentity, hosts] = await Promise.all([
    collectSubagentDiagnostics({
      config: subagentConfig,
      cwd,
      env,
    }),
    projectRsiStatus(rsiConfig, cwd),
    profile.agentKind === 'codex'
      ? resolveCodexActiveConfigIdentity(codexHome)
      : Promise.resolve(undefined),
    profile.agentKind === 'codex'
      ? readHostRegistry(paths.profileDir)
      : Promise.resolve([]),
  ]);
  const running = uniqueRuntimeIdentities(
    hosts
      .filter(host => processAlive(host.pid) && host.runtimeIdentity)
      .map(host => host.runtimeIdentity!),
  );
  const runningUnknown = hosts.filter(host => processAlive(host.pid) && !host.runtimeIdentity).length;
  const configuredCcSwitchProviderId = diagnostics.ccSwitch.currentProviderCodex;
  const pendingSwitch = providerSwitchState(
    running,
    configuredCcSwitchProviderId,
    configuredCodexIdentity,
    runningUnknown,
  );
  const safeSubagentConfig: SubagentConfig = {
    ...subagentConfig,
    ...(subagentConfig.mixagents
      ? {
          mixagents: {
            ...(subagentConfig.mixagents.mcpCommand
              ? { mcpCommand: subagentConfig.mixagents.mcpCommand }
              : {}),
            ...(subagentConfig.mixagents.mcpCwd
              ? { mcpCwd: subagentConfig.mixagents.mcpCwd }
              : {}),
            ...(subagentConfig.mixagents.credentialEnvKeys
              ? { credentialEnvKeys: subagentConfig.mixagents.credentialEnvKeys }
              : {}),
            ...(subagentConfig.mixagents.credentialMode
              ? { credentialMode: subagentConfig.mixagents.credentialMode }
              : {}),
            ...(subagentConfig.mixagents.credentialProvider
              ? { credentialProvider: subagentConfig.mixagents.credentialProvider }
              : {}),
          },
        }
      : {}),
  };
  return {
    version: 1,
    profile: profileName,
    agentKind: profile.agentKind,
    workspace: cwd,
    ccSwitch: diagnostics.ccSwitch,
    mainProvider: {
      configuredCcSwitchProviderId,
      configuredCodexProviderId: configuredCodexIdentity?.codexProviderId ?? null,
      configuredModel: configuredCodexIdentity?.model ?? null,
      running,
      runningUnknown,
      pendingSwitch,
      safeSwitchPoint: 'next-idle-turn-or-profile-restart',
    },
    subagents: {
      config: safeSubagentConfig,
      diagnostics,
    },
    rsi: {
      config: rsiConfig,
      status: rsiStatus,
    },
    nextCommands: [
      `arg-bridge settings --profile ${profileName}`,
      'arg-bridge doctor --json',
      `arg-bridge restart --profile ${profileName}`,
      'codex plugin marketplace add Utopia-V/mixagents',
      'codex plugin add mixagents-broker@mixagents',
    ],
  };
}

export function formatSettings(snapshot: SettingsSnapshot): string {
  return formatSnapshot(snapshot);
}

function formatSnapshot(snapshot: SettingsSnapshot): string {
  const diagnostics = snapshot.subagents.diagnostics;
  const provider = snapshot.ccSwitch.currentProviderCodex ?? '(unknown)';
  const routeLines = diagnostics.readRoutes.length > 0
    ? diagnostics.readRoutes.map(route =>
        `- ${route.id}: ${route.provider}/${route.model} access=read-only available=${route.available}` +
        (route.revision ? ` revision=${route.revision}` : '') +
        (route.missingEnvironment.length
          ? ` missing=${route.missingEnvironment.join(',')}`
          : '')
      )
    : ['- (none)'];
  const writeLines = diagnostics.writeRoutes.length > 0
    ? diagnostics.writeRoutes.map(route =>
        `- ${route.id}: ${route.provider}/${route.model} access=workspace-write（不用于 /btw，需逐任务授权）`
      )
    : ['- (none)'];
  return [
    `profile=${snapshot.profile} agentKind=${snapshot.agentKind}`,
    `workspace=${snapshot.workspace}`,
    `cc-switch provider=${provider} name=${snapshot.ccSwitch.currentProviderName ?? '(unknown)'}`,
    `main configured: ccSwitch=${snapshot.mainProvider.configuredCcSwitchProviderId ?? '(unknown)'}` +
      ` codexProvider=${snapshot.mainProvider.configuredCodexProviderId ?? '(unknown)'}` +
      ` model=${snapshot.mainProvider.configuredModel ?? '(config-default)'}`,
    `main running: ${snapshot.mainProvider.running.length > 0
      ? snapshot.mainProvider.running.map(run =>
          `ccSwitch=${run.ccSwitchProviderId ?? '?'} codexProvider=${run.codexProviderId} model=${run.model ?? '?'}`
        ).join(' | ')
      : '(none)'}`,
    `main running with legacy/unknown identity=${snapshot.mainProvider.runningUnknown}`,
    `provider switch=${snapshot.mainProvider.pendingSwitch}; safe point=${snapshot.mainProvider.safeSwitchPoint}`,
    `MixAgents mode=${snapshot.subagents.config.mode} routeMode=${snapshot.subagents.config.routeMode}` +
      ` MCP=${diagnostics.mcp.status} version=${diagnostics.packageVersion ?? '(unknown)'}`,
    `credential mode=${diagnostics.credentials.mode} status=${diagnostics.credentials.status}` +
      ` providerRef=${diagnostics.credentials.providerReference ?? '(none)'}`,
    `selected route=${diagnostics.selectedRoute.id ?? '(none)'}` +
      (diagnostics.selectedRoute.error ? ` error=${diagnostics.selectedRoute.error}` : ''),
    `route config=${diagnostics.routeMap.path}`,
    `MixAgents broker config=${diagnostics.brokerConfigPath}`,
    'read routes:',
    ...routeLines,
    'write routes:',
    ...writeLines,
    `RSI mode=${snapshot.rsi.config.mode} initialized=${snapshot.rsi.status.initialized}` +
      ` root=${snapshot.rsi.status.projectRoot ?? '(auto/new)'}` +
      ` runner=${snapshot.rsi.status.runner} validator=${snapshot.rsi.status.validator}`,
    `RSI latest run=${snapshot.rsi.status.latestRun?.runId ?? '(none)'}` +
      ` validated=${snapshot.rsi.status.latestRun?.validated ?? false}`,
    `RSI gate: bridge=${snapshot.rsi.status.bridgeGate}` +
      ` nativeTerminal=${snapshot.rsi.status.nativeTerminalGate}` +
      ` historicalTaskRsi=${snapshot.rsi.status.historicalTaskRsi}`,
    'next commands:',
    ...snapshot.nextCommands.map(command => `- ${command}`),
  ].join('\n');
}

function parseStringArray(value: string, label: string): string[] {
  if (!value.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${label}必须是 JSON 字符串数组`);
  }
  if (!Array.isArray(parsed) || parsed.some(item => typeof item !== 'string')) {
    throw new Error(`${label}必须是 JSON 字符串数组`);
  }
  if (parsed.some(item => /(?:sk-|token|secret|api[_-]?key)[=:]\s*\S+/iu.test(item))) {
    throw new Error(`${label}疑似包含凭据；请改用环境变量名，不要把 key 写入参数`);
  }
  return parsed;
}

async function validatedRsiRoot(input: string): Promise<string> {
  if (!input || input.includes('\0')) throw new Error('Project RSI root 无效');
  const candidate = await realpath(resolve(input)).catch(() => undefined);
  if (!candidate) throw new Error(`Project RSI root 不存在：${input}`);
  if (
    candidate === parse(candidate).root ||
    candidate === resolve(homedir()) ||
    dirname(candidate) === parse(candidate).root
  ) {
    throw new Error('Project RSI root 不能是 /、home 或宽泛父目录');
  }
  const project = await discoverProjectRsi(candidate, candidate);
  if (!project) {
    throw new Error(
      `该目录尚未初始化 ${candidate}/.project-rsi/config.json。请先用上游 Project RSI init，` +
        '再在 arg-bridge settings 中指定；bridge 不会自动初始化。',
    );
  }
  return candidate;
}

function assertPrompt<T>(value: T | symbol): asserts value is T {
  if (p.isCancel(value)) {
    p.cancel('已取消，未修改 profile。');
    throw new Error('settings cancelled');
  }
}

function uniqueRuntimeIdentities(
  identities: CodexHostRuntimeIdentity[],
): CodexHostRuntimeIdentity[] {
  const seen = new Set<string>();
  return identities.filter(identity => {
    const key = [
      identity.ccSwitchProviderId ?? '',
      identity.codexProviderId,
      identity.model ?? '',
    ].join('\0');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function providerSwitchState(
  running: CodexHostRuntimeIdentity[],
  configuredCcSwitchProviderId: string | null,
  configured: CodexActiveConfigIdentity | undefined,
  runningUnknown: number,
): SettingsSnapshot['mainProvider']['pendingSwitch'] {
  if (!configured) return 'unknown';
  if (runningUnknown > 0) return 'unknown';
  if (running.length === 0) return 'not-running';
  const inSync = running.every(identity =>
    (identity.ccSwitchProviderId ?? null) === configuredCcSwitchProviderId &&
    identity.codexProviderId === configured.codexProviderId &&
    (identity.model ?? null) === (configured.model ?? null)
  );
  return inSync ? 'in-sync' : 'pending-next-turn';
}

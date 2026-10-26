import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, parse, resolve } from 'node:path';
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
  loadBrokerRouteMap,
  saveBrokerRouteMap,
  type BrokerRouteMap,
} from '../../integrations/broker-routes';
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
  const settingsEnv = options.env ?? process.env;
  const paths = resolveAppPaths({
    rootDir: settingsEnv.LARK_CHANNEL_HOME,
    profile: snapshot.profile,
  });
  const rawRoot = await loadRootConfig(paths.configFile);
  const rawProfile = rawRoot?.profiles[snapshot.profile];
  if (!rawRoot || !rawProfile) throw new Error(`profile 不存在：${snapshot.profile}`);
  const diagnostics = snapshot.subagents.diagnostics;
  const currentSubagents = snapshot.subagents.config;
  const currentRsi = snapshot.rsi.config;
  const ccProviders = diagnostics.ccSwitch.providers.length > 0
    ? diagnostics.ccSwitch.providers
    : diagnostics.ccSwitch.currentProviderCodex
      ? [{
          id: diagnostics.ccSwitch.currentProviderCodex,
          name: diagnostics.ccSwitch.currentProviderName
            ?? diagnostics.ccSwitch.currentProviderCodex,
          current: true,
        }]
      : [];
  const providerSummary = ccProviders.length > 0
    ? ccProviders.map(provider =>
        `${provider.current ? '●' : '○'} ${provider.name} (${provider.id})`
      ).join('\n')
    : '(cc-switch 未返回可用账号)';
  const availableReadRoutes = diagnostics.readRoutes.filter(route => route.available);
  const availableWriteRoutes = diagnostics.writeRoutes.filter(route => route.available);
  const unavailableRoutes = diagnostics.readRoutes.filter(route => !route.available);

  p.note([
    `主对话账号：${diagnostics.ccSwitch.currentProviderName ?? '(unknown)'}` +
      ` [${diagnostics.ccSwitch.currentProviderCodex ?? '(unknown)'}]`,
    `Codex 模型：${snapshot.mainProvider.configuredModel ?? '(config default)'}`,
    '',
    'cc-switch 中的 Codex 账号：',
    providerSummary,
    '',
    '这里只显示账号 ID、名称和运行状态；API Key 不会显示或写入配置。' +
      '子代理派发时由 cc-switch resolver 在内存中读取，并只传给 MixAgents 子进程。' +
      '主对话 provider 仍由 cc-switch 决定。',
  ].join('\n'), '步骤 1 / 5 · 自动读取主对话配置');

  const selectedMode = await p.select<SubagentMode>({
    message: '子代理在 Broker 不可用时怎么办？',
    initialValue: currentSubagents.mode,
    options: [
      {
        value: 'auto',
        label: '自动（推荐）',
        hint: '优先使用 MixAgents；不可用时按下方设置决定是否用本地 Codex fork',
      },
      {
        value: 'broker',
        label: '只允许 MixAgents',
        hint: '不会静默降级；配置或 Key 不完整时明确报错',
      },
      {
        value: 'fork',
        label: '只用本地 Codex fork',
        hint: '不跨 provider，沿用当前 Codex 模型',
      },
      { value: 'off', label: '关闭子代理', hint: '主对话不受影响' },
    ],
  });
  assertPrompt(selectedMode);
  let allowForkFallback = currentSubagents.allowForkFallback;
  if (selectedMode === 'auto') {
    const fallback = await p.confirm({
      message: 'MixAgents 暂时不可用时，是否改用本地 Codex fork？',
      initialValue: allowForkFallback,
    });
    assertPrompt(fallback);
    allowForkFallback = fallback;
  }
  let routeMode: SubagentRouteMode = currentSubagents.routeMode;
  let readRoute = currentSubagents.readRoute;
  let selectedCcProvider = currentSubagents.ccSwitchProviderId;
  let selectedReadRoute = readRoute;
  const routeMapState = await loadBrokerRouteMap(settingsEnv);
  if (routeMapState.error) throw new Error(routeMapState.error);

  if (
    (selectedMode === 'auto' || selectedMode === 'broker') &&
    ccProviders.length > 0
  ) {
    p.note([
      'Bridge 会自动读取这里选中的 cc-switch Codex provider，并生成 Broker route、模型和凭据。',
      '默认“跟随当前 provider”：以后在 cc-switch 切换 provider 后，下一条子代理任务自动使用新 provider，无需改 Key 或手写 route。',
      '如果选择固定 provider，子代理始终使用该 provider；主对话仍由 cc-switch 当前 provider 控制。',
      availableReadRoutes.length === 0
        ? '当前 provider 的 Broker route 会在首次派发时自动生成；doctor 会显示真实可用性。'
        : `当前已解析 ${availableReadRoutes.length} 条可用只读 route。`,
      ...(unavailableRoutes.length
        ? [`当前不可用 route：${unavailableRoutes.map(route =>
            `${route.id}(${route.missingEnvironment.join(',') || 'unavailable'})`
          ).join('、')}`]
        : []),
    ].join('\n'), '步骤 2 / 5 · 选择子代理 provider');
    const followCurrent = '__follow_current__';
    const providerChoice = await p.select<string>({
      message: '子代理用哪个 cc-switch Codex provider？',
      initialValue: selectedCcProvider && ccProviders.some(provider => provider.id === selectedCcProvider)
        ? selectedCcProvider
        : followCurrent,
      options: [
        {
          value: followCurrent,
          label: '跟随当前 provider（推荐）',
          hint: `现在使用 ${diagnostics.ccSwitch.currentProviderName ?? '(unknown)'}，以后随 cc-switch 切换自动更新`,
        },
        ...ccProviders.map(provider => ({
          value: provider.id,
          label: `${provider.name} (${provider.id})`,
          hint: provider.current ? '当前主对话 provider；也可固定使用' : '固定使用这个 provider',
        })),
      ],
    });
    assertPrompt(providerChoice);
    selectedCcProvider = providerChoice === followCurrent ? null : providerChoice;

    routeMode = 'follow-cc-switch';
    selectedReadRoute = null;
    readRoute = null;
  }

  const currentCredential = currentMcpCredentials(rawProfile);
  let credentialMode = currentCredential.mode;
  let credentialEnvKeys = currentCredential.credentialEnvKeys.join(', ');
  let credentialProvider = currentCredential.credentialProvider ?? '';
  if (
    (selectedMode === 'auto' || selectedMode === 'broker') &&
    routeMode === 'manual'
  ) {
    p.note([
      'Bridge 不会读取、打印或保存 API Key。',
      `当前启动环境中的 MIXAGENTS_BROKER_CREDENTIALS_JSON：${
        settingsEnv.MIXAGENTS_BROKER_CREDENTIALS_JSON?.trim() ? 'PRESENT' : 'MISSING'
      }`,
      '',
      '推荐方式：由启动 Bridge 的环境/secret manager 提供：',
      '  MIXAGENTS_BROKER_CREDENTIALS_JSON',
      '这个变量内部是“环境变量名 → Key”的 JSON；Bridge 只检查变量是否存在，并把环境交给 MixAgents 子进程。',
      '',
      'MixAgents 当前公开版本 0.1.1 尚未实现直接读取 cc-switch Key；“MixAgents managed” 仅保留为未验证接口。',
    ].join('\n'), '步骤 3 / 5 · 子代理 Key 由谁提供');
    const selectedCredentialMode = await p.select<'inherit-env' | 'mixagents-managed'>({
      message: '子代理 Key 从哪里来？',
      initialValue: credentialMode === 'mixagents-managed' ? 'inherit-env' : credentialMode,
      options: [
        {
          value: 'inherit-env',
          label: '启动环境已提供（推荐）',
          hint: '只保存环境变量名；不会把 Key 写进 arg-bridge 配置',
        },
        {
          value: 'mixagents-managed',
          label: '由 MixAgents 管理（未验证）',
          hint: '需要 MixAgents/受信 helper 自行解析 cc-switch；当前 0.1.1 不具备该能力',
        },
      ],
    });
    assertPrompt(selectedCredentialMode);
    credentialMode = selectedCredentialMode;
    if (credentialMode === 'inherit-env') {
      const envKeysInput = await p.text({
        message: 'Bridge 启动环境中的 Key 容器变量名（只填名称）',
        initialValue: credentialEnvKeys || 'MIXAGENTS_BROKER_CREDENTIALS_JSON',
        placeholder: 'MIXAGENTS_BROKER_CREDENTIALS_JSON',
      });
      assertPrompt(envKeysInput);
      credentialEnvKeys = envKeysInput;
    } else {
      credentialEnvKeys = '';
    }
    const missingCredentialNames = credentialEnvKeys
      .split(',')
      .map(value => value.trim())
      .filter(Boolean)
      .filter(name => !settingsEnv[name]?.trim());
    if (missingCredentialNames.length > 0) {
      p.note(
        `当前进程缺少这些环境变量：${missingCredentialNames.join(', ')}。` +
          '设置仍可保存，但在启动 Bridge 的环境补齐之前，相关子代理线路会显示不可用。',
        '凭据状态提醒',
      );
    }
    credentialProvider = credentialMode === 'mixagents-managed'
      ? (selectedCcProvider ?? diagnostics.ccSwitch.currentProviderCodex ?? '')
      : '';
  } else if (selectedMode === 'auto' || selectedMode === 'broker') {
    p.note([
      'Bridge 会从当前 cc-switch provider 自动读取模型、Base URL 和 Key 字段，并仅把它们传给 MixAgents 子进程。',
      'Key 不会写入 profile、broker-routes.json、worker mapping、日志或 doctor JSON；你不需要手工设置 MIXAGENTS_BROKER_CREDENTIALS_JSON。',
    ].join('\n'), '步骤 3 / 5 · 自动凭据');
    credentialMode = 'inherit-env';
    credentialEnvKeys = '';
    credentialProvider = '';
  }

  p.note([
    'Project RSI 是“项目完成证据校验”：只有项目已经创建 .project-rsi/config.json 时才启用。',
    '普通问答不会触发；产生文件修改或高影响结论时，才要求项目自己的 runner/validator 生成新证据。',
    'Bridge 不会自动初始化项目、伪造 receipt 或降低项目校验标准。',
  ].join('\n'), '步骤 4 / 5 · 项目完成证据校验');
  const rsiMode = await p.select<RsiConfig['mode']>({
    message: '产生文件修改时要不要做项目证据校验？',
    initialValue: currentRsi.mode,
    options: [
      {
        value: 'auto',
        label: '自动（推荐）',
        hint: '项目已初始化时启用；普通问答不触发',
      },
      {
        value: 'off',
        label: '关闭',
        hint: '不使用 Bridge 的 Project RSI 完成门禁',
      },
    ],
  });
  assertPrompt(rsiMode);
  const projectRootText = rsiMode === 'auto'
    ? await p.text({
        message: '项目根目录（通常留空，自动从当前工作区向上查找）',
        initialValue: currentRsi.projectRoot ?? '',
        placeholder: '留空即可',
      })
    : '';
  assertPrompt(projectRootText);
  const projectRoot = projectRootText.trim()
    ? await validatedRsiRoot(projectRootText.trim())
    : null;
  let reviewerRouteMode: SubagentRouteMode = currentRsi.reviewerRouteMode;
  let reviewerRoute = currentRsi.reviewerRoute;
  if (rsiMode === 'auto') {
    const reviewerStrategy = await p.select<'follow' | 'manual'>({
      message: 'RSI 证据由哪个子代理复核？',
      initialValue: currentRsi.reviewerRouteMode === 'manual' ? 'manual' : 'follow',
      options: [
        {
          value: 'follow',
          label: '跟随当前子代理线路（推荐）',
          hint: '与 /btw、自动派工使用同一 cc-switch 映射',
        },
        {
          value: 'manual',
          label: '固定一条复核线路',
          hint: '适合专门使用一个审阅模型',
        },
      ],
    });
    assertPrompt(reviewerStrategy);
    reviewerRouteMode = reviewerStrategy === 'follow' ? 'follow-cc-switch' : 'manual';
    reviewerRoute = reviewerStrategy === 'follow' ? null : reviewerRoute;
    if (reviewerStrategy === 'manual' && availableReadRoutes.length > 0) {
      const selected = await p.select<string>({
        message: '选择固定复核线路',
        initialValue: reviewerRoute && availableReadRoutes.some(route => route.id === reviewerRoute)
          ? reviewerRoute
          : selectedReadRoute && availableReadRoutes.some(route => route.id === selectedReadRoute)
            ? selectedReadRoute
            : availableReadRoutes[0]!.id,
        options: availableReadRoutes.map(route => ({
          value: route.id,
          label: `${route.provider} / ${route.model}`,
          hint: route.id,
        })),
      });
      assertPrompt(selected);
      reviewerRoute = selected;
    }
  }

  let writeRoute = currentSubagents.writeRoute;
  let allowWriteWorkers = currentSubagents.allowWriteWorkers;
  let modelTools = currentSubagents.modelTools;
  let nativeToolPolicy = currentSubagents.nativeToolPolicy;
  let maxConcurrentWorkers = currentSubagents.maxConcurrentWorkers;
  let workerTimeoutMs = currentSubagents.workerTimeoutMs;
  let includeProgressSnapshot = currentSubagents.includeProgressSnapshot;
  let maxRepairRounds = currentRsi.maxRepairRounds;
  const currentMcp = rawProfile.subagents?.mixagents;
  let mcpCommand = currentMcp?.mcpCommand ?? '';
  let mcpArgs = currentMcp?.mcpArgs ?? [];
  const advanced = await p.confirm({
    message: '是否展开高级参数？（并发、写权限、自定义 MCP、修复轮次）',
    initialValue: false,
  });
  assertPrompt(advanced);
  if (advanced) {
    const snapshotConfirm = await p.confirm({
      message: '/btw 是否附带已脱敏的主任务进度摘要？',
      initialValue: includeProgressSnapshot,
    });
    assertPrompt(snapshotConfirm);
    includeProgressSnapshot = snapshotConfirm;
    const toolsConfirm = await p.confirm({
      message: '允许父 Codex 模型自动调用 Broker 子代理工具？',
      initialValue: modelTools,
    });
    assertPrompt(toolsConfirm);
    modelTools = toolsConfirm;
    const nativeChoice = await p.select<SubagentConfig['nativeToolPolicy']>({
      message: 'Codex 自带的子代理工具怎么处理？',
      initialValue: nativeToolPolicy,
      options: [
        {
          value: 'shadow',
          label: '隐藏 native 工具（推荐）',
          hint: '只走 Broker，避免第三方 provider 收到加密子任务后无法读取',
        },
        {
          value: 'preserve',
          label: '保留 native 工具',
          hint: '可能绕过 Broker；doctor 会标记风险',
        },
      ],
    });
    assertPrompt(nativeChoice);
    nativeToolPolicy = nativeChoice;
    const concurrencyText = await p.text({
      message: '最多同时运行几个子代理？（1-32）',
      initialValue: String(maxConcurrentWorkers),
    });
    assertPrompt(concurrencyText);
    maxConcurrentWorkers = boundedIntegerInput(concurrencyText, 1, 32, '最大并发子代理数');
    const timeoutText = await p.text({
      message: '单个子代理最长运行时间（分钟）',
      initialValue: String(workerTimeoutMs / 60_000),
    });
    assertPrompt(timeoutText);
    workerTimeoutMs = Math.round(
      boundedNumberInput(timeoutText, 0.5, 1440, '子代理超时分钟数') * 60_000,
    );
    const writeWorkers = await p.confirm({
      message: '允许模型创建可写文件的子代理？（仍需用户逐任务授权）',
      initialValue: allowWriteWorkers,
    });
    assertPrompt(writeWorkers);
    allowWriteWorkers = writeWorkers;
    if (availableWriteRoutes.length > 0) {
      const noneValue = '__none__';
      const selected = await p.select<string>({
        message: '可写子代理使用哪条线路？',
        initialValue: writeRoute && availableWriteRoutes.some(route => route.id === writeRoute)
          ? writeRoute
          : noneValue,
        options: [
          { value: noneValue, label: '不配置可写线路', hint: '只允许只读子代理' },
          ...availableWriteRoutes.map(route => ({
            value: route.id,
            label: `${route.provider} / ${route.model}`,
            hint: `${route.id} · 需要逐任务授权`,
          })),
        ],
      });
      assertPrompt(selected);
      writeRoute = selected === noneValue ? null : selected;
    }
    const repairText = await p.text({
      message: 'RSI 校验失败后，最多自动修复几轮？（0-10）',
      initialValue: String(maxRepairRounds),
    });
    assertPrompt(repairText);
    maxRepairRounds = boundedIntegerInput(repairText, 0, 10, 'RSI 最大修复轮次');
    const command = await p.text({
      message: '自定义 MixAgents MCP 命令（通常留空，自动使用 npm 包）',
      initialValue: mcpCommand,
      placeholder: '留空自动发现',
    });
    assertPrompt(command);
    mcpCommand = command.trim();
    const argsText = await p.text({
      message: '自定义 MCP 参数 JSON 数组（留空保持现值）',
      initialValue: '',
      placeholder: '例如 ["dist/server.js"]',
    });
    assertPrompt(argsText);
    if (argsText.trim()) mcpArgs = parseStringArray(argsText, 'MCP 参数');
  }

  let nextRouteMap: BrokerRouteMap | undefined;
  if (
    (selectedMode === 'auto' || selectedMode === 'broker') &&
    routeMode === 'follow-cc-switch' &&
    selectedCcProvider &&
    selectedReadRoute
  ) {
    const baseMap: BrokerRouteMap = routeMapState.config ?? { version: 1, providers: {} };
    const existing = baseMap.providers[selectedCcProvider] ?? {};
    nextRouteMap = {
      ...baseMap,
      providers: {
        ...baseMap.providers,
        [selectedCcProvider]: {
          ...existing,
          readRoute: selectedReadRoute,
          ...(allowWriteWorkers && writeRoute ? { writeRoute } : {}),
        },
      },
    };
  }

  const modeText = selectedMode === 'auto'
    ? '自动：优先 MixAgents，失败时按设置决定'
    : selectedMode === 'broker'
      ? '只允许 MixAgents'
      : selectedMode === 'fork'
        ? '只用本地 Codex fork'
        : '关闭子代理';
  const routeText = selectedMode === 'auto' || selectedMode === 'broker'
    ? routeMode === 'follow-cc-switch'
      ? selectedCcProvider
        ? `固定 provider=${selectedCcProvider}，route 自动生成`
        : '跟随 cc-switch 当前 provider，route 自动生成'
      : `固定线路 ${selectedReadRoute ?? readRoute ?? '(none)'}`
    : '(不适用)';
  const credentialText = routeMode === 'follow-cc-switch'
    ? 'cc-switch 自动解析 provider Key（不显示、不写入配置）'
    : credentialMode === 'inherit-env'
      ? `启动环境变量 ${credentialEnvKeys || '(未配置)'}`
      : 'MixAgents managed（当前版本未验证）';
  p.note([
    `主对话：${diagnostics.ccSwitch.currentProviderName ?? '(unknown)'}（保持不变）`,
    `子代理：${modeText}`,
    `子代理线路：${routeText}`,
    `Key：${credentialText}`,
    `项目证据校验：${rsiMode === 'off' ? '关闭' : '自动（只对已初始化项目）'}`,
    advanced ? '高级参数：已展开编辑' : '高级参数：保持原值',
  ].join('\n'), '步骤 5 / 5 · 保存前确认');

  const save = await p.confirm({
    message: '按以上设置保存？',
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
    if (nextRouteMap) await saveBrokerRouteMap(nextRouteMap, settingsEnv);
    const {
      mcpCommand: _previousMcpCommand,
      credentialMode: _previousCredentialMode,
      credentialProvider: _previousCredentialProvider,
      credentialEnvKeys: _previousCredentialEnvKeys,
      ...mcpBase
    } = currentMcp ?? {};
    const nextMcp = (selectedMode === 'auto' || selectedMode === 'broker' || currentMcp)
      ? {
          ...mcpBase,
          ...(mcpCommand.trim() ? { mcpCommand: mcpCommand.trim() } : {}),
          ...(mcpArgs.length > 0 ? { mcpArgs } : {}),
          credentialMode,
          ...(credentialProvider.trim()
            ? { credentialProvider: credentialProvider.trim() }
            : {}),
          ...(normalizedKeys.length > 0
            ? { credentialEnvKeys: normalizedKeys }
            : {}),
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
        ccSwitchProviderId: routeMode === 'follow-cc-switch'
          ? selectedCcProvider
          : currentSubagents.ccSwitchProviderId ?? null,
        readRoute,
        writeRoute: routeMode === 'manual' ? writeRoute : null,
        modelTools,
        nativeToolPolicy,
        maxConcurrentWorkers,
        workerTimeoutMs,
        allowWriteWorkers,
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
        maxRepairRounds,
      },
    };
    await saveRootConfig(root, paths.configFile);
  });
  p.outro(
    '已保存。下一条 /btw 会重新解析路由；Broker dynamic tools/native shadow 从新 thread 生效，旧 thread 不会静默绕过。',
  );
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
      stateDir: join(paths.profileDir, 'structured'),
      codexHome,
      codexBin: profile.codex?.binaryPath ?? 'codex',
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

function currentMcpCredentials(profile: { subagents?: SubagentConfig }): {
  mode: 'inherit-env' | 'mixagents-managed';
  credentialEnvKeys: string[];
  credentialProvider?: string;
} {
  const mixagents = profile.subagents?.mixagents;
  return {
    mode: mixagents?.credentialMode === 'mixagents-managed'
      ? 'mixagents-managed'
      : 'inherit-env',
    credentialEnvKeys: mixagents?.credentialEnvKeys ?? [],
    ...(mixagents?.credentialProvider
      ? { credentialProvider: mixagents.credentialProvider }
      : {}),
  };
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
    `cc-switch accounts=${diagnostics.ccSwitch.providers.length > 0
      ? diagnostics.ccSwitch.providers.map(item =>
          `${item.current ? '*' : '-'}${item.id}:${item.name}`
        ).join(' | ')
      : '(none reported)'}`,
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
      ` provider=${snapshot.subagents.config.ccSwitchProviderId ?? '(follow-current)'}` +
      ` MCP=${diagnostics.mcp.status} version=${diagnostics.packageVersion ?? '(unknown)'}`,
    `Broker tools=${diagnostics.modelTools.brokerWired ? 'wired' : 'degraded'}` +
      ` namespace=${diagnostics.modelTools.namespace}` +
      ` native=${diagnostics.modelTools.nativeToolPolicy}` +
      ` maxWorkers=${diagnostics.limits.maxConcurrentWorkers}` +
      ` workerTimeoutMs=${diagnostics.limits.workerTimeoutMs}` +
      ` writeWorkers=${diagnostics.limits.allowWriteWorkers}`,
    `Broker tools degraded=${diagnostics.modelTools.degradedReason ?? '(none)'}`,
    `credential mode=${diagnostics.credentials.mode} status=${diagnostics.credentials.status}` +
      ` providerRef=${diagnostics.credentials.providerReference ?? '(none)'}`,
    `selected route=${diagnostics.selectedRoute.id ?? '(none)'}` +
      (diagnostics.selectedRoute.error ? ` error=${diagnostics.selectedRoute.error}` : ''),
    `selected write route=${diagnostics.selectedWriteRoute.id ?? '(none)'}` +
      (diagnostics.selectedWriteRoute.error ? ` error=${diagnostics.selectedWriteRoute.error}` : ''),
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
    `RSI feedback loop maxRounds=${snapshot.rsi.config.maxRepairRounds}` +
      ` timeoutMs=${snapshot.rsi.config.repairTimeoutMs}`,
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

function boundedIntegerInput(
  value: string,
  minimum: number,
  maximum: number,
  label: string,
): number {
  const parsed = Number(value.trim());
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label}必须是 ${minimum}-${maximum} 的整数`);
  }
  return parsed;
}

function boundedNumberInput(
  value: string,
  minimum: number,
  maximum: number,
  label: string,
): number {
  const parsed = Number(value.trim());
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label}必须是 ${minimum}-${maximum} 的数字`);
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

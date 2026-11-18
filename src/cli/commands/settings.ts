import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, parse, resolve } from 'node:path';
import * as p from '@clack/prompts';
import { normalizeProviderRecovery, type ProviderRecoveryConfig } from '../../config/provider-recovery';
import {
  collectSubagentDiagnostics,
  type SubagentDiagnostics,
} from '../../agent/subagents/diagnostics';
import {
  DEFAULT_RSI_CONFIG,
  DEFAULT_SUBAGENT_CONFIG,
  type AgentKind,
  type DshConfig,
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
import { resolveCurrentCcSwitchCodexProvider } from '../../integrations/cc-switch-provider';
import { discoverProviderModels } from '../../integrations/provider-models';
import { resolveDshProvider } from '../../agent/dsh/provider';
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
  providerRecovery: ProviderRecoveryConfig;
  version: 1;
  profile: string;
  agentKind: AgentKind;
  workspace: string;
  ccSwitch: SubagentDiagnostics['ccSwitch'];
  dsh?: {
    provider: string | null;
    model: string | null;
    pinnedProvider?: string;
    api?: DshConfig['api'];
  };
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
  const unavailableRoutes = diagnostics.readRoutes.filter(route => !route.available);
  let dsh = rawProfile.dsh;
  if (dsh) {
    const providers = new Map(ccProviders.map(provider => [provider.id, provider.name]));
    if (dsh.ccSwitchProviderId && !providers.has(dsh.ccSwitchProviderId)) {
      providers.set(dsh.ccSwitchProviderId, dsh.ccSwitchProviderId);
    }
    const provider = await p.select<string>({
      message: 'DeepSeek Harness 主会话账号',
      initialValue: dsh.ccSwitchProviderId ?? '',
      options: [
        { value: '', label: '跟随 cc-switch 当前账号' },
        ...[...providers].map(([value, label]) => ({ value, label })),
      ],
    });
    assertPrompt(provider);
    const api = await p.select<DshConfig['api'] | 'auto'>({
      message: '主会话 API 协议',
      initialValue: dsh.api ?? 'auto',
      options: [
        { value: 'auto', label: '跟随账号配置' },
        { value: 'openai-responses', label: 'OpenAI Responses' },
        { value: 'openai-completions', label: 'OpenAI Chat Completions' },
        { value: 'anthropic-messages', label: 'Anthropic Messages' },
      ],
    });
    assertPrompt(api);
    dsh = { ...dsh, ccSwitchProviderId: provider || undefined, api: api === 'auto' ? undefined : api };
  }

  p.note([
    `主对话账号：${snapshot.dsh?.provider ?? diagnostics.ccSwitch.currentProviderName ?? '(unknown)'}`,
    `当前默认模型：${snapshot.dsh?.model ?? snapshot.mainProvider.configuredModel ?? '(config default)'}`,
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
    initialValue: dsh && currentSubagents.mode === 'fork' ? 'auto' : currentSubagents.mode,
    options: [
      {
        value: 'auto',
        label: '自动（推荐）',
        hint: dsh ? '按所选 provider 与模型顺序派发 /btw' : '优先使用所选 provider；runtime 自愈后仍不可用，才按下方设置改用主会话 Codex',
      },
      {
        value: 'broker',
        label: '只允许 MixAgents',
        hint: '不会静默降级；配置或 Key 不完整时明确报错',
      },
      ...(dsh ? [] : [{
        value: 'fork' as const,
        label: '只用本地 Codex fork',
        hint: '不跨 provider，沿用当前 Codex 模型',
      }]),
      { value: 'off', label: '关闭子代理', hint: '主对话不受影响' },
    ],
  });
  assertPrompt(selectedMode);
  let allowForkFallback = !dsh && currentSubagents.allowForkFallback;
  if (selectedMode === 'auto' && !dsh) {
    const fallback = await p.confirm({
      message: '所选子代理 provider 自愈后仍不可用时，是否改用主会话 provider 的只读 Codex fork？',
      initialValue: allowForkFallback,
    });
    assertPrompt(fallback);
    allowForkFallback = fallback;
  }
  let routeMode: SubagentRouteMode = currentSubagents.routeMode;
  let readRoute = currentSubagents.readRoute;
  let selectedCcProvider = currentSubagents.ccSwitchProviderId;
  const providerOverrides = { ...currentSubagents.providerOverrides };
  const previousPriority = currentSubagents.providerPriority ?? [];
  let unifiedRouting = false;
  let providerPriority = currentSubagents.providerPriority ?? [];
  let selectedModelSummary = '(由 route/provider 决定)';
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
      `Web Search 能力：provider ${
        diagnostics.webSearch.providerSupported === true
          ? '声明支持'
          : diagnostics.webSearch.providerSupported === false
            ? '声明不支持'
            : '未声明'
      }；当前策略=${diagnostics.webSearch.mode}，实际=${diagnostics.webSearch.effective}。` +
        (diagnostics.webSearch.effective === 'disabled'
          ? '需要联网搜索时请切换到声明支持原生搜索的 API，或仅在已验证时强制 native。'
          : ''),
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
      initialValue: providerPriority.length ? '__priority__' : selectedCcProvider && ccProviders.some(provider => provider.id === selectedCcProvider)
        ? selectedCcProvider
        : followCurrent,
      options: [
        { value: '__priority__', label: '多个 provider，按优先级备用', hint: '自动读取模型列表；每个 provider 选择 1–2 个模型' },
        {
          value: followCurrent,
          label: '跟随当前 provider（推荐）',
          hint: `现在使用 ${diagnostics.ccSwitch.currentProviderName ?? '(unknown)'}，以后随 cc-switch 切换自动更新`,
        },
        ...ccProviders.map(provider => ({
          value: provider.id,
          label: `${provider.name} (${provider.id})`,
          hint: provider.current
            ? `当前主对话 provider；Web Search=${
                diagnostics.webSearch.providerSupported === true
                  ? 'supported'
                  : diagnostics.webSearch.providerSupported === false
                    ? 'unsupported'
                    : 'undeclared'
              }`
            : '固定使用这个 provider；保存后会重新解析其模型和 Web Search 能力',
        })),
      ],
    });
    assertPrompt(providerChoice);
    if (providerChoice === '__priority__') {
      const selected = await p.multiselect<string>({ message: '选择子代理可用的 provider',
        options: ccProviders.map(provider => ({ value: provider.id, label: provider.name })),
        initialValues: providerPriority.map(target => target.providerId).filter(id => ccProviders.some(provider => provider.id === id)), required: true });
      assertPrompt(selected);
      if (selected.length > 16) throw new Error('最多选择 16 个 provider');
      const remaining = [...selected];
      const ordered: string[] = [];
      while (remaining.length) {
        const id = remaining.length === 1 ? remaining[0]! : await p.select<string>({
          message: `第 ${ordered.length + 1} 优先使用哪个 provider？`,
          options: remaining.map(value => ({ value, label: ccProviders.find(provider => provider.id === value)?.name ?? value })),
        });
        assertPrompt(id); ordered.push(id); remaining.splice(remaining.indexOf(id), 1);
      }
      providerPriority = [];
      for (const providerId of ordered) {
        const spinner = p.spinner(); spinner.start(`读取 ${ccProviders.find(provider => provider.id === providerId)?.name ?? providerId} 的模型列表`);
        const resolved = await resolveCurrentCcSwitchCodexProvider({ env: settingsEnv, providerId });
        let catalog: Awaited<ReturnType<typeof discoverProviderModels>>;
        try { catalog = await discoverProviderModels(resolved, { env: settingsEnv }); }
        finally { spinner.stop(); }
        if (catalog.notice) p.note(catalog.notice, providerId);
        const models = await selectProviderModels(resolved.summary.name, catalog.models,
          previousPriority.find(target => target.providerId === providerId)?.models
            ?? [providerOverrides[providerId]?.model ?? resolved.summary.model]);
        providerPriority.push({ providerId, models });
      }
      selectedCcProvider = providerPriority[0]?.providerId ?? null;
      selectedModelSummary = providerPriority.map((target, i) => `${i + 1}. ${target.providerId}: ${target.models.join(' → ')}`).join('\n');
      p.note('新任务按顺序选择可用目录中的模型；明确失败的线路冷却两分钟。已有 worker 不自动复制任务到备用线路，避免重复工具操作。模型目录可用不等于推理请求一定成功。', '优先级路由');
    } else {
      providerPriority = [];
      selectedCcProvider = providerChoice === followCurrent ? null : providerChoice;
      const effectiveProviderId = selectedCcProvider ?? diagnostics.ccSwitch.currentProviderCodex;
      let defaultEffort: string | null = null;
      if (effectiveProviderId) {
        const resolved = await resolveCurrentCcSwitchCodexProvider({
          env: settingsEnv,
          providerId: effectiveProviderId,
        });
        defaultEffort = resolved.summary.reasoningEffort;
        if (providerChoice === followCurrent) {
          selectedModelSummary = '跟随当前 provider：每个新任务读取该 provider 配置的默认模型';
          p.note(
            '只读 side、可写 worker 和 reviewer 都跟随 cc-switch 当前 provider 的默认模型。需要选择模型和备用顺序时，请选择固定 provider 或“多个 provider，按优先级备用”。',
            '统一候选线路',
          );
        } else {
          let models: string[] = resolved.summary.configuredModels ?? [resolved.summary.model];
          try {
            const catalog = await discoverProviderModels(resolved, { env: settingsEnv });
            models = catalog.models;
            if (catalog.notice) p.note(catalog.notice, '模型检测');
          } catch {
            p.note('模型目录暂不可用，显示 cc-switch 已配置模型；这不代表推理请求已经验证。', '模型检测');
          }
          const ordered = await selectProviderModels(resolved.summary.name, models,
            previousPriority.find(target => target.providerId === effectiveProviderId)?.models
              ?? [providerOverrides[effectiveProviderId]?.model ?? resolved.summary.model]);
          providerPriority = [{ providerId: effectiveProviderId, models: ordered }];
          selectedModelSummary = `${effectiveProviderId}: ${ordered.join(' → ')}`;
          p.note('这组模型同时用于只读 side、可写 worker 和 reviewer；可写开关只控制权限，不会切换到另一套模型。', '统一候选线路');
        }
        const previous = providerOverrides[effectiveProviderId];
        const effort = await p.select<SubagentConfig['sideReasoningEffort']>({
          message: '统一候选线路的推理强度',
          initialValue: previous?.reasoningEffort ?? 'inherit',
          options: [
            { value: 'inherit', label: '跟随 provider 配置（推荐）', hint: defaultEffort ?? 'provider 默认' },
            { value: 'low', label: 'low · 低' },
            { value: 'medium', label: 'medium · 中' },
            { value: 'high', label: 'high · 高' },
            { value: 'xhigh', label: 'xhigh · 很高' },
            { value: 'max', label: 'max · 最高（需 provider 支持）' },
          ],
        });
        assertPrompt(effort);
        providerOverrides[effectiveProviderId] = { model: null, reasoningEffort: effort };
      }
    }

    routeMode = 'follow-cc-switch';
    selectedReadRoute = null;
    readRoute = null;
    unifiedRouting = true;
    // A saved priority list (or follow-current choice) is the only model source.
    for (const [providerId, preference] of Object.entries(providerOverrides)) {
      providerOverrides[providerId] = { ...preference, model: null };
    }
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

  if (!dsh) p.note([
    'Project RSI 是“项目完成证据校验”：只有项目已经创建 .project-rsi/config.json 时才启用。',
    '普通问答不会触发；产生文件修改或高影响结论时，才要求项目自己的 runner/validator 生成新证据。',
    'Bridge 不会自动初始化项目、伪造 receipt 或降低项目校验标准。',
  ].join('\n'), '步骤 4 / 5 · 项目完成证据校验');
  const rsiMode = dsh ? 'off' : await p.select<RsiConfig['mode']>({
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
  const reviewerRouteMode: SubagentRouteMode = rsiMode === 'auto'
    ? routeMode
    : currentRsi.reviewerRouteMode;
  const reviewerRoute: string | null = rsiMode === 'auto' ? readRoute : currentRsi.reviewerRoute;
  if (rsiMode === 'auto') {
    p.note(
      'RSI reviewer 自动继承上面配置的 provider/model 候选顺序；不会再单独选择 route 或模型。',
      '统一候选线路',
    );
  }

  // Write permission is independent from routing. A writable worker uses the
  // same provider/model candidates as a read-only side and reviewer.
  let allowWriteWorkers = currentSubagents.allowWriteWorkers;
  let modelTools = currentSubagents.modelTools;
  let nativeToolPolicy = currentSubagents.nativeToolPolicy;
  let maxConcurrentWorkers = currentSubagents.maxConcurrentWorkers;
  let workerTimeoutMs = currentSubagents.workerTimeoutMs;
  let sideTimeoutMs = currentSubagents.sideTimeoutMs;
  let sideReasoningEffort = currentSubagents.sideReasoningEffort;
  let webSearch = currentSubagents.webSearch;
  let includeProgressSnapshot = currentSubagents.includeProgressSnapshot;
  let maxRepairRounds = currentRsi.maxRepairRounds;
  const currentMcp = rawProfile.subagents?.mixagents;
  let mcpCommand = currentMcp?.mcpCommand ?? '';
  let mcpArgs = currentMcp?.mcpArgs ?? [];
  const advanced = await p.confirm({
    message: dsh ? '是否展开高级参数？（并发、写权限、自定义 MCP）'
      : '是否展开高级参数？（并发、写权限、自定义 MCP、修复轮次）',
    initialValue: false,
  });
  assertPrompt(advanced);
  if (advanced) {
    p.note(
      dsh
        ? '只读 /btw、可写子代理和模型调用的 MixAgents 工具共用同一组 provider 和模型优先级。'
        : '只读 /btw、可写 worker、模型可见的 subagent 和 RSI reviewer 共用上面同一组 provider/model 优先级。下面只调整权限、并发、等待、推理强度和工具行为；这里不会再填写模型或选择另一条写 route。',
      '统一候选线路',
    );
    const snapshotConfirm = await p.confirm({
      message: '/btw 是否附带已脱敏的主任务进度摘要？',
      initialValue: includeProgressSnapshot,
    });
    assertPrompt(snapshotConfirm);
    includeProgressSnapshot = snapshotConfirm;
    const toolsConfirm = await p.confirm({
      message: dsh ? '允许 DeepSeek Harness 调用 MixAgents 子代理工具？'
        : '允许父 Codex 模型自动调用 Broker 子代理工具？',
      initialValue: modelTools,
    });
    assertPrompt(toolsConfirm);
    modelTools = toolsConfirm;
    const nativeChoice = dsh ? 'preserve' : await p.select<SubagentConfig['nativeToolPolicy']>({
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
      message: '单个 worker 等待窗口（分钟；超时返回仍在运行）',
      initialValue: String(workerTimeoutMs / 60_000),
    });
    assertPrompt(timeoutText);
    workerTimeoutMs = Math.round(
      boundedNumberInput(timeoutText, 0.5, 1440, '子代理等待窗口分钟数') * 60_000,
    );
    const sideTimeoutText = await p.text({
      message: '/btw 超过多少秒后提示“仍在后台运行”？（秒）',
      initialValue: String(sideTimeoutMs / 1_000),
    });
    assertPrompt(sideTimeoutText);
    sideTimeoutMs = Math.round(
      boundedNumberInput(sideTimeoutText, 15, 1800, '/btw 快速等待提示秒数') * 1_000,
    );
    const sideEffort = await p.select<SubagentConfig['sideReasoningEffort']>({
      message: '未设置 provider 推理强度时，只读 side 的备用强度（不改变模型）',
      initialValue: sideReasoningEffort,
      options: [
        {
          value: 'low',
          label: '低（推荐）',
          hint: '仅在所选 provider 没有单独推理设置时生效',
        },
        { value: 'medium', label: '中', hint: '速度与质量平衡' },
        { value: 'high', label: '高', hint: '更慢，适合复杂复核' },
        { value: 'xhigh', label: '很高', hint: '慢速深度复核' },
        { value: 'max', label: '最高', hint: '最慢，通常只用于离线重任务' },
        {
          value: 'inherit',
          label: '跟随 provider',
          hint: '使用 cc-switch provider 自己的配置',
        },
      ],
    });
    assertPrompt(sideEffort);
    sideReasoningEffort = sideEffort;
    const webSearchMode = await p.select<SubagentConfig['webSearch']>({
      message: '子代理是否启用原生 Web Search？',
      initialValue: webSearch,
      options: [
        {
          value: 'auto',
          label: '按 provider 能力自动决定（推荐）',
          hint: 'provider 未声明支持时关闭；需要联网时请换支持搜索的 API',
        },
        {
          value: 'native',
          label: '强制使用原生 Web Search',
          hint: '只应对已验证支持 Responses web_search 的 provider 使用',
        },
        {
          value: 'disabled',
          label: '始终关闭',
          hint: '适合无需联网的纯本地复核',
        },
      ],
    });
    assertPrompt(webSearchMode);
    webSearch = webSearchMode;
    const writeWorkers = await p.confirm({
      message: '允许模型创建可写文件的子代理？（仍需用户逐任务授权）',
      initialValue: allowWriteWorkers,
    });
    assertPrompt(writeWorkers);
    allowWriteWorkers = writeWorkers;
    p.note(
      `可写 worker 将继承：${selectedModelSummary}。开启可写权限只允许经过逐任务 workspace 授权，不会创建独立模型配置。`,
      '可写 worker 路由',
    );
    const repairText = dsh ? '0' : await p.text({
      message: 'RSI 校验失败后，最多自动修复几轮？（0-10）',
      initialValue: String(maxRepairRounds),
    });
    assertPrompt(repairText);
    maxRepairRounds = boundedIntegerInput(repairText, 0, 10, 'RSI 最大修复轮次');
    const command = await p.text({
      message: '自定义 MixAgents MCP 命令（通常留空，自动使用随包 Broker）',
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
      ? providerPriority.length
        ? `按已选的 ${providerPriority.length} 个 provider 和模型优先级自动选择`
        : selectedCcProvider
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
    dsh ? `主对话账号：${dsh.ccSwitchProviderId ?? '跟随 cc-switch 当前账号'}`
      : `主对话：${diagnostics.ccSwitch.currentProviderName ?? '(unknown)'}（保持不变）`,
    `子代理：${modeText}`,
    `子代理线路：${routeText}`,
    `子代理模型：${selectedModelSummary}`,
    `可写子代理：${allowWriteWorkers ? '开启，仍需逐任务授权' : '关闭'}；与 side 使用相同模型和备用顺序`,
    `Key：${credentialText}`,
    `子代理 Web Search：${webSearch === 'auto'
      ? `按 provider 能力（当前 ${diagnostics.webSearch.effective}）`
      : webSearch === 'native'
        ? '强制原生'
        : '关闭'}`,
    `/btw：备用 reasoning=${sideReasoningEffort} fast-notice=${sideTimeoutMs / 1_000}s；` +
    `等待窗口 ${workerTimeoutMs / 60_000} 分钟；超时返回仍在运行，/btw result 查询，/btw out 取消`,
    ...(!dsh ? [`项目证据校验：${rsiMode === 'off' ? '关闭' : '自动（只对已初始化项目）'}`] : []),
    advanced ? '高级参数：已展开编辑' : '高级参数：保持原值',
  ].join('\n'), '步骤 5 / 5 · 保存前确认');

  let providerRecovery = snapshot.providerRecovery;
  if (snapshot.agentKind === 'codex') {
    const mode = await p.select({
      message: '主会话遇到临时 API 错误后自动继续？',
      initialValue: !providerRecovery.enabled ? 'off' : providerRecovery.providers.length ? 'selected' : 'all',
      options: [
        { value: 'all', label: '所有 provider（推荐）', hint: '终止失败后退避恢复；故障预算一小时，/recover off 关闭' },
        { value: 'selected', label: '仅选定 provider' },
        { value: 'off', label: '关闭自动继续' },
      ],
    });
    assertPrompt(mode);
    let providers = providerRecovery.providers;
    if (mode === 'selected') {
      const choices = new Map(ccProviders.map(provider => [provider.id, provider.name]));
      for (const id of providers) if (!choices.has(id)) choices.set(id, id);
      if (snapshot.mainProvider.configuredCodexProviderId) choices.set(snapshot.mainProvider.configuredCodexProviderId, `Codex: ${snapshot.mainProvider.configuredCodexProviderId}`);
      if (!choices.size) throw new Error('没有可识别的 provider；请先配置 cc-switch。');
      const selected = await p.multiselect({ message: '允许自动继续的 provider',
        options: [...choices].map(([value, label]) => ({ value, label })), initialValues: providers, required: true });
      assertPrompt(selected);
      providers = selected;
    }
    providerRecovery = {
      ...providerRecovery,
      enabled: mode !== 'off',
      version: 2,
      continuous: false,
      providers: mode === 'all' ? [] : providers,
    };
    p.note(`自动恢复：${providerRecovery.enabled ? '开启' : '关闭'}；故障预算 ${providerRecovery.budgetSeconds / 60} 分钟。活动重连只读观察，不注入 continue。` +
      `当前会话可用 /recover off/on/status 控制；/stop 会停止当前任务。`, '主会话恢复');
  }
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
      ...(profile.codex ? { codex: { ...profile.codex, providerRecovery } } : {}),
      ...(dsh ? { dsh } : {}),
      subagents: {
        ...DEFAULT_SUBAGENT_CONFIG,
        ...profile.subagents,
        enabled: selectedMode !== 'off',
        mode: selectedMode,
        routeMode,
        ccSwitchProviderId: routeMode === 'follow-cc-switch'
          ? selectedCcProvider
          : currentSubagents.ccSwitchProviderId ?? null,
        providerOverrides,
        providerPriority,
        readRoute,
        writeRoute: unifiedRouting ? null : currentSubagents.writeRoute,
        modelTools,
        nativeToolPolicy,
        maxConcurrentWorkers,
        workerTimeoutMs,
        sideTimeoutMs,
        sideReasoningEffort,
        webSearch,
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
  p.outro(dsh
    ? '已保存。下一轮主会话和下一条 /btw 会读取新设置。'
    : '已保存。下一条 /btw 会重新解析路由；Broker dynamic tools/native shadow 从新 thread 生效，旧 thread 不会静默绕过。');
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
  const [diagnostics, rsiStatus, configuredCodexIdentity, hosts, dshProvider] = await Promise.all([
    collectSubagentDiagnostics({
      config: subagentConfig,
      dsh: profile.dsh,
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
    profile.dsh ? resolveDshProvider(profile.dsh, env).catch(() => undefined) : undefined,
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
    providerRecovery: normalizeProviderRecovery(profile.codex?.providerRecovery),
    profile: profileName,
    agentKind: profile.agentKind,
    workspace: cwd,
    ccSwitch: diagnostics.ccSwitch,
    ...(profile.dsh ? { dsh: {
      provider: dshProvider?.id ?? profile.dsh.ccSwitchProviderId ?? null,
      model: dshProvider?.model ?? null,
      ...(profile.dsh.ccSwitchProviderId ? { pinnedProvider: profile.dsh.ccSwitchProviderId } : {}),
      ...(dshProvider?.api ? { api: dshProvider.api } : {}),
    } } : {}),
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
        `- ${route.id}: ${route.provider}/${route.model} access=workspace-write` +
        '（/btw 需 --write --workspace 逐任务授权）'
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
      ` MCP=${diagnostics.mcp.status} version=${diagnostics.packageVersion ?? '(unknown)'}` +
      ` progress=${diagnostics.progress.mode}` +
      ` vendorBroker=${diagnostics.launchCompatibility.vendor}` +
      ` legacyNpmBroker=${diagnostics.launchCompatibility.legacyNpm}` +
      ` legacyNpmRuntime=${diagnostics.launchCompatibility.legacyNpmRuntime}`,
    `subagent model preferences=${JSON.stringify(snapshot.subagents.config.providerOverrides ?? {})}`,
    `subagent provider priority=${JSON.stringify(snapshot.subagents.config.providerPriority ?? [])}`,
    `Broker tools=${diagnostics.modelTools.brokerWired ? 'wired' : 'degraded'}` +
      ` namespace=${diagnostics.modelTools.namespace}` +
      ` native=${diagnostics.modelTools.nativeToolPolicy}` +
      ` maxWorkers=${diagnostics.limits.maxConcurrentWorkers}` +
      ` workerTimeoutMs=${diagnostics.limits.workerTimeoutMs}` +
      ` sideTimeoutMs=${diagnostics.limits.sideTimeoutMs}` +
      ` sideReasoning=${diagnostics.limits.sideReasoningEffort}` +
      ` writeWorkers=${diagnostics.limits.allowWriteWorkers}`,
    `web search mode=${diagnostics.webSearch.mode}` +
      ` providerSupported=${diagnostics.webSearch.providerSupported ?? 'unknown'}` +
      ` effective=${diagnostics.webSearch.effective}` +
      ` reason=${diagnostics.webSearch.reason}`,
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

async function selectProviderModels(
  providerName: string,
  models: string[],
  previous: string[],
): Promise<string[]> {
  if (!models.length) throw new Error(`${providerName} 没有可选择的模型`);
  const initial = previous.filter(model => models.includes(model));
  for (;;) {
    const chosen = await p.multiselect<string>({
      message: `${providerName} 使用哪些模型？选 1–2 个（side、可写子代理和 reviewer 共用）`,
      options: models.map(value => ({ value, label: value })),
      initialValues: initial.length ? initial : [models[0]!],
      required: true,
    });
    assertPrompt(chosen);
    if (chosen.length < 1 || chosen.length > 2) {
      p.note('每个 provider 请选择一到两个模型。', '请重新选择');
      continue;
    }
    if (chosen.length === 1) return chosen;
    const primary = await p.select<string>({
      message: `${providerName} 优先使用哪个模型？`,
      options: chosen.map(value => ({ value, label: value })),
      initialValue: initial.find(model => chosen.includes(model)) ?? chosen[0],
    });
    assertPrompt(primary);
    return [primary, ...chosen.filter(model => model !== primary)];
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

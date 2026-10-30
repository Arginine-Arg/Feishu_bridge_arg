import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ProfileConfig, SubagentConfig } from '../../config/profile-schema';
import { loadRootConfig } from '../../config/profile-store';
import { materializeCcSwitchBrokerRuntime } from '../../integrations/cc-switch-provider';
import { readCcSwitchCurrentProvider } from '../../integrations/cc-switch';
import { sanitizeAgentEnv } from '../../platform/network-env';
import { writeFileAtomic } from '../../platform/atomic-write';
import { log } from '../../core/logger';
import {
  applyCodexCredentialEnv,
  defaultCodexHome,
  resolveCodexCredentialEnv,
  type CodexCredentialResolution,
} from '../codex/credentials';
import {
  resolveCodexActiveConfigIdentity,
  resolveCodexProvider,
} from '../codex/provider';
import { BrokerToolController, brokerCodexThreadConfig, brokerToolSpecs, BROKER_TOOL_VERSION, DEFAULT_BROKER_TOOL_NAMESPACE } from '../subagents/broker-tools';
import { redactSecrets } from '../subagents/mcp-client';
import type { MixAgentsRuntimeOverrides } from '../subagents/mixagents';
import { CodexStructuredSession } from './codex';
import {
  codexThreadPermissionOverrides,
  releaseCodexThreadWriter,
  resumeCodexThread,
  type CodexApprovalPolicy,
} from './permissions';
import { connectCodexHost } from './host';
import {
  fingerprintCredentialEnv,
  fileStamp,
  processAlive,
  codexHostRuntimeDirectory,
  dropOwner,
  readHostRegistry,
} from './host-registry';
import { RpcClient, type Wire } from './rpc';
import { resolveAppServerSocketPath } from './socket-security';
import { discoverCodexThreadWriterOwners } from './thread-owner';

const MAX_HANDOFF_CHARS = 48_000;

export interface NativeCodexEnvironment {
  env: NodeJS.ProcessEnv;
  codexHome?: string;
  thirdParty: boolean;
  credential: CodexCredentialResolution;
  runtimeIdentity?: {
    ccSwitchProviderId?: string;
    codexProviderId: string;
    model?: string;
    recordedAt: number;
  };
  fingerprint: {
    credentials: Record<string, string>;
    networkMode: string;
    configStamp?: string;
    authStamp?: string;
  };
}

export interface NativeBridgeSessionOptions {
  profileName: string;
  profileDir: string;
  cwd: string;
  config: ProfileConfig;
  configFile?: string;
  env?: NodeJS.ProcessEnv;
  binary: string;
  codexHome?: string;
  sandbox: NativeSandbox;
  approvalPolicy?: CodexApprovalPolicy;
  /** Attach to an existing Bridge-managed thread. */
  threadId?: string;
  /** Migrate a legacy thread into a new Bridge-managed thread. */
  adoptThreadId?: string;
  /**
   * With --adopt, create the destination under the current cc-switch
   * provider/model instead of inheriting the source thread's App Server.
   */
  followCurrentProvider?: boolean;
}

export type NativeSandbox = 'read-only' | 'workspace-write' | 'danger-full-access';

export interface NativeBridgeSession {
  mode: 'new' | 'adopted' | 'attached';
  threadId: string;
  oldThreadId?: string;
  /** True when --adopt resolves an intact marker instead of creating a thread. */
  reusedAdoption?: boolean;
  providerSelection?: NativeBridgeProviderSelection;
  endpoint: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  markerPath: string;
  ownsHost: boolean;
  controller?: BrokerToolController;
  session?: CodexStructuredSession;
  close(): Promise<void>;
}

export interface NativeBridgeProviderSelection {
  ccSwitchProviderId?: string;
  modelProvider: string;
  model: string;
  /** Opaque hash of provider/model/fingerprint; contains no credential values. */
  runtimeFingerprint: string;
}

/**
 * Prepare the same provider/credential/network environment used by the
 * ordinary native launcher. Keeping this separate makes the Broker-managed
 * path use exactly the same cc-switch and auth semantics as `native`.
 */
export async function prepareNativeCodexEnvironment(input: {
  config: ProfileConfig;
  env?: NodeJS.ProcessEnv;
  codexHome?: string;
}): Promise<NativeCodexEnvironment> {
  const sourceEnv = { ...(input.env ?? process.env) };
  const activeHome = input.codexHome ?? defaultCodexHome(sourceEnv);
  const [provider, activeIdentity, ccSwitch] = await Promise.all([
    resolveCodexProvider(activeHome),
    resolveCodexActiveConfigIdentity(activeHome),
    readCcSwitchCurrentProvider(sourceEnv),
  ]);
  const thirdParty = !provider.official;
  const env = await sanitizeAgentEnv(sourceEnv, input.config.network, {
    thirdPartyProvider: thirdParty,
  });
  if (input.codexHome) env.CODEX_HOME = input.codexHome;
  const credential = await resolveCodexCredentialEnv(env.CODEX_HOME, {
    baseEnv: env,
  });
  applyCodexCredentialEnv(credential, env);
  const runtimeIdentity = activeIdentity
    ? {
        ...(ccSwitch.providerId ? { ccSwitchProviderId: ccSwitch.providerId } : {}),
        codexProviderId: activeIdentity.codexProviderId,
        ...(activeIdentity.model ? { model: activeIdentity.model } : {}),
        recordedAt: Date.now(),
      }
    : undefined;
  return {
    env,
    ...(input.codexHome ? { codexHome: input.codexHome } : {}),
    thirdParty,
    credential,
    ...(runtimeIdentity ? { runtimeIdentity } : {}),
    fingerprint: {
      credentials: fingerprintCredentialEnv(credential.env),
      networkMode: thirdParty ? 'inherit:third-party-direct' : input.config.network?.mode ?? 'inherit',
      configStamp: env.CODEX_HOME ? fileStamp(join(env.CODEX_HOME, 'config.toml')) : undefined,
      authStamp: env.CODEX_HOME ? fileStamp(join(env.CODEX_HOME, 'auth.json')) : undefined,
    },
  };
}

export function resolveFollowCurrentProviderSelection(
  prepared: NativeCodexEnvironment,
): NativeBridgeProviderSelection {
  const identity = prepared.runtimeIdentity;
  if (!identity?.ccSwitchProviderId) {
    throw new Error('无法解析当前 cc-switch Codex provider ID；已拒绝 follow-current-provider 迁移');
  }
  if (!identity.codexProviderId) {
    throw new Error('无法解析当前 Codex model_provider；已拒绝 follow-current-provider 迁移');
  }
  if (!identity.model) {
    throw new Error('无法解析当前 Codex model；已拒绝 follow-current-provider 迁移');
  }
  if (prepared.credential.missingToken) {
    throw new Error(
      `当前 provider ${identity.ccSwitchProviderId} 缺少凭据字段 ${prepared.credential.envKey ?? '(unknown)'}；` +
        '已拒绝创建可能使用旧 key 的 Bridge thread',
    );
  }
  const runtimeFingerprint = createHash('sha256')
    .update(JSON.stringify({
      ccSwitchProviderId: identity.ccSwitchProviderId,
      modelProvider: identity.codexProviderId,
      model: identity.model,
      fingerprint: prepared.fingerprint,
    }))
    .digest('hex');
  return {
    ccSwitchProviderId: identity.ccSwitchProviderId,
    modelProvider: identity.codexProviderId,
    model: identity.model,
    runtimeFingerprint,
  };
}

export async function createNativeBridgeSession(
  input: NativeBridgeSessionOptions,
): Promise<NativeBridgeSession> {
  if (input.adoptThreadId && input.threadId) {
    throw new Error('--adopt and a positional thread cannot be used together');
  }
  if (!input.config.subagents) {
    throw new Error('当前 profile 没有 subagents 配置；请先运行 arg-bridge settings');
  }
  if (input.config.agentKind !== 'codex') {
    throw new Error('arg-bridge native --bridge 只支持 Codex profile');
  }

  const prepared = await prepareNativeCodexEnvironment({
    config: input.config,
    env: input.env,
    codexHome: input.codexHome,
  });
  const env = prepared.env;
  const config = input.config.subagents;
  if (
    !config.enabled ||
    !config.modelTools ||
    config.nativeToolPolicy !== 'shadow' ||
    config.mode === 'off' ||
    config.mode === 'fork'
  ) {
    throw new Error(
      '当前 settings 没有启用严格的 Broker interface（需要 modelTools=true、mode=auto/broker、nativeToolPolicy=shadow）；' +
        '请先运行 arg-bridge settings',
    );
  }

  const namespace = config.toolNamespace || DEFAULT_BROKER_TOOL_NAMESPACE;
  const markerPath = join(input.profileDir, 'structured', 'broker-threads.json');
  const requestedThread = input.threadId?.trim();
  const adoptThread = input.adoptThreadId?.trim();
  if (input.followCurrentProvider && !adoptThread) {
    throw new Error('--follow-current-provider 只能与 --adopt <thread-id> 一起使用');
  }
  if (input.followCurrentProvider && requestedThread) {
    throw new Error('--follow-current-provider migration 不能同时指定 positional thread');
  }
  const providerSelection = input.followCurrentProvider
    ? resolveFollowCurrentProviderSelection(prepared)
    : undefined;
  const lineageHead = adoptThread
    ? await findLatestAdoptedThreadMarker(markerPath, adoptThread, namespace)
    : undefined;
  const adoptedMarker = lineageHead &&
    (!providerSelection || adoptedThreadMarkerMatchesProvider(lineageHead, providerSelection))
    ? lineageHead
    : undefined;
  const adoptionSourceThread = providerSelection && lineageHead && !adoptedMarker
    ? lineageHead.threadId
    : adoptThread;
  const existingThread = requestedThread ?? adoptedMarker?.threadId;

  if (requestedThread) {
    const marker = await readThreadMarker(markerPath, requestedThread);
    if (!marker || marker.namespace !== namespace) {
      throw new Error(
        `thread ${requestedThread} 没有匹配的 Bridge Broker marker。` +
          '请使用 --adopt 做安全迁移；不能伪造 marker。',
      );
    }
  }

  let sourceHost = providerSelection && adoptionSourceThread && !adoptedMarker
    ? await findLoadedThreadHost(input.profileDir, adoptionSourceThread, env)
    : undefined;
  let host = existingThread
    ? await findLoadedThreadHost(input.profileDir, existingThread, env)
    : undefined;
  if (!host && adoptThread && !providerSelection) {
    host = await findLoadedThreadHost(input.profileDir, adoptThread, env);
  }
  const nativeScope = providerSelection
    ? `native-bridge-follow-current:${input.profileName}:${input.cwd}:${providerSelection.runtimeFingerprint}`
    : `native-bridge:${input.profileName}:${input.cwd}`;
  const nativeHostDirectory = codexHostRuntimeDirectory(
    input.profileDir,
    nativeScope,
    input.cwd,
    { env },
  );
  let ownsHost = false;
  if (!host) {
    try {
      const connected = await connectCodexHost({
        binary: input.binary,
        profileDir: input.profileDir,
        scope: nativeScope,
        cwd: input.cwd,
        env,
        fingerprint: prepared.fingerprint,
        ...(prepared.runtimeIdentity ? { runtimeIdentity: prepared.runtimeIdentity } : {}),
      });
      host = {
        rpc: connected.rpc,
        endpoint: connected.endpoint,
        directory: nativeHostDirectory,
      };
      ownsHost = true;
    } catch (error) {
      sourceHost?.rpc.close();
      throw error;
    }
  }
  if (!host) throw new Error('Bridge native App Server host 不可用');

  let rpc = host.rpc;
  let endpoint = host.endpoint;
  let markerThreadId: string | undefined;
  let oldThreadId: string | undefined;
  let mode: NativeBridgeSession['mode'] = 'new';
  let reusedAdoption = false;
  let controller: BrokerToolController | undefined;
  let session: CodexStructuredSession | undefined;
  const owned = ownsHost;

  const close = async (): Promise<void> => {
    await session?.close().catch(() => {});
    await controller?.close().catch(() => {});
    await releaseCodexThreadWriter(rpc, markerThreadId);
    sourceHost?.rpc.close();
    rpc.close();
    if (owned) await dropOwner(input.profileDir).catch(() => {});
  };

  try {
    if (existingThread) {
      const resumed = await resumeCodexThread(
        rpc,
        { threadId: existingThread, excludeTurns: true, cwd: input.cwd },
        codexThreadPermissionOverrides(input.sandbox, input.approvalPolicy),
        180_000,
        { preserveProviderModel: true },
      );
      if (providerSelection) {
        const resumedProvider = typeof resumed.thread?.modelProvider === 'string'
          ? resumed.thread.modelProvider
          : typeof resumed.modelProvider === 'string'
            ? resumed.modelProvider
            : '';
        const resumedModel = typeof resumed.thread?.model === 'string'
          ? resumed.thread.model
          : typeof resumed.model === 'string'
            ? resumed.model
            : '';
        if (
          resumedProvider !== providerSelection.modelProvider ||
          resumedModel !== providerSelection.model
        ) {
          throw new Error(
            `已有 follow-current-provider thread 的 provider/model 不匹配：` +
              `期望 ${providerSelection.modelProvider}/${providerSelection.model}，` +
              `实际 ${resumedProvider || '(missing)'}/${resumedModel || '(missing)'}`,
          );
        }
      }
      markerThreadId = existingThread;
      mode = adoptedMarker ? 'adopted' : 'attached';
      if (adoptedMarker) {
        oldThreadId = adoptedMarker.previousThreadId ?? adoptThread;
        reusedAdoption = true;
      }
    }

    if (!markerThreadId && adoptThread) {
      const sourceThreadId = adoptionSourceThread ?? adoptThread;
      if (sourceThreadId !== adoptThread && !sourceHost) {
        throw new Error(
          `最新 provider lineage head ${sourceThreadId} 的 owner App Server 当前不可用；` +
            '为避免丢失最近上下文，已拒绝复用更早的 provider branch。请先恢复该 thread 的 owner 后重试。',
        );
      }
      const old = await readIdleThread(sourceHost?.rpc ?? rpc, sourceThreadId);
      sourceHost?.rpc.close();
      sourceHost = undefined;
      const sourceSnapshot = await readThreadHistorySnapshot(input.profileDir, sourceThreadId);
      const extracted = extractAssistantHistory(old, {
        excludeTurnIds: new Set(sourceSnapshot?.turnIds ?? []),
      });
      const history = boundHandoffEntries([
        ...handoffEntriesFromItems(sourceSnapshot?.items ?? []),
        ...handoffEntriesFromItems(extracted.items),
      ]);
      const historyTurnIds = [
        ...(sourceSnapshot?.turnIds ?? []),
        ...turnIdsFromThread(old),
      ];
      if (history.items.length === 0) {
        throw new Error(
          `旧 thread ${sourceThreadId} 没有可安全注入的 user/assistant 文本历史；已拒绝创建空迁移线程`,
        );
      }
      oldThreadId = sourceThreadId;
      mode = 'adopted';
      const started = await startBridgeThread(rpc, {
        cwd: input.cwd,
        config,
        sandbox: input.sandbox,
        approvalPolicy: input.approvalPolicy,
        namespace,
        adoptedFrom: sourceThreadId,
        ...(providerSelection ? { providerSelection } : {}),
      });
      markerThreadId = started.id;
      await rpc.request('thread/inject_items', {
        threadId: markerThreadId,
        items: history.items,
      }, 180_000);
      await writeThreadHistorySnapshot(
        input.profileDir,
        markerThreadId,
        history,
        historyTurnIds,
      );
      await materializeBridgeThread(rpc, markerThreadId, sourceThreadId);
    } else if (!markerThreadId) {
      const started = await startBridgeThread(rpc, {
        cwd: input.cwd,
        config,
        sandbox: input.sandbox,
        approvalPolicy: input.approvalPolicy,
        namespace,
      });
      markerThreadId = started.id;
      await materializeBridgeThread(rpc, markerThreadId);
    }

    if (!markerThreadId) throw new Error('Codex 没有返回 Bridge-managed thread ID');
    const configFile = input.configFile;
    const getConfig = async (): Promise<SubagentConfig> => {
      if (!configFile) return config;
      const root = await loadRootConfig(configFile);
      return root?.profiles[input.profileName]?.subagents ?? config;
    };
    const runtimeResolver = async (): Promise<MixAgentsRuntimeOverrides | undefined> => {
      const current = await getConfig();
      if (
        !current.enabled ||
        current.routeMode !== 'follow-cc-switch' ||
        (current.mode !== 'auto' && current.mode !== 'broker')
      ) return undefined;
      const generated = await materializeCcSwitchBrokerRuntime({
        env,
        ...(input.codexHome ? { codexHome: input.codexHome } : {}),
        ...(prepared.runtimeIdentity?.ccSwitchProviderId
          ? { parentProviderId: prepared.runtimeIdentity.ccSwitchProviderId }
          : {}),
        ...(current.ccSwitchProviderId ? { providerId: current.ccSwitchProviderId } : {}),
        cwd: input.cwd,
        codexBin: input.binary,
        stateDir: join(input.profileDir, 'structured'),
      });
      return {
        brokerConfigPath: generated.brokerConfigPath,
        credentials: generated.credentials,
        fingerprint: generated.fingerprint,
        route: generated.route,
      };
    };
    controller = new BrokerToolController({
      threadId: markerThreadId,
      cwd: input.cwd,
      scope: `native-bridge:${input.profileName}:${markerThreadId}`,
      stateFile: join(
        input.profileDir,
        'structured',
        `broker-workers-${createHash('sha256').update(markerThreadId).digest('hex').slice(0, 24)}.json`,
      ),
      env,
      namespace,
      getConfig,
      runtimeResolver,
    });
    const preflight = await controller.call('list_routes', {}, AbortSignal.timeout(30_000));
    if (!preflight.success) {
      throw new Error(`Bridge Broker preflight 失败：${preflight.text}`);
    }
    if (!reusedAdoption) {
      await writeThreadMarker(
        markerPath,
        markerThreadId,
        namespace,
        adoptThread ?? oldThreadId,
        providerSelection,
        oldThreadId,
      );
    }
    session = new CodexStructuredSession(markerThreadId, endpoint, rpc, controller);
    return {
      mode,
      threadId: markerThreadId,
      ...(oldThreadId ? { oldThreadId } : {}),
      ...(reusedAdoption ? { reusedAdoption: true } : {}),
      ...(providerSelection ? { providerSelection } : {}),
      endpoint,
      env,
      cwd: input.cwd,
      markerPath,
      ownsHost: owned,
      controller,
      session,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

export interface HandoffHistory {
  items: Array<Record<string, unknown>>;
  sourceChars: number;
}

interface ThreadHistorySnapshot {
  version: 1;
  threadId: string;
  updatedAt: number;
  turnIds: string[];
  items: Array<Record<string, unknown>>;
}

type HandoffEntry = { role: 'user' | 'assistant'; text: string };

function historySnapshotPath(profileDir: string, threadId: string): string {
  return join(
    profileDir,
    'structured',
    'broker-thread-history',
    `${createHash('sha256').update(threadId).digest('hex')}.json`,
  );
}

async function readThreadHistorySnapshot(
  profileDir: string,
  threadId: string,
): Promise<ThreadHistorySnapshot | undefined> {
  try {
    const parsed = JSON.parse(
      await readFile(historySnapshotPath(profileDir, threadId), 'utf8'),
    ) as ThreadHistorySnapshot;
    return parsed.version === 1 &&
      parsed.threadId === threadId &&
      Array.isArray(parsed.items) &&
      Array.isArray(parsed.turnIds)
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

async function writeThreadHistorySnapshot(
  profileDir: string,
  threadId: string,
  history: HandoffHistory,
  turnIds: readonly string[],
): Promise<void> {
  const path = historySnapshotPath(profileDir, threadId);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const snapshot: ThreadHistorySnapshot = {
    version: 1,
    threadId,
    updatedAt: Date.now(),
    turnIds: [...new Set(turnIds)],
    items: history.items,
  };
  await writeFileAtomic(path, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
}

function boundHandoffEntries(entries: readonly HandoffEntry[]): HandoffHistory {
  const selected: HandoffEntry[] = [];
  let chars = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (chars + entry.text.length > MAX_HANDOFF_CHARS && selected.length > 0) break;
    const text = chars + entry.text.length > MAX_HANDOFF_CHARS
      ? entry.text.slice(-(MAX_HANDOFF_CHARS - chars))
      : entry.text;
    selected.unshift({ role: entry.role, text });
    chars += text.length;
  }
  return {
    sourceChars: chars,
    items: selected.map(entry => ({
      type: 'message',
      role: entry.role,
      content: [{
        type: entry.role === 'assistant' ? 'output_text' : 'input_text',
        text: entry.text,
      }],
    })),
  };
}

function handoffEntriesFromItems(items: readonly Record<string, unknown>[]): HandoffEntry[] {
  const entries: HandoffEntry[] = [];
  for (const item of items) {
    if (item.type !== 'message' || (item.role !== 'user' && item.role !== 'assistant')) continue;
    const content = Array.isArray(item.content) ? item.content : [];
    const text = content.flatMap(entry => {
      if (!entry || typeof entry !== 'object') return [];
      const value = (entry as Record<string, unknown>).text;
      return typeof value === 'string' ? [value] : [];
    }).join('\n').trim();
    if (text) entries.push({ role: item.role, text });
  }
  return entries;
}

/**
 * Convert persisted Codex thread items into ordinary Responses input items.
 * Tool calls, reasoning, encrypted agent messages and images are deliberately
 * omitted: the new thread receives bounded user/assistant text only.
 */
export function extractAssistantHistory(
  threadValue: Wire,
  options: { excludeTurnIds?: ReadonlySet<string> } = {},
): HandoffHistory {
  const thread = threadValue.thread ?? threadValue;
  const turns: Wire[] = Array.isArray(thread?.turns) ? thread.turns : [];
  const entries: HandoffEntry[] = [];
  for (const turn of turns) {
    if (options.excludeTurnIds?.has(String(turn?.id ?? ''))) continue;
    for (const item of Array.isArray(turn?.items) ? turn.items : []) {
      if (!item || typeof item !== 'object') continue;
      if (item.type === 'userMessage') {
        const text = textFromUserContent(item.content);
        if (text) entries.push({ role: 'user', text });
      } else if (item.type === 'agentMessage' && typeof item.text === 'string') {
        const text = redactSecrets(item.text.trim());
        if (text) entries.push({ role: 'assistant', text });
      }
    }
  }
  return boundHandoffEntries(entries);
}

function turnIdsFromThread(threadValue: Wire): string[] {
  const thread = threadValue.thread ?? threadValue;
  const turns: Wire[] = Array.isArray(thread?.turns) ? thread.turns : [];
  return turns.flatMap(turn => typeof turn?.id === 'string' && turn.id ? [turn.id] : []);
}

async function startBridgeThread(
  rpc: RpcClient,
  input: {
    cwd: string;
    config: SubagentConfig;
    sandbox: NativeSandbox;
    approvalPolicy?: CodexApprovalPolicy;
    namespace: string;
    adoptedFrom?: string;
    providerSelection?: NativeBridgeProviderSelection;
  },
): Promise<{ id: string; modelProvider: string; model: string }> {
  const configRead: Wire = await rpc.request('config/read', { cwd: input.cwd }).catch(() => ({}));
  const existing = configRead.config?.developer_instructions;
  if (existing != null && typeof existing !== 'string') {
    throw new Error('无法保留 Codex 的 native developer instructions');
  }
  const instructions = [
    existing?.trim() ? existing : '',
    BrokerToolController.instructions(input.namespace),
    ...(input.adoptedFrom
      ? [
          `This Bridge-managed thread is a safe migration from ${input.adoptedFrom}. ` +
            'The injected messages are historical user/assistant text only; tool calls and encrypted payloads were omitted.',
        ]
      : []),
  ].filter(Boolean).join('\n\n');
  const result = await rpc.request('thread/start', {
    cwd: input.cwd,
    config: brokerCodexThreadConfig(input.config),
    developerInstructions: instructions,
    dynamicTools: brokerToolSpecs(input.namespace),
    ...(input.providerSelection ? {
      modelProvider: input.providerSelection.modelProvider,
      model: input.providerSelection.model,
    } : {}),
    ...codexThreadPermissionOverrides(input.sandbox, input.approvalPolicy),
  });
  const id = result.thread?.id;
  if (typeof id !== 'string' || !id) {
    throw new Error('Codex thread/start 没有返回 thread ID');
  }
  const modelProvider = typeof result.modelProvider === 'string'
    ? result.modelProvider
    : (typeof result.thread?.modelProvider === 'string' ? result.thread.modelProvider : '');
  const model = typeof result.model === 'string'
    ? result.model
    : (typeof result.thread?.model === 'string' ? result.thread.model : '');
  if (input.providerSelection) {
    if (modelProvider !== input.providerSelection.modelProvider) {
      throw new Error(
        `新 Bridge thread provider 不匹配：期望 ${input.providerSelection.modelProvider}，` +
          `实际 ${modelProvider || '(missing)'}`,
      );
    }
    if (model !== input.providerSelection.model) {
      throw new Error(
        `新 Bridge thread model 不匹配：期望 ${input.providerSelection.model}，` +
          `实际 ${model || '(missing)'}`,
      );
    }
  }
  return { id, modelProvider, model };
}

/**
 * `thread/start` allocates an id but current Codex does not create a rollout
 * until the thread has model-visible history. A remote TUI cannot resume an
 * unmaterialized id. Inject one bridge-policy developer item (not a user task)
 * so the TUI can attach without spending a model request.
 */
async function materializeBridgeThread(
  rpc: RpcClient,
  threadId: string,
  adoptedFrom?: string,
): Promise<void> {
  await rpc.request('thread/inject_items', {
    threadId,
    items: [{
      type: 'message',
      role: 'developer',
      content: [{
        type: 'input_text',
        text: [
          'Bridge-managed native session initialized.',
          'Use arg_bridge.* tools for delegated work; native collaboration is not the authoritative path.',
          ...(adoptedFrom ? [`This thread is a bounded text migration from ${adoptedFrom}.`] : []),
        ].join(' '),
      }],
    }],
  });
}

async function readIdleThread(rpc: RpcClient, threadId: string): Promise<Wire> {
  const statusResult = await rpc.request('thread/read', {
    threadId,
    includeTurns: false,
  }, 180_000);
  const thread = statusResult.thread ?? statusResult;
  if (!thread || typeof thread !== 'object') {
    throw new Error(`无法读取旧 thread ${threadId}`);
  }
  const turns: Wire[] = Array.isArray(thread.turns) ? thread.turns : [];
  const active = thread.status?.type === 'active' ||
    turns.some(turn => turn.status === 'inProgress');
  if (active) {
    throw new Error(`旧 thread ${threadId} 仍在运行；请等当前 turn 完成后再执行 --adopt`);
  }
  if (turns.length > 0) return statusResult;

  try {
    return await rpc.request('thread/read', {
      threadId,
      includeTurns: true,
    }, 180_000);
  } catch (error) {
    log.warn('agent', 'native-adopt-full-history-unavailable', {
      threadId,
      reason: error instanceof Error ? error.message : String(error),
      fallback: 'recent-tail',
    });
  }

  // Full `thread/read` can exceed the RPC budget for very long histories.
  // Recent turns are sufficient because the handoff itself keeps only a
  // bounded text tail.
  const recent: Wire = await rpc.request('thread/turns/list', {
    threadId,
    limit: 200,
    sortDirection: 'desc',
  }, 180_000).catch(() => ({}));
  const newest = Array.isArray(recent.data) ? recent.data : [];
  if (newest.length === 0) {
    throw new Error(`无法读取旧 thread ${threadId} 的最近历史；完整读取超时且 recent-tail 为空`);
  }
  return {
    ...statusResult,
    thread: {
      ...thread,
      turns: [...newest].reverse(),
    },
  };
}

export async function findLoadedThreadHost(
  profileDir: string,
  threadId: string | undefined,
  env: NodeJS.ProcessEnv,
): Promise<{ rpc: RpcClient; endpoint: string; directory: string } | undefined> {
  if (!threadId) return undefined;
  const codexHome = env.CODEX_HOME ?? defaultCodexHome(env);
  const owner = codexHome
    ? discoverCodexThreadWriterOwners(codexHome, threadId)
    : { pids: [], endpoints: [] };
  const registry = (await readHostRegistry(profileDir)).filter(host => processAlive(host.pid));

  // The writer lock is the authoritative ownership signal. A different
  // App Server sharing CODEX_HOME can read this thread's JSONL history, so
  // `thread/read` must never be used to guess that it owns the live runtime.
  if (owner.pids.length > 0) {
    if (owner.endpoints.length === 0) {
      throw new Error(
        `thread ${threadId} 的 writer 由 PID ${owner.pids.join(', ')} 持有，但无法安全定位其 App Server socket；` +
          '已拒绝启动新的 writer。请保留原后台或提供有效 socket 后重试。',
      );
    }
    log.info('agent', 'codex-thread-owner-discovered', {
      threadId,
      pids: owner.pids,
      endpoints: owner.endpoints,
    });
    const loaded = await probeLoadedEndpoints(owner.endpoints, threadId, env);
    if (loaded.length === 1) return loaded[0];
    if (loaded.length > 1) {
      throw new Error(
        `thread ${threadId} 同时出现在多个 writer-owner endpoint；所有权不明确，已拒绝创建竞争 writer。`,
      );
    }
    throw new Error(
      `thread ${threadId} 的 writer 由 PID ${owner.pids.join(', ')} 持有，但其已知 App Server endpoint 未报告该 thread 已加载；` +
        '已拒绝冷启动新的 writer。',
    );
  }

  // Platforms without /proc or a short-lived startup race can leave the lock
  // unavailable. Only an explicit loaded-list match is sufficient; a readable
  // rollout is historical data, not proof of ownership.
  const registered = registry.map(host => join(host.directory, 'server.sock'));
  const loaded = await probeLoadedEndpoints(
    registered,
    threadId,
    env,
  );
  if (loaded.length > 1) {
    throw new Error(
      `thread ${threadId} 同时被多个注册后台报告为已加载；所有权不明确，已拒绝创建竞争 writer。`,
    );
  }
  return loaded[0];
}

async function probeLoadedEndpoints(
  socketPaths: readonly string[],
  threadId: string,
  env: NodeJS.ProcessEnv,
): Promise<Array<{ rpc: RpcClient; endpoint: string; directory: string }>> {
  const loaded: Array<{ rpc: RpcClient; endpoint: string; directory: string }> = [];
  const seen = new Set<string>();
  for (const candidate of socketPaths) {
    let socketPath: string;
    try {
      socketPath = await resolveAppServerSocketPath(candidate);
    } catch {
      continue;
    }
    if (seen.has(socketPath)) continue;
    seen.add(socketPath);
    let rpc: RpcClient | undefined;
    try {
      rpc = await RpcClient.connect(`ws+unix://${socketPath}:/`, {
        codexHome: env.CODEX_HOME,
      });
      await rpc.initialize();
      const result = await rpc.request('thread/loaded/list', {});
      if (Array.isArray(result.data) && result.data.includes(threadId)) {
        loaded.push({
          rpc,
          endpoint: `unix://${socketPath}`,
          directory: dirname(socketPath),
        });
        continue;
      }
    } catch {
      // A stale owner registration is not permission to cold-resume elsewhere.
    }
    rpc?.close();
  }
  return loaded;
}

interface ThreadMarker {
  version: number;
  namespace: string;
  createdAt: number;
  adoptedFrom?: string;
  previousThreadId?: string;
  followCurrentProvider?: boolean;
  ccSwitchProviderId?: string;
  modelProvider?: string;
  model?: string;
  runtimeFingerprint?: string;
}

export interface AdoptedThreadMarker {
  threadId: string;
  createdAt: number;
  previousThreadId?: string;
  followCurrentProvider?: boolean;
  ccSwitchProviderId?: string;
  modelProvider?: string;
  model?: string;
  runtimeFingerprint?: string;
}

async function readAdoptionMarkers(
  path: string,
  adoptedFrom: string,
  namespace: string,
): Promise<AdoptedThreadMarker[]> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as {
      version?: number;
      threads?: Record<string, ThreadMarker>;
    };
    if (parsed.version !== 1 || !parsed.threads || typeof parsed.threads !== 'object') {
      return [];
    }
    return Object.entries(parsed.threads)
      .flatMap(([threadId, marker]): AdoptedThreadMarker[] => {
        if (
          !threadId ||
          marker?.version !== BROKER_TOOL_VERSION ||
          marker.namespace !== namespace ||
          marker.adoptedFrom !== adoptedFrom
        ) return [];
        return [{
          threadId,
          createdAt: Number.isFinite(marker.createdAt) ? marker.createdAt : 0,
          ...(marker.previousThreadId ? { previousThreadId: marker.previousThreadId } : {}),
          ...(marker.followCurrentProvider ? { followCurrentProvider: true } : {}),
          ...(marker.ccSwitchProviderId ? { ccSwitchProviderId: marker.ccSwitchProviderId } : {}),
          ...(marker.modelProvider ? { modelProvider: marker.modelProvider } : {}),
          ...(marker.model ? { model: marker.model } : {}),
          ...(marker.runtimeFingerprint ? { runtimeFingerprint: marker.runtimeFingerprint } : {}),
        }];
      })
      .sort((left, right) =>
        right.createdAt - left.createdAt || right.threadId.localeCompare(left.threadId)
      );
  } catch {
    return [];
  }
}

export function adoptedThreadMarkerMatchesProvider(
  marker: Pick<
    AdoptedThreadMarker,
    'followCurrentProvider' | 'ccSwitchProviderId' | 'modelProvider' | 'model' | 'runtimeFingerprint'
  >,
  providerSelection: NativeBridgeProviderSelection,
): boolean {
  return marker.followCurrentProvider === true &&
    marker.ccSwitchProviderId === providerSelection.ccSwitchProviderId &&
    marker.modelProvider === providerSelection.modelProvider &&
    marker.model === providerSelection.model &&
    marker.runtimeFingerprint === providerSelection.runtimeFingerprint;
}

/** Latest thread in one adopted lineage, regardless of the provider that created it. */
export async function findLatestAdoptedThreadMarker(
  path: string,
  adoptedFrom: string,
  namespace: string,
): Promise<AdoptedThreadMarker | undefined> {
  return (await readAdoptionMarkers(path, adoptedFrom, namespace))[0];
}

/**
 * Reuse is safe only when the newest branch already uses the selected
 * provider. Returning an older branch here would discard context appended by a
 * newer provider generation.
 */
export async function findAdoptedThreadMarker(
  path: string,
  adoptedFrom: string,
  namespace: string,
  providerSelection?: NativeBridgeProviderSelection,
): Promise<AdoptedThreadMarker | undefined> {
  const latest = await findLatestAdoptedThreadMarker(path, adoptedFrom, namespace);
  if (!latest) return undefined;
  if (providerSelection && !adoptedThreadMarkerMatchesProvider(latest, providerSelection)) {
    return undefined;
  }
  return latest;
}

async function readThreadMarker(
  path: string,
  threadId: string,
): Promise<ThreadMarker | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as {
      version?: number;
      threads?: Record<string, ThreadMarker>;
    };
    const marker = parsed.version === 1 ? parsed.threads?.[threadId] : undefined;
    return marker && marker.version === BROKER_TOOL_VERSION && typeof marker.namespace === 'string'
      ? marker
      : undefined;
  } catch {
    return undefined;
  }
}

async function writeThreadMarker(
  path: string,
  threadId: string,
  namespace: string,
  adoptedFrom?: string,
  providerSelection?: NativeBridgeProviderSelection,
  previousThreadId?: string,
): Promise<void> {
  let parsed: {
    version?: number;
    threads?: Record<string, ThreadMarker>;
  } = { version: 1, threads: {} };
  try {
    const current = JSON.parse(await readFile(path, 'utf8')) as typeof parsed;
    if (
      current.version !== 1 ||
      !current.threads ||
      typeof current.threads !== 'object' ||
      Array.isArray(current.threads)
    ) {
      throw new Error(`Broker thread marker 格式无效：${path}`);
    }
    parsed = current;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // First Bridge-managed native thread in this profile.
  }
  const threads = { ...(parsed.threads ?? {}) };
  threads[threadId] = {
    version: BROKER_TOOL_VERSION,
    namespace,
    createdAt: Date.now(),
    ...(adoptedFrom ? { adoptedFrom } : {}),
    ...(previousThreadId && previousThreadId !== adoptedFrom ? { previousThreadId } : {}),
    ...(providerSelection ? {
      followCurrentProvider: true,
      ...(providerSelection.ccSwitchProviderId
        ? { ccSwitchProviderId: providerSelection.ccSwitchProviderId }
        : {}),
      modelProvider: providerSelection.modelProvider,
      model: providerSelection.model,
      runtimeFingerprint: providerSelection.runtimeFingerprint,
    } : {}),
  };
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFileAtomic(path, `${JSON.stringify({ version: 1, threads }, null, 2)}\n`, {
    mode: 0o600,
  });
}

function textFromUserContent(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content.flatMap((entry): string[] => {
    if (typeof entry === 'string') return [entry];
    if (!entry || typeof entry !== 'object') return [];
    const value = entry as Record<string, unknown>;
    return typeof value.text === 'string' ? [value.text] : [];
  }).join('\n').trim();
}

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, readdir, realpath } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
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
  readCodexConfigSummary,
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
  findSocketHolders,
  fileStamp,
  forgetHost,
  processAlive,
  codexHostRuntimeDirectory,
  dropOwner,
  readHostRegistry,
  waitForIdleSocket,
} from './host-registry';
import { RpcClient, type Wire } from './rpc';
import { resolveAppServerSocketPath } from './socket-security';
import { discoverCodexThreadWriterOwners } from './thread-owner';
import {
  acquireNativeThreadLease,
  registerThreadHandoffClient,
  releaseThreadHandoffClients,
  withHostConnectionLock,
} from './thread-handoff';

const MAX_HANDOFF_CHARS = 48_000;
const THREAD_HISTORY_PAGE_SIZE = 20;
const MAX_THREAD_HISTORY_PAGE_REQUESTS = 8;

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
   * Use the current cc-switch provider/model. With --adopt this creates a new
   * destination thread; with --bridge <thread-id> it rebinds that idle thread
   * in place through a provider-specific App Server.
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
  /** True when --bridge <thread-id> changed the thread's provider generation. */
  providerRebound?: boolean;
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
  const codexHome = input.codexHome ?? defaultCodexHome(input.env ?? process.env);
  if (!codexHome) throw new Error('无法确定 Codex home；未启动 native writer');
  const leases: Array<Awaited<ReturnType<typeof acquireNativeThreadLease>>> = [];
  const leased = new Set<string>();
  const claim = async (id: string) => {
    if (leased.has(id)) return;
    leases.push(await acquireNativeThreadLease(codexHome, id, input.profileName)); leased.add(id);
  };
  let bridge: NativeBridgeSession | undefined;
  let unregister: (() => Promise<void>) | undefined;
  try {
    if (input.threadId?.trim()) await claim(input.threadId.trim());
    if (input.adoptThreadId?.trim()) {
      await claim(`adopt:${input.adoptThreadId.trim()}`);
      const head = await findLatestAdoptedThreadMarker(join(input.profileDir, 'structured', 'broker-threads.json'), input.adoptThreadId.trim(), input.config.subagents?.toolNamespace || DEFAULT_BROKER_TOOL_NAMESPACE);
      if (head) await claim(head.threadId);
    }
    bridge = await createNativeBridgeSessionInternal(input);
    await claim(bridge.threadId);
    unregister = await registerThreadHandoffClient({
      codexHome,
      threadId: bridge.threadId,
      endpoint: bridge.endpoint,
      profile: input.profileName,
      inspect: async () => { throw new Error('native 控制连接仍在使用该 thread'); },
      release: async () => {},
    });
    for (const lease of leases) await lease.attached();
    const close = bridge.close;
    let closing: Promise<void> | undefined;
    bridge.close = () => closing ??= (async () => {
      try { await unregister?.(); await close(); }
      finally { for (const lease of leases) await lease.release(); }
    })();
    return bridge;
  } catch (error) {
    await unregister?.();
    await bridge?.close();
    for (const lease of leases) await lease.release();
    throw error;
  }
}

async function createNativeBridgeSessionInternal(
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
  if (input.followCurrentProvider && !adoptThread && !requestedThread) {
    throw new Error(
      '--follow-current-provider 需要 --adopt <thread-id> 或 --bridge <thread-id>',
    );
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
  let existingMarker: ThreadMarker | undefined;

  if (requestedThread) {
    existingMarker = await readThreadMarker(markerPath, requestedThread);
    if (!existingMarker || existingMarker.namespace !== namespace) {
      throw new Error(
        `thread ${requestedThread} 没有匹配的 Bridge Broker marker。` +
          '请使用 --adopt 做安全迁移；不能伪造 marker。',
      );
    }
  }

  const providerGenerationChanged = Boolean(
    providerSelection &&
      requestedThread &&
      (!existingMarker ||
        !adoptedThreadMarkerMatchesProvider(existingMarker, providerSelection)),
  );
  const providerCompatibility = providerSelection &&
    (providerGenerationChanged || existingMarker?.compatibilityProvider)
    ? await buildProviderCompatibilityConfig(
        env.CODEX_HOME ?? defaultCodexHome(env),
        existingThread!,
        existingMarker?.compatibilityProvider ?? existingMarker?.modelProvider,
        providerSelection,
      )
    : undefined;
  const compatibilityScope = providerCompatibility
    ? `:compat-${createHash('sha256').update(providerCompatibility.resumeProvider).digest('hex').slice(0, 16)}`
    : '';
  const nativeScope = providerSelection
    ? `native-bridge-follow-current:${input.profileName}:${input.cwd}:${providerSelection.runtimeFingerprint}${compatibilityScope}`
    : `native-bridge:${input.profileName}:${input.cwd}`;
  const nativeHostDirectory = codexHostRuntimeDirectory(
    input.profileDir,
    nativeScope,
    input.cwd,
    { env },
  );
  let sourceHost = providerSelection && adoptionSourceThread && !adoptedMarker
    ? await findLoadedThreadHost(input.profileDir, adoptionSourceThread, env)
    : undefined;
  const loadedThreadHost = existingThread
    ? await findLoadedThreadHost(input.profileDir, existingThread, env)
    : undefined;
  if (
    providerGenerationChanged &&
    loadedThreadHost &&
    loadedThreadHost.directory !== nativeHostDirectory
  ) {
    await reclaimIdleThreadHost(
      input.profileDir,
      loadedThreadHost,
      existingThread!,
    );
  }
  let host = loadedThreadHost?.directory === nativeHostDirectory
    ? loadedThreadHost
    : (!providerGenerationChanged ? loadedThreadHost : undefined);
  if (!host && adoptThread && !providerSelection) {
    host = await findLoadedThreadHost(input.profileDir, adoptThread, env);
  }
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
        ...(providerCompatibility ? {
          configOverrides: codexConfigOverrideArgs(providerCompatibility.config),
        } : {}),
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
  let providerRebound = false;
  let controller: BrokerToolController | undefined;
  let session: CodexStructuredSession | undefined;
  let sessionCwd = input.cwd;
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
      // A changed provider cannot preflight `thread/read`: Codex validates the
      // thread's historical provider before returning metadata. If an old
      // owner exists, it was already checked (or rejected) above; otherwise
      // the authoritative writer lock showed no active owner and the explicit
      // resume below performs the rebind atomically.
      if (providerSelection && !providerGenerationChanged) {
        await assertIdleThread(
          rpc,
          existingThread,
          '--bridge <thread-id> --follow-current-provider',
        );
      }
      const resumed = await resumeCodexThread(
        rpc,
        {
          threadId: existingThread,
          excludeTurns: true,
          ...(providerSelection ? {
            modelProvider: providerCompatibility?.resumeProvider
              ?? providerSelection.modelProvider,
            model: providerSelection.model,
          } : {}),
          ...(providerCompatibility ? {
            config: providerCompatibility.config,
          } : {}),
        },
        codexThreadPermissionOverrides(input.sandbox, input.approvalPolicy),
        180_000,
        { preserveProviderModel: true },
      );
      const resumedThreadId = typeof resumed.thread?.id === 'string'
        ? resumed.thread.id
        : typeof resumed.id === 'string'
          ? resumed.id
          : '';
      if (resumedThreadId !== existingThread) {
        throw new Error(
          `provider rebind 返回了不同 thread：期望 ${existingThread}，` +
            `实际 ${resumedThreadId || '(missing)'}`,
        );
      }
      markerThreadId = existingThread;
      if (typeof resumed.cwd === 'string' && resumed.cwd) sessionCwd = resumed.cwd;
      else if (typeof resumed.thread?.cwd === 'string' && resumed.thread.cwd) sessionCwd = resumed.thread.cwd;
      if (providerSelection) {
        const expectedProvider = providerCompatibility?.resumeProvider
          ?? providerSelection.modelProvider;
        await verifyNativeProviderSelection(rpc, existingThread, resumed, {
          modelProvider: expectedProvider, model: providerSelection.model,
        });
      }
      markerThreadId = existingThread;
      mode = adoptedMarker ? 'adopted' : 'attached';
      providerRebound = providerGenerationChanged;
      if (adoptedMarker) {
        oldThreadId = adoptedMarker.previousThreadId ?? adoptThread;
        reusedAdoption = true;
      }
    }

    if (!markerThreadId && adoptThread) {
      const sourceThreadId = adoptionSourceThread ?? adoptThread;
      const codexHome = env.CODEX_HOME ?? defaultCodexHome(env);
      const { old, snapshot: sourceSnapshot } = await readAdoptionSourceHistory({
        profileDir: input.profileDir,
        codexHome,
        sourceThreadId,
        ...(sourceHost ? { sourceHost } : {}),
        rpc,
        reconnect: async (): Promise<RpcClient> => {
          const reconnected = await reconnectCodexRpc(endpoint, codexHome);
          rpc = reconnected;
          host.rpc = reconnected;
          return reconnected;
        },
        lineageHead: sourceThreadId !== adoptThread,
      });
      sourceHost?.rpc.close();
      sourceHost = undefined;
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
        (current.routeMode !== 'follow-cc-switch' && current.routeMode !== 'follow-magpie') ||
        (current.mode !== 'auto' && current.mode !== 'broker')
      ) return undefined;
      const source = current.routeMode === 'follow-magpie' ? 'magpie' : 'cc-switch';
      const generated = await materializeCcSwitchBrokerRuntime({
        env,
        ...(input.codexHome ? { codexHome: input.codexHome } : {}),
        ...(prepared.runtimeIdentity?.ccSwitchProviderId
          ? { parentProviderId: prepared.runtimeIdentity.ccSwitchProviderId }
          : {}),
        ...(source === 'magpie'
          ? (current.magpieProviderId ? { providerId: current.magpieProviderId } : {})
          : (current.ccSwitchProviderId ? { providerId: current.ccSwitchProviderId } : {})),
        source,
        cwd: sessionCwd,
        codexBin: input.binary,
        stateDir: join(input.profileDir, 'structured'),
        runtimePolicy: { role: 'worker', webSearch: current.webSearch, sideReasoningEffort: current.sideReasoningEffort, providerOverrides: current.providerOverrides, providerPriority: current.providerPriority, source },
      });
      return {
        brokerConfigPath: generated.brokerConfigPath,
        credentials: generated.credentials,
        fingerprint: generated.fingerprint,
        route: generated.route,
        healthFile: generated.healthFile,
      };
    };
    controller = new BrokerToolController({
      threadId: markerThreadId,
      cwd: sessionCwd,
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
        adoptThread ?? oldThreadId ?? existingMarker?.adoptedFrom,
        providerSelection,
        oldThreadId ?? existingMarker?.previousThreadId,
        providerCompatibility?.resumeProvider,
      );
    }
    session = new CodexStructuredSession(markerThreadId, endpoint, rpc, controller);
    return {
      mode,
      threadId: markerThreadId,
      ...(oldThreadId ? { oldThreadId } : {}),
      ...(reusedAdoption ? { reusedAdoption: true } : {}),
      ...(providerRebound ? { providerRebound: true } : {}),
      ...(providerSelection ? { providerSelection } : {}),
      endpoint,
      env,
      cwd: sessionCwd,
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

/** Resume's top-level identity is effective; nested thread metadata can be historical. */
export async function verifyNativeProviderSelection(
  rpc: RpcClient,
  threadId: string,
  resumed: Wire,
  expected: { modelProvider: string; model: string },
): Promise<void> {
  const provider = typeof resumed.modelProvider === 'string' ? resumed.modelProvider : resumed.thread?.modelProvider;
  let model = typeof resumed.model === 'string' ? resumed.model : resumed.thread?.model;
  if (provider === expected.modelProvider && model !== expected.model) {
    // Codex can reuse an already-loaded thread and ignore model on resume.
    // Apply only the explicitly requested model at a proved idle boundary.
    await assertIdleThread(rpc, threadId, '--follow-current-provider model update');
    let updateError: unknown;
    try { await rpc.request('thread/settings/update', { threadId, model: expected.model }, 10_000); }
    catch (error) { updateError = error; }
    const snapshot = await rpc.request('thread/read', { threadId, includeTurns: false }, 10_000);
    if (snapshot.thread?.status?.type !== 'idle') throw new Error(`thread ${threadId} 在模型切换期间开始工作；请检查当前线程状态`);
    model = snapshot.thread?.model;
    if (model !== expected.model && updateError) throw updateError;
  }
  if (provider !== expected.modelProvider || model !== expected.model) {
    throw new Error(`provider rebind 后的 thread provider/model 不匹配：期望 ${expected.modelProvider}/${expected.model}，实际 ${provider ?? '(missing)'}/${model ?? '(missing)'}；thread=${threadId}，未启动 TUI`);
  }
}

export interface HandoffHistory {
  items: Array<Record<string, unknown>>;
  sourceChars: number;
}

export interface ThreadHistorySnapshot {
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

export async function readIdleThread(
  rpc: RpcClient,
  threadId: string,
  options: {
    codexHome?: string;
    reconnect?: () => Promise<RpcClient>;
  } = {},
): Promise<Wire> {
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
    throw new Error(`thread ${threadId} 仍在运行；请等当前 turn 完成后再执行 --adopt`);
  }
  if (turns.length > 0) return statusResult;

  let paginatedHistory: Wire | undefined;
  let paginatedError: unknown;
  try {
    paginatedHistory = await readPaginatedThreadHistoryTail(rpc, threadId);
  } catch (error) {
    paginatedError = error;
  }

  const paginatedExtracted = paginatedHistory
    ? extractAssistantHistory(paginatedHistory)
    : undefined;
  if (paginatedExtracted?.items.length) {
    if (rpc.closed && options.reconnect) await options.reconnect();
    return paginatedHistory!;
  }

  // Full thread hydration is deliberately avoided: a single JSON-RPC frame
  // over 32 MiB closes the websocket. Rollout JSONL is already local, has the
  // same canonical message ids, and can be streamed with bounded memory.
  const localHistory = options.codexHome
    ? await readThreadHistoryFromRollout(options.codexHome, threadId).catch(error => {
        log.warn('agent', 'native-adopt-rollout-history-unavailable', {
          threadId,
          reason: error instanceof Error ? error.message : String(error),
        });
        return undefined;
      })
    : undefined;
  if (localHistory) {
    if (rpc.closed && options.reconnect) await options.reconnect();
    return {
      ...statusResult,
      thread: {
        ...thread,
        turns: localHistory.thread.turns,
      },
    };
  }

  const reason = paginatedError instanceof Error
    ? `；分页读取失败：${paginatedError.message}`
    : '';
  throw new Error(
    `无法读取旧 thread ${threadId} 的最近历史；分页历史为空，本地 rollout 也不可用${reason}`,
  );
}

async function readPaginatedThreadHistoryTail(
  rpc: RpcClient,
  threadId: string,
): Promise<Wire | undefined> {
  const turns: Wire[] = [];
  let cursor: string | null | undefined;
  for (
    let pageIndex = 0;
    pageIndex < MAX_THREAD_HISTORY_PAGE_REQUESTS;
    pageIndex += 1
  ) {
    let page: Wire;
    try {
      page = await rpc.request('thread/turns/list', {
        threadId,
        limit: THREAD_HISTORY_PAGE_SIZE,
        sortDirection: 'desc',
        // The protocol default is the bounded summary view. Omitting the
        // explicit field keeps compatibility with older 0.16x App Servers.
        ...(cursor ? { cursor } : {}),
      }, 180_000);
    } catch (error) {
      // Keep a valid partial page if a later request closes the socket.
      if (turns.length === 0) throw error;
      break;
    }
    const data = Array.isArray(page.data) ? page.data : [];
    turns.push(...data);
    const history = extractAssistantHistory({ thread: { turns } });
    if (history.sourceChars >= MAX_HANDOFF_CHARS) break;
    if (!page.nextCursor || data.length === 0) break;
    cursor = page.nextCursor;
  }
  if (turns.length === 0) return undefined;
  return {
    thread: {
      turns: [...turns].reverse(),
    },
  };
}

export async function readThreadHistoryFromRollout(
  codexHome: string,
  threadId: string,
): Promise<Wire | undefined> {
  const filePath = await findThreadRolloutFile(codexHome, threadId);
  if (!filePath) return undefined;

  type RolloutEntry = HandoffEntry & {
    id: string;
    ordinal: number;
    turnId?: string;
  };
  const selected: RolloutEntry[] = [];
  const selectedById = new Map<string, RolloutEntry>();
  let selectedChars = 0;
  let observed = 0;
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      observed += 1;
      let record: Wire;
      try {
        record = JSON.parse(line) as Wire;
      } catch {
        continue;
      }
      const payload: Wire = record.payload ?? {};
      const ordinal = typeof record.ordinal === 'number' && Number.isFinite(record.ordinal)
        ? record.ordinal
        : observed;
      let id: string | undefined;
      let role: 'user' | 'assistant' | undefined;
      let text = '';
      let turnId =
        typeof payload.turn_id === 'string'
          ? payload.turn_id
          : typeof payload.internal_chat_message_metadata_passthrough?.turn_id === 'string'
            ? payload.internal_chat_message_metadata_passthrough.turn_id
            : undefined;

      if (
        record.type === 'response_item' &&
        payload.type === 'message' &&
        (payload.role === 'user' || payload.role === 'assistant')
      ) {
        id = typeof payload.id === 'string' ? payload.id : undefined;
        role = payload.role;
        text = textFromMessageContent(payload.content);
      } else if (
        record.type === 'event_msg' &&
        payload.type === 'item_completed' &&
        (payload.item?.type === 'UserMessage' || payload.item?.type === 'AgentMessage')
      ) {
        const item: Wire = payload.item;
        id = typeof item.id === 'string' ? item.id : undefined;
        role = item.type === 'UserMessage' ? 'user' : 'assistant';
        text = role === 'user'
          ? textFromMessageContent(item.content)
          : typeof item.text === 'string' ? item.text : '';
        turnId ??= typeof payload.turn_id === 'string' ? payload.turn_id : undefined;
      }

      text = role === 'assistant' ? redactSecrets(text.trim()) : text.trim();
      if (!role || !text) continue;
      const key = id ?? `${record.type}:${ordinal}`;
      const boundedText = text.length > MAX_HANDOFF_CHARS
        ? text.slice(-MAX_HANDOFF_CHARS)
        : text;
      const existing = selectedById.get(key);
      if (existing) {
        selectedChars -= existing.text.length;
        existing.text = boundedText;
        existing.ordinal = ordinal;
        if (turnId) existing.turnId = turnId;
        selectedChars += existing.text.length;
      } else {
        const entry: RolloutEntry = {
          id: key,
          ordinal,
          role,
          text: boundedText,
          ...(turnId ? { turnId } : {}),
        };
        selected.push(entry);
        selectedById.set(key, entry);
        selectedChars += entry.text.length;
      }
      while (selectedChars > MAX_HANDOFF_CHARS && selected.length > 1) {
        const removed = selected.shift()!;
        selectedChars -= removed.text.length;
        if (selectedById.get(removed.id) === removed) selectedById.delete(removed.id);
      }
      if (selectedChars > MAX_HANDOFF_CHARS) {
        const only = selected[0]!;
        only.text = only.text.slice(-MAX_HANDOFF_CHARS);
        selectedChars = only.text.length;
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }

  if (selected.length === 0) return undefined;

  const grouped = new Map<string, Wire[]>();
  for (const entry of selected) {
    const turnId = entry.turnId ?? `rollout-${entry.ordinal}`;
    const items = grouped.get(turnId) ?? [];
    items.push(entry.role === 'user'
      ? {
          type: 'userMessage',
          content: [{ type: 'input_text', text: entry.text }],
        }
      : {
          type: 'agentMessage',
          text: entry.text,
        });
    grouped.set(turnId, items);
  }
  return {
    thread: {
      turns: [...grouped.entries()].map(([id, items]) => ({ id, items })),
    },
  };
}

export interface AdoptionSourceHistory {
  old: Wire;
  snapshot?: ThreadHistorySnapshot;
}

/**
 * Read the history that a new provider generation inherits.
 *
 * A live owner is preferred because it can answer `thread/read` with real turn
 * ids. When the owner is already gone, the local rollout is the authoritative
 * record: it is complete, already contains the inherited history, and does not
 * depend on a process that may have exited. Only when neither is available do
 * we fall back to the new host and refuse rather than silently rewinding to an
 * older provider branch.
 */
export async function readAdoptionSourceHistory(input: {
  profileDir: string;
  codexHome?: string;
  sourceThreadId: string;
  sourceHost?: Pick<LoadedThreadHost, 'rpc'>;
  rpc: RpcClient;
  reconnect: () => Promise<RpcClient>;
  lineageHead: boolean;
}): Promise<AdoptionSourceHistory> {
  if (input.sourceHost) {
    return {
      old: await readIdleThread(input.sourceHost.rpc, input.sourceThreadId, {
        codexHome: input.codexHome,
      }),
      snapshot: await readThreadHistorySnapshot(input.profileDir, input.sourceThreadId),
    };
  }
  const local = input.codexHome
    ? await readThreadHistoryFromRollout(input.codexHome, input.sourceThreadId)
    : undefined;
  if (local) return { old: local };
  try {
    return {
      old: await readIdleThread(input.rpc, input.sourceThreadId, {
        codexHome: input.codexHome,
        reconnect: input.reconnect,
      }),
      snapshot: await readThreadHistorySnapshot(input.profileDir, input.sourceThreadId),
    };
  } catch (error) {
    if (!input.lineageHead) throw error;
    throw new Error(
      `最新 provider lineage head ${input.sourceThreadId} 的 owner App Server 当前不可用，` +
        '且本地 rollout 不可读；为避免丢失最近上下文，已拒绝复用更早的 provider branch。' +
        '请先恢复该 thread 的 owner 后重试。' +
        `（${error instanceof Error ? error.message : String(error)}）`,
    );
  }
}

async function reconnectCodexRpc(
  endpoint: string,
  codexHome: string | undefined,
): Promise<RpcClient> {
  const url = endpoint.startsWith('unix://')
    ? `ws+unix://${endpoint.slice('unix://'.length)}:/`
    : endpoint;
  const reconnected = await RpcClient.connect(url, {
    ...(codexHome ? { codexHome } : {}),
  });
  try {
    await reconnected.initialize();
    return reconnected;
  } catch (error) {
    reconnected.close();
    throw error;
  }
}

async function assertIdleThread(
  rpc: RpcClient,
  threadId: string,
  operation: string,
): Promise<void> {
  const result = await rpc.request('thread/read', {
    threadId,
    includeTurns: false,
  }, 180_000);
  const thread = result.thread ?? result;
  const turns: Wire[] = Array.isArray(thread?.turns) ? thread.turns : [];
  const active = thread?.status?.type === 'active' ||
    turns.some(turn => turn.status === 'inProgress');
  if (active) {
    throw new Error(
      `thread ${threadId} 仍有活动 turn；不能在运行中执行 ${operation}，请等当前 turn 完成`,
    );
  }
  if (!['idle', 'notLoaded'].includes(thread?.status?.type)) {
    throw new Error(`thread ${threadId} 未确认空闲（status=${thread?.status?.type ?? 'unknown'}）；未执行 ${operation}`);
  }
}

async function buildProviderCompatibilityConfig(
  codexHome: string | undefined,
  threadId: string,
  markerProvider: string | undefined,
  selection: NativeBridgeProviderSelection,
): Promise<{
  resumeProvider: string;
  config: Record<string, unknown>;
} | undefined> {
  if (!codexHome) return undefined;
  const historical = await readHistoricalThreadIdentity(codexHome, threadId);
  const historicalProvider = markerProvider ?? historical.modelProvider;
  if (!historicalProvider || historicalProvider === selection.modelProvider) return undefined;

  const config = await readCodexConfigSummary(join(codexHome, 'config.toml'));
  const current = config.providers.get(selection.modelProvider);
  const officialCurrent = selection.modelProvider === 'openai'
    || selection.modelProvider === 'codex';
  if (!current?.baseUrl && !officialCurrent) return undefined;
  const alias = current?.baseUrl
    ? {
        name: current.name ?? selection.modelProvider,
        base_url: current.baseUrl,
        ...(current.envKey ? { env_key: current.envKey } : {}),
        ...(current.wireApi ? { wire_api: current.wireApi } : {}),
        ...(current.requiresOpenAiAuth !== undefined
          ? { requires_openai_auth: current.requiresOpenAiAuth }
          : {}),
        ...(current.supportsStandaloneWebSearch !== undefined
          ? { supports_standalone_web_search: current.supportsStandaloneWebSearch }
          : {}),
        ...(current.envHttpHeaders ? { env_http_headers: current.envHttpHeaders } : {}),
        ...(current.httpHeaders ? { http_headers: current.httpHeaders } : {}),
      }
    : {
        name: 'OpenAI',
        wire_api: 'responses',
        requires_openai_auth: true,
      };

  return {
    resumeProvider: historicalProvider,
    config: {
      model_provider: historicalProvider,
      model: selection.model,
      model_providers: {
        [historicalProvider]: alias,
      },
    },
  };
}

function codexConfigOverrideArgs(config: Record<string, unknown>): string[] {
  const args: string[] = [];
  const visit = (prefix: string, value: unknown): void => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [key, child] of Object.entries(value)) {
        visit(
          prefix ? `${prefix}.${configPathSegment(key)}` : configPathSegment(key),
          child,
        );
      }
      return;
    }
    const serialized = typeof value === 'string'
      ? JSON.stringify(value)
      : typeof value === 'boolean' || typeof value === 'number'
        ? String(value)
        : JSON.stringify(value);
    if (serialized !== undefined) args.push('-c', `${prefix}=${serialized}`);
  };
  for (const [key, value] of Object.entries(config)) {
    visit(configPathSegment(key), value);
  }
  return args;
}

function configPathSegment(key: string): string {
  return /^[A-Za-z0-9_-]+$/u.test(key) ? key : JSON.stringify(key);
}

async function readHistoricalThreadIdentity(
  codexHome: string,
  threadId: string,
): Promise<{ modelProvider?: string; model?: string }> {
  const filePath = await findThreadRolloutFile(codexHome, threadId);
  if (!filePath) return {};
  const file = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    for (const line of buffer.subarray(0, bytesRead).toString('utf8').split('\n')) {
      try {
        const entry = JSON.parse(line) as Wire;
        if (entry.type !== 'session_meta') continue;
        const payload = entry.payload ?? entry;
        return {
          ...(typeof payload.model_provider === 'string' && payload.model_provider.trim()
            ? { modelProvider: payload.model_provider.trim() }
            : {}),
          ...(typeof payload.model === 'string' && payload.model.trim()
            ? { model: payload.model.trim() }
            : {}),
        };
      } catch {
        // The first line can be partially buffered only if it exceeds
        // the safety window; try the next complete line.
      }
    }
  } finally {
    await file.close();
  }
  return {};
}

async function findThreadRolloutFile(
  codexHome: string,
  threadId: string,
): Promise<string | undefined> {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(threadId)) {
    return undefined;
  }
  const timestamp = Number.parseInt(threadId.replaceAll('-', '').slice(0, 12), 16);
  for (const rootName of ['sessions', 'archived_sessions']) {
    for (const offset of [-86_400_000, 0, 86_400_000]) {
      const date = new Date(timestamp + offset).toISOString().slice(0, 10).split('-');
      const directory = join(codexHome, rootName, ...date);
      for (const name of await readdir(directory).catch(() => [] as string[])) {
        if (name.endsWith(`-${threadId}.jsonl`)) return join(directory, name);
      }
    }
  }
  return undefined;
}

export interface LoadedThreadHost {
  rpc: RpcClient;
  endpoint: string;
  directory: string;
  /** Direct writer-lock holders discovered from `/proc/locks` on Linux. */
  ownerPids?: number[];
}

/**
 * Release an idle thread from an old provider host before the current
 * provider generation resumes it. Codex may retain an idle runtime and its
 * writer lock for an extended period after the native TUI disconnects, while
 * the App Server itself is no longer serving any client.
 */
export async function reclaimIdleThreadHost(
  profileDir: string,
  host: LoadedThreadHost,
  threadId: string,
): Promise<void> {
  const codexHome = host.rpc.codexHome;
  const registrations = await readHostRegistry(profileDir);
  const registered = registrations.find(item => item.directory === host.directory);
  const context = `thread ${threadId}, writer PID ${(host.ownerPids ?? []).join(', ') || 'unknown'}, profile=${registered ? basename(profileDir) : 'unknown'}, endpoint=${host.endpoint}`;
  const owner = () => codexHome ? discoverCodexThreadWriterOwners(codexHome, threadId) : undefined;
  const unlocked = () => process.platform === 'linux' && owner()?.pids.length === 0;
  try {
    if (!codexHome) throw new Error('无法核实 Codex home，未启动竞争 writer');
    await assertIdleThread(host.rpc, threadId, 'provider 交接');
    // Address the real Bot/relay RPC connections, not this read-only probe.
    await releaseThreadHandoffClients(codexHome, threadId, host.endpoint);
    for (let check = 0; check < 10; check += 1) {
      if (unlocked()) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    // Retained idle runtimes (including pre-upgrade hosts) may keep the writer
    // even without subscribers. A shared host is never terminated.
    await assertIdleThread(host.rpc, threadId, 'provider 交接');
    const loaded = await listLoadedThreadIds(host.rpc);
    if (loaded.some(id => id !== threadId)) {
      throw new Error(`目标 writer 尚未释放，旧 Server 还加载其他线程：${loaded.filter(id => id !== threadId).join(', ')}；保留共享 Server`);
    }
    if (!loaded.includes(threadId)) {
      if (unlocked()) return;
      throw new Error('旧 Server 未报告目标线程，writer 归属未确认');
    }
    // A fresh connection's unsubscribe would only affect itself. Closing the
    // probe lets /proc distinguish a retained runtime from actual clients.
    await assertIdleThread(host.rpc, threadId, 'provider 交接');
    host.rpc.close();
    const socketPath = host.endpoint.slice('unix://'.length);
    await withHostConnectionLock(socketPath, async () => {
      if (unlocked()) return;
      if (process.platform !== 'linux' || !await waitForIdleSocket(host.directory, 2_500, socketPath)) {
        throw new Error('旧 Server 仍有未释放的客户端连接（可能是 native TUI 或旧版 Bot）；未终止 Server');
      }
      const current = owner();
      const expected = host.ownerPids ?? [];
      if (!current?.pids.length || !expected.length || current.pids.some(pid => !expected.includes(pid))) {
        if (unlocked()) return;
        throw new Error('writer PID 已变化或未能重新确认，未向进程发送信号');
      }
      // Only signal the confirmed idle server/writer processes, never a
      // process group or another thread's host. No forced SIGKILL escalation.
      const holders = findSocketHolders(host.directory, socketPath);
      const pids = [...new Set([...current.pids, ...holders])];
      for (const pid of pids) {
        try { process.kill(pid, 'SIGTERM'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      }
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && (!unlocked() || pids.some(processAlive))) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (!unlocked() || pids.some(processAlive)) throw new Error(`旧空闲 Server 尚未确认退出（PID ${pids.filter(processAlive).join(', ')}）；交接未完成，可安全重试`);
      if (registered && !processAlive(registered.pid)) await forgetHost(profileDir, host.directory);
      log.info('agent', 'provider-host-idle-handoff', { threadId, pids, directory: host.directory });
    });
    if (!unlocked()) throw new Error('writer 锁尚未释放，未启动新 writer');
  } catch (error) {
    throw new Error(`provider 自动交接失败（${context}）：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    host.rpc.close();
  }
}

async function listLoadedThreadIds(rpc: RpcClient): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    const result = await rpc.request('thread/loaded/list', { limit: 100, ...(cursor ? { cursor } : {}) }, 10_000);
    if (!Array.isArray(result.data) || result.data.some((id: unknown) => typeof id !== 'string')) throw new Error('loaded/list 响应不完整');
    ids.push(...result.data);
    if (!result.nextCursor) return ids;
    if (result.nextCursor === cursor) break;
    cursor = result.nextCursor;
  }
  throw new Error('loaded/list 分页未完成，未猜测独占所有权');
}

export async function findLoadedThreadHost(
  profileDir: string,
  threadId: string | undefined,
  env: NodeJS.ProcessEnv,
): Promise<LoadedThreadHost | undefined> {
  if (!threadId) return undefined;
  const codexHome = env.CODEX_HOME ?? defaultCodexHome(env);
  const owner = codexHome
    ? discoverCodexThreadWriterOwners(codexHome, threadId)
    : { pids: [], endpoints: [] };
  const registry = (await readHostRegistry(profileDir)).filter(host => processAlive(host.pid));
  const locateRegistration = async (host: LoadedThreadHost): Promise<LoadedThreadHost> => {
    for (const registration of registry) {
      const socket = await realpath(join(registration.directory, 'server.sock')).catch(() => undefined);
      if (socket && `unix://${socket}` === host.endpoint) return { ...host, directory: registration.directory };
    }
    return host;
  };

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
    if (loaded.length === 1) return locateRegistration({ ...loaded[0]!, ownerPids: owner.pids });
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
  return loaded[0] ? locateRegistration(loaded[0]) : undefined;
}

async function probeLoadedEndpoints(
  socketPaths: readonly string[],
  threadId: string,
  env: NodeJS.ProcessEnv,
): Promise<Array<Omit<LoadedThreadHost, 'ownerPids'>>> {
  const loaded: Array<Omit<LoadedThreadHost, 'ownerPids'>> = [];
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
      const ids = await listLoadedThreadIds(rpc);
      if (ids.includes(threadId)) {
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
  /** Historical provider ID kept inside the thread while requests use the
   * current provider's endpoint and credential configuration. */
  compatibilityProvider?: string;
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
  compatibilityProvider?: string;
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
          ...(marker.compatibilityProvider
            ? { compatibilityProvider: marker.compatibilityProvider }
            : {}),
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
  compatibilityProvider?: string,
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
  const previous = threads[threadId];
  threads[threadId] = {
    ...(previous ?? {}),
    version: BROKER_TOOL_VERSION,
    namespace,
    createdAt: previous?.createdAt ?? Date.now(),
    ...(adoptedFrom ?? previous?.adoptedFrom
      ? { adoptedFrom: adoptedFrom ?? previous?.adoptedFrom! }
      : {}),
    ...(previousThreadId ?? previous?.previousThreadId
      ? { previousThreadId: previousThreadId ?? previous?.previousThreadId! }
      : {}),
    ...(providerSelection ? {
      followCurrentProvider: true,
      ...(providerSelection.ccSwitchProviderId
        ? { ccSwitchProviderId: providerSelection.ccSwitchProviderId }
        : {}),
      modelProvider: providerSelection.modelProvider,
      model: providerSelection.model,
      runtimeFingerprint: providerSelection.runtimeFingerprint,
      ...(compatibilityProvider ? { compatibilityProvider } : {}),
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

function textFromMessageContent(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content.flatMap((entry): string[] => {
    if (typeof entry === 'string') return [entry];
    if (!entry || typeof entry !== 'object') return [];
    const value = entry as Record<string, unknown>;
    return typeof value.text === 'string' ? [value.text] : [];
  }).join('\n').trim();
}

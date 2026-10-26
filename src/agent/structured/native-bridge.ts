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

const MAX_HANDOFF_CHARS = 12_000;

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
}

export type NativeSandbox = 'read-only' | 'workspace-write' | 'danger-full-access';

export interface NativeBridgeSession {
  mode: 'new' | 'adopted' | 'attached';
  threadId: string;
  oldThreadId?: string;
  endpoint: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  markerPath: string;
  ownsHost: boolean;
  controller?: BrokerToolController;
  session?: CodexStructuredSession;
  close(): Promise<void>;
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
  const existingThread = input.threadId?.trim();
  const adoptThread = input.adoptThreadId?.trim();

  if (existingThread) {
    const marker = await readThreadMarker(markerPath, existingThread);
    if (!marker || marker.namespace !== namespace) {
      throw new Error(
        `thread ${existingThread} 没有匹配的 Bridge Broker marker。` +
          '请使用 --adopt 做安全迁移；不能伪造 marker。',
      );
    }
  }

  let host = await findLoadedThreadHost(
    input.profileDir,
    existingThread ?? adoptThread,
    env,
  );
  const nativeScope = `native-bridge:${input.profileName}:${input.cwd}`;
  const nativeHostDirectory = codexHostRuntimeDirectory(
    input.profileDir,
    nativeScope,
    input.cwd,
  );
  let ownsHost = false;
  if (!host) {
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
  }
  if (!host) throw new Error('Bridge native App Server host 不可用');

  let rpc = host.rpc;
  let endpoint = host.endpoint;
  let markerThreadId: string | undefined;
  let oldThreadId: string | undefined;
  let mode: NativeBridgeSession['mode'] = 'new';
  let controller: BrokerToolController | undefined;
  let session: CodexStructuredSession | undefined;
  const owned = ownsHost;

  const close = async (): Promise<void> => {
    await session?.close().catch(() => {});
    await controller?.close().catch(() => {});
    await releaseCodexThreadWriter(rpc, markerThreadId);
    rpc.close();
    if (owned) await dropOwner(input.profileDir).catch(() => {});
  };

  try {
    if (existingThread) {
      await resumeCodexThread(
        rpc,
        { threadId: existingThread, excludeTurns: true, cwd: input.cwd },
        codexThreadPermissionOverrides(input.sandbox, input.approvalPolicy),
        180_000,
        { preserveProviderModel: true },
      );
      markerThreadId = existingThread;
      mode = 'attached';
    }

    if (mode !== 'attached' && adoptThread) {
      const old = await readIdleThread(rpc, adoptThread);
      const history = extractAssistantHistory(old);
      if (history.items.length === 0) {
        throw new Error(
          `旧 thread ${adoptThread} 没有可安全注入的 user/assistant 文本历史；已拒绝创建空迁移线程`,
        );
      }
      oldThreadId = adoptThread;
      mode = 'adopted';
      markerThreadId = await startBridgeThread(rpc, {
        cwd: input.cwd,
        config,
        sandbox: input.sandbox,
        approvalPolicy: input.approvalPolicy,
        namespace,
        adoptedFrom: adoptThread,
      });
      await rpc.request('thread/inject_items', {
        threadId: markerThreadId,
        items: history.items,
      });
      await materializeBridgeThread(rpc, markerThreadId, adoptThread);
    } else if (mode !== 'attached') {
      markerThreadId = await startBridgeThread(rpc, {
        cwd: input.cwd,
        config,
        sandbox: input.sandbox,
        approvalPolicy: input.approvalPolicy,
        namespace,
      });
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
    await writeThreadMarker(markerPath, markerThreadId, namespace, oldThreadId);
    session = new CodexStructuredSession(markerThreadId, endpoint, rpc, controller);
    return {
      mode,
      threadId: markerThreadId,
      ...(oldThreadId ? { oldThreadId } : {}),
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

/**
 * Convert persisted Codex thread items into ordinary Responses input items.
 * Tool calls, reasoning, encrypted agent messages and images are deliberately
 * omitted: the new thread receives bounded user/assistant text only.
 */
export function extractAssistantHistory(threadValue: Wire): HandoffHistory {
  const thread = threadValue.thread ?? threadValue;
  const turns: Wire[] = Array.isArray(thread?.turns) ? thread.turns : [];
  const entries: Array<{ role: 'user' | 'assistant'; text: string }> = [];
  for (const turn of turns) {
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
  const selected: Array<{ role: 'user' | 'assistant'; text: string }> = [];
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

async function startBridgeThread(
  rpc: RpcClient,
  input: {
    cwd: string;
    config: SubagentConfig;
    sandbox: NativeSandbox;
    approvalPolicy?: CodexApprovalPolicy;
    namespace: string;
    adoptedFrom?: string;
  },
): Promise<string> {
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
    ...codexThreadPermissionOverrides(input.sandbox, input.approvalPolicy),
  });
  const id = result.thread?.id;
  if (typeof id !== 'string' || !id) {
    throw new Error('Codex thread/start 没有返回 thread ID');
  }
  return id;
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
  const result = await rpc.request('thread/read', {
    threadId,
    includeTurns: true,
  });
  const thread = result.thread ?? result;
  if (!thread || typeof thread !== 'object') {
    throw new Error(`无法读取旧 thread ${threadId}`);
  }
  const turns: Wire[] = Array.isArray(thread.turns) ? thread.turns : [];
  const active = thread.status?.type === 'active' ||
    turns.some(turn => turn.status === 'inProgress');
  if (active) {
    throw new Error(`旧 thread ${threadId} 仍在运行；请等当前 turn 完成后再执行 --adopt`);
  }
  return result;
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

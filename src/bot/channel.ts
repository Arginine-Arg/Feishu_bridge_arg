import type {
  LarkChannel,
  LarkChannelOptions,
  NormalizedMessage,
} from '@larksuite/channel';
import { createLarkChannel } from '@larksuite/channel';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { claudeCapability, codexCapability } from '../agent/capability';
import { BridgeAgent, createBridgeAgentFromEnvironment } from '../bridge-agent';
import {
  isCodexModelId,
  modelLabel,
  normalizeModelSelection,
  resolveModelArg,
} from '../agent/models';
import {
  buildAgentPrompt,
  type BridgePromptInteractiveCard,
  type BridgePromptMention,
  type BridgePromptQuotedMessage,
  type BridgePromptTopicMessage,
} from '../agent/prompt';
import type { AgentAdapter, AgentEvent } from '../agent/types';
import {
  AGENT_INPUT_CALLBACK_ACTION,
  BRIDGE_CALLBACK_MARKER,
  handleCardAction,
  LIVE_INPUT_CALLBACK_ACTION,
} from '../card/dispatcher';
import { consumeInteractivePrompts, PROMPT_CALLBACK_ACTION } from '../card/interactive-prompt';
import { isLiveControlInput } from '../agent/live-session';
import { CallbackAuth } from '../card/callback-auth';
import { CallbackNonceStore } from '../card/callback-store';
import { renderCard } from '../card/run-renderer';
import {
  finalizeIfRunning,
  initialState,
  markIdleTimeout,
  markInterrupted,
  reduce,
  type RunState,
} from '../card/run-state';
import { renderText } from '../card/text-renderer';
import { saveProfileModelPreferences, tryHandleCommand, type Controls } from '../commands';
import type { AppConfig, CodexReasoningEffort } from '../config/schema';
import {
  getAgentSessionMode,
  getAgentStopGraceMs,
  getCotMessages,
  getMaxConcurrentRuns,
  getMessageReplyMode,
  getRequireMentionInGroup,
  getRunIdleTimeoutMs,
  getShowToolCalls,
} from '../config/schema';
import { resolveAppSecret } from '../config/secret-resolver';
import { log, reportMetric, withTrace } from '../core/logger';
import { MediaCache, type LocalAttachment } from '../media/cache';
import {
  toPolicyAttachment,
  toPromptAttachment,
} from '../media/attachment';
import { canRunAdminCommand, canUseDm, canUseGroup } from '../policy/access';
import { resolveWorkingDirectory } from '../policy/workspace';
import type { ScopeContext } from '../policy/run-policy';
import { createOwnerRefreshController } from '../policy/owner';
import { RunExecutor } from '../runtime/run-executor';
import type { SessionCatalog } from '../session/catalog';
import type { SessionStore } from '../session/store';
import type { WorkspaceStore } from '../workspace/store';
import { ActiveRuns, type RunHandle } from './active-runs';
import { ChatModeCache, type ChatMode } from './chat-mode-cache';
import { handleCommentMention } from './comments';
import { recordRunSessionEvent, startRunFlow } from './run-flow';
import { commandSessionCatalogIdentity } from './session-catalog-identity';
import { startKeepalive } from './keepalive';
import { PendingQueue } from './pending-queue';
import { ProcessPool } from './process-pool';
import { fetchQuotedContext, fetchTopicContext, type QuotedContext } from './quote';
import { lookupMessageThreadId } from './thread-id';
import { addWorkingReaction, removeReaction } from './reaction';
import { fetchKnownChats } from './lark-info';
import {
  isForceLiveAgentCommandMessage,
  isNativeAgentCommandMessage,
  liveInputModeForMessage,
  markNativeAgentCommand,
  type LiveInputMode,
} from './live-input';
import type { AppPaths } from '../config/app-paths';
import {
  consumeCotEvents,
  CotClient,
  CotPublisher,
  finalAnswerOnlyState,
} from './cot';

const DEBOUNCE_MS = 600;
const STREAM_TERMINAL_GRACE_MS = 3000;
const STREAM_ROLLOVER_MS = 8 * 60_000;
const REACTION_CLEANUP_GRACE_MS = 1000;

const BRIDGE_AGENT_INSTRUCTIONS = [
  '你在 bridge 进程中运行，普通 lark-cli 会继承 LARK_CHANNEL=1 并进入 bridge-bound 模式。',
  '不要 unset LARK_CHANNEL / LARK_CHANNEL_HOME / LARK_CHANNEL_PROFILE / LARKSUITE_CLI_CONFIG_DIR，也不要用 env -u LARK_CHANNEL 绕回本机普通配置。',
  'Codex bridge 默认使用 danger-full-access 对齐 Claude bridge 的 bypassPermissions 行为，因此 lark-cli 应能像用户本机终端一样访问 keychain。',
  '如果提示 lark-channel context detected but not bound，停止当前操作并请用户重启 bridge 或运行 bridge doctor/preflight；不要改用普通 profile，不要自行 bind，也不要直接读取 config.json 里的账号或密钥。',
];

// Lark SDK logs API errors at error level even when the caller catches them.
// These specific codes are EXPECTED in our flow (wiki-node lookup that
// usually misses, fileComment.get that we deliberately let fall back to
// .list) and the surrounding noise is already covered by our own logs.
const SUPPRESSED_API_ERROR_CODES = new Set([
  131005, // wiki.space.getNode "not found" — the doc isn't a wiki node
  1069307, // drive.fileComment.get "not exist" — fall back to .list
  1069302, // drive.fileCommentReply.create — whole-doc comments don't accept replies; fall back to fileComment.create
]);

const SUPPRESSED_ENDPOINT_API_ERRORS = [
  {
    code: 99991672,
    urlPart: '/open-apis/wiki/v2/spaces/get_node',
  },
];

function codeFromObj(m: unknown): number | undefined {
  if (!m || typeof m !== 'object') return undefined;
  const top = (m as { code?: unknown }).code;
  if (typeof top === 'number') return top;
  const nested = (m as { response?: { data?: { code?: unknown } } })?.response?.data?.code;
  return typeof nested === 'number' ? nested : undefined;
}

function urlFromObj(m: unknown): string | undefined {
  if (!m || typeof m !== 'object') return undefined;
  const configUrl = (m as { config?: { url?: unknown } })?.config?.url;
  if (typeof configUrl === 'string') return configUrl;
  const requestPath = (m as { request?: { path?: unknown } })?.request?.path;
  return typeof requestPath === 'string' ? requestPath : undefined;
}

function isSuppressedSdkMessage(msg: unknown): boolean {
  if (Array.isArray(msg)) return msg.some(isSuppressedSdkMessage);
  const code = codeFromObj(msg);
  if (code === undefined) return false;
  if (SUPPRESSED_API_ERROR_CODES.has(code)) return true;
  const url = urlFromObj(msg);
  return SUPPRESSED_ENDPOINT_API_ERRORS.some(
    (rule) => code === rule.code && url?.includes(rule.urlPart),
  );
}

export function shouldSuppressSdkErrorLog(args: unknown[]): boolean {
  return args.some(isSuppressedSdkMessage);
}

function buildQuietLogger(): {
  error: (...m: unknown[]) => void;
  warn: (...m: unknown[]) => void;
  info: (...m: unknown[]) => void;
  debug: (...m: unknown[]) => void;
  trace: (...m: unknown[]) => void;
} {
  return {
    error: (...args: unknown[]) => {
      if (shouldSuppressSdkErrorLog(args)) return;
      log.warn('sdk', 'error', { args: stringifyArgs(args) });
    },
    warn: (...args: unknown[]) => log.warn('sdk', 'warn', { args: stringifyArgs(args) }),
    info: (...args: unknown[]) => log.info('sdk', 'info', { args: stringifyArgs(args) }),
    debug: () => {},
    trace: () => {},
  };
}

function stringifyArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === 'string') return a;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(' ');
}

function expandHomeDirectory(path: string): string {
  if (path === '~') return homedir();
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}

export interface BridgeChannel {
  channel: LarkChannel;
  disconnect(): Promise<void>;
}

export interface StartChannelDeps {
  cfg: AppConfig;
  agent: AgentAdapter;
  bridgeAgent?: BridgeAgent;
  sessions: SessionStore;
  sessionCatalog?: SessionCatalog;
  workspaces: WorkspaceStore;
  controls: Controls;
  appPaths?: Pick<AppPaths, 'secretsFile' | 'keystoreSaltFile' | 'mediaDir'>;
}

export async function startChannel(deps: StartChannelDeps): Promise<BridgeChannel> {
  const { cfg, agent, sessions, sessionCatalog, workspaces, controls } = deps;
  const bridgeAgent = deps.bridgeAgent ?? createBridgeAgentFromEnvironment();
  const activeRuns = new ActiveRuns();
  // ChatModeCache stays per-bridge-instance — invalidated on restart along
  // with everything else. Topic-mode chats only need one chat.get() call ever.
  const chatModeCache = new ChatModeCache();
  // Concurrency cap — reads `preferences.maxConcurrentRuns` on each acquire,
  // so /config bumps take effect for the next run.
  const pool = new ProcessPool(() => getMaxConcurrentRuns(controls.cfg));
  const executor = new RunExecutor({ agent, pool, activeRuns });

  // Resolve the App Secret to plaintext. The config field can be a literal
  // string, a "${VAR}" template, or a {source, id} SecretRef referencing
  // the encrypted keystore / env / file / exec provider. Re-resolved on
  // every startChannel so /account change picks up new secrets.
  const appSecret = await resolveAppSecret(cfg, deps.appPaths);
  const callbackNonceStore = deps.appPaths?.mediaDir
    ? new CallbackNonceStore(join(dirname(deps.appPaths.mediaDir), 'callback-nonces.json'))
    : undefined;
  await callbackNonceStore?.load();
  const callbackAuth = callbackNonceStore
    ? new CallbackAuth({
        keys: [{ version: 1, secret: appSecret }],
        nonceStore: callbackNonceStore,
      })
    : undefined;
  const activePolicyFingerprints = new Map<string, string>();
  // Per-scope record of the model used on the last run, so a `/config` model
  // switch can inject a one-time "model changed" note into the next (resumed)
  // prompt. In-memory only: on restart the first run re-seeds silently.
  const lastRunModelByScope = new Map<string, string>();
  // Hybrid live mode keeps normal chat on turn-mode runs. This map records
  // scopes currently showing an agent picker so later up/down/enter messages
  // are routed as terminal controls instead of plain chat.
  const liveInteractionByScope = new Map<string, LiveInteractionState>();
  const cotClient = new CotClient({
    tenant: cfg.accounts.app.tenant,
    appId: cfg.accounts.app.id,
    appSecret,
  });
  const threadModeOverrideWarnedChats = new Set<string>();
  const logThreadModeOverride: LogThreadModeOverride = ({ chatId, resolvedMode, threadId }) => {
    const fields = { chatId, cachedMode: resolvedMode, threadId };
    if (threadModeOverrideWarnedChats.has(chatId)) {
      log.info('chat', 'mode-overridden-by-thread', fields);
      return;
    }
    threadModeOverrideWarnedChats.add(chatId);
    log.warn('chat', 'mode-overridden-by-thread', fields);
  };

  // @larksuite/channel defaults local path uploads to deny. Keep one mutable
  // array because chat workspaces can change through /cd after channel startup.
  const allowedFileDirs: string[] = [];
  const allowLocalFileRoot = async (candidate: string): Promise<boolean> => {
    const result = await resolveWorkingDirectory(expandHomeDirectory(candidate));
    if (!result.ok) {
      log.warn('channel', 'local-file-root-rejected', { reason: result.reason });
      return false;
    }
    if (!allowedFileDirs.includes(result.cwdRealpath)) {
      allowedFileDirs.push(result.cwdRealpath);
      log.info('channel', 'local-file-root-allowed', { root: result.cwdRealpath });
    }
    return true;
  };
  const initialFileRoots = [
    deps.appPaths?.mediaDir,
    controls.profileConfig.workspaces.default,
    ...Object.values(workspaces.listCwds()),
    ...Object.values(workspaces.listNamed()),
    ...controls.profileConfig.outbound.allowedFileDirs,
  ].filter((root): root is string => Boolean(root));
  await Promise.all(initialFileRoots.map((root) => allowLocalFileRoot(root)));

  const opts: LarkChannelOptions = {
    appId: cfg.accounts.app.id,
    appSecret,
    domain:
      cfg.accounts.app.tenant === 'lark'
        ? 'https://open.larksuite.com'
        : 'https://open.feishu.cn',
    source: 'arg-bridge',
    logger: buildQuietLogger(),
    policy: {
      dmMode: 'open',
      requireMention: false,
      respondToMentionAll: false,
    },
    // Disable per-chat serialization so we can implement our own
    // debounce + run-chain policy (see pending-queue + runChain below).
    safety: {
      chatQueue: { enabled: false },
    },
    // Attach raw Feishu event body to normalized events so we can read fields
    // the normalizer drops (e.g. action.form_value on CardKit 2.0 form submits).
    includeRawEvent: true,
    outbound: {
      streamThrottleMs: 400,
      allowedFileDirs,
    },
    // SDK 1.65.0-alpha.3+ knobs.
    wsConfig: {
      // 3s liveness watchdog: if no inbound message arrives within 3s after
      // the last ping, SDK presumes connection dead and forces a reconnect.
      pingTimeout: 3,
    },
    // 8s handshake timeout (replaces hardcoded 15s). Fast-fail + fast-retry
    // beats slow-fail in unstable networks.
    handshakeTimeoutMs: 8_000,
    // Per-request REST timeout — without a cap a slow API can hang the
    // event-handling thread.
    httpTimeoutMs: 30_000,
    // Route WS + REST through HTTPS_PROXY / HTTP_PROXY when set (no-op otherwise).
    respectProxyEnv: true,
  };

  const channel = createLarkChannel(opts);
  const media = new MediaCache(channel, deps.appPaths?.mediaDir);

  // Pending → run handoff: while a run is active on a chat, block its pending
  // queue so messages keep accumulating without flushing. When the run ends,
  // unblock arms a fresh quiet-window timer. Net effect: at most one run per
  // chat in flight, and everything sent during a run merges into the next
  // batch (only flushed once 600ms of silence has passed *after* the run).
  const pending = new PendingQueue(DEBOUNCE_MS, (scope, batch) => {
    const firstMsg = batch[0];
    if (!firstMsg) return;
    pending.block(scope);
    void withTrace({ chatId: firstMsg.chatId }, async () => {
      log.info('flush', 'start', {
        scope,
        batchSize: batch.length,
        chatId: firstMsg.chatId,
        threadId: firstMsg.threadId,
        msgId: firstMsg.messageId,
      });
      try {
        const resolvedMode = await chatModeCache.resolve(channel, firstMsg.chatId);
        // Feishu/Lark converted topic groups may still resolve as `group` from
        // the chat info API/cache, while message events already carry threadId.
        // Treat threadId as authoritative for IM messages so scope and replies
        // stay isolated per topic.
        const mode = firstMsg.threadId ? 'topic' : resolvedMode;
        if (firstMsg.threadId && resolvedMode !== 'topic') {
          chatModeCache.invalidate(firstMsg.chatId);
          logThreadModeOverride({
            chatId: firstMsg.chatId,
            resolvedMode,
            threadId: firstMsg.threadId,
          });
        }
        // A persistent terminal has an editor, not a request protocol. Sending
        // a debounced batch there turns separate IM messages into one multiline
        // paste. Keep every live-mode message as its own terminal turn while
        // preserving their FIFO order.
        const runBatches = splitNativeLiveBatches(
          batch,
          getAgentSessionMode(controls.cfg) === 'live',
        );
        if (runBatches.length > 1) {
          log.info('flush', 'split-native-live-batch', {
            scope,
            batchSize: batch.length,
            runBatches: runBatches.length,
          });
        }
        for (const runBatch of runBatches) {
          await runAgentBatch({
            channel,
            executor,
            bridgeAgent,
            sessions,
            sessionCatalog,
            workspaces,
            media,
            batch: runBatch,
            controls,
            cotClient,
            callbackAuth,
            activePolicyFingerprints,
            lastRunModelByScope,
            liveInteractionByScope,
            pending,
            scope,
            mode,
          });
        }
      } catch (err) {
        log.fail('flush', err);
      } finally {
        pending.unblock(scope);
        log.info('flush', 'end');
      }
    });
  });

  // Counter for stdout reconnect escalation; reset on `reconnected`.
  let consecutiveReconnects = 0;

  channel.on({
    message: async (msg) => {
      await withTrace({ chatId: msg.chatId, msgId: msg.messageId }, () =>
        intakeMessage({
          channel,
          agent,
          sessions,
          sessionCatalog,
          workspaces,
          activeRuns,
          pending,
          msg,
          controls,
          chatModeCache,
          logThreadModeOverride,
          executor,
          pool,
          liveInteractionByScope,
          allowLocalFileRoot,
        }),
      ).catch((err) => log.fail('intake', err));
    },
    reject: (evt) => {
      log.info('intake', 'reject', { chatId: evt.chatId, reason: evt.reason });
    },
    cardAction: async (evt) => {
      await withTrace({ chatId: evt.chatId, msgId: evt.messageId }, async () => {
        await handleCardAction({
          channel,
          evt,
          sessions,
          sessionCatalog,
          workspaces,
          activeRuns,
          agent,
          processPool: pool,
          runExecutor: executor,
          controls,
          pending,
          chatModeCache,
          callbackAuth,
          callbackPolicyFingerprintForScope: (scope) => activePolicyFingerprints.get(scope),
        });
      }).catch((err) => log.fail('cardAction', err));
    },
    comment: async (evt) => {
      await withTrace({ chatId: 'comment' }, async () => {
        await handleCommentMention({
          channel,
          evt,
          agent,
          sessions,
          sessionCatalog,
          workspaces,
          activeRuns,
          executor,
          controls,
        }).catch((err) => log.fail('comment', err));
      }).catch((err) => log.fail('comment', err));
    },
    reconnecting: () => {
      consecutiveReconnects++;
      log.warn('ws', 'reconnecting', { consecutive: consecutiveReconnects });
      reportMetric('ws_reconnect', 1, { kind: 'ws' });
      // Stdout escalation — surface jitter that's hidden in the file log.
      if (consecutiveReconnects === 3) {
        console.error('⚠️ 已连续重连 3 次,网络可能不稳。');
      } else if (consecutiveReconnects === 10) {
        console.error('❌ 已连续重连 10 次,建议在飞书发 /reconnect 或重启 bot。');
      }
    },
    reconnected: () => {
      if (consecutiveReconnects > 1) {
        log.info('ws', 'recovered', { afterAttempts: consecutiveReconnects });
      } else {
        log.info('ws', 'reconnected');
      }
      consecutiveReconnects = 0;
    },
    // Classify common WS errors into the `network` phase so /doctor and grep
    // can find them without scanning generic `ws.fail` entries.
    error: (err) => {
      const msg = err?.message ?? String(err);
      if (/ENOTFOUND|getaddrinfo/.test(msg)) {
        log.fail('network', err, { kind: 'dns', code: err.code });
      } else if (/handshake|did not complete/.test(msg)) {
        log.fail('network', err, { kind: 'handshake-timeout', code: err.code });
      } else if (/timeout/i.test(msg)) {
        log.fail('network', err, { kind: 'timeout', code: err.code });
      } else {
        log.fail('ws', err, { code: err.code });
      }
    },
  });

  await channel.connect();
  const ownerRefresh = createOwnerRefreshController({
    controls,
    source: channel,
    appId: cfg.accounts.app.id,
  });
  await ownerRefresh.start();
  const knownChatsRefresh = startKnownChatsRefreshTimer(channel, controls);

  const identity = channel.botIdentity;
  // Late-bind the bot's own IM identity into the agent adapter so the system
  // prompt can state "this open_id is you" with the real value. Covers both
  // initial start and credential-swap reconnects (both go through here).
  if (identity?.openId) {
    agent.setBotIdentity?.({
      openId: identity.openId,
      ...(identity.name ? { name: identity.name } : {}),
    });
  }
  log.info('ws', 'connected', {
    bot: identity?.name ?? 'unknown',
    openId: identity?.openId ?? '-',
    agent: `${agent.displayName} (${agent.id})`,
    appId: cfg.accounts.app.id,
    procId: controls.processId,
  });
  console.log('正在监听消息。按 Ctrl+C 退出。\n');

  // App-level keepalive: 15s probe + wake-up detection + HTTP reachability.
  // Defense-in-depth — the SDK's pingTimeout watchdog handles half-dead WS,
  // this catches anything that the SDK misses (silent state stuck, etc.).
  const probeDomain =
    cfg.accounts.app.tenant === 'lark'
      ? 'https://open.larksuite.com'
      : 'https://open.feishu.cn';
  const keepalive = startKeepalive({
    channel,
    domain: probeDomain,
    forceReconnect: () => controls.restart(),
  });

  return {
    channel,
    disconnect: async () => {
      activeRuns.pauseNewRuns('bridge-disconnect');
      ownerRefresh.stop();
      knownChatsRefresh.stop();
      keepalive.stop();
      pending.cancelAll();
      const [disconnectResult, stopAllResult, ...flushResults] = await Promise.allSettled([
        channel.disconnect(),
        activeRuns.stopAll(),
        agent.shutdown?.(),
        sessions.flush(),
        sessionCatalog?.flush(),
        callbackNonceStore?.flush(),
        workspaces.flush(),
      ]);
      if (stopAllResult.status === 'rejected') {
        log.fail('disconnect', stopAllResult.reason, { step: 'stopAll' });
      }
      for (const [idx, result] of flushResults.entries()) {
        if (result.status === 'rejected') {
          log.fail('disconnect', result.reason, { step: `flush-${idx}` });
        }
      }
      if (disconnectResult.status === 'rejected') {
        throw disconnectResult.reason;
      }
    },
  };
}

function startKnownChatsRefreshTimer(
  channel: LarkChannel,
  controls: Controls,
): { stop(): void } {
  const intervalMs = 30 * 60 * 1000;
  const refresh = async (): Promise<void> => {
    const chats = await fetchKnownChats(channel);
    if (chats.length > 0) {
      controls.knownChats = chats;
    }
  };
  void refresh();
  const timer = setInterval(() => void refresh(), intervalMs);
  return {
    stop() {
      clearInterval(timer);
    },
  };
}

async function sendNonAllowedGroupHint(
  channel: LarkChannel,
  chatId: string,
  replyToMessageId: string,
): Promise<void> {
  const text =
    '当前群尚未加入响应列表，所以 bot 不会处理消息。\n' +
    'Bot owner/管理员可在本群发 /invite group 加入白名单。';
  try {
    await channel.send(chatId, { text }, { replyTo: replyToMessageId });
  } catch {
    await channel.send(chatId, { text });
  }
}

interface IntakeDeps {
  channel: LarkChannel;
  agent: AgentAdapter;
  sessions: SessionStore;
  sessionCatalog?: SessionCatalog;
  workspaces: WorkspaceStore;
  activeRuns: ActiveRuns;
  pending: PendingQueue;
  msg: NormalizedMessage;
  controls: Controls;
  chatModeCache: ChatModeCache;
  logThreadModeOverride: LogThreadModeOverride;
  executor: RunExecutor;
  pool: ProcessPool;
  liveInteractionByScope: Map<string, LiveInteractionState>;
  allowLocalFileRoot: (root: string) => Promise<boolean>;
}

type LogThreadModeOverride = (input: {
  chatId: string;
  resolvedMode: ChatMode;
  threadId: string;
}) => void;

async function intakeMessage(deps: IntakeDeps): Promise<void> {
  const {
    channel,
    agent,
    sessions,
    sessionCatalog,
    workspaces,
    activeRuns,
    pending,
    msg,
    controls,
    chatModeCache,
    logThreadModeOverride,
    executor,
    pool,
    liveInteractionByScope,
    allowLocalFileRoot,
  } = deps;
  const preview = msg.content.length > 80 ? `${msg.content.slice(0, 80)}…` : msg.content;
  // Resolve scope (and underlying chat mode) once at intake — every
  // downstream consumer keys off these.
  const resolvedMode = await chatModeCache.resolve(channel, msg.chatId);
  // Feishu delivers a sizable fraction of topic-group message events without a
  // `thread_id` (notably the message that opens a new topic). We route topic
  // replies (`replyInThread`) and isolate per-topic session scope off it, so a
  // missing one makes the reply escape into a brand-new topic AND collapses the
  // scope to the chat level. When getChatMode says this is a topic group but
  // the event dropped `thread_id`, backfill it from the raw message — the same
  // recovery the card-click path uses.
  let threadId = msg.threadId;
  if (!threadId && resolvedMode === 'topic') {
    threadId = await lookupMessageThreadId(channel, msg.messageId);
    if (threadId) {
      log.info('intake', 'thread-id-backfilled', {
        chatId: msg.chatId,
        msgId: msg.messageId,
        threadId,
      });
    }
  }
  // Carry the (possibly backfilled) threadId on the message so the batched
  // flush — which reads `firstMsg.threadId` for reply routing and CoT — sees it.
  const emsg: NormalizedMessage = threadId === msg.threadId ? msg : { ...msg, threadId };
  // Some groups are converted into topic groups after creation. In that state
  // getChatMode can lag behind the message event shape, so threadId is the
  // stronger signal for topic-scoped sessions and reply routing.
  const chatMode = threadId ? 'topic' : resolvedMode;
  if (threadId && resolvedMode !== 'topic') {
    chatModeCache.invalidate(msg.chatId);
    logThreadModeOverride({
      chatId: msg.chatId,
      resolvedMode,
      threadId,
    });
  }
  const scope = chatMode === 'topic' && threadId
    ? `${msg.chatId}:${threadId}`
    : msg.chatId;
  log.info('intake', 'enter', {
    scope,
    chatType: msg.chatType,
    chatMode,
    resolvedMode,
    threadId,
    msgId: msg.messageId,
    sender: msg.senderId,
    preview,
    resources: msg.resources.length,
  });

  const accessDecision =
    msg.chatType === 'p2p'
      ? canUseDm(controls.profileConfig, controls, msg.senderId)
      : canUseGroup(controls.profileConfig, controls, msg.chatId, msg.senderId);
  if (!accessDecision.ok) {
    log.info('intake', 'skip-not-allowed-user', {
      scope,
      sender: msg.senderId.slice(-6),
      reason: accessDecision.reason,
    });
    if (msg.chatType !== 'p2p' && accessDecision.reason === 'denied-chat' && msg.mentionedBot) {
      void sendNonAllowedGroupHint(channel, msg.chatId, msg.messageId).catch((err) =>
        log.warn('intake', 'non-allowed-hint-failed', { err: String(err) }),
      );
    }
    return;
  }

  // Group-mention policy. p2p is always unrestricted; in groups (regular and
  // topic) we drop messages that don't @bot when the user has opted into the
  // quiet-by-default behavior. Slash commands are NOT exempt — the user
  // chose strict mode so the group stays uniformly quiet unless mentioned.
  // @全员 is already filtered by SDK (`respondToMentionAll: false`), so any
  // event reaching here is either targeted or undirected chatter.
  if (
    msg.chatType !== 'p2p' &&
    getRequireMentionInGroup(controls.cfg) &&
    !msg.mentionedBot
  ) {
    log.info('intake', 'skip-no-mention', { scope, chatType: msg.chatType });
    return;
  }

  const route = rewriteAgentCommandMessage(emsg, controls.profileConfig.agentKind);
  const nativeCodexModelCommand =
    controls.profileConfig.agentKind === 'codex' && route.msg.content.trim() === '/model';

  if (
    nativeCodexModelCommand &&
    !canRunAdminCommand(controls.profileConfig, controls, msg.senderId).ok
  ) {
    log.info('command', 'admin-deny', {
      cmd: '/model',
      sender: msg.senderId.slice(-6),
    });
    await channel.send(
      msg.chatId,
      { markdown: '❌ 此命令仅管理员可用。' },
      {
        replyTo: msg.messageId,
        ...(chatMode === 'topic' && threadId ? { replyInThread: true } : {}),
      },
    );
    return;
  }

  if (!route.forceNative && !nativeCodexModelCommand) {
    const handled = await tryHandleCommand({
      channel,
      msg: route.msg,
      scope,
      chatMode,
      sessions,
      workspaces,
      agent,
      activeRuns,
      sessionCatalog,
      sessionCatalogIdentity: await commandSessionCatalogIdentity({
        msg: emsg,
        scope,
        mode: chatMode,
        workspaces,
        controls,
        access: accessDecision,
      }),
      runExecutor: executor,
      processPool: pool,
      controls,
      allowLocalFileRoot,
    });
    if (handled) {
      const preservePending = commandPreservesPendingMessages(route.msg.content);
      const dropped = preservePending ? [] : pending.cancel(scope);
      log.info('intake', 'command', {
        scope,
        preservePending,
        droppedPending: dropped.length,
      });
      return;
    }
  }

  // Hybrid live mode: slash commands that survived bridge command dispatch
  // (/goal, /fast, /compact, agent-specific commands, etc.) go to the
  // persistent CLI; picker controls go there only while this scope is known to
  // be inside a picker. Ordinary chat stays on turn-mode runs instead of being
  // typed into a TUI.
  const pickerActive = liveInteractionByScope.has(scope);
  const nativeInputActive =
    pickerActive || getAgentSessionMode(controls.cfg) === 'live';
  const forceNative = route.forceNative || nativeCodexModelCommand;
  const agentMsg = forceNative
    ? markNativeAgentCommand(
        route.msg,
        nativeCodexModelCommand ? 'command' : (route.nativeMode ?? 'command'),
      )
    : nativeInputActive &&
        isNativeAgentInputText(route.msg.content, pickerActive)
      ? markNativeAgentCommand(
          route.msg,
          route.msg.content.trimStart().startsWith('/')
            ? 'command'
            : pickerActive
              ? 'control'
              : undefined,
        )
      : route.msg;
  const priorityLiveControl =
    pickerActive && liveInputModeForMessage(agentMsg) === 'control';
  const size = priorityLiveControl
    ? pending.pushFront(scope, agentMsg)
    : pending.push(scope, agentMsg);
  log.info('intake', 'queued', { scope, queueSize: size, debounceMs: DEBOUNCE_MS });

  // A run is already in flight on this scope, so this message won't be picked
  // up until it finishes (block/unblock in the pending→run handoff). Without a
  // hint the sender thinks the bot is dead. Ack once per busy window — not per
  // queued message — and never let the ack block or throw into intake.
  if (pending.shouldAckBusy(scope)) {
    void channel
      .send(
        msg.chatId,
        {
          text: `⏳ 当前任务仍在运行，你的消息已排队（当前 ${size} 条）。可随时发送 /status 检查会话；想立即打断请发 /stop。`,
        },
        { replyTo: msg.messageId },
      )
      .catch((err) => log.warn('intake', 'busy-ack-failed', { scope, err: String(err) }));
  }
}

export interface AgentCommandRoute {
  msg: NormalizedMessage;
  forceNative: boolean;
  nativeMode?: LiveInputMode;
}

export function commandPreservesPendingMessages(content: string): boolean {
  const command = content.trim().toLowerCase();
  return (
    /^\/(?:status|help|ps)(?:\s|$)/u.test(command) ||
    /^\/session(?:\s+\/?status)?\s*$/u.test(command) ||
    /^\/tmux(?:\s+(?:list|status))?(?:\s|$)/u.test(command) ||
    /^\/timeout(?:\s|$)/u.test(command)
  );
}

export function rewriteAgentCommandMessage(
  msg: NormalizedMessage,
  agentKind: 'claude' | 'codex',
): AgentCommandRoute {
  const trimmed = msg.content.trimStart();
  const match = /^\/([A-Za-z][A-Za-z0-9_-]*)(?:\s+([\s\S]+))?$/.exec(trimmed);
  if (!match) return { msg, forceNative: false };
  const target = match[1]?.toLowerCase();
  const rest = match[2] ?? '';
  const aliases =
    agentKind === 'claude'
      ? new Set(['claude', 'claude-code', 'claudecode'])
      : new Set(['codex', 'codex-cli', 'codexcli']);
  if (!target || !aliases.has(target)) return { msg, forceNative: false };
  const normalized = normalizeAgentPrefixedNativeInput(rest.trim() ? rest : '/status');
  return {
    msg: {
      ...msg,
      content: normalized.text,
    },
    forceNative: normalized.forceNative,
    ...(normalized.nativeMode ? { nativeMode: normalized.nativeMode } : {}),
  };
}

function normalizeAgentPrefixedNativeInput(input: string): {
  text: string;
  forceNative: boolean;
  nativeMode?: LiveInputMode;
} {
  const trimmed = input.trim();
  const slashless = /^\/([A-Za-z0-9_-]+)$/u.exec(trimmed)?.[1];
  const controlText = slashless && isLivePickerInput(slashless) ? slashless : trimmed;
  if (isLivePickerInput(controlText)) {
    return { text: controlText, forceNative: true, nativeMode: 'control' };
  }
  return {
    text: input,
    forceNative: trimmed.startsWith('/'),
    ...(trimmed.startsWith('/') ? { nativeMode: 'command' as const } : {}),
  };
}

function isSlashCommandText(text: string): boolean {
  return text.trimStart().startsWith('/');
}

function isNativeAgentInputText(text: string, pickerActive: boolean): boolean {
  if (isSlashCommandText(text)) return true;
  return pickerActive && isLivePickerInput(text);
}

function isLivePickerInput(text: string): boolean {
  const trimmed = text.trim();
  return isLiveControlInput(trimmed) || /^\d{1,2}$/u.test(trimmed) || /^(?:y|yes|n|no)$/iu.test(trimmed);
}

function splitNativeLiveBatches(
  batch: NormalizedMessage[],
  splitEveryMessage = false,
): NormalizedMessage[][] {
  const out: NormalizedMessage[][] = [];
  let ordinary: NormalizedMessage[] = [];
  const flushOrdinary = (): void => {
    if (ordinary.length === 0) return;
    out.push(ordinary);
    ordinary = [];
  };

  for (const msg of batch) {
    if (splitEveryMessage || isForceLiveAgentCommandMessage(msg)) {
      flushOrdinary();
      out.push([msg]);
    } else {
      ordinary.push(msg);
    }
  }
  flushOrdinary();
  return out;
}

interface LiveInteractionState {
  picker: true;
  updatedAt: number;
  signature?: string;
}

interface RunBatchDeps {
  channel: LarkChannel;
  executor: RunExecutor;
  bridgeAgent: BridgeAgent;
  sessions: SessionStore;
  sessionCatalog?: SessionCatalog;
  workspaces: WorkspaceStore;
  media: MediaCache;
  batch: NormalizedMessage[];
  controls: Controls;
  cotClient: CotClient;
  callbackAuth?: CallbackAuth;
  activePolicyFingerprints: Map<string, string>;
  lastRunModelByScope: Map<string, string>;
  liveInteractionByScope: Map<string, LiveInteractionState>;
  pending: PendingQueue;
  scope: string;
  mode: ChatMode;
}

async function runAgentBatch(deps: RunBatchDeps): Promise<void> {
  const {
    channel,
    executor,
    bridgeAgent,
    sessions,
    sessionCatalog,
    workspaces,
    media,
    batch,
    controls,
    cotClient,
    callbackAuth,
    activePolicyFingerprints,
    lastRunModelByScope,
    liveInteractionByScope,
    pending,
    scope,
    mode,
  } = deps;
  if (batch.length === 0) return;
  const firstMsg = batch[0];
  const lastMsg = batch[batch.length - 1];
  if (!firstMsg || !lastMsg) return;

  const chatId = firstMsg.chatId;
  const threadId = firstMsg.threadId;

  const resourceItems = batch.flatMap((m) =>
    m.resources.map((r) => ({ messageId: m.messageId, resource: r })),
  );
  const attachments = await media.resolve(resourceItems, controls.profileConfig.attachments);
  if (attachments.length > 0) {
    log.info('media', 'resolved', { count: attachments.length });
    for (const attachment of attachments) {
      log.info('attachment', 'decision', {
        decision: attachment.decision,
        kind: attachment.kind,
        hash: attachment.hash,
        size: attachment.size,
        sourceMessageId: attachment.sourceMessageId,
        reason: attachment.rejectionReason,
      });
    }
  }

  // Collect any reply-quote targets in the batch. Dedup so the same target
  // quoted by multiple messages in one batch only fetches once. Filter out
  // ids that are themselves in the batch — those are already in the prompt.
  const batchIds = new Set(batch.map((m) => m.messageId));
  const quoteTargets = [
    ...new Set(
      batch
        .map((m) => replyQuoteTargetForMessage(m, mode))
        .filter((id): id is string => Boolean(id) && !batchIds.has(id!)),
    ),
  ];
  const quotes: QuotedContext[] = [];
  for (const targetId of quoteTargets) {
    const q = await fetchQuotedContext(channel, targetId);
    if (q) {
      quotes.push(q);
      log.info('quote', 'fetched', {
        messageId: targetId,
        type: q.rawContentType,
        contentChars: q.content.length,
      });
    }
  }

  // Topic upstream context. When the bot is pulled into a topic for the FIRST
  // time (no session yet for this scope), the topic's earlier messages — the
  // root question that may never have @-mentioned the bot, plus prior replies —
  // live nowhere the agent can see them. Fetch them so it isn't blind to what
  // the user is pointing at. An already-engaged topic keeps that history in its
  // resumed session, so we skip the fetch there.
  let topicContext: QuotedContext[] = [];
  if (mode === 'topic' && threadId && !sessions.getRaw(scope)) {
    const exclude = new Set([...batchIds, ...quoteTargets]);
    topicContext = await fetchTopicContext(channel, threadId, {
      maxMessages: 40,
      excludeIds: exclude,
    });
    if (topicContext.length > 0) {
      log.info('topic', 'context-fetched', {
        scope,
        threadId,
        count: topicContext.length,
      });
    }
  }

  // Detect a model switch since this scope's last run. When resuming an
  // existing conversation the transcript still claims the old model, so tell
  // the (now-switched) agent its model changed — otherwise it keeps echoing
  // the previously-announced model. Only fires when a prior model was seen
  // for this scope (never on the first run) and the selection actually
  // changed. `requestedModel` (the `--model` value, or undefined for default)
  // is reused below to log requested-vs-actual against the init event.
  const agentKind = controls.profileConfig.agentKind;
  const modelPref = controls.profileConfig.preferences.model;
  const modelSelection = normalizeModelSelection(agentKind, modelPref);
  const requestedModel = resolveModelArg(agentKind, modelPref);
  const prevModel = lastRunModelByScope.get(scope);
  const modelSwitched = prevModel !== undefined && prevModel !== modelSelection;
  lastRunModelByScope.set(scope, modelSelection);
  const extraInstructions = modelSwitched
    ? [
        `用户刚把本会话使用的模型切换为「${modelLabel(agentKind, modelPref)}」。` +
          '之前的对话里可能提到别的模型,请以当前模型为准;若被问到你用的是什么模型,据此回答。',
      ]
    : undefined;

  const nativeCommand = nativeAgentCommandForBatch(batch);
  const forceLiveSession = batch.some(isForceLiveAgentCommandMessage);
  const useLiveSession = forceLiveSession || getAgentSessionMode(controls.cfg) === 'live';
  const rawTerminalInput = buildTerminalInput(batch, attachments, quotes);
  const bridgeRoute = useLiveSession
    ? await bridgeAgent.route({
        userInput: nativeCommand ?? rawTerminalInput,
        ...(nativeCommand ? { inputMode: liveInputModeForBatch(batch, nativeCommand) } : {}),
      })
    : undefined;
  const liveInputMode = bridgeRoute?.inputMode;
  const prompt =
    bridgeRoute?.stdin ??
    buildPrompt(
      batch,
      attachments,
      quotes,
      topicContext,
      channel.botIdentity,
      extraInstructions,
    );
  log.info('prompt', 'built', {
    promptChars: prompt.length,
    nativeCommand: bridgeRoute?.kind === 'native-command',
    sessionMode: useLiveSession ? 'live' : 'turn',
    quotes: quotes.length,
    topicContext: topicContext.length,
    ...(modelSwitched ? { modelSwitchedTo: modelSelection } : {}),
  });

  // For topic groups: thread the reply so it lands in the same topic as the
  // user's message. Otherwise the SDK posts at top level and the user's
  // topic discussion breaks visually.
  const sendOpts = {
    replyTo: lastMsg.messageId,
    ...(mode === 'topic' && threadId ? { replyInThread: true } : {}),
  };
  log.info('flush', 'reply-target', {
    scope,
    mode,
    chatId,
    threadId,
    replyTo: sendOpts.replyTo,
    replyInThread: sendOpts.replyInThread === true,
  });

  const accessDecision =
    firstMsg.chatType === 'p2p'
      ? canUseDm(controls.profileConfig, controls, firstMsg.senderId)
      : canUseGroup(controls.profileConfig, controls, firstMsg.chatId, firstMsg.senderId);
  const scopeContext: ScopeContext = {
    source: 'im',
    chatId,
    actorId: firstMsg.senderId,
    ...(threadId ? { threadId } : {}),
  };
  const capability =
    controls.profileConfig.agentKind === 'codex'
      ? codexCapability(controls.profileConfig)
      : claudeCapability(controls.profileConfig);
  const flow = await startRunFlow({
    scopeId: scope,
    scope: scopeContext,
    prompt,
    sessionMode: useLiveSession ? 'live' : 'turn',
    liveInputMode,
    attachments: attachments.map(toPolicyAttachment),
    access: accessDecision,
    capability,
    profileConfig: controls.profileConfig,
    sessions,
    sessionCatalog,
    workspaces,
    executor,
    now: Date.now(),
    stopGraceMs: getAgentStopGraceMs(controls.cfg),
    observability: {
      profile: controls.profile,
      agent: capability.agentId,
      source: 'im',
      stage: 'submit',
    },
  });
  if (!flow.ok) {
    log.info('run-flow', 'rejected', { scope, code: flow.rejectReason.code });
    log.warn('policy', 'denied', {
      scope,
      source: 'im',
      code: flow.rejectReason.code,
    });
    await channel.send(chatId, { markdown: flow.rejectReason.userVisible }, sendOpts);
    return;
  }

  const { execution, cwdRealpath: cwd } = flow;
  activePolicyFingerprints.set(scope, flow.policy.policyFingerprint);
  const handle = execution.handle;
  const eventStream = execution.subscribe();
  if (flow.resumeFrom) {
    log.info('session', 'resume', { sessionId: flow.resumeFrom, cwd });
  } else {
    log.info('session', 'fresh', { cwd });
  }
  const recordSession = (evt: AgentEvent): void => {
    recordRunSessionEvent({
      scopeId: scope,
      sessions,
      sessionCatalog,
      capability,
      policy: flow.policy,
      event: evt,
    });
    if (evt.type === 'system' && evt.sessionId) {
      log.info('session', 'set', { sessionId: evt.sessionId });
    }
    // Ground truth for "which model is actually running": claude reports the
    // model it loaded in its init event. Logging requested-vs-actual reveals
    // whether the --model pin took effect or claude silently fell back (e.g.
    // an id this claude build/account doesn't recognize).
    if (evt.type === 'system' && evt.model) {
      log.info('session', 'model', {
        requested: requestedModel ?? 'default',
        actual: evt.model,
      });
    }
    if (evt.type === 'system' && evt.threadId) {
      log.info('session', 'set-thread', { threadId: evt.threadId });
    }
  };
  const sentInteractionSignatures = new Set<string>();
  const pendingInteractionSignatures = new Set<string>();
  const interactionSends: Promise<void>[] = [];
  const modelPreferenceSaves: Promise<void>[] = [];
  const syncedNativeModelSelections = new Set<string>();
  let interactionTextBuffer = '';
  let startupInteractionDeferred = false;
  if (useLiveSession && nativeCommand && opensLivePicker(nativeCommand)) {
    const wasActive = liveInteractionByScope.has(scope);
    liveInteractionByScope.set(scope, { picker: true, updatedAt: Date.now() });
    if (!wasActive) log.info('agent-live', 'picker-enter', { scope, input: nativeCommand });
  }
  const observeLiveEvent = (evt: AgentEvent, opts: { sendInteractionCard?: boolean } = {}): void => {
    const isStartupInteraction = evt.type === 'interactive' && evt.phase === 'startup';
    if (evt.type !== 'text' && evt.type !== 'interactive') return;
    const delta = evt.type === 'text' ? evt.delta : evt.text;
    if (isStartupInteraction && liveInputMode !== 'control') {
      if (!startupInteractionDeferred) {
        startupInteractionDeferred = true;
        const queueSize = pending.deferUntilPriority(scope, batch);
        log.info('agent-live', 'startup-interaction-deferred', {
          scope,
          queueSize,
          batchSize: batch.length,
        });
      }
    }
    if (useLiveSession && nativeCommand && controls.profileConfig.agentKind === 'codex') {
      const selection = parseNativeCodexModelSelection(delta);
      if (selection) {
        const signature = `${selection.model}:${selection.reasoningEffort ?? ''}`;
        if (!syncedNativeModelSelections.has(signature)) {
          syncedNativeModelSelections.add(signature);
          const save = saveProfileModelPreferences(controls, {
            model: selection.model,
            reasoningEffort:
              selection.reasoningEffort ?? controls.profileConfig.preferences.reasoningEffort,
          })
            .then(() => {
              log.info('agent-live', 'model-preference-synced', {
                scope,
                model: selection.model,
                ...(selection.reasoningEffort
                  ? { reasoningEffort: selection.reasoningEffort }
                  : {}),
              });
            })
            .catch((err) => {
              log.warn('agent-live', 'model-preference-sync-failed', {
                scope,
                err: err instanceof Error ? err.message : String(err),
              });
            });
          modelPreferenceSaves.push(save);
        }
      }
    }
    interactionTextBuffer = `${interactionTextBuffer}\n${delta}`.slice(-4000);
    const outputKind = bridgeAgent.classifyOutput(interactionTextBuffer);
    const pickerLike = isStartupInteraction || outputKind === 'picker';
    const interaction = pickerLike ? detectLiveInteraction(interactionTextBuffer) : undefined;
    if (useLiveSession && (interaction || pickerLike)) {
      const wasActive = liveInteractionByScope.has(scope);
      const previous = liveInteractionByScope.get(scope);
      const nextSignature = interaction?.signature ?? previous?.signature;
      liveInteractionByScope.set(scope, {
        picker: true,
        updatedAt: Date.now(),
        ...(nextSignature ? { signature: nextSignature } : {}),
      });
      if (!wasActive) log.info('agent-live', 'picker-enter', { scope });
    }
    if (opts.sendInteractionCard === false) return;
    if (isStartupInteraction && liveInputMode === 'control') return;
    if (!interaction || !cardRenderOptions.signCallback) return;
    if (!useLiveSession && (sentInteractionSignatures.size > 0 || pendingInteractionSignatures.size > 0)) {
      return;
    }
    if (
      sentInteractionSignatures.has(interaction.signature) ||
      pendingInteractionSignatures.has(interaction.signature)
    ) {
      return;
    }
    pendingInteractionSignatures.add(interaction.signature);
    const route: LiveInteractionInputRoute = useLiveSession ? 'live' : 'agent';
    const promise = channel
      .send(chatId, { card: liveInteractionCard(interaction, cardRenderOptions.signCallback, route) }, sendOpts)
      .then(() => {
        sentInteractionSignatures.add(interaction.signature);
        log.info('agent-live', 'interaction-card-sent', { scope, route });
      })
      .catch(async (err) => {
        log.warn('agent-live', 'interaction-card-failed', {
          scope,
          route,
          err: err instanceof Error ? err.message : String(err),
        });
        try {
          await channel.send(
            chatId,
            { markdown: liveInteractionFallbackMarkdown(interaction, route) },
            sendOpts,
          );
          sentInteractionSignatures.add(interaction.signature);
          log.info('agent-live', 'interaction-text-fallback-sent', { scope, route });
        } catch (fallbackErr) {
          log.warn('agent-live', 'interaction-text-fallback-failed', {
            scope,
            route,
            err: fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr),
          });
        }
      })
      .finally(() => {
        pendingInteractionSignatures.delete(interaction.signature);
      });
    interactionSends.push(promise);
  };

  // Resolve idle-timeout for this run: scope override (on SessionEntry) wins
  // over global default (preferences). 0 / undefined = no watchdog.
  const scopeOverride = sessions.getIdleTimeoutMinutes(scope);
  const idleTimeoutMs =
    scopeOverride !== undefined
      ? scopeOverride > 0
        ? scopeOverride * 60_000
        : undefined
      : getRunIdleTimeoutMs(controls.cfg);
  if (idleTimeoutMs) {
    log.info('flush', 'idle-watchdog', { idleTimeoutMs });
  }

  const configuredReplyMode = getMessageReplyMode(controls.cfg);
  const replyMode =
    useLiveSession && bridgeRoute?.presentation === 'card' ? 'card' : configuredReplyMode;
  log.info('flush', 'reply-mode', {
    mode: replyMode,
    ...(replyMode !== configuredReplyMode ? { configuredMode: configuredReplyMode } : {}),
  });
  const cotMessages = getCotMessages(controls.cfg);
  const cotEnabled = cotMessages !== 'off';

  // Re-read prefs on every flush so toggling /config mid-stream takes
  // effect immediately. Cheap object lookups, no allocation when on.
  const filterForPrefs = (state: RunState): RunState => {
    if (getShowToolCalls(controls.cfg)) return state;
    return { ...state, blocks: state.blocks.filter((b) => b.kind !== 'tool') };
  };
  const withNativeEmptyFallback = (state: RunState): RunState => {
    if (
      !useLiveSession ||
      bridgeRoute?.kind !== 'native-command' ||
      state.terminal !== 'done' ||
      renderText(state).trim()
    ) {
      return state;
    }
    const observed = interactionTextBuffer.trim();
    if (observed && looksLikeAgentPicker(observed)) {
      log.info('agent-live', 'picker-final-fallback', {
        scope,
        chars: observed.length,
      });
      return {
        ...state,
        blocks: [
          {
            kind: 'text',
            content: `${observed}\n`,
            streaming: false,
          },
        ],
      };
    }
    return {
      ...state,
      blocks: [
        {
          kind: 'text',
          content: `命令已发送到 ${controls.profileConfig.agentKind === 'codex' ? 'Codex' : 'Claude'} live session，未返回文本内容。\n`,
          streaming: false,
        },
      ],
    };
  };
  const prepareStateForReply = (state: RunState): RunState =>
    filterForPrefs(withNativeEmptyFallback(state));
  const cardRenderOptions = callbackAuth
    ? {
        signCallback: (action: string) =>
          callbackAuth.sign({
            runId: execution.runId,
            scope,
            chatId,
            operatorOpenId: firstMsg.senderId,
            action,
            policyFingerprint: flow.policy.policyFingerprint,
            ttlMs: 24 * 60 * 60 * 1000,
          }),
      }
    : {};

  // Interactive-prompt bridging: when the agent raises AskUserQuestion /
  // ExitPlanMode, the headless CLI auto-declines it ("Answer questions?"),
  // but we surface it as a Feishu callback card so the user can answer with a
  // click. The click resumes the session (via handleCardAction → pending
  // queue) as a follow-up turn carrying the choice. Runs as an independent
  // stream subscriber; awaited in finally so it drains before cleanup.
  const promptBridge = callbackAuth
    ? consumeInteractivePrompts(execution.subscribe(), {
        channel,
        chatId,
        scope,
        sendOpts,
        sign: () =>
          callbackAuth.sign({
            runId: execution.runId,
            scope,
            chatId,
            operatorOpenId: firstMsg.senderId,
            action: PROMPT_CALLBACK_ACTION,
            policyFingerprint: flow.policy.policyFingerprint,
            ttlMs: 24 * 60 * 60 * 1000,
          }),
      })
    : Promise.resolve();

  // For non-card modes Claude's output doesn't surface visually until either
  // a first streamed token (markdown mode) or the whole run ends (text mode).
  // Add a "Typing" reaction to the triggering message as an instant ack, but
  // never let that outbound API call block agent event draining.
  const reactionPromise =
    cotEnabled || replyMode === 'card' ? undefined : addWorkingReaction(channel, lastMsg.messageId);

  try {
    if (useLiveSession && nativeCommand) {
      const finalState = await processAgentStream(
        handle,
        eventStream,
        scope,
        idleTimeoutMs,
        recordSession,
        async () => {},
        observeLiveEvent,
      );
      await sendFinalReply({
        channel,
        chatId,
        scope,
        state: prepareStateForReply(finalState),
        replyMode: 'card',
        sendOpts,
        cardRenderOptions,
        skipLiveInteractionSignatures: new Set([
          ...sentInteractionSignatures,
          ...pendingInteractionSignatures,
        ]),
        liveInteractionInputRoute: 'live',
      });
      return;
    }

    if (cotEnabled) {
      const cotPublisher = new CotPublisher({
        client: cotClient,
        chatId,
        // Mirror sendOpts.replyInThread: in topic groups the CoT bubble must be
        // addressed to the thread so it lands inside the topic, not at the
        // group top level.
        ...(mode === 'topic' && threadId ? { threadId } : {}),
        originMessageId: lastMsg.messageId,
        runId: execution.runId,
        scope,
        inputPreview: lastMsg.content,
      });
      await cotPublisher.start();
      if (!cotPublisher.disabled) {
        const cotDone = consumeCotEvents(execution.subscribe(), cotPublisher, {
          detail: cotMessages,
        });
        const finalState = await processAgentStream(
          handle,
          eventStream,
          scope,
          idleTimeoutMs,
          recordSession,
          async () => {},
          observeLiveEvent,
        );
        await cotDone;
        if (cotPublisher.degradedReason) {
          await sendCotDegradedNotice({
            channel,
            chatId,
            scope,
            sendOpts,
            reason: cotPublisher.degradedReason,
          });
        }
        await sendFinalReply({
          channel,
          chatId,
          scope,
          state: finalAnswerOnlyState(prepareStateForReply(finalState)),
          replyMode,
          sendOpts,
          cardRenderOptions,
          skipLiveInteractionSignatures: new Set([
            ...sentInteractionSignatures,
            ...pendingInteractionSignatures,
          ]),
          liveInteractionInputRoute: useLiveSession ? 'live' : 'agent',
        });
        return;
      }
      log.warn('cot', 'fallback-existing-reply', { reason: 'create-disabled' });
    }

    if (replyMode === 'card') {
      let latestState: RunState = initialState;
      // The streamed message can die mid-run (Feishu 230011 "message withdrawn",
      // content-length limits, or the platform's automatic 10-minute stream
      // close). Keep draining events, roll over before the platform deadline,
      // and post the final answer as a fresh message if the last patch failed.
      let streamDegraded = false;
      let freshFinalPosted = false;
      let cardCtrl:
        | { update(next: object | ((current: object) => object)): Promise<void> }
        | undefined;
      const postFreshFinal = async (state: RunState): Promise<void> => {
        if (freshFinalPosted) return;
        freshFinalPosted = true;
        await channel.send(
          chatId,
          {
            card: renderLiveAwareReplyCard(
              prepareStateForReply(state),
              cardRenderOptions,
              useLiveSession ? 'live' : 'agent',
            ),
          },
          sendOpts,
        );
      };
      const renderDone = processAgentStream(
        handle,
        eventStream,
        scope,
        idleTimeoutMs,
        recordSession,
        async (state) => {
          latestState = state;
          if (cardCtrl) {
            try {
              await cardCtrl.update(
                renderLiveAwareReplyCard(
                  prepareStateForReply(state),
                  cardRenderOptions,
                  useLiveSession ? 'live' : 'agent',
                ),
              );
            } catch (err) {
              streamDegraded = true;
              cardCtrl = undefined;
              log.warn('stream', 'patch-degraded', {
                scope,
                mode: replyMode,
                err: err instanceof Error ? err.message : String(err),
              });
            }
          }
        },
        observeLiveEvent,
      );
      await runRollingReplyStream({
        mode: replyMode,
        renderDone,
        startSegment: (segmentDone, markProducerStarted) =>
          channel.stream(
            chatId,
            {
              card: {
                initial: renderLiveAwareReplyCard(
                  prepareStateForReply(latestState),
                  cardRenderOptions,
                  useLiveSession ? 'live' : 'agent',
                ),
                producer: async (ctrl) => {
                  markProducerStarted();
                  streamDegraded = false;
                  cardCtrl = ctrl;
                  try {
                    await ctrl.update(
                      renderLiveAwareReplyCard(
                        prepareStateForReply(latestState),
                        cardRenderOptions,
                        useLiveSession ? 'live' : 'agent',
                      ),
                    );
                  } catch (err) {
                    streamDegraded = true;
                    cardCtrl = undefined;
                    log.warn('stream', 'patch-degraded', {
                      scope,
                      mode: replyMode,
                      step: 'initial',
                      err: err instanceof Error ? err.message : String(err),
                    });
                  }
                  try {
                    await segmentDone;
                  } finally {
                    if (cardCtrl === ctrl) cardCtrl = undefined;
                  }
                },
              },
            },
            sendOpts,
          ),
        fallback: postFreshFinal,
      });
      if (streamDegraded) {
        await postFreshFinal(prepareStateForReply(latestState));
      }
    } else if (replyMode === 'markdown') {
      let latestState: RunState = initialState;
      // See card branch: a withdrawn/failed patch must degrade to a fresh final
      // message instead of aborting the run and losing the answer.
      let streamDegraded = false;
      let freshFinalPosted = false;
      let markdownCtrl: { setContent(markdown: string): Promise<void> } | undefined;
      const postFreshFinal = async (state: RunState): Promise<void> => {
        if (freshFinalPosted) return;
        freshFinalPosted = true;
        const body = renderText(prepareStateForReply(state));
        if (body.trim()) {
          await channel.send(chatId, { markdown: body }, sendOpts);
        }
      };
      const renderDone = processAgentStream(
        handle,
        eventStream,
        scope,
        idleTimeoutMs,
        recordSession,
        async (state) => {
          latestState = state;
          if (markdownCtrl) {
            try {
              await markdownCtrl.setContent(renderText(prepareStateForReply(state)));
            } catch (err) {
              streamDegraded = true;
              markdownCtrl = undefined;
              log.warn('stream', 'patch-degraded', {
                scope,
                mode: replyMode,
                err: err instanceof Error ? err.message : String(err),
              });
            }
          }
        },
        observeLiveEvent,
      );
      await runRollingReplyStream({
        mode: replyMode,
        renderDone,
        startSegment: (segmentDone, markProducerStarted) =>
          channel.stream(
            chatId,
            {
              markdown: async (ctrl) => {
                markProducerStarted();
                streamDegraded = false;
                markdownCtrl = ctrl;
                try {
                  await ctrl.setContent(renderText(prepareStateForReply(latestState)));
                } catch (err) {
                  streamDegraded = true;
                  markdownCtrl = undefined;
                  log.warn('stream', 'patch-degraded', {
                    scope,
                    mode: replyMode,
                    step: 'initial',
                    err: err instanceof Error ? err.message : String(err),
                  });
                }
                try {
                  await segmentDone;
                } finally {
                  if (markdownCtrl === ctrl) markdownCtrl = undefined;
                }
              },
            },
            sendOpts,
          ),
        fallback: postFreshFinal,
      });
      if (streamDegraded) {
        await postFreshFinal(prepareStateForReply(latestState));
      }
    } else {
      // text mode: drain the agent stream without sending anything during
      // the run, then post the final rendered text once as a plain markdown
      // (msg_type=post) message — no card, no streaming, no typewriter.
      const finalState = await processAgentStream(
        handle,
        eventStream,
        scope,
        idleTimeoutMs,
        recordSession,
        async () => {},
        observeLiveEvent,
      );
      await sendFinalReply({
        channel,
        chatId,
        scope,
        state: prepareStateForReply(finalState),
        replyMode,
        sendOpts,
        cardRenderOptions,
        skipLiveInteractionSignatures: new Set([
          ...sentInteractionSignatures,
          ...pendingInteractionSignatures,
        ]),
        liveInteractionInputRoute: useLiveSession ? 'live' : 'agent',
      });
    }
  } catch (err) {
    log.fail('stream', err);
  } finally {
    // Let the interactive-prompt subscriber drain (it resolves when the event
    // stream ends); it never rejects, so this can't mask a run error.
    await promptBridge;
    await Promise.allSettled(interactionSends);
    await Promise.allSettled(modelPreferenceSaves);
    if (useLiveSession && nativeCommand && closesLivePicker(nativeCommand)) {
      if (liveInteractionByScope.delete(scope)) {
        log.info('agent-live', 'picker-exit', { scope, input: nativeCommand });
      }
    }
    activePolicyFingerprints.delete(scope);
    scheduleWorkingReactionCleanup(channel, lastMsg.messageId, reactionPromise);
  }
}

async function sendFinalReply(input: {
  channel: LarkChannel;
  chatId: string;
  scope: string;
  state: RunState;
  replyMode: ReturnType<typeof getMessageReplyMode>;
  sendOpts: { replyTo: string; replyInThread?: boolean };
  cardRenderOptions: { signCallback?: (action: string) => string };
  skipLiveInteractionSignatures?: ReadonlySet<string>;
  liveInteractionInputRoute?: LiveInteractionInputRoute;
}): Promise<void> {
  const body = renderText(input.state);

  if (input.replyMode === 'card') {
    if (isSkippedLiveInteractionForText(body, input.skipLiveInteractionSignatures)) {
      log.info('outbound', 'skipped', outboundLogFields(input, 'live-interaction-duplicate', body));
      return;
    }
    const liveCard = renderLiveAwareReplyCard(
      input.state,
      input.cardRenderOptions,
      input.liveInteractionInputRoute ?? 'live',
      input.skipLiveInteractionSignatures,
    );
    let result: { messageId?: string } | undefined;
    try {
      result = await input.channel.send(
        input.chatId,
        { card: liveCard },
        input.sendOpts,
      );
    } catch (err) {
      log.warn('outbound', 'card-fallback', {
        scope: input.scope,
        err: err instanceof Error ? err.message : String(err),
      });
      if (!body.trim()) return;
      result = await input.channel.send(
        input.chatId,
        { markdown: body },
        input.sendOpts,
      );
      log.info('outbound', 'sent', outboundLogFields(input, 'markdown', body, result));
      return;
    }
    log.info(
      'outbound',
      'sent',
      outboundLogFields(
        input,
        isLiveInteractionCardForText(body, input.skipLiveInteractionSignatures) ? 'live-interaction-card' : 'card',
        body,
        result,
      ),
    );
  } else if (input.replyMode === 'markdown') {
    if (body.trim()) {
      try {
        await input.channel.stream(
          input.chatId,
          {
            markdown: async (ctrl) => {
              await ctrl.setContent(body);
            },
          },
          input.sendOpts,
        );
        log.info('outbound', 'sent', outboundLogFields(input, 'markdown-stream', body));
      } catch (err) {
        log.warn('outbound', 'markdown-stream-fallback', {
          err: err instanceof Error ? err.message : String(err),
        });
        const result = await input.channel.send(
          input.chatId,
          { markdown: body },
          input.sendOpts,
        );
        log.info('outbound', 'sent', outboundLogFields(input, 'markdown', body, result));
      }
    }
  } else if (body.trim()) {
    const result = await input.channel.send(
      input.chatId,
      { markdown: body },
      input.sendOpts,
    );
    log.info('outbound', 'sent', outboundLogFields(input, 'text', body, result));
  }
}

async function sendCotDegradedNotice(input: {
  channel: LarkChannel;
  chatId: string;
  scope: string;
  sendOpts: { replyTo: string; replyInThread?: boolean };
  reason: string;
}): Promise<void> {
  log.warn('cot', 'degraded', {
    scope: input.scope,
    reason: input.reason,
    replyInThread: input.sendOpts.replyInThread === true,
  });
  try {
    await input.channel.send(
      input.chatId,
      { markdown: 'COT 过程消息更新失败，已停止展示过程；最终答案仍会继续发送。' },
      input.sendOpts,
    );
  } catch (err) {
    log.warn('cot', 'degraded-notice-failed', {
      scope: input.scope,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

function outboundLogFields(
  input: {
    scope?: string;
    replyMode: ReturnType<typeof getMessageReplyMode>;
    sendOpts?: { replyTo?: string; replyInThread?: boolean };
  },
  type: string,
  body: string,
  result?: { messageId?: string },
): Record<string, unknown> {
  return {
    type,
    scope: input.scope,
    mode: input.replyMode,
    chars: body.length,
    messageId: result?.messageId,
    replyTo: input.sendOpts?.replyTo,
    replyInThread: input.sendOpts?.replyInThread === true,
  };
}

/**
 * Drive the agent's event stream into a stateful RunState, calling `flush`
 * on every state transition. Used by both card and markdown reply modes —
 * the only difference between the two is what `flush` does with the state.
 */
async function processAgentStream(
  handle: RunHandle,
  events: AsyncIterable<AgentEvent>,
  scope: string,
  idleTimeoutMs: number | undefined,
  recordSession: (event: AgentEvent) => void,
  flush: (state: RunState) => Promise<void>,
  observeEvent: (event: AgentEvent) => void = () => {},
): Promise<RunState> {
  const runStart = Date.now();
  let state: RunState = initialState;

  // Idle watchdog: claude going silent for `idleTimeoutMs` is treated as
  // "presumed hung", we stop() and surface a timeout marker on the card.
  //
  // BUT — claude can legitimately be silent for a long time when it's
  // waiting on a long-running tool call (e.g. `lark-cli` printing an
  // OAuth URL and blocking until the user clicks authorize). In that
  // case there's no event stream activity from claude itself, only the
  // tool subprocess running. We track which tool_use ids haven't matched
  // a tool_result yet, and pause the watchdog whenever the set is
  // non-empty.
  //
  // The watchdog re-arms when:
  //  - a tool_result drains the in-flight set to zero, OR
  //  - any non-tool event arrives while the set is empty.
  let idleFired = false;
  let timer: NodeJS.Timeout | undefined;
  const inFlightTools = new Set<string>();
  const armOrPauseIdle = (): void => {
    if (!idleTimeoutMs) return;
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (inFlightTools.size > 0) return;
    timer = setTimeout(() => {
      idleFired = true;
      handle.interrupted = true;
      log.warn('agent', 'idle-timeout', { scope, idleTimeoutMs });
      void handle.run.stop().catch(() => {
        /* stop errors are non-fatal */
      });
    }, idleTimeoutMs);
  };
  armOrPauseIdle();

  try {
    for await (const evt of events) {
      if (handle.interrupted) break;

      // Track tool flight before re-arming the idle timer so the arm step
      // sees the correct set size. tool_use opens a window; tool_result
      // closes it. Other event types are bookkept after the if/else.
      if (evt.type === 'tool_use') {
        inFlightTools.add(evt.id);
        log.info('agent', 'tool-in-flight', {
          tool: evt.name,
          inFlight: inFlightTools.size,
        });
      } else if (evt.type === 'tool_result') {
        inFlightTools.delete(evt.id);
        log.info('agent', 'tool-done', { inFlight: inFlightTools.size });
      }
      armOrPauseIdle();

      if (evt.type === 'system') {
        recordSession(evt);
        continue;
      }
      if (evt.type === 'usage') {
        const { costUsd, inputTokens, outputTokens } = evt;
        if (costUsd !== undefined || inputTokens !== undefined || outputTokens !== undefined) {
          log.info('agent', 'usage', {
            ...(costUsd !== undefined ? { costUsd: Number(costUsd.toFixed(4)) } : {}),
            ...(inputTokens !== undefined ? { inputTokens } : {}),
            ...(outputTokens !== undefined ? { outputTokens } : {}),
          });
          if (costUsd !== undefined) reportMetric('cost_usd', costUsd);
          if (inputTokens !== undefined) reportMetric('tokens_in', inputTokens);
          if (outputTokens !== undefined) reportMetric('tokens_out', outputTokens);
        }
        continue;
      }

      observeEvent(evt);
      const prevTerminal = state.terminal;
      const prevFooter = state.footer;
      state = reduce(state, evt);
      if (state.footer !== prevFooter || state.terminal !== prevTerminal) {
        log.info('card', 'transition', { footer: state.footer, terminal: state.terminal });
      }
      await flush(state);
      // Stop iterating as soon as we have a terminal state. Some claude
      // versions don't close stdout immediately after the result event, which
      // would leave the for-await waiting forever otherwise.
      if (state.terminal !== 'running') break;
    }
  } finally {
    if (timer) clearTimeout(timer);
  }

  // If state already reached a terminal event (done/error/etc.) before the
  // watchdog or interrupt could land, don't clobber it — that real terminal
  // wins. This avoids "claude finished but flush was slow → timer fired
  // mid-flush → user sees 'idle_timeout' on a successful run".
  if (state.terminal === 'running') {
    if (idleFired) {
      state = markIdleTimeout(state, Math.round(idleTimeoutMs! / 60_000));
    } else if (handle.interrupted) {
      state = markInterrupted(state);
    } else {
      state = finalizeIfRunning(state);
    }
  }
  log.info('card', 'final', { scope, terminal: state.terminal, interrupted: handle.interrupted });
  reportMetric('run_e2e_ms', Date.now() - runStart, { terminal: state.terminal });
  await flush(state);
  if (handle.interrupted) {
    await handle.run.stop();
  }
  return state;
}

export async function runRollingReplyStream(input: {
  mode: 'card' | 'markdown';
  renderDone: Promise<RunState>;
  startSegment: (
    segmentDone: Promise<void>,
    markProducerStarted: () => void,
  ) => Promise<unknown>;
  fallback: (state: RunState) => Promise<void>;
  rolloverMs?: number;
}): Promise<void> {
  let renderSettled = false;
  const renderResult = input.renderDone.then(
    (state) => {
      renderSettled = true;
      return { kind: 'render' as const, ok: true as const, state };
    },
    (err) => {
      renderSettled = true;
      return { kind: 'render' as const, ok: false as const, err };
    },
  );
  const rolloverMs = input.rolloverMs ?? STREAM_ROLLOVER_MS;
  let segment = 0;

  while (true) {
    segment += 1;
    let producerStarted = false;
    let rolloverTimer: NodeJS.Timeout | undefined;
    const rollover = new Promise<void>((resolve) => {
      rolloverTimer = setTimeout(resolve, rolloverMs);
    });
    const segmentDone = Promise.race([
      renderResult.then(() => undefined),
      rollover,
    ]);
    const streamResult = Promise.resolve()
      .then(() => input.startSegment(segmentDone, () => {
        producerStarted = true;
      }))
      .then(
        () => ({ kind: 'stream' as const, ok: true as const }),
        (err) => ({ kind: 'stream' as const, ok: false as const, err }),
      );
    const first = await Promise.race([streamResult, renderResult]);
    if (rolloverTimer) clearTimeout(rolloverTimer);

    if (!first.ok) {
      if (first.kind === 'stream') {
        log.fail('stream', first.err, { mode: input.mode, step: 'stream', segment });
        const rendered = await renderResult;
        if (!rendered.ok) throw rendered.err;
        await runFallbackReply(input.mode, rendered.state, input.fallback);
        return;
      }
      throw first.err;
    }

    if (first.kind === 'render') {
      if (!producerStarted) {
        log.warn('stream', 'producer-not-started-before-agent-terminal', {
          mode: input.mode,
          segment,
        });
        await runFallbackReply(input.mode, first.state, input.fallback);
        return;
      }

      const terminal = await Promise.race([
        streamResult,
        delay(STREAM_TERMINAL_GRACE_MS).then(() => undefined),
      ]);
      if (!terminal) {
        log.warn('stream', 'terminal-grace-expired', {
          mode: input.mode,
          segment,
          graceMs: STREAM_TERMINAL_GRACE_MS,
        });
        void streamResult.then((result) => {
          if (!result.ok) {
            log.fail('stream', result.err, {
              mode: input.mode,
              segment,
              step: 'stream-terminal-late',
            });
          }
        });
        return;
      }
      if (!terminal.ok) throw terminal.err;
      return;
    }

    if (renderSettled) {
      const rendered = await renderResult;
      if (!rendered.ok) throw rendered.err;
      return;
    }

    log.info('stream', 'rollover', {
      mode: input.mode,
      segment,
      rolloverMs,
    });
  }
}

async function runFallbackReply(
  mode: 'card' | 'markdown',
  state: RunState,
  fallback: (state: RunState) => Promise<void>,
): Promise<void> {
  try {
    await fallback(state);
  } catch (err) {
    log.fail('stream', err, { mode, step: 'fallback' });
  }
}

function scheduleWorkingReactionCleanup(
  channel: LarkChannel,
  messageId: string,
  reactionPromise: Promise<string | undefined> | undefined,
): void {
  if (!reactionPromise) return;

  void (async () => {
    const reactionResult = reactionPromise.then(
      (reactionId) => ({ ok: true as const, reactionId }),
      (err) => ({ ok: false as const, err }),
    );
    const settled = await Promise.race([
      reactionResult,
      delay(REACTION_CLEANUP_GRACE_MS).then(() => undefined),
    ]);

    if (!settled) {
      log.warn('reaction', 'cleanup-deferred', {
        messageId,
        graceMs: REACTION_CLEANUP_GRACE_MS,
      });
      void reactionResult.then((result) => {
        if (!result.ok || !result.reactionId) return;
        void removeReaction(channel, messageId, result.reactionId);
      });
      return;
    }

    if (!settled.ok || !settled.reactionId) return;
    await removeReaction(channel, messageId, settled.reactionId);
  })();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildPrompt(
  batch: NormalizedMessage[],
  attachments: LocalAttachment[],
  quotes: QuotedContext[] = [],
  topicContext: QuotedContext[] = [],
  botIdentity?: { openId: string; name?: string },
  extraInstructions?: string[],
): string {
  const first = batch[0];
  if (!first) return '';

  const fileKeys = batch.flatMap((m) => m.resources.map((r) => r.fileKey));
  // When the debounce window merged messages (possibly from several senders —
  // common in bot-at-bot group chats), annotate each segment with its sender
  // so the agent can tell who said what. Single-message batches stay verbatim.
  const annotate = batch.length > 1;
  const texts = batch
    .map((m) => {
      const text = stripAttachmentRefs(m.content, fileKeys).trim();
      if (!text) return '';
      return annotate ? `${senderAnnotation(m)} ${text}` : text;
    })
    .filter(Boolean);
  const userPart =
    texts.length > 0
      ? texts.join('\n\n')
      : attachments.length > 0
        ? '请看下面的附件。'
        : quotes.length > 0
          ? '（对方仅引用了上述消息。请围绕引用内容回答；若其中没有明确问题或任务，再简短询问其意图。）'
          : '（对方发来一条没有正文的消息——通常是只 @ 了你的唤醒（ping）。请简短回应。）';

  const senderType = senderTypeOf(first);
  const mentions = mergeMentions(batch);

  return buildAgentPrompt({
    context: {
      chatId: first.chatId,
      chatType: first.chatType,
      senderId: first.senderId,
      ...(first.senderName ? { senderName: first.senderName } : {}),
      ...(senderType ? { senderType } : {}),
      ...(botIdentity?.openId ? { botOpenId: botIdentity.openId } : {}),
      ...(mentions.length > 0 ? { mentions } : {}),
      ...(first.threadId ? { threadId: first.threadId } : {}),
      messageIds: batch.map((m) => m.messageId),
      source: 'im',
    },
    instructions:
      extraInstructions && extraInstructions.length > 0
        ? [...BRIDGE_AGENT_INSTRUCTIONS, ...extraInstructions]
        : BRIDGE_AGENT_INSTRUCTIONS,
    userInput: userPart,
    ...(topicContext.length > 0 ? { topicContext: topicContext.map(toPromptTopicMessage) } : {}),
    quotedMessages: quotes.map(toPromptQuote),
    interactiveCards: batch.map(toPromptInteractiveCard).filter(isDefined),
    attachments: attachments.map(toPromptAttachment),
  });
}

function buildTerminalInput(
  batch: NormalizedMessage[],
  attachments: LocalAttachment[],
  quotes: QuotedContext[],
): string {
  const fileKeys = batch.flatMap((message) => message.resources.map((resource) => resource.fileKey));
  const texts = batch
    .map((message) => stripAttachmentRefs(message.content, fileKeys))
    .filter((text) => text.length > 0);
  if (texts.length > 0) return texts.join('\n\n');

  const quotedText = quotes.map((quote) => quote.content).filter((text) => text.length > 0);
  if (quotedText.length > 0) return quotedText.join('\n\n');

  return attachments.map((attachment) => attachment.path).join('\n');
}

function nativeAgentCommandForBatch(batch: NormalizedMessage[]): string | undefined {
  if (batch.length !== 1) return undefined;
  const msg = batch[0];
  if (!msg || !isNativeAgentCommandMessage(msg)) return undefined;
  const text = msg.content.trimStart();
  if (isForceLiveAgentCommandMessage(msg)) return text;
  return isSlashCommandText(text) || isLivePickerInput(text) ? text : undefined;
}

function liveInputModeForBatch(
  batch: NormalizedMessage[],
  nativeCommand: string,
): LiveInputMode | undefined {
  const mode = batch.map(liveInputModeForMessage).find((item): item is LiveInputMode => Boolean(item));
  if (mode) return mode;
  return nativeCommand.trimStart().startsWith('/') ? 'command' : 'control';
}

function looksLikeAgentPicker(text: string): boolean {
  return (
    isClaudeBypassPermissionsPrompt(text) ||
    isCodexUpdatePrompt(text) ||
    /press\s+enter\s+to\s+(?:confirm|continue)/i.test(text) ||
    /esc\s+to\s+(?:go\s+back|cancel)/i.test(text) ||
    /\b(?:y\/n|yes\/no|no\/yes)\b/i.test(text) ||
    /\bselect\s+(?:a\s+)?(?:model|option)\b/i.test(text) ||
    /\bchoose an action\b/i.test(text) ||
    /(?:^|\n)\s*(?:[›>▸*+-]\s*)?\d{1,2}[.)、:\s-]+\S/u.test(text) &&
      /\b(?:choose|select|enable|disable|skills?|model|effort|action)\b/i.test(text) ||
    /(?:↑|↓|up\/down|arrow keys?|use .*arrows?)/i.test(text) ||
    /(?:do you want to|would you like to|shall i|waiting for (?:user|your) (?:input|confirmation)|requires? (?:approval|confirmation)|approve|allow).*(?:\?|proceed|continue|run|execute|apply|approve|allow)/i.test(
      text,
    ) ||
    /(?:请选择|请(?:输入|回复).*(?:选项|编号|是|否)|等待(?:你|用户)(?:的)?(?:输入|选择|确认)|是否.*[？?]|(?:按下?|点击)回车(?:键)?.*确认)/i.test(
      text,
    )
  );
}

interface LiveInteractionButton {
  label: string;
  input: string;
}

interface LiveInteractionPrompt {
  signature: string;
  prompt: string;
  buttons: LiveInteractionButton[];
}

export type LiveInteractionInputRoute = 'live' | 'agent';

interface NumberedInteractionChoice {
  input: string;
  body: string;
  selected: boolean;
  model?: string;
  state?: string;
}

function detectLiveInteraction(text: string): LiveInteractionPrompt | undefined {
  const prompt = recentLiveInteractionPrompt(text);
  const numberedChoices = extractNumberedInteractionChoices(prompt);
  const displayPrompt = formatLiveInteractionPrompt(prompt, numberedChoices);
  const buttons: LiveInteractionButton[] = [];
  const seenInputs = new Set<string>();
  const add = (label: string, input: string): void => {
    if (seenInputs.has(input)) return;
    seenInputs.add(input);
    buttons.push({ label, input });
  };

  const arrowNumberedPrompt =
    isClaudeBypassPermissionsPrompt(prompt) || isCodexUpdatePrompt(prompt);
  const selectedChoice = numberedChoices.findIndex((choice) => choice.selected);
  for (const [index, choice] of numberedChoices.slice(0, 8).entries()) {
    if (!arrowNumberedPrompt) {
      add(choice.input, choice.input);
      continue;
    }
    const distance = index - (selectedChoice >= 0 ? selectedChoice : 0);
    const navigation = distance < 0 ? 'up '.repeat(-distance) : 'down '.repeat(distance);
    add(choice.input, `${navigation}enter`.trim());
  }
  const hasNumberedChoices = buttons.length > 0;
  const isBinaryConfirmation =
    /\b(?:y\/n|yes\/no|no\/yes)\b|(?:\[y\/n\]|\(y\/n\))/i.test(prompt) ||
    /(?:do you want to|would you like to|shall i|requires? (?:approval|confirmation)|approve|allow).*(?:\?|proceed|continue|run|execute|apply|approve|allow)/i.test(
      prompt,
    );

  if (!hasNumberedChoices && isBinaryConfirmation) {
    add('yes', 'yes');
    add('no', 'no');
  }
  if (
    /(?:press\s+)?enter\s+to\s+confirm|enter\s+to\s+(?:confirm|continue)|(?:按下?|点击)回车(?:键)?.*确认/i.test(
      prompt,
    )
  ) {
    add('enter', 'enter');
  }
  if (
    /esc\s+to\s+(?:go\s+back|cancel)|escape\s+to\s+cancel|(?:按下?|点击).*(?:esc|取消|返回)/i.test(
      prompt,
    )
  ) {
    add('esc', 'esc');
  }
  if (hasNumberedChoices && looksLikeAgentPicker(prompt)) {
    add('enter', 'enter');
    add('esc', 'esc');
  }
  if (buttons.length === 0 && looksLikeAgentPicker(prompt)) {
    add('up', 'up');
    add('down', 'down');
    add('enter', 'enter');
    add('esc', 'esc');
  }
  if (buttons.length === 0) return undefined;
  return {
    signature: `${prompt}\n${buttons.map((button) => button.input).join('|')}`.slice(0, 500),
    prompt: displayPrompt.slice(0, 1200),
    buttons,
  };
}

function recentLiveInteractionPrompt(text: string): string {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const recent = lines.slice(-40);
  let start = -1;
  for (let index = 0; index < recent.length; index += 1) {
    if (isLiveInteractionPromptStart(recent[index]!)) start = index;
  }
  return (start >= 0 ? recent.slice(start) : recent.slice(-12)).join('\n');
}

function isLiveInteractionPromptStart(line: string): boolean {
  return (
    /claude\s+code\s+running\s+in\s+bypass\s+permissions\s+mode/i.test(line) ||
    /\bupdate\s+available\b/i.test(line) ||
    /\bselect\s+(?:a\s+)?(?:model|reasoning|option)\b/i.test(line) ||
    /^skills?$/i.test(line) ||
    /\bchoose an action\b/i.test(line) ||
    /\b(?:command )?requires? (?:approval|confirmation)\b/i.test(line) ||
    /\b(?:do you want to|would you like to|shall i)\s+(?:proceed|continue|run|execute|apply|approve|allow)\b/i.test(
      line,
    )
  );
}

function isClaudeBypassPermissionsPrompt(text: string): boolean {
  return (
    /claude\s+code\s+running\s+in\s+bypass\s+permissions\s+mode/i.test(text) &&
    /\b(?:no,?\s+exit|yes,?\s+i\s+accept)\b/i.test(text)
  );
}

function isCodexUpdatePrompt(text: string): boolean {
  return (
    /\bupdate\s+available\b/i.test(text) &&
    /\bskip(?:\s+until\s+next\s+version)?\b/i.test(text)
  );
}

function extractNumberedInteractionChoices(prompt: string): NumberedInteractionChoice[] {
  const choices = new Map<string, NumberedInteractionChoice>();
  for (const line of prompt.split('\n')) {
    const match = line.match(/^(?:[›❯>▸*+-]\s*)?(\d{1,2})[.)、:\s-]+(.+)$/u);
    if (!match) continue;
    addNumberedInteractionChoice(choices, match[1]!, match[2]!, /^[›❯>▸]/u.test(line));
  }

  if (isCodexModelPickerPrompt(prompt)) {
    const inlineModelChoice = /(?:^|[^0-9])(?:[›>▸*+-]\s*)?(\d{1,2})\s*[.)、:]\s*[a-z]{0,3}(gpt-[a-z0-9][a-z0-9._-]*)/giu;
    for (const match of prompt.matchAll(inlineModelChoice)) {
      addNumberedInteractionChoice(choices, match[1]!, match[2]!, /[›>▸]/u.test(match[0]));
    }
  }

  const out = [...choices.values()];
  if (isCodexModelPickerPrompt(prompt)) {
    out.sort((left, right) => Number(left.input) - Number(right.input));
  }
  return out;
}

function addNumberedInteractionChoice(
  choices: Map<string, NumberedInteractionChoice>,
  input: string,
  body: string,
  selected: boolean,
): void {
  const existing = choices.get(input);
  const model = body.match(/\b(gpt-[a-z0-9][a-z0-9._-]*)\b/iu)?.[1];
  const state = body.match(/\b(current|default)\b/iu)?.[1]?.toLowerCase();
  if (existing) {
    if (!existing.model && model) existing.model = model;
    if (!existing.state && state) existing.state = state;
    existing.selected ||= selected;
    return;
  }
  choices.set(input, {
    input,
    body,
    selected,
    ...(model ? { model } : {}),
    ...(state ? { state } : {}),
  });
}

function formatLiveInteractionPrompt(
  prompt: string,
  choices: NumberedInteractionChoice[],
): string {
  if (!isCodexModelPickerPrompt(prompt)) return prompt;
  const modelChoices = choices.filter((choice) => choice.model);
  if (modelChoices.length === 0) return prompt;
  const title = prompt
    .split('\n')
    .find((line) => /\bselect\s+(?:a\s+)?model\b/i.test(line)) ?? 'Select Model and Effort';
  const rows = modelChoices.map((choice) => {
    const state = choice.state ? ` (${choice.state})` : choice.selected ? ' (selected)' : '';
    return `${choice.input}. ${choice.model}${state}`;
  });
  const hint = /press\s+enter\s+to\s+confirm.*esc\s+to\s+(?:go\s+back|cancel)/i.test(prompt)
    ? 'Press enter to confirm or esc to go back'
    : undefined;
  return [title, ...rows, ...(hint ? [hint] : [])].join('\n');
}

function isCodexModelPickerPrompt(prompt: string): boolean {
  return /\bselect\s+(?:a\s+)?model\b/i.test(prompt) && /\bgpt-[a-z0-9]/i.test(prompt);
}

export function liveInteractionCard(
  interaction: LiveInteractionPrompt,
  signCallback: (action: string) => string,
  inputRoute: LiveInteractionInputRoute = 'live',
): object {
  const actionName =
    inputRoute === 'live' ? LIVE_INPUT_CALLBACK_ACTION : AGENT_INPUT_CALLBACK_ACTION;
  const cmd = inputRoute === 'live' ? 'live.input' : 'agent.input';
  const buttons = interaction.buttons.map((button) => {
    const value: Record<string, unknown> = { cmd, input: button.input };
    value[BRIDGE_CALLBACK_MARKER] = true;
    value.bridge_token = signCallback(actionName);
    return {
      tag: 'button',
      text: { tag: 'plain_text', content: button.label },
      type: button.input === 'yes' || button.input === 'enter' ? 'primary' : 'default',
      width: 'default',
      behaviors: [{ type: 'callback', value }],
    };
  });
  return {
    schema: '2.0',
    config: {
      streaming_mode: false,
      summary: { content: inputRoute === 'live' ? 'live CLI 等待选择' : 'agent 等待输入' },
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: `${inputRoute === 'live' ? 'live CLI 正在等待选择' : 'agent 正在等待输入'}：\n\`\`\`\n${escapeFence(interaction.prompt)}\n\`\`\``,
        },
        ...buttons,
      ],
    },
  };
}

function liveInteractionFallbackMarkdown(
  interaction: LiveInteractionPrompt,
  inputRoute: LiveInteractionInputRoute,
): string {
  const title = inputRoute === 'live' ? 'live CLI 正在等待选择' : 'agent 正在等待输入';
  const choices = interaction.buttons.map((button) => button.input).join(' / ');
  return [
    `${title}（交互卡片发送失败，已退回文本）：`,
    '```',
    escapeFence(interaction.prompt),
    '```',
    choices ? `可直接回复：${choices}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function liveInteractionCardForText(
  text: string,
  signCallback?: (action: string) => string,
  inputRoute: LiveInteractionInputRoute = 'live',
  skipSignatures?: ReadonlySet<string>,
): object | undefined {
  if (!signCallback) return undefined;
  if (!looksLikeAgentPicker(text)) return undefined;
  const interaction = detectLiveInteraction(text);
  if (!interaction || skipSignatures?.has(interaction.signature)) return undefined;
  return liveInteractionCard(interaction, signCallback, inputRoute);
}

export function renderLiveAwareReplyCard(
  state: RunState,
  cardRenderOptions: { signCallback?: (action: string) => string } = {},
  inputRoute: LiveInteractionInputRoute = 'live',
  skipSignatures?: ReadonlySet<string>,
): object {
  const body = renderText(state);
  return (
    liveInteractionCardForText(body, cardRenderOptions.signCallback, inputRoute, skipSignatures) ??
    renderCard(state, cardRenderOptions)
  );
}

function isLiveInteractionCardForText(
  text: string,
  skipSignatures?: ReadonlySet<string>,
): boolean {
  if (!looksLikeAgentPicker(text)) return false;
  const interaction = detectLiveInteraction(text);
  return Boolean(interaction && !skipSignatures?.has(interaction.signature));
}

function isSkippedLiveInteractionForText(
  text: string,
  skipSignatures?: ReadonlySet<string>,
): boolean {
  if (!skipSignatures || !looksLikeAgentPicker(text)) return false;
  const interaction = detectLiveInteraction(text);
  return Boolean(interaction && skipSignatures.has(interaction.signature));
}

function escapeFence(value: string): string {
  return value.replace(/```/g, "'''");
}

function closesLivePicker(input: string): boolean {
  const trimmed = input.trim();
  return (
    /\b(?:enter|return|esc|escape)\b/iu.test(trimmed) ||
    /(?:确认|回车|取消|返回)/u.test(trimmed) ||
    /^[0-9]{1,2}$/u.test(trimmed)
  );
}

function opensLivePicker(input: string): boolean {
  return /^\/(?:model|skills|permissions|resume)(?:\s|$)/iu.test(input.trim());
}

export interface NativeCodexModelSelection {
  model: string;
  reasoningEffort?: CodexReasoningEffort;
}

export function parseNativeCodexModelSelection(
  text: string,
): NativeCodexModelSelection | undefined {
  const lines = text.split('\n').reverse();
  for (const line of lines) {
    const match = line
      .trim()
      .match(/^(?:[•*+-]\s*)?Model changed to\s+([a-z0-9][a-z0-9._-]{0,127})(?:\s+(.+?))?\s*$/iu);
    if (!match || !isCodexModelId(match[1])) continue;
    const rawEffort = match[2]?.trim();
    const reasoningEffort = rawEffort
      ? normalizeNativeCodexReasoningEffort(rawEffort)
      : undefined;
    if (rawEffort && !reasoningEffort) continue;
    return {
      model: match[1],
      ...(reasoningEffort ? { reasoningEffort } : {}),
    };
  }
  return undefined;
}

function normalizeNativeCodexReasoningEffort(
  value: string,
): CodexReasoningEffort | undefined {
  const normalized = value
    .toLowerCase()
    .replace(/[()]/gu, '')
    .replace(/^reasoning\s+/u, '')
    .replace(/[.!。]+$/u, '')
    .trim();
  if (normalized === 'extra high' || normalized === 'extra-high' || normalized === 'extra_high') {
    return 'xhigh';
  }
  return normalized === 'minimal' ||
    normalized === 'low' ||
    normalized === 'medium' ||
    normalized === 'high' ||
    normalized === 'xhigh' ||
    normalized === 'max' ||
    normalized === 'ultra'
    ? normalized
    : undefined;
}

/**
 * Classify the sender as human or bot from the raw Feishu event
 * (`sender.sender_type`: 'user' = human, 'app' = bot). The normalizer drops
 * this field, so read it off `msg.raw` (`includeRawEvent: true` above).
 * Unknown / missing values return undefined — omit rather than guess.
 */
function senderTypeOf(msg: NormalizedMessage): 'user' | 'bot' | undefined {
  const raw = msg.raw as { sender?: { sender_type?: unknown } } | undefined;
  const senderType = raw?.sender?.sender_type;
  if (senderType === 'user') return 'user';
  if (senderType === 'app' || senderType === 'bot') return 'bot';
  return undefined;
}

function senderAnnotation(msg: NormalizedMessage): string {
  const name = msg.senderName ?? msg.senderId;
  const type = senderTypeOf(msg);
  return type ? `[${name} (${type})]:` : `[${name}]:`;
}

function mergeMentions(batch: NormalizedMessage[]): BridgePromptMention[] {
  const seen = new Set<string>();
  const out: BridgePromptMention[] = [];
  for (const msg of batch) {
    for (const mention of msg.mentions ?? []) {
      const dedupeKey = mention.openId ?? `${mention.name ?? ''}:${mention.key}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      out.push({
        ...(mention.openId ? { openId: mention.openId } : {}),
        ...(mention.name ? { name: mention.name } : {}),
        ...(mention.isBot !== undefined ? { isBot: mention.isBot } : {}),
      });
    }
  }
  return out;
}

function replyQuoteTargetForMessage(
  msg: NormalizedMessage,
  mode: ChatMode,
): string | undefined {
  const replyTo = msg.replyToMessageId;
  if (!replyTo) return undefined;

  // Feishu topic messages use root_id/parent_id as the topic root anchor even
  // for ordinary in-topic messages. Treat that as structure, not a quote.
  if (mode === 'topic' && msg.threadId && msg.rootId && replyTo === msg.rootId) {
    return undefined;
  }
  return replyTo;
}

function stripAttachmentRefs(text: string, fileKeys: string[]): string {
  if (!text || fileKeys.length === 0) return text;
  let out = text;
  for (const key of fileKeys) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`!?\\[[^\\]]*\\]\\(${escaped}\\)`, 'g'), '');
    out = out.replace(
      new RegExp(
        `<\\s*(?:file|image|img|audio|video|media|folder)\\b[^>]*\\bkey\\s*=\\s*["']${escaped}["'][^>]*>`,
        'gi',
      ),
      '',
    );
  }
  return out.replace(/\n{3,}/g, '\n\n');
}

function toPromptQuote(q: QuotedContext): BridgePromptQuotedMessage {
  return {
    messageId: q.messageId,
    senderId: q.senderId,
    ...(q.senderName ? { senderName: q.senderName } : {}),
    ...(q.createdAt ? { createdAt: q.createdAt } : {}),
    rawContentType: q.rawContentType,
    content: q.content,
  };
}

function toPromptTopicMessage(q: QuotedContext): BridgePromptTopicMessage {
  return {
    messageId: q.messageId,
    senderId: q.senderId,
    ...(q.senderName ? { senderName: q.senderName } : {}),
    ...(q.senderType ? { senderType: q.senderType } : {}),
    ...(q.createdAt ? { createdAt: q.createdAt } : {}),
    rawContentType: q.rawContentType,
    content: q.content,
  };
}

function toPromptInteractiveCard(m: NormalizedMessage): BridgePromptInteractiveCard | undefined {
  if (m.rawContentType !== 'interactive') return undefined;
  const rawContent = (m.raw as { message?: { content?: unknown } } | undefined)
    ?.message?.content;
  if (typeof rawContent !== 'string' || rawContent.length === 0) return undefined;
  return {
    messageId: m.messageId,
    content: parseJsonOrRaw(rawContent),
  };
}

function parseJsonOrRaw(input: string): unknown {
  try {
    return JSON.parse(input) as unknown;
  } catch {
    return input;
  }
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

import type {
  LarkChannel,
  LarkChannelOptions,
  NormalizedMessage,
} from '@larksuite/channel';
import { createLarkChannel } from '@larksuite/channel';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { claudeCapability, codexCapability } from '../agent/capability';
import { BridgeAgent, createBridgeAgentFromEnvironment } from '../bridge-agent';
import {
  isCodexModelId,
  resolveModelArg,
} from '../agent/models';
import {
  buildAgentPrompt,
  type BridgePromptInteractiveCard,
  type BridgePromptQuotedMessage,
  type BridgePromptTopicMessage,
} from '../agent/prompt';
import type { AgentAdapter, AgentEvent, LiveSessionDiagnostics } from '../agent/types';
import {
  AGENT_INPUT_CALLBACK_ACTION,
  BRIDGE_CALLBACK_MARKER,
  handleCardAction,
  LIVE_INPUT_CALLBACK_ACTION,
} from '../card/dispatcher';
import { consumeInteractivePrompts, PROMPT_CALLBACK_ACTION } from '../card/interactive-prompt';
import { isLiveControlInput, isLiveInterruptInput } from '../agent/live-session';
import type { TmuxBindingStatus } from '../agent/tmux-control';
import {
  isBareAgentConfirmation,
  isActionableBinaryConfirmation,
  isLiveInputPromptLine,
  isLiveInteractionPromptStart,
  isStructuredLiveInteraction,
  liveInteractionSurface,
  parseLiveInteractionOptions,
  type LiveInteractionOption,
} from '../agent/live-interaction-detection';
import { CallbackAuth } from '../card/callback-auth';
import { CallbackNonceStore } from '../card/callback-store';
import {
  answerCard,
  answerHasStructuredBlocks,
  parseAnswerBlocks,
  splitAnswerForDelivery,
} from '../card/answer-presentation';
import { renderCard } from '../card/run-renderer';
import {
  initialState,
  markIdleTimeout,
  markInterrupted,
  markRunFailed,
  reduce,
  type RunState,
} from '../card/run-state';
import { renderText, splitTextForDelivery } from '../card/text-renderer';
import { saveProfileModelPreferences, tryHandleCommand, type Controls } from '../commands';
import type { AppConfig, CodexReasoningEffort } from '../config/schema';
import {
  getAgentSessionMode,
  getAgentStopGraceMs,
  getCotMessages,
  getMaxConcurrentRuns,
  getMessageReplyMode,
  getProgressHeartbeatMs,
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
import type { OutputMode, SessionStore } from '../session/store';
import type { WorkspaceStore } from '../workspace/store';
import { ActiveRuns, requestRunStop, type RunHandle } from './active-runs';
import { ChatModeCache, type ChatMode } from './chat-mode-cache';
import { handleCommentMention } from './comments';
import { recordRunSessionEvent, startRunFlow } from './run-flow';
import { commandSessionCatalogIdentity } from './session-catalog-identity';
import { startKeepalive } from './keepalive';
import { PendingQueue } from './pending-queue';
import { sendStructuredCard } from '../card/structured-interaction';
import { ProcessPool } from './process-pool';
import { fetchQuotedContext, fetchTopicContext, type QuotedContext } from './quote';
import { lookupMessageThreadId } from './thread-id';
import { addWorkingReaction, removeReaction } from './reaction';
import { fetchKnownChats } from './lark-info';
import { ArtifactBroker } from './artifact-broker';
import { InboundMessageLedger } from './inbound-message-ledger';
import { RunEventGate, SerializedDelivery } from './run-delivery';
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
// Keep streamed cards comfortably below CardKit's payload ceiling. A long
// answer is delivered as complete follow-up markdown chunks instead of being
// silently folded to its head and tail inside one card.
const LONG_REPLY_CARD_THRESHOLD_BYTES = 20_000;
const LONG_REPLY_CHUNK_BYTES = 12_000;
const LIVE_INTERACTION_TTL_MS = 30 * 60_000;
// Side mode belongs to the persistent terminal, not to one bridge run. Keep a
// short-lived bridge marker so a body sent immediately after `/btw` can be
// routed while the terminal is still redrawing, then refresh it from tmux.
const SIDE_CONVERSATION_TTL_MS = 24 * 60 * 60_000;
const SIDE_OPENING_TTL_MS = 5 * 60_000;
const SIDE_CLOSING_TTL_MS = 2 * 60_000;
// Keep a confirmed-exit tombstone while tmux can still return the previous
// side footer. Without this, the next ordinary message can be re-routed into
// side mode before the terminal's main-thread frame has been captured.
const SIDE_CLOSED_TTL_MS = 10_000;
// A tmux capture can briefly lag the side footer immediately after Codex
// switches panels. Keep a recently confirmed side marker through that one
// stale main-thread frame; an older false observation still clears manually
// exited side sessions on the next message.
const SIDE_MAIN_CONFIRM_GRACE_MS = 5_000;

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
  const inboundMessages = new InboundMessageLedger(
    deps.appPaths?.mediaDir
      ? join(dirname(deps.appPaths.mediaDir), 'inbound-message-ledger.json')
      : undefined,
  );
  await inboundMessages.load();
  const callbackAuth = callbackNonceStore
    ? new CallbackAuth({
        keys: [{ version: 1, secret: appSecret }],
        nonceStore: callbackNonceStore,
      })
    : undefined;
  const activePolicyFingerprints = new Map<string, string>();
  // Hybrid live mode keeps normal chat on turn-mode runs. This map records
  // scopes currently showing an agent picker so later up/down/enter messages
  // are routed as terminal controls instead of plain chat.
  const liveInteractionByScope = new Map<string, LiveInteractionState>();
  const sideConversationByScope = new Map<string, SideConversationState>();
  for (const [scope, state] of sessions.liveInteractionEntries()) {
    liveInteractionByScope.set(scope, state);
  }
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
  const artifactStateDir = deps.appPaths?.mediaDir
    ? dirname(deps.appPaths.mediaDir)
    : undefined;
  const artifactBroker = new ArtifactBroker(
    join(artifactStateDir ?? join(process.cwd(), '.arg-bridge-media'), 'artifact-broker.sock'),
    channel,
    allowLocalFileRoot,
    artifactStateDir ? join(artifactStateDir, 'artifact-grants.json') : undefined,
  );
  await artifactBroker.start();
  if (agent.tmux?.restoreArtifactDelivery) {
    const restored = await Promise.all(
      artifactBroker.persistentDeliveries().map(async (grant) => ({
        scope: grant.scope,
        restored: await agent.tmux!.restoreArtifactDelivery!(grant.scope, grant).catch(() => false),
      })),
    );
    const count = restored.filter((item) => item.restored).length;
    if (count > 0) log.info('artifact', 'managed-tmux-capabilities-restored', { count });
  }

  // Pending → run handoff: while a run is active on a chat, block its pending
  // queue so messages keep accumulating without flushing. When the run ends,
  // unblock arms a fresh quiet-window timer. Net effect: at most one run per
  // chat in flight, and everything sent during a run merges into the next
  // batch (only flushed once 600ms of silence has passed *after* the run).
  const pending = new PendingQueue(DEBOUNCE_MS, (scope, batch) => {
    const firstMsg = batch[0];
    if (!firstMsg) return;
    // Capture this before any asynchronous handoff. A lifecycle command can
    // arrive while the batch is resolving media/policy and before the
    // executor has registered an ActiveRuns handle. Main and side batches use
    // independent generations so stopping a side relay never cancels a main
    // goal that is still preparing.
    // A priority native command (notably /btw) may flush while the scope is
    // already blocked by the pursuing main run.  Queue blocking has depth
    // semantics, so only the flush that acquired the block may release it.
    // Re-entering block here and unconditionally unblocking in finally leaves
    // a stale depth after the side relay finishes, which makes later /stop and
    // ordinary messages appear to do nothing.
    const ownsQueueBlock = !pending.isBlocked(scope);
    if (ownsQueueBlock) pending.block(scope);
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
          const runInputMode = liveInputModeForMessage(runBatch[0]!);
          const runStopGenerationTarget =
            runInputMode === 'side' || runInputMode === 'side-exit' ? 'side' : 'main';
          const runStopGeneration = activeRuns.currentStopGeneration(scope, runStopGenerationTarget);
          await runAgentBatch({
            channel,
            agent,
            activeRuns,
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
            liveInteractionByScope,
            sideConversationByScope,
            artifactBroker,
            pending,
            scope,
            mode,
            stopGeneration: runStopGeneration,
            stopGenerationTarget: runStopGenerationTarget,
          });
        }
      } catch (err) {
        log.fail('flush', err);
      } finally {
        if (ownsQueueBlock) pending.unblock(scope);
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
          sideConversationByScope,
          allowLocalFileRoot,
          inboundMessages,
          callbackAuth,
        }),
      ).catch((err) => log.fail('intake', err));
    },
    reject: (evt) => {
      log.info('intake', 'reject', { chatId: evt.chatId, reason: evt.reason });
    },
    cardAction: async (evt) => {
      return withTrace({ chatId: evt.chatId, msgId: evt.messageId }, async () => {
        return handleCardAction({
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
          liveDiagnostics: async (scope) => {
            const cwd = workspaces.cwdFor(scope) ?? controls.profileConfig.workspaces.default;
            const live = await agent.tmux?.diagnostics?.(scope, cwd);
            const tmux = await agent.tmux?.status(scope, cwd);
            const queued = pending.snapshot(scope)[0];
            const active = activeRuns.get(scope) ?? activeRuns.getSide(scope);
            const picker = liveInteractionState(sessions, liveInteractionByScope, scope);
            return {
              ...(active ? { runId: active.run.runId } : {}),
              ...(live ? { live } : {}),
              ...(picker ? { picker } : {}),
              ...(queued ? { queue: { queued: queued.queued, deferred: queued.deferred, blocked: queued.blocked } } : {}),
              ...(tmux ? { tmux } : {}),
            };
          },
          liveInteractionGeneration: (scope) =>
            liveInteractionState(sessions, liveInteractionByScope, scope)?.generation,
        });
      }).catch((err) => {
        log.fail('cardAction', err);
        return {
          toast: {
            type: 'error',
            content: '处理点击失败，请稍后重试',
          },
        };
      });
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
      const [disconnectResult, detachResult, ...flushResults] = await Promise.allSettled([
        channel.disconnect(),
        activeRuns.detachAll(),
        agent.shutdown?.(),
        artifactBroker.close(),
        sessions.flush(),
        sessionCatalog?.flush(),
        callbackNonceStore?.flush(),
        inboundMessages.flush(),
        workspaces.flush(),
      ]);
      if (detachResult.status === 'rejected') {
        log.fail('disconnect', detachResult.reason, { step: 'detachAll' });
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
  callbackAuth?: CallbackAuth;
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
  sideConversationByScope: Map<string, SideConversationState>;
  allowLocalFileRoot: (root: string) => Promise<boolean>;
  inboundMessages: InboundMessageLedger;
}

type LogThreadModeOverride = (input: {
  chatId: string;
  resolvedMode: ChatMode;
  threadId: string;
}) => void;

async function intakeMessage(deps: IntakeDeps): Promise<void> {
  const {
    callbackAuth,
    channel,
    agent: rootAgent,
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
    sideConversationByScope,
    allowLocalFileRoot,
    inboundMessages,
  } = deps;
  // `/stop` is an emergency control path. Install its duplicate claim in
  // memory immediately, but do not wait for a potentially slow network-file
  // persistence flush before handling the command.
  const earlyRoute = rewriteAgentCommandMessage(msg, controls.profileConfig.agentKind);
  const isImmediateStop = /^\/stop(?:\s|$)/iu.test(earlyRoute.msg.content.trim());
  if (!(await inboundMessages.claim(msg.messageId, { waitForPersist: !isImmediateStop }))) {
    log.info('intake', 'duplicate-message-suppressed', { msgId: msg.messageId, chatId: msg.chatId });
    return;
  }
  const preview = msg.content.length > 80 ? `${msg.content.slice(0, 80)}…` : msg.content;
  // Resolve scope (and underlying chat mode) once at intake — every
  // downstream consumer keys off these.
  // A stop command must not wait for chat metadata. If the event contains a
  // thread id it still gets the correct topic scope; otherwise ActiveRuns can
  // recover an unambiguous topic scope by chat id below.
  const resolvedMode = isImmediateStop
    ? msg.chatType === 'p2p'
      ? 'p2p' as const
      : msg.threadId
        ? 'topic' as const
        : 'group' as const
    : await chatModeCache.resolve(channel, msg.chatId);
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
  let emsg: NormalizedMessage = threadId === msg.threadId ? msg : { ...msg, threadId };
  // Some groups are converted into topic groups after creation. In that state
  // getChatMode can lag behind the message event shape, so threadId is the
  // stronger signal for topic-scoped sessions and reply routing.
  let chatMode = threadId ? 'topic' : resolvedMode;
  if (threadId && resolvedMode !== 'topic') {
    chatModeCache.invalidate(msg.chatId);
    logThreadModeOverride({
      chatId: msg.chatId,
      resolvedMode,
      threadId,
    });
  }
  let scope = chatMode === 'topic' && threadId
    ? `${msg.chatId}:${threadId}`
    : msg.chatId;
  let agent = rootAgent.forScope?.(scope) ?? rootAgent;
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
  const structuredQuestion = agent.structuredQuestion?.(scope);
  if (structuredQuestion && !route.forceNative && !route.msg.content.trimStart().startsWith('/')) {
    route.msg = { ...route.msg, content: `/answer ${structuredQuestion} ${route.msg.content}` };
    route.forceNative = true;
    route.nativeMode = 'control';
  }
  if (route.nativeMode === 'control' && !threadId) {
    const recovery = recoverLiveControlScope(
      liveInteractionByScope,
      msg.chatId,
      scope,
    );
    if (recovery.ambiguous && recovery.ambiguous.length > 0) {
      await channel.send(
        msg.chatId,
        { markdown: `⚠️ 检测到多个可能的选择窗（${recovery.ambiguous.map((item) => `\`${item}\``).join('、')}），未猜测目标。请在对应话题中重试。` },
        {
          replyTo: msg.messageId,
          ...(threadId ? { replyInThread: true } : {}),
        },
      );
      return;
    }
    if (recovery.scope && recovery.scope !== scope) {
      const requestedScope = scope;
      scope = recovery.scope;
      agent = rootAgent.forScope?.(scope) ?? rootAgent;
      const recoveredThreadId = threadIdForChatScope(msg.chatId, scope);
      if (!threadId && recoveredThreadId) {
        threadId = recoveredThreadId;
        emsg = { ...emsg, threadId };
        route.msg = { ...route.msg, threadId };
        chatMode = 'topic';
      }
      log.info('agent-live', 'picker-scope-recovered', {
        requestedScope,
        scope,
        threadId,
      });
    }
  }
  const sideExitRequested = route.nativeMode === 'side-exit';
  if (sideExitRequested) {
    const requestedScope = scope;
    const recovery = await recoverSideConversationScope({
      map: sideConversationByScope,
      requestedScope: scope,
      chatId: msg.chatId,
      agent,
      activeRuns,
      sessionCatalog,
      workspaces,
      controls,
    });
    if (recovery.ambiguous && recovery.ambiguous.length > 0) {
      const labels = recovery.ambiguous.map((candidate) => `\`${candidate}\``).join('、');
      await channel.send(
        msg.chatId,
        { markdown: `⚠️ 检测到多个可能的 side conversation（${labels}），未猜测退出目标。请在原话题中重试 /btw out。` },
        {
          replyTo: msg.messageId,
          ...(threadId ? { replyInThread: true } : {}),
        },
      );
      return;
    }
    if (recovery.scope && recovery.scope !== scope) {
      scope = recovery.scope;
      agent = rootAgent.forScope?.(scope) ?? rootAgent;
      const recoveredThreadId = threadIdForChatScope(msg.chatId, scope);
      if (!threadId && recoveredThreadId) {
        threadId = recoveredThreadId;
        emsg = { ...emsg, threadId };
        route.msg = { ...route.msg, threadId };
        chatMode = 'topic';
      }
      log.info('agent-live', 'side-scope-recovered', {
        requestedScope,
        scope,
        threadId,
      });
    }
  }
  const pickerActive = agent.structuredControl
    ? (await agent.tmux?.diagnostics?.(scope))?.phase === 'picker'
    : Boolean(liveInteractionState(sessions, liveInteractionByScope, scope));
  // Lifecycle controls must not wait for a potentially slow tmux capture. In
  // particular, /stop is the escape hatch for a stuck run and /btw out must be
  // able to reach the live terminal while Codex is still repainting its side
  // footer. The live session performs its own authoritative state wait.
  const fastLifecycleCommand =
    /^\/stop(?:\s|$)/iu.test(route.msg.content.trim()) ||
    route.nativeMode === 'side' ||
    route.nativeMode === 'side-exit';
  const existingSideState = (fastLifecycleCommand || route.nativeMode === 'control')
    ? sideConversationState(sideConversationByScope, scope)
    : await refreshSideConversationState(
        sideConversationByScope,
        scope,
        agent,
        workspaces,
        controls,
      );
  const pickerFollowup = pickerActive
    ? normalizeLivePickerFollowup(route.msg.content)
    : undefined;
  const sideCommandRequested = route.nativeMode === 'side';
  if (sideCommandRequested) {
    saveSideConversationState(sideConversationByScope, scope, 'opening');
  } else if (sideExitRequested && existingSideState && existingSideState.phase !== 'closed') {
    saveSideConversationState(sideConversationByScope, scope, 'closing', existingSideState.generation);
  }
  const sideFollowup =
    !pickerActive &&
    !pickerFollowup &&
    !route.forceNative &&
    !isSlashCommandText(route.msg.content) &&
    Boolean(existingSideState && (existingSideState.phase === 'opening' || existingSideState.phase === 'active'));
  const routedMsg = pickerFollowup
    ? { ...route.msg, content: pickerFollowup }
    : sideFollowup
      ? markNativeAgentCommand(
          { ...route.msg, content: `/btw ${route.msg.content.trim()}` },
          'side',
        )
      : route.msg;
  if (sideFollowup) {
    log.info('intake', 'side-followup-routed', {
      scope,
      phase: existingSideState?.phase,
      preview: route.msg.content.slice(0, 120),
    });
  }
  const lifecycleScopes = /^\/stop(?:\s|$)/iu.test(routedMsg.content.trim())
    ? sideConversationScopesForChat(sideConversationByScope, msg.chatId, ['opening', 'closing'])
    : [];
  const nativeModelCommand = routedMsg.content.trim() === '/model';
  if (agent.structuredControl && /^\/(?:reset|resume)(?:\s|$)|^\/new(?:\s*$|\s+(?!chat\b))/i.test(routedMsg.content.trim())) {
    await channel.send(msg.chatId, { markdown: '结构化预览尚未开放旧会话导入与重置。请使用独立 profile 测试；现有终端会话未改变。' }, {
      replyTo: msg.messageId, ...(threadId ? { replyInThread: true } : {}),
    });
    return;
  }

  if (
    nativeModelCommand &&
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

  if (!route.forceNative && !nativeModelCommand && !pickerFollowup) {
    const stopCommand = /^\/stop(?:\s|$)/iu.test(routedMsg.content.trim());
    // A remembered `active` side marker describes the terminal panel, not an
    // in-flight side operation. If its side handle has already drained, a
    // plain `/stop` must still be able to stop the main pursuing run. Only an
    // opening/closing transition (which may legitimately have no handle while
    // media/policy preparation is pending) is side-only.
    const sideTransitionPending =
      existingSideState?.phase === 'opening' || existingSideState?.phase === 'closing';
    const lifecycleTarget = stopCommand && (
      Boolean(activeRuns.getSide(scope)) ||
      sideTransitionPending ||
      activeRuns
        .scopesForChat(msg.chatId)
        .some((candidate) => Boolean(activeRuns.getSide(candidate))) ||
      lifecycleScopes.some((candidate) => {
        const state = sideConversationState(sideConversationByScope, candidate);
        return state?.phase === 'opening' || state?.phase === 'closing';
      })
    ) ? 'side' as const : undefined;
    const handled = await tryHandleCommand({
      channel,
      msg: routedMsg,
      scope,
      chatMode,
      sessions,
      workspaces,
      agent,
      activeRuns,
      sessionCatalog,
      ...(stopCommand
        ? { sessionCatalogIdentity: undefined }
        : {
            sessionCatalogIdentity: await commandSessionCatalogIdentity({
              msg: emsg,
              scope,
              mode: chatMode,
              workspaces,
              controls,
              access: accessDecision,
            }),
          }),
      runExecutor: executor,
      processPool: pool,
      controls,
      ...(lifecycleTarget ? { lifecycleTarget } : {}),
      ...(lifecycleScopes.length > 0 ? { lifecycleScopes } : {}),
      allowLocalFileRoot,
      liveDiagnostics: async () => {
        const cwd = workspaces.cwdFor(scope) ?? controls.profileConfig.workspaces.default;
        const live = await agent.tmux?.diagnostics?.(scope, cwd);
        const tmux = await agent.tmux?.status(scope, cwd);
        const queued = pending.snapshot(scope)[0];
        const active = activeRuns.get(scope) ?? activeRuns.getSide(scope);
        const picker = liveInteractionState(sessions, liveInteractionByScope, scope);
        return {
          ...(active ? { runId: active.run.runId } : {}),
          ...(live ? { live } : {}),
          ...(picker ? { picker } : {}),
          ...(queued ? { queue: { queued: queued.queued, deferred: queued.deferred, blocked: queued.blocked } } : {}),
          ...(tmux ? { tmux } : {}),
        };
      },
    });
    if (handled) {
      if (clearsSideConversationOnCommand(routedMsg.content)) {
        clearSideConversationState(sideConversationByScope, scope);
        log.info('agent-live', 'side-state-cleared-command', {
          scope,
          command: routedMsg.content.trim().split(/\s+/u)[0] ?? '',
        });
      }
      const preservePending = commandPreservesPendingMessages(routedMsg.content);
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
  const nativeInputActive =
    Boolean(agent.structuredControl) || pickerActive || getAgentSessionMode(controls.cfg) === 'live';
  const routedInputMode = liveInputModeForMessage(routedMsg);
  // Native controls are a separate control plane.  They must never pass
  // through prompt batching just because an earlier picker card expired or a
  // bridge restart lost its in-memory picker flag.
  const explicitLiveControl = nativeInputActive && isLiveControlInput(routedMsg.content);
  const forceNative =
    route.forceNative ||
    nativeModelCommand ||
    Boolean(pickerFollowup) ||
    explicitLiveControl ||
    isForceLiveAgentCommandMessage(routedMsg);
  const agentMsg = forceNative
    ? markNativeAgentCommand(
        routedMsg,
        explicitLiveControl
          ? 'control'
          : pickerFollowup
          ? 'control'
          : nativeModelCommand
            ? 'command'
            : (route.nativeMode ?? routedInputMode ?? 'command'),
      )
    : nativeInputActive &&
        isNativeAgentInputText(routedMsg.content, pickerActive)
      ? markNativeAgentCommand(
          routedMsg,
          routedMsg.content.trimStart().startsWith('/')
            ? 'command'
            : pickerActive
              ? 'control'
              : undefined,
        )
      : routedMsg;
  // Picker controls and native slash commands form a separate control plane.
  // They must run before ordinary work so a long task cannot strand a model,
  // status, or side-conversation command in the conversational queue.
  const nativeInputMode = liveInputModeForMessage(agentMsg);
  if (agent.structuredControl && activeRuns.hasAny(scope) && (nativeInputMode === 'command' || nativeInputMode === 'control')) {
    const sendOpts = { replyTo: msg.messageId, ...(threadId ? { replyInThread: true } : {}) };
    try {
      for (const event of await agent.structuredControl(scope, agentMsg.content)) {
        if (event.type === 'text') await channel.send(msg.chatId, { markdown: event.delta }, sendOpts);
        if (event.type === 'interactive' && event.interaction) {
          await sendStructuredCard(channel, msg.chatId, event.interaction, callbackAuth ? input => callbackAuth.sign({
            runId: event.interaction!.id, scope, chatId: msg.chatId, operatorOpenId: msg.senderId,
            action: `live_input:${input}`, policyFingerprint: 'structured', ttlMs: 30 * 60 * 1000,
          }) : undefined, sendOpts);
        }
      }
    } catch (error) { await channel.send(msg.chatId, { markdown: `⚠️ ${error instanceof Error ? error.message : String(error)}` }, sendOpts); }
    return;
  }
  const priorityNativeCommand =
    isForceLiveAgentCommandMessage(agentMsg) &&
    (nativeInputMode === 'command' || nativeInputMode === 'side' || nativeInputMode === 'side-exit');
  const activeControlHandle = [activeRuns.getSide(scope), activeRuns.get(scope)].find(
    (handle): handle is RunHandle => Boolean(
      handle && !handle.interrupted && !handle.stopRequested && !handle.detached,
    ),
  );
  const explicitInterruptControl = isLiveInterruptInput(agentMsg.content);
  let terminalPickerActive = explicitInterruptControl;
  let pickerDiagnosticsAvailable = false;
  if (
    nativeInputMode === 'control' &&
    !explicitInterruptControl &&
    activeControlHandle &&
    agent.tmux?.diagnostics
  ) {
    pickerDiagnosticsAvailable = true;
    const diagnostics = await withBoundedSideDiagnostic(
      agent.tmux.diagnostics(
        scope,
        workspaces.cwdFor(scope) ?? controls.profileConfig.workspaces.default,
      ),
      2_000,
    );
    if (diagnostics) {
      terminalPickerActive = diagnostics.phase === 'picker';
    } else {
      pickerDiagnosticsAvailable = false;
      log.info('intake', 'picker-diagnostics-unavailable', { scope });
    }
  }
  // A persisted marker is sufficient when no live diagnostics hook exists
  // (older adapters/bridge restarts). When diagnostics is available, require
  // its current picker phase so an old card cannot inject into a normal task.
  const priorityControlEvidence =
    terminalPickerActive || (!pickerDiagnosticsAvailable && pickerActive);
  const explicitPrefixedControl =
    liveInputModeForMessage(agentMsg) === 'control' && route.forceNative;
  const priorityLiveControl =
    liveInputModeForMessage(agentMsg) === 'control' &&
    (isLiveInterruptInput(agentMsg.content) || priorityControlEvidence || explicitPrefixedControl);
  const canDirectLiveControl =
    liveInputModeForMessage(agentMsg) === 'control' &&
    (isLiveInterruptInput(agentMsg.content) ||
      priorityControlEvidence ||
      (explicitPrefixedControl && Boolean(activeControlHandle && agent.tmux?.sendInput)));
  if (explicitPrefixedControl && activeControlHandle && !agent.tmux?.sendInput) {
    await channel.send(
      msg.chatId,
      { markdown: '⚠️ 当前 live 适配器不支持直接发送选择按键，未修改正在运行的任务。' },
      {
        replyTo: msg.messageId,
        ...(chatMode === 'topic' && threadId ? { replyInThread: true } : {}),
      },
    ).catch((err) => log.warn('intake', 'live-control-unsupported-reply-failed', { scope, err: String(err) }));
    return;
  }
  // A picker can belong to the currently running main live turn. Inject its
  // control into that existing terminal instead of creating a second
  // RunExecutor entry (which would collide with the scope reservation and be
  // placed back into the blocked conversational queue).
  if (canDirectLiveControl && nativeInputMode === 'control') {
    const activeHandle = activeControlHandle;
    const sendInput = agent.tmux?.sendInput;
    let directInjectionAttempted = false;
    if (
      activeHandle &&
      !activeHandle.interrupted &&
      !activeHandle.stopRequested &&
      !activeHandle.detached &&
      sendInput
    ) {
      directInjectionAttempted = true;
      const controlCwd = workspaces.cwdFor(scope) ?? controls.profileConfig.workspaces.default;
      try {
        const stillActive = (): boolean => {
          const currentHandle = [activeRuns.getSide(scope), activeRuns.get(scope)].find(
            (handle): handle is RunHandle => Boolean(
              handle && !handle.interrupted && !handle.stopRequested && !handle.detached,
            ),
          );
          return currentHandle === activeHandle;
        };
        if (stillActive() && await sendInput(scope, agentMsg.content, controlCwd, stillActive)) {
          log.info('intake', 'live-control-injected', {
            scope,
            input: agentMsg.content,
            activeSide: Boolean(activeRuns.getSide(scope)),
          });
          return;
        }
      } catch (err) {
        log.warn('intake', 'live-control-injection-failed', {
          scope,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (directInjectionAttempted) {
      // Never requeue a control that was meant for an active picker: the
      // ordinary active-run guard would put it back behind the same picker
      // forever. Return a retryable diagnostic instead.
      await channel.send(
        msg.chatId,
        { markdown: '⚠️ 当前选择窗无法接收该操作，未发送按键。请等待最新选择卡片后重试。' },
        {
          replyTo: msg.messageId,
          ...(chatMode === 'topic' && threadId ? { replyInThread: true } : {}),
        },
      ).catch((err) => log.warn('intake', 'live-control-failure-reply-failed', { scope, err: String(err) }));
      return;
    }
  }
  if (priorityNativeCommand && activeRuns.hasAny(scope)) {
    log.info('intake', 'native-command-preempt', {
      scope,
      inputMode: nativeInputMode,
      command: agentMsg.content.trim().slice(0, 120),
    });
    if (nativeInputMode === 'side' || nativeInputMode === 'side-exit') {
      // Side conversations share the live terminal but are observed through
      // a separate run. Never detach the main handle here: doing so removes
      // its EventFanout listener and makes the pursuing goal appear to stop.
      log.info('intake', 'native-side-coexists-with-main', { scope, inputMode: nativeInputMode });
    } else {
      activeRuns.advanceStopGeneration(scope);
      activeRuns.interrupt(scope);
    }
  }
  const priorityLiveInput = priorityLiveControl || priorityNativeCommand;
  const size = priorityLiveInput
    ? pending.pushFront(scope, agentMsg, {
        immediate: true,
        priorityOrder: 'fifo',
        ...((priorityNativeCommand || explicitPrefixedControl) ? { preempt: true } : {}),
        // A picker control is already a complete action and must reach the
        // native TUI even while the parent run keeps the conversational queue
        // blocked. Without bypassBlock, `/codex 1` is merely placed ahead of
        // the FIFO but still waits for the long task to finish—the exact
        // symptom seen when the Feishu card is visible yet its choice does
        // nothing. The explicit `/codex` prefix makes this safe even if the
        // persisted picker marker was lost during a restart.
        ...((priorityControlEvidence || isLiveInterruptInput(agentMsg.content) ||
          (priorityNativeCommand && (nativeInputMode === 'side' || nativeInputMode === 'side-exit')))
          ? { bypassBlock: true }
          : {}),
      })
    : pending.push(scope, agentMsg);
  log.info('intake', 'queued', { scope, queueSize: size, debounceMs: DEBOUNCE_MS });

  // A run is already in flight on this scope, so this message won't be picked
  // up until it finishes (block/unblock in the pending→run handoff). Without a
  // hint the sender thinks the bot is dead. Ack once per busy window — not per
  // queued message — and never let the ack block or throw into intake.
  if (!priorityNativeCommand && !priorityLiveControl && pending.shouldAckBusy(scope)) {
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
    /^\/tmux(?:\s+(?:list|status|tail|attach))?(?:\s|$)/u.test(command) ||
    /^\/(?:timeout|output)(?:\s|$)/u.test(command)
  );
}

export function rewriteAgentCommandMessage(
  msg: NormalizedMessage,
  agentKind: 'claude' | 'codex',
): AgentCommandRoute {
  const trimmed = msg.content.trimStart();
  if (agentKind === 'codex' && /^\/btw(?:\s|$)/iu.test(trimmed)) {
    return {
      msg: { ...msg, content: trimmed },
      forceNative: true,
      nativeMode: /^\/btw\s+out\s*$/iu.test(trimmed) ? 'side-exit' : 'side',
    };
  }
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
  // `/codex model` is the natural shorthand users type for `/codex /model`.
  // Treat it as the native picker command rather than ordinary conversation.
  if (/^model$/iu.test(trimmed)) {
    return { text: '/model', forceNative: true, nativeMode: 'command' };
  }
  if (/^\/btw(?:\s|$)/iu.test(trimmed)) {
    return {
      text: input,
      forceNative: true,
      nativeMode: /^\/btw\s+out\s*$/iu.test(trimmed) ? 'side-exit' : 'side',
    };
  }
  // Keep the agent-prefixed lifecycle command on the bridge control plane.
  // Sending `/codex /stop` to the native TUI is a no-op and can also strand
  // the bridge's active-run handle.
  const stopMatch = /^\/?stop(?:\s+([\s\S]+))?$/iu.exec(trimmed);
  if (stopMatch) {
    const target = stopMatch[1]?.trim();
    return { text: target ? `/stop ${target}` : '/stop', forceNative: false };
  }
  const slashless = /^\/([A-Za-z0-9_-]+)$/u.exec(trimmed)?.[1];
  const controlText = slashless && isLivePickerInput(slashless) ? slashless : trimmed;
  if (isLivePickerInput(controlText) || isLiveControlInput(controlText)) {
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

function clearsSideConversationOnCommand(content: string): boolean {
  const command = content.trim().toLowerCase();
  return /^(?:\/new|\/reset|\/cd|\/resume)(?:\s|$)/u.test(command);
}

function isNativeAgentInputText(text: string, pickerActive: boolean): boolean {
  // `/stop` is owned by the bridge lifecycle command even in live mode. If it
  // is marked as a native TUI command, intake preempts the run and then types
  // the literal slash command into Codex where it has no effect.
  if (/^\/stop(?:\s|$)/iu.test(text.trim())) return false;
  if (isSlashCommandText(text)) return true;
  return pickerActive && isLivePickerInput(text);
}

function isLivePickerInput(text: string): boolean {
  const trimmed = text.trim();
  return isLiveControlInput(trimmed) || /^\d{1,2}$/u.test(trimmed) || /^(?:y|yes|n|no)$/iu.test(trimmed);
}

function normalizeLivePickerFollowup(text: string): string | undefined {
  const trimmed = text.trim();
  if (isLivePickerInput(trimmed)) return trimmed;
  const match = /^\/model\s+(.+)$/iu.exec(trimmed);
  const input = match?.[1]?.trim();
  return input && isLivePickerInput(input) ? input : undefined;
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
  expiresAt: number;
  signature?: string;
  generation?: string;
}

type SideConversationPhase = 'opening' | 'active' | 'closing' | 'closed';

interface SideConversationState {
  phase: SideConversationPhase;
  updatedAt: number;
  expiresAt: number;
  generation?: string;
}

function sideConversationState(
  map: Map<string, SideConversationState>,
  scope: string,
): SideConversationState | undefined {
  const state = map.get(scope);
  if (!state) return undefined;
  if (state.expiresAt <= Date.now()) {
    map.delete(scope);
    return undefined;
  }
  return state;
}

/** Recover pending side-transition scopes when Feishu omits a topic thread id. */
function sideConversationScopesForChat(
  map: Map<string, SideConversationState>,
  chatId: string,
  phases: readonly SideConversationPhase[] = ['active', 'opening', 'closing'],
): string[] {
  const prefix = `${chatId}:`;
  const scopes: string[] = [];
  const allowed = new Set(phases);
  for (const candidate of map.keys()) {
    if (candidate !== chatId && !candidate.startsWith(prefix)) continue;
    const state = sideConversationState(map, candidate);
    if (state && allowed.has(state.phase)) scopes.push(candidate);
  }
  return scopes;
}

function threadIdForChatScope(chatId: string, scope: string): string | undefined {
  const prefix = `${chatId}:`;
  return scope.startsWith(prefix) ? scope.slice(prefix.length) || undefined : undefined;
}

interface SideConversationScopeRecovery {
  scope?: string;
  ambiguous?: string[];
}

function recoverLiveControlScope(
  pickerMap: Map<string, LiveInteractionState>,
  chatId: string,
  requestedScope: string,
): { scope?: string; ambiguous?: string[] } {
  const prefix = `${chatId}:`;
  const candidates = new Set<string>([
    requestedScope,
    ...[...pickerMap.keys()].filter((candidate) => candidate === chatId || candidate.startsWith(prefix)),
  ]);
  const positive = [...candidates].filter((candidate) => {
    const picker = liveInteractionStateFromMap(pickerMap, candidate);
    return Boolean(picker);
  });
  if (positive.includes(requestedScope)) return {};
  if (positive.length === 1) return { scope: positive[0] };
  if (positive.length > 1) return { ambiguous: positive.sort() };
  return {};
}

function liveInteractionStateFromMap(
  map: Map<string, LiveInteractionState>,
  scope: string,
): LiveInteractionState | undefined {
  const state = map.get(scope);
  if (!state || state.expiresAt <= Date.now()) {
    if (state) map.delete(scope);
    return undefined;
  }
  return state;
}

/**
 * Recover the durable side target before `/btw out` enters RunExecutor.
 *
 * Topic events occasionally omit `threadId`, and the in-memory marker is lost
 * when the bridge restarts. Managed terminal records and live diagnostics are
 * the only durable bridge-owned evidence in that case. We inspect candidates
 * in parallel and only select a single positive side footer; a multi-topic
 * chat is deliberately rejected instead of sending Ctrl-C to a guessed pane.
 */
async function recoverSideConversationScope(input: {
  map: Map<string, SideConversationState>;
  requestedScope: string;
  chatId: string;
  agent: AgentAdapter;
  activeRuns: ActiveRuns;
  sessionCatalog?: SessionCatalog;
  workspaces: WorkspaceStore;
  controls: Controls;
}): Promise<SideConversationScopeRecovery> {
  const prefix = `${input.chatId}:`;
  const candidates = new Set<string>([
    input.requestedScope,
    ...sideConversationScopesForChat(input.map, input.chatId),
    ...input.activeRuns.scopesForChat(input.chatId),
  ]);
  const cwdByScope = new Map<string, string>();
  const managedCandidates = new Set<string>();
  for (const [scopeId, cwd] of Object.entries(input.workspaces.listCwds(input.chatId))) {
    if (scopeId === input.chatId || scopeId.startsWith(prefix)) {
      candidates.add(scopeId);
      cwdByScope.set(scopeId, cwd);
    }
  }
  for (const entry of input.sessionCatalog?.entries() ?? []) {
    if (entry.status !== 'active' || entry.agentId !== input.controls.profileConfig.agentKind) continue;
    if (entry.scopeId !== input.chatId && !entry.scopeId.startsWith(prefix)) continue;
    candidates.add(entry.scopeId);
    cwdByScope.set(entry.scopeId, entry.cwdRealpath);
  }
  try {
    const managedScopes = await input.agent.tmux?.managedScopesForChat?.(input.chatId);
    for (const candidate of managedScopes ?? []) {
      if (candidate === input.chatId || candidate.startsWith(prefix)) {
        managedCandidates.add(candidate);
        candidates.add(candidate);
      }
    }
  } catch (err) {
    log.info('agent-live', 'side-scope-managed-scan-failed', {
      chatId: input.chatId,
      err: String(err),
    });
  }

  const scoped = [...candidates].filter(
    (candidate) => candidate === input.chatId || candidate.startsWith(prefix),
  );
  if (scoped.length === 0) return {};
  const results = await Promise.all(
    scoped.map(async (candidate) => {
      const remembered = sideConversationState(input.map, candidate);
      const cwd =
        cwdByScope.get(candidate) ??
        input.workspaces.cwdFor(candidate) ??
        input.controls.profileConfig.workspaces.default;
      let diagnostics: LiveSessionDiagnostics | undefined;
      if (input.agent.tmux?.diagnostics && cwd) {
        diagnostics = await withBoundedSideDiagnostic(
          input.agent.tmux.diagnostics(candidate, cwd),
          5_000,
        );
      }
      // An in-memory active/closing marker is the same evidence already used
      // by the exact-scope `/btw out` path. Keep it as a fallback when a single
      // diagnostic capture is a stale main frame; if several remembered topic
      // scopes exist, the ambiguity check below still refuses to guess.
      const rememberedSide = Boolean(
        remembered && (remembered.phase === 'active' || remembered.phase === 'closing'),
      );
      const side = diagnostics?.sideConversation === true || rememberedSide;
      return { candidate, remembered, diagnostics, side };
    }),
  );
  const positives = results.filter((result) => result.side).map((result) => result.candidate);
  if (positives.length > 1) return { ambiguous: positives.sort() };
  const selected = positives[0];
  if (!selected) {
    // A managed topic with a temporarily stale/blank diagnostic is still a
    // useful scope target: run the guarded side-exit there and let the live
    // session wait for a delayed side footer. It never receives Ctrl-C until
    // that footer (or prior bridge evidence) confirms side ownership.
    const onlyManaged = [...managedCandidates].filter((candidate) => candidate !== input.chatId);
    if (onlyManaged.length === 1) return { scope: onlyManaged[0] };
    return {};
  }
  const remembered = results.find((result) => result.candidate === selected)?.remembered;
  if (remembered?.phase !== 'closed') {
    saveSideConversationState(input.map, selected, 'active', remembered?.generation);
  }
  return { scope: selected };
}

async function withBoundedSideDiagnostic(
  operation: Promise<LiveSessionDiagnostics>,
  timeoutMs: number,
): Promise<LiveSessionDiagnostics | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation.catch(() => undefined),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function saveSideConversationState(
  map: Map<string, SideConversationState>,
  scope: string,
  phase: SideConversationPhase,
  generation?: string,
): SideConversationState {
  const now = Date.now();
  const next: SideConversationState = {
    phase,
    updatedAt: now,
    expiresAt:
      now +
      (phase === 'opening'
        ? SIDE_OPENING_TTL_MS
        : phase === 'closing'
          ? SIDE_CLOSING_TTL_MS
          : phase === 'closed'
            ? SIDE_CLOSED_TTL_MS
            : SIDE_CONVERSATION_TTL_MS),
    ...(generation ? { generation } : {}),
  };
  map.set(scope, next);
  return next;
}

function clearSideConversationState(map: Map<string, SideConversationState>, scope: string): void {
  map.delete(scope);
}

async function refreshSideConversationState(
  map: Map<string, SideConversationState>,
  scope: string,
  agent: AgentAdapter,
  workspaces: WorkspaceStore,
  controls: Controls,
): Promise<SideConversationState | undefined> {
  const state = sideConversationState(map, scope);
  const diagnostics = await agent.tmux?.diagnostics?.(
    scope,
    workspaces.cwdFor(scope) ?? controls.profileConfig.workspaces.default,
  ).catch((err) => {
    log.info('agent-live', 'side-state-refresh-failed', { scope, err: String(err) });
    return undefined;
  });
  if (diagnostics?.sideConversation === true) {
    // A confirmed `/btw out` owns the transition. Ignore a stale side footer
    // until a main-thread frame arrives or the short tombstone expires.
    if (state?.phase === 'closed') return state;
    // Recover side ownership after a bridge restart or a stale reconciliation
    // frame cleared the in-memory marker. The terminal footer is the durable
    // source of truth for the shared live session.
    return saveSideConversationState(map, scope, 'active', state?.generation);
  }
  if (diagnostics?.sideConversation === false) {
    // During an explicit side transition, `false` is commonly just the
    // previous main-thread frame: the helper can answer before Codex paints
    // the side footer. Keep the transition marker until the side run's
    // reconciliation has either confirmed success or recorded a failure.
    if (state?.phase === 'opening' || state?.phase === 'closing') {
      return state;
    }
    // Do not let one lagging capture immediately hijack a body that follows a
    // just-opened side panel. A later false observation (after the grace
    // window) still releases a manually exited side session.
    if (state?.phase === 'active' && Date.now() - state.updatedAt < SIDE_MAIN_CONFIRM_GRACE_MS) {
      return state;
    }
    if (state) {
      clearSideConversationState(map, scope);
      log.info('agent-live', 'side-state-cleared-terminal-main', { scope });
    }
    return undefined;
  }
  // Older adapters do not expose sideConversation. Preserve the marker in that
  // case; the marker still expires and is refreshed after every side command.
  return state;
}

async function reconcileSideConversationState(input: {
  map: Map<string, SideConversationState>;
  scope: string;
  agent: AgentAdapter;
  inputMode: 'side' | 'side-exit';
  failed: boolean;
  entryConfirmed?: boolean;
  exitConfirmed?: boolean;
  cwd: string;
}): Promise<void> {
  const before = sideConversationState(input.map, input.scope);
  const diagnostics = await input.agent.tmux?.diagnostics?.(input.scope, input.cwd).catch((err) => {
    log.info('agent-live', 'side-state-reconcile-failed', {
      scope: input.scope,
      err: String(err),
    });
    return undefined;
  });
  if (input.inputMode === 'side-exit') {
    if (input.exitConfirmed === true) {
      saveSideConversationState(input.map, input.scope, 'closed', before?.generation);
      log.info('agent-live', 'side-state-closed-exit', { scope: input.scope });
      return;
    }
    // A failed/ambiguous exit must remain retryable. The diagnostic captured at
    // this boundary can still be the pre-transition main frame, so treating
    // `sideConversation: false` as proof of closure loses the only bridge hint
    // that authorizes the next `/btw out`. Keep a closing tombstone: ordinary
    // text is not routed into it, while a later explicit out can retry. Only a
    // positive exit acknowledgement above is allowed to write `closed`.
    if (before || diagnostics?.sideConversation === true || input.exitConfirmed === false) {
      saveSideConversationState(input.map, input.scope, 'closing', before?.generation);
      log.info('agent-live', 'side-state-kept-exit-retryable', { scope: input.scope });
    }
    return;
  }

  if (diagnostics?.sideConversation === false) {
    // A side operation owns the transition and may finish before the next
    // tmux capture paints the side footer. Preserve a successful/active side
    // marker through that stale main-thread frame. A failed entry has no side
    // ownership to preserve; a failed body keeps an already confirmed side so
    // the user can retry the body without re-opening the panel.
    if (input.inputMode === 'side' && before?.phase === 'active') {
      saveSideConversationState(input.map, input.scope, 'active', before.generation);
      return;
    }
    if (
      input.inputMode === 'side' &&
      before?.phase === 'opening' &&
      !input.failed &&
      input.entryConfirmed === true
    ) {
      saveSideConversationState(input.map, input.scope, 'active', before.generation);
      return;
    }
    // If an entry failed while the terminal is visibly in the main thread, do
    // not leave a marker that would hijack the next ordinary task.
    clearSideConversationState(input.map, input.scope);
    log.info('agent-live', 'side-state-cleared-main', { scope: input.scope });
    return;
  }
  if (input.inputMode === 'side' && input.entryConfirmed === true) {
    saveSideConversationState(input.map, input.scope, 'active', before?.generation);
    return;
  }
  if (input.failed && before?.phase !== 'active') {
    clearSideConversationState(input.map, input.scope);
    log.info('agent-live', 'side-state-cleared-failed-entry', { scope: input.scope });
    return;
  }
  // Adapters predating explicit side lifecycle evidence may not expose a
  // diagnostics hook. Preserve their successful side turn as the fallback;
  // Codex live sessions emit `entryConfirmed` above and take the stricter
  // path when diagnostics is available.
  if (input.inputMode === 'side' && !input.failed && !input.agent.tmux?.diagnostics) {
    saveSideConversationState(input.map, input.scope, 'active', before?.generation);
    return;
  }
  // A successful side entry/body leaves Codex in side mode. When an older
  // adapter has no diagnostics hook, the side run itself is still sufficient
  // evidence; the next refresh will revalidate if the hook becomes available.
  saveSideConversationState(input.map, input.scope, 'active', before?.generation);
}

function liveInteractionState(
  sessions: SessionStore,
  map: Map<string, LiveInteractionState>,
  scope: string,
): LiveInteractionState | undefined {
  const state = map.get(scope) ?? sessions.getLiveInteraction(scope);
  if (!state || state.expiresAt <= Date.now()) {
    if (map.delete(scope)) sessions.clearLiveInteraction(scope);
    return undefined;
  }
  if (!map.has(scope)) map.set(scope, state);
  return state;
}

function saveLiveInteractionState(
  sessions: SessionStore,
  map: Map<string, LiveInteractionState>,
  scope: string,
  state: Omit<LiveInteractionState, 'expiresAt'> & Partial<Pick<LiveInteractionState, 'expiresAt'>>,
): LiveInteractionState {
  const next: LiveInteractionState = {
    ...state,
    expiresAt: state.expiresAt ?? Date.now() + LIVE_INTERACTION_TTL_MS,
  };
  map.set(scope, next);
  sessions.setLiveInteraction(scope, next);
  return next;
}

function clearLiveInteractionState(
  sessions: SessionStore,
  map: Map<string, LiveInteractionState>,
  scope: string,
  generation?: string,
): boolean {
  const current = map.get(scope);
  if (generation && current?.generation && current.generation !== generation) return false;
  const deleted = map.delete(scope);
  if (deleted || sessions.getLiveInteraction(scope)) sessions.clearLiveInteraction(scope);
  return deleted;
}

interface RunBatchDeps {
  channel: LarkChannel;
  agent: AgentAdapter;
  activeRuns: ActiveRuns;
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
  liveInteractionByScope: Map<string, LiveInteractionState>;
  sideConversationByScope: Map<string, SideConversationState>;
  artifactBroker: ArtifactBroker;
  pending: PendingQueue;
  scope: string;
  mode: ChatMode;
  stopGeneration: number;
  stopGenerationTarget: 'main' | 'side';
}

async function runAgentBatch(deps: RunBatchDeps): Promise<void> {
  const {
    channel,
    agent,
    activeRuns,
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
    liveInteractionByScope,
    sideConversationByScope,
    artifactBroker,
    pending,
    scope,
    mode,
    stopGeneration,
    stopGenerationTarget,
  } = deps;
  if (batch.length === 0) return;
  const firstMsg = batch[0];
  const lastMsg = batch[batch.length - 1];
  if (!firstMsg || !lastMsg) return;

  // A priority `/btw` batch can be flushed while the main live run remains
  // active. Do not consume ordinary messages that happened to be queued
  // behind it; put them back and let the main run release the scope normally.
  const firstInputMode = liveInputModeForMessage(firstMsg);
  const isSideBatch = firstInputMode === 'side' || firstInputMode === 'side-exit';
  const stopRequested = (stage: string): boolean => {
    if (activeRuns.isStopGenerationCurrent(scope, stopGeneration, stopGenerationTarget)) return false;
    // A queued /btw that was stopped before it spawned must not leave an
    // `opening` marker that reroutes the next ordinary message into side.
    if (firstInputMode === 'side') clearSideConversationState(sideConversationByScope, scope);
    log.info('flush', 'cancelled-before-spawn', { scope, stage, stopGeneration });
    return true;
  };
  if (stopRequested('batch-start')) return;
  if (!isSideBatch && activeRuns.hasAny(scope)) {
    if (firstInputMode === 'control' && agent.structuredControl) {
      // An observer may have registered since this control entered the FIFO.
      // Reuse it instead of stranding the approval behind that same run.
      const sendOpts = { replyTo: firstMsg.messageId, ...(firstMsg.threadId ? { replyInThread: true } : {}) };
      try {
        for (const event of await agent.structuredControl(scope, firstMsg.content)) {
          if (event.type === 'text') await channel.send(firstMsg.chatId, { markdown: event.delta }, sendOpts);
          if (event.type === 'interactive' && event.interaction) await sendStructuredCard(channel, firstMsg.chatId, event.interaction,
            callbackAuth ? input => callbackAuth.sign({ runId: event.interaction!.id, scope, chatId: firstMsg.chatId,
              operatorOpenId: firstMsg.senderId, action: `live_input:${input}`, policyFingerprint: 'structured', ttlMs: 30 * 60 * 1000 }) : undefined, sendOpts);
        }
      } catch (error) { await channel.send(firstMsg.chatId, { markdown: `⚠️ ${error instanceof Error ? error.message : String(error)}` }, sendOpts); }
      return;
    }
    for (const message of batch) pending.push(scope, message);
    log.info('flush', 'ordinary-batch-deferred-during-side', {
      scope,
      batchSize: batch.length,
    });
    return;
  }

  const chatId = firstMsg.chatId;
  const threadId = firstMsg.threadId;

  const resourceItems = batch.flatMap((m) =>
    m.resources.map((r) => ({ messageId: m.messageId, resource: r })),
  );
  const attachments = await media.resolve(resourceItems, controls.profileConfig.attachments);
  if (stopRequested('media')) return;
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
    if (stopRequested('quote')) return;
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
    if (stopRequested('topic-context')) return;
    if (topicContext.length > 0) {
      log.info('topic', 'context-fetched', {
        scope,
        threadId,
        count: topicContext.length,
      });
    }
  }

  const requestedModel = resolveModelArg(
    controls.profileConfig.agentKind,
    controls.profileConfig.preferences.model,
  );

  const nativeCommand = nativeAgentCommandForBatch(batch);
  const forceLiveSession = batch.some(isForceLiveAgentCommandMessage);
  const useLiveSession = forceLiveSession || getAgentSessionMode(controls.cfg) === 'live';
  const nativeInputMode = nativeCommand
    ? liveInputModeForBatch(batch, nativeCommand)
    : undefined;
  const sideInputMode = nativeInputMode === 'side' || nativeInputMode === 'side-exit';
  const sideStateBeforeRun = sideConversationState(sideConversationByScope, scope);
  const sideConversationConfirmed =
    sideInputMode &&
    Boolean(
      sideStateBeforeRun &&
        (sideStateBeforeRun.phase === 'active' || sideStateBeforeRun.phase === 'closing'),
    );
  if (
    useLiveSession &&
    (nativeInputMode === 'side' || nativeInputMode === 'side-exit') &&
    clearLiveInteractionState(sessions, liveInteractionByScope, scope)
  ) {
    log.info('agent-live', 'picker-dismissed-for-side-conversation', { scope });
  }
  if (useLiveSession && !nativeCommand && clearLiveInteractionState(sessions, liveInteractionByScope, scope)) {
    // A normal user task supersedes an abandoned native picker. The live
    // terminal will press Escape before typing this task; clear the bridge's
    // matching control-plane state so later words are never misrouted as
    // picker keys.
    log.info('agent-live', 'picker-dismissed-for-task', { scope });
  }
  // Normal turns remain user text. Quotes, cards and attachment paths are
  // appended only when present; native slash/control input stays raw because
  // it targets the CLI TUI rather than a conversational prompt.
  const structuredPrompt = buildPrompt(
    batch,
    attachments,
    quotes,
    topicContext,
  );
  const bridgeRoute = useLiveSession
    ? await bridgeAgent.route({
        userInput: nativeCommand ?? structuredPrompt,
        ...(nativeCommand && nativeInputMode ? { inputMode: nativeInputMode } : {}),
      })
    : undefined;
  if (stopRequested('route')) return;
  const liveInputMode = bridgeRoute?.inputMode;
  const prompt = bridgeRoute?.stdin ?? structuredPrompt;
  log.info('prompt', 'built', {
    promptChars: prompt.length,
    nativeCommand: bridgeRoute?.kind === 'native-command',
    sessionMode: useLiveSession ? 'live' : 'turn',
    quotes: quotes.length,
    topicContext: topicContext.length,
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
  // Allocate a token before spawning so it can be injected into the agent
  // process. It is activated with the verified workspace root immediately
  // after run-policy resolution succeeds.
  const artifactGrant = artifactBroker.issue({
    scope,
    chatId,
    replyTo: lastMsg.messageId,
    ...(mode === 'topic' && threadId ? { replyInThread: true } : {}),
    allowedRoots: [],
    maxFileBytes: controls.profileConfig.attachments.maxFileBytes,
    persistent: useLiveSession,
  });
  const flow = await startRunFlow({
    scopeId: scope,
    stopGeneration,
    scope: scopeContext,
    prompt,
    sessionMode: useLiveSession ? 'live' : 'turn',
    stopGenerationTarget,
    liveInputMode,
    ...(sideInputMode && sideConversationConfirmed ? { sideConversationConfirmed: true } : {}),
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
    artifactDelivery: artifactGrant,
    observability: {
      profile: controls.profile,
      agent: capability.agentId,
      source: 'im',
      stage: 'submit',
    },
  });
  if (!flow.ok) {
    if (flow.rejectReason.code === 'stop-requested' || stopRequested('flow-rejected')) {
      if (firstInputMode === 'side') clearSideConversationState(sideConversationByScope, scope);
      artifactBroker.revoke(artifactGrant.token);
      return;
    }
    if (sideInputMode) {
      clearSideConversationState(sideConversationByScope, scope);
    }
    if (!useLiveSession) artifactBroker.revoke(artifactGrant.token);
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
  artifactBroker.activate(artifactGrant.token, [cwd]);
  const nativeStatusTmux =
    useLiveSession && nativeCommand?.trim().toLowerCase() === '/status'
      ? await agent.tmux?.status(scope, cwd).catch((err) => {
          log.warn('agent-live', 'status-tmux-fallback-failed', { scope, err: String(err) });
          return undefined;
        })
      : undefined;
  const nativeStatusFallback = nativeStatusTmux
    ? buildNativeStatusTmuxFallback(cwd, nativeStatusTmux)
    : undefined;
  // Presentation is scope policy, not a property of this execution. Read it
  // again at every delivery boundary so `/output off` can mute an already
  // running task without cancelling the agent, and a later `/output final`
  // can still recover its terminal answer.
  const outputModeAtStart = sessions.getOutputMode(scope);
  const currentOutputMode = (): OutputMode => sessions.getOutputMode(scope);
  log.info('delivery', 'run-policy', { scope, mode: outputModeAtStart });
  const previousActivePolicyFingerprint = activePolicyFingerprints.get(scope);
  activePolicyFingerprints.set(scope, flow.policy.policyFingerprint);
  const handle = execution.handle;
  const eventStream = execution.subscribe();
  let sideRunFailed = false;
  let sideEntryConfirmed: boolean | undefined;
  let sideExitConfirmed: boolean | undefined;
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
    if (evt.type === 'system' && evt.sideConversation === 'entered') {
      sideEntryConfirmed = true;
    }
    if (evt.type === 'system' && evt.sideConversation === 'exited') {
      sideExitConfirmed = true;
    }
  };
  const sentInteractionSignatures = new Set<string>();
  const pendingInteractionSignatures = new Set<string>();
  const interactionSends: Promise<void>[] = [];
  let observedNativeModelSelection: NativeCodexModelSelection | undefined;
  let interactionTextBuffer = '';
  let startupInteractionDeferred = false;
  let pickerObservedAfterInput = false;
  let controlFooterOnly = false;
  const previousControlInteractionSignature =
    useLiveSession && nativeCommand && !nativeCommand.trimStart().startsWith('/')
      ? liveInteractionState(sessions, liveInteractionByScope, scope)?.signature
      : undefined;
  if (useLiveSession && nativeCommand && !nativeCommand.trimStart().startsWith('/')) {
    const existing = liveInteractionState(sessions, liveInteractionByScope, scope);
    if (existing) {
      saveLiveInteractionState(sessions, liveInteractionByScope, scope, {
        ...existing,
        generation: execution.runId,
        updatedAt: Date.now(),
      });
    }
  }
  if (useLiveSession && nativeCommand && opensLivePicker(nativeCommand)) {
    const wasActive = Boolean(liveInteractionState(sessions, liveInteractionByScope, scope));
    saveLiveInteractionState(sessions, liveInteractionByScope, scope, {
      picker: true,
      updatedAt: Date.now(),
      generation: execution.runId,
    });
    if (!wasActive) log.info('agent-live', 'picker-enter', { scope, input: nativeCommand });
  }
  // A control turn starts from the picker that produced its card. The first
  // terminal redraw after a key often contains that same frame with only the
  // cursor moved; treat it as already delivered so the click does not create a
  // duplicate card before a genuinely new picker/result appears.
  if (useLiveSession && nativeCommand && !nativeCommand.trimStart().startsWith('/')) {
    if (previousControlInteractionSignature) {
      sentInteractionSignatures.add(previousControlInteractionSignature);
    }
  }
  const observeLiveEvent = (evt: AgentEvent, opts: { sendInteractionCard?: boolean } = {}): void => {
    if (agent.structuredControl) {
      if (evt.type === 'error' && sideInputMode) sideRunFailed = true;
      if (evt.type === 'interactive' && evt.interaction) {
        pickerObservedAfterInput = true;
        const interaction = evt.interaction;
        if (!sentInteractionSignatures.has(interaction.id)) {
          sentInteractionSignatures.add(interaction.id);
          interactionSends.push(sendStructuredCard(channel, chatId, interaction, callbackAuth ? input => callbackAuth.sign({
            runId: interaction.id, scope, chatId, operatorOpenId: firstMsg.senderId,
            action: `live_input:${input}`, policyFingerprint: flow.policy.policyFingerprint, ttlMs: 30 * 60 * 1000,
          }) : undefined, sendOpts));
        }
      }
      return;
    }
    // `recordSession` is intentionally limited to system events. Side
    // lifecycle evidence arrives as text/error events, so capture it here
    // before the interaction-only observer returns early.
    if (sideInputMode && evt.type === 'error') sideRunFailed = true;
    if (nativeInputMode === 'side-exit' && evt.type === 'text') {
      if (evt.delta.includes('已退出 Codex btw side conversation')) sideExitConfirmed = true;
      if (evt.delta.includes('未确认处于 Codex btw side conversation')) sideExitConfirmed = false;
    }
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
      if (selection) observedNativeModelSelection = selection;
    }
    // Keep enough terminal history to reconstruct the current native menu.
    // The structured surface is derived from the latest actionable terminal
    // snapshot, not from a fixed command/menu depth, so selecting "More
    // options" can publish an arbitrary next-level picker.
    // Keep enough bounded history to reconcile a model-picker redraw whose
    // first row scrolled out of the latest viewport. The detector applies its
    // own line bound and rejects conflicting source/diff rows.
    interactionTextBuffer = `${interactionTextBuffer}\n${delta}`.slice(-64_000);
    const interaction = detectLiveInteraction(interactionTextBuffer);
    const pickerLike = isStartupInteraction || Boolean(interaction);
    if (!isStartupInteraction && (interaction || pickerLike)) {
      pickerObservedAfterInput = true;
    }
    if (
      liveInputMode === 'control' &&
      previousControlInteractionSignature &&
      !isControlFooterOnly(delta) &&
      (!interaction || interaction.signature !== previousControlInteractionSignature)
    ) {
      // The first redraw after a click can be the old picker footer. Suppress
      // only that frame; once the terminal shows any real progress/result,
      // allow an identical menu to be published again (a repeated command can
      // legitimately ask the same approval question twice).
      sentInteractionSignatures.delete(previousControlInteractionSignature);
    }
    if (useLiveSession && (interaction || pickerLike)) {
      const currentState = liveInteractionState(sessions, liveInteractionByScope, scope);
      // A control turn is intentionally a follow-up to the run that created
      // the picker. It may start before that run's final frame is persisted,
      // so its generation can legitimately differ; rejecting it here drops
      // the nested picker card under rapid `/codex 1` input. Ordinary/side
      // turns retain the guard so stale observers cannot overwrite a newer
      // control surface.
      if (
        currentState?.generation &&
        currentState.generation !== execution.runId &&
        liveInputMode !== 'control'
      ) return;
      const wasActive = Boolean(currentState);
      const previous = currentState;
      const nextSignature = interaction?.signature ?? previous?.signature;
      saveLiveInteractionState(sessions, liveInteractionByScope, scope, {
        picker: true,
        updatedAt: Date.now(),
        generation: execution.runId,
        ...(nextSignature ? { signature: nextSignature } : {}),
      });
      if (!wasActive) log.info('agent-live', 'picker-enter', { scope });
    }
    // Native pickers are control-plane state, not normal agent narration:
    // users must still be able to drive `/model`, `/resume`, etc. while their
    // ordinary output policy is muted.
    if (
      opts.sendInteractionCard === false ||
      (currentOutputMode() === 'off' && bridgeRoute?.kind !== 'native-command')
    ) return;
    if (isStartupInteraction && liveInputMode === 'control') return;
    // A model picker is rendered row-by-row by the native TUI. Publishing as
    // soon as two rows arrive can expose a truncated card (for example 2..5
    // before row 1 and the confirmation footer are drawn). Keep lifecycle
    // state active immediately, but wait for the explicit footer before
    // sending a standalone card. The final reply path still publishes the
    // accumulated picker if the terminal finishes without a footer.
    if (!interaction || !cardRenderOptions.signCallback || !isReadyToPublishLiveInteraction(interaction.prompt)) {
      return;
    }
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

  // Heartbeat cadence for the streaming run card. 0 / undefined = disabled.
  // When enabled, the bridge re-renders the card every `progressHeartbeatMs`
  // while a tool is in flight so the user sees the elapsed-time suffix tick
  // — without this, multi-minute Bash/test/train runs look frozen.
  const progressHeartbeatMs = getProgressHeartbeatMs(controls.cfg);
  if (progressHeartbeatMs > 0) {
    log.info('flush', 'progress-heartbeat', { progressHeartbeatMs });
  }

  const configuredReplyMode = getMessageReplyMode(controls.cfg);
  const structuredWorkControl = Boolean(agent.structuredControl) && (
    liveInputMode === 'control' || liveInputMode === 'side' ||
    /^\/goal\s+(?!pause\b|clear\b|edit\b|status\b)/.test(nativeCommand ?? '')
  );
  const replyMode = outputModeAtStart === 'final'
    ? 'text'
    : useLiveSession && bridgeRoute?.presentation === 'card' && !structuredWorkControl
      ? 'card'
      : configuredReplyMode;
  log.info('flush', 'reply-mode', {
    mode: replyMode,
    ...(replyMode !== configuredReplyMode ? { configuredMode: configuredReplyMode } : {}),
  });
  const cotMessages = getCotMessages(controls.cfg);
  const cotEnabled = outputModeAtStart === 'live' && cotMessages !== 'off';

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
      state.terminal !== 'done'
    ) {
      return state;
    }
    const observed = interactionTextBuffer.trim();
    const observedSurface = observed ? liveInteractionSurface(observed) : undefined;
    const currentText = renderText(state, { activityMode: 'none' });
    if (
      nativeStatusFallback &&
      (!currentText.trim() || currentText.includes('命令已发送到'))
    ) {
      return {
        ...state,
        blocks: [{ kind: 'text', content: `${nativeStatusFallback}\n`, streaming: false }],
      };
    }
    const shouldUseObservedPicker =
      Boolean(observedSurface) &&
      (!currentText.trim() ||
        looksLikeAgentPicker(currentText));
    if (shouldUseObservedPicker && observedSurface) {
      log.info('agent-live', 'picker-final-fallback', {
        scope,
        chars: observed.length,
      });
      return {
        ...state,
        blocks: [
          {
            kind: 'text',
            content: `${observedSurface}\n`,
            streaming: false,
          },
        ],
      };
    }
    if (opensLivePicker(nativeCommand ?? '') && !currentText.trim() && !observedSurface) {
      log.info('agent-live', 'picker-empty-final-suppressed', { scope, input: nativeCommand });
      return { ...state, blocks: [] };
    }
    // Native commands can return a real acknowledgement or result (for
    // example `/btw out` confirms that the main thread resumed). Preserve it;
    // the generic acknowledgement is only for a command that produced no
    // usable terminal text at all.
    if (currentText.trim()) return state;
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
        structuredOnly: Boolean(agent.structuredControl),
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
  const promptBridge = outputModeAtStart !== 'off' && callbackAuth && !agent.structuredControl
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
    outputModeAtStart !== 'live' || cotEnabled || replyMode === 'card'
      ? undefined
      : addWorkingReaction(channel, lastMsg.messageId);

  try {
    // Native slash commands and pickers form the control plane. They remain
    // observable even under `/output off`, otherwise a user could not select
    // a model or resume a session while ordinary task narration is muted.
    if (useLiveSession && nativeCommand && !structuredWorkControl) {
      const finalState = await processAgentStream(
        handle,
        eventStream,
        scope,
        idleTimeoutMs,
        progressHeartbeatMs,
        recordSession,
        async () => {},
        observeLiveEvent,
      );
      if (handle.detached) return;
      if (agent.structuredControl && !completeReplyText(finalState).trim()) return;
      // A native control turn can finish after the TUI has only redrawn its
      // confirmation legend. That is an intermediate surface, not a final
      // answer; publishing it as a completed card leaves the user with a
      // stale-looking footer and hides whether the selection was accepted.
      controlFooterOnly =
        liveInputMode === 'control' && isControlFooterOnly(completeReplyText(finalState));
      if (controlFooterOnly) {
        log.info('agent-live', 'control-footer-only-suppressed', { scope, input: nativeCommand });
        return;
      }
      const preparedFinalState = prepareStateForReply(finalState);
      const preparedText = completeReplyText(preparedFinalState).trim();
      if (liveInputMode === 'control' && !preparedText && !interactionTextBuffer.trim()) {
        log.info('agent-live', 'control-empty-final-suppressed', { scope, input: nativeCommand });
        return;
      }
      if (opensLivePicker(nativeCommand) && !preparedText && !interactionTextBuffer.trim()) {
        log.info('agent-live', 'picker-empty-final-suppressed', { scope, input: nativeCommand });
        return;
      }
      await sendFinalReply({
        channel,
        chatId,
        scope,
        state: preparedFinalState,
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
    if (outputModeAtStart === 'off') {
      const finalState = await processAgentStream(
        handle,
        eventStream,
        scope,
        idleTimeoutMs,
        progressHeartbeatMs,
        recordSession,
        async () => {},
        observeLiveEvent,
      );
      // Re-enabling output while a muted task is still running intentionally
      // recovers only its final answer. A stream created after the fact would
      // replay old terminal history and reintroduce duplicate delivery.
      if (!handle.detached && currentOutputMode() !== 'off') {
        await sendFinalReply({
          channel,
          chatId,
          scope,
          state: finalAnswerOnlyState(prepareStateForReply(finalState)),
          replyMode: 'text',
          sendOpts,
          cardRenderOptions,
          skipLiveInteractionSignatures: new Set([
            ...sentInteractionSignatures,
            ...pendingInteractionSignatures,
          ]),
          liveInteractionInputRoute: useLiveSession ? 'live' : 'agent',
        });
      }
      return;
    }
    if (currentOutputMode() === 'off') {
      await processAgentStream(
        handle,
        eventStream,
        scope,
        idleTimeoutMs,
        progressHeartbeatMs,
        recordSession,
        async () => {},
        observeLiveEvent,
      );
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
          progressHeartbeatMs,
          recordSession,
          async () => {},
          observeLiveEvent,
        );
        await cotDone;
        if (handle.detached) return;
        if (cotPublisher.degradedReason) {
          await sendCotDegradedNotice({
            channel,
            chatId,
            scope,
            sendOpts,
            reason: cotPublisher.degradedReason,
          });
        }
        if (currentOutputMode() === 'off') return;
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
      // A rolling Feishu stream is a new message, not a continuation of the
      // prior card's mutable document.  Keep a per-segment output cursor so
      // the new message contains only text produced after that cursor.
      let segmentBaseText = '';
      // A continuation card is useful only after the previous segment has
      // produced new text.  Starting one on the eight-minute timer alone
      // creates a stream of cards containing only the running footer while a
      // long tool call is still quiet.
      let resolveSegmentText: (() => void) | undefined;
      let segmentTextReady: Promise<void> = Promise.resolve();
      let segmentTextReadyFlag = true;
      const armSegmentTextWait = (): void => {
        segmentTextReadyFlag = false;
        segmentTextReady = new Promise<void>((resolve) => {
          resolveSegmentText = resolve;
        });
      };
      const signalSegmentText = (state: RunState): void => {
        if (
          resolveSegmentText &&
          runStateTextCursor(prepareStateForReply(state)) !== segmentBaseText
        ) {
          const resolve = resolveSegmentText;
          resolveSegmentText = undefined;
          segmentTextReadyFlag = true;
          resolve();
        }
      };
      const stateForSegment = (state: RunState): RunState =>
        projectRunStateFromCursor(prepareStateForReply(state), segmentBaseText);
      const stateForDelivery = (state: RunState): RunState =>
        currentOutputMode() === 'final'
          ? finalAnswerOnlyState(prepareStateForReply(state))
          : stateForSegment(state);
      // The streamed message can die mid-run (Feishu 230011 "message withdrawn",
      // content-length limits, or the platform's automatic 10-minute stream
      // close). Keep draining events, roll over before the platform deadline,
      // and post the final answer as a fresh message if the last patch failed.
      let streamDegraded = false;
      let freshFinalPosted = false;
      let longReplyText: string | undefined;
      let longReplyDelivered = false;
      let cardCtrl:
        | { update(next: object | ((current: object) => object)): Promise<void> }
        | undefined;
      const deliverLongReply = async (): Promise<void> => {
        if (!longReplyText || longReplyDelivered || handle.detached) return;
        if (currentOutputMode() === 'off') return;
        longReplyDelivered = true;
        freshFinalPosted = true;
        await sendCompleteReplyChunks({
          channel,
          chatId,
          sendOpts,
          text: longReplyText,
          scope,
          replyMode: 'card',
        });
      };
      const postFreshFinal = async (state: RunState): Promise<void> => {
        if (handle.detached) return;
        if (freshFinalPosted) return;
        if (currentOutputMode() === 'off') return;
        freshFinalPosted = true;
        const replyState =
          currentOutputMode() === 'final'
            ? finalAnswerOnlyState(prepareStateForReply(state))
            : prepareStateForReply(state);
        const complete = completeReplyText(replyState);
        if (
          isLongReplyText(complete) &&
          !looksLikeAgentPicker(complete, useLiveSession ? false : true)
        ) {
          longReplyText = complete;
          // The rolling stream already communicates that this answer is being
          // split. Sending a second standalone notice card here only leaves a
          // redundant "正文较长" message above the complete chunks.
          await deliverLongReply();
          return;
        }
        await sendWithRetry(
          () => channel.send(
            chatId,
            {
              card: renderLiveAwareReplyCard(replyState, cardRenderOptions, useLiveSession ? 'live' : 'agent'),
            },
            sendOpts,
          ),
          { scope, chunk: 0, total: 0, warning: true },
        );
      };
      let lastSentCardSerialized: string | undefined;
      const renderDone = processAgentStream(
        handle,
        eventStream,
        scope,
        idleTimeoutMs,
        progressHeartbeatMs,
        recordSession,
        async (state) => {
          latestState = state;
          signalSegmentText(state);
          const deliveryMode = currentOutputMode();
          if (deliveryMode === 'off' || (deliveryMode === 'final' && state.terminal === 'running')) {
            return;
          }
          if (cardCtrl) {
            const replyState = stateForDelivery(state);
            if (state.terminal !== 'running') {
              const complete = completeReplyText(
                currentOutputMode() === 'final'
                  ? finalAnswerOnlyState(prepareStateForReply(state))
                  : prepareStateForReply(state),
              );
              if (
                isLongReplyText(complete) &&
                !looksLikeAgentPicker(complete, useLiveSession ? false : true)
              ) {
                longReplyText = complete;
                const notice = longReplyNoticeCard(complete);
                const noticeSerialized = JSON.stringify(notice);
                if (noticeSerialized === lastSentCardSerialized) return;
                lastSentCardSerialized = noticeSerialized;
                try {
                  await cardCtrl.update(notice);
                } catch (err) {
                  streamDegraded = true;
                  cardCtrl = undefined;
                  log.warn('stream', 'long-reply-notice-failed', {
                    scope,
                    err: err instanceof Error ? err.message : String(err),
                  });
                }
                return;
              }
            }
            // Dedup: skip PATCH if the rendered card is byte-identical to the
            // last one we sent. SDK throttle absorbs most redundant updates,
            // but during long runs with no state change the reducer still
            // emits `done` / `usage` events that re-render → identical card.
            // Without this guard we PATCH the same JSON many times in a row.
            const nextCard = renderLiveAwareReplyCard(
              replyState,
              cardRenderOptions,
              useLiveSession ? 'live' : 'agent',
            );
            const nextSerialized = JSON.stringify(nextCard);
            if (nextSerialized === lastSentCardSerialized) {
              return;
            }
            lastSentCardSerialized = nextSerialized;
            try {
              await cardCtrl.update(nextCard);
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
        startSegment: (segmentDone, markProducerStarted, segment) => {
          segmentBaseText = segment === 1 ? '' : runStateTextCursor(prepareStateForReply(latestState));
          if (segment > 1) {
            armSegmentTextWait();
          }
          lastSentCardSerialized = undefined;
          const waitForNewText = segment > 1
            ? Promise.race([
                segmentTextReady.then(() => true),
                renderDone.then(() => false),
              ])
            : Promise.resolve(true);
          return (
          waitForNewText.then((hasNewText) => {
            if (segment > 1 && !hasNewText) return;
            if (segment > 1 && !segmentTextReadyFlag) return;
            const currentSegmentState = stateForDelivery(latestState);
            return channel.stream(
            chatId,
            {
              card: {
                initial: renderLiveAwareReplyCard(
                  currentSegmentState,
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
                        stateForDelivery(latestState),
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
            );
          })
          );
        },
        fallback: postFreshFinal,
      });
      await deliverLongReply();
      if (!handle.detached && streamDegraded && currentOutputMode() !== 'off') {
        await postFreshFinal(prepareStateForReply(latestState));
      }
    } else if (replyMode === 'markdown') {
      let latestState: RunState = initialState;
      let segmentBaseText = '';
      // Do not create a continuation message merely because the platform's
      // stream lifetime expired.  Wait for a genuinely new text delta; this
      // keeps long quiet tasks from emitting footer-only messages forever.
      let resolveSegmentText: (() => void) | undefined;
      let segmentTextReady: Promise<void> = Promise.resolve();
      let segmentTextReadyFlag = true;
      const armSegmentTextWait = (): void => {
        segmentTextReadyFlag = false;
        segmentTextReady = new Promise<void>((resolve) => {
          resolveSegmentText = resolve;
        });
      };
      const signalSegmentText = (state: RunState): void => {
        if (
          resolveSegmentText &&
          runStateTextCursor(prepareStateForReply(state)) !== segmentBaseText
        ) {
          const resolve = resolveSegmentText;
          resolveSegmentText = undefined;
          segmentTextReadyFlag = true;
          resolve();
        }
      };
      const stateForSegment = (state: RunState): RunState =>
        projectRunStateFromCursor(prepareStateForReply(state), segmentBaseText);
      const stateForDelivery = (state: RunState): RunState =>
        currentOutputMode() === 'final'
          ? finalAnswerOnlyState(prepareStateForReply(state))
          : stateForSegment(state);
      // See card branch: a withdrawn/failed patch must degrade to a fresh final
      // message instead of aborting the run and losing the answer.
      let streamDegraded = false;
      let freshFinalPosted = false;
      let longReplyText: string | undefined;
      let longReplyDelivered = false;
      let markdownCtrl: { setContent(markdown: string): Promise<void> } | undefined;
      const deliverLongReply = async (): Promise<void> => {
        if (!longReplyText || longReplyDelivered || handle.detached) return;
        if (currentOutputMode() === 'off') return;
        longReplyDelivered = true;
        freshFinalPosted = true;
        await sendCompleteReplyChunks({
          channel,
          chatId,
          sendOpts,
          text: longReplyText,
          scope,
          replyMode: 'markdown',
        });
      };
      const postFreshFinal = async (state: RunState): Promise<void> => {
        if (handle.detached) return;
        if (freshFinalPosted) return;
        if (currentOutputMode() === 'off') return;
        freshFinalPosted = true;
        const replyState =
          currentOutputMode() === 'final'
            ? finalAnswerOnlyState(prepareStateForReply(state))
            : prepareStateForReply(state);
        const complete = completeReplyText(replyState);
        if (
          isLongReplyText(complete) &&
          !looksLikeAgentPicker(complete, useLiveSession ? false : true)
        ) {
          longReplyText = complete;
          await deliverLongReply();
          return;
        }
        const body = renderText(replyState, { activityMode: 'summary' });
        if (body.trim()) {
          await sendWithRetry(
            () => channel.send(chatId, { markdown: body }, sendOpts),
            { scope, chunk: 0, total: 0, warning: true },
          );
        }
      };
      let lastSentMarkdownText: string | undefined;
      const renderDone = processAgentStream(
        handle,
        eventStream,
        scope,
        idleTimeoutMs,
        progressHeartbeatMs,
        recordSession,
        async (state) => {
          latestState = state;
          signalSegmentText(state);
          const deliveryMode = currentOutputMode();
          if (deliveryMode === 'off' || (deliveryMode === 'final' && state.terminal === 'running')) {
            return;
          }
          if (markdownCtrl) {
            const replyState = stateForDelivery(state);
            if (state.terminal !== 'running') {
              const complete = completeReplyText(
                currentOutputMode() === 'final'
                  ? finalAnswerOnlyState(prepareStateForReply(state))
                  : prepareStateForReply(state),
              );
              if (
                isLongReplyText(complete) &&
                !looksLikeAgentPicker(complete, useLiveSession ? false : true)
              ) {
                longReplyText = complete;
                const notice = '正文较长，已分段发送。';
                if (notice === lastSentMarkdownText) return;
                lastSentMarkdownText = notice;
                try {
                  await markdownCtrl.setContent(notice);
                } catch (err) {
                  streamDegraded = true;
                  markdownCtrl = undefined;
                  log.warn('stream', 'long-reply-notice-failed', {
                    scope,
                    err: err instanceof Error ? err.message : String(err),
                  });
                }
                return;
              }
            }
            // Dedup: skip PATCH if rendered markdown is identical to the
            // last one we sent. SDK throttle absorbs most redundant updates,
            // but on text-heavy streams (v0.6.32 motivation: bridge echoed
            // a 6KB+ reply 30+ times), this kills the perceived "duplicate"
            // symptom in Feishu.
            const nextText = renderText(replyState, { activityMode: 'summary' });
            if (nextText === lastSentMarkdownText) return;
            lastSentMarkdownText = nextText;
            try {
              await markdownCtrl.setContent(nextText);
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
        startSegment: (segmentDone, markProducerStarted, segment) => {
          segmentBaseText = segment === 1 ? '' : runStateTextCursor(prepareStateForReply(latestState));
          if (segment > 1) {
            armSegmentTextWait();
          }
          lastSentMarkdownText = undefined;
          const waitForNewText = segment > 1
            ? Promise.race([
                segmentTextReady.then(() => true),
                renderDone.then(() => false),
              ])
            : Promise.resolve(true);
          return (
          waitForNewText.then((hasNewText) => {
            if (segment > 1 && !hasNewText) return;
            if (segment > 1 && !segmentTextReadyFlag) return;
            const currentSegmentState = stateForDelivery(latestState);
            return channel.stream(
            chatId,
            {
              markdown: async (ctrl) => {
                markProducerStarted();
                streamDegraded = false;
                markdownCtrl = ctrl;
                try {
                  await ctrl.setContent(renderText(currentSegmentState, { activityMode: 'summary' }));
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
            );
          })
          );
        },
        fallback: postFreshFinal,
      });
      await deliverLongReply();
      if (!handle.detached && streamDegraded && currentOutputMode() !== 'off') {
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
        progressHeartbeatMs,
        recordSession,
        async () => {},
        observeLiveEvent,
      );
      if (handle.detached || currentOutputMode() === 'off') return;
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
    }
  } catch (err) {
    log.fail('stream', err);
  } finally {
    if (!useLiveSession) artifactBroker.revoke(artifactGrant.token);
    // Let the interactive-prompt subscriber drain (it resolves when the event
    // stream ends); it never rejects, so this can't mask a run error.
    await promptBridge;
    await Promise.allSettled(interactionSends);
    if (
      useLiveSession &&
      nativeCommand &&
      controls.profileConfig.agentKind === 'codex' &&
      observedNativeModelSelection &&
      !pickerObservedAfterInput
    ) {
      const selection = observedNativeModelSelection;
      await saveProfileModelPreferences(controls, {
        model: selection.model,
        reasoningEffort:
          selection.reasoningEffort ?? controls.profileConfig.preferences.reasoningEffort,
      })
        .then(() => {
          log.info('agent-live', 'model-preference-synced', {
            scope,
            model: selection.model,
            ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
          });
        })
        .catch((err) => {
          log.warn('agent-live', 'model-preference-sync-failed', {
            scope,
            err: err instanceof Error ? err.message : String(err),
          });
        });
    }
    if (useLiveSession && nativeCommand) {
      const opensPicker = opensLivePicker(nativeCommand);
      const closesPicker = closesLivePicker(nativeCommand);
      if ((opensPicker || closesPicker) && !pickerObservedAfterInput) {
        if (!controlFooterOnly && clearLiveInteractionState(sessions, liveInteractionByScope, scope, execution.runId)) {
          log.info('agent-live', 'picker-exit', { scope, input: nativeCommand });
        }
      } else if (closesPicker && pickerObservedAfterInput) {
        log.info('agent-live', 'picker-advance', { scope, input: nativeCommand });
      }
    }
    if (sideInputMode) {
      await reconcileSideConversationState({
        map: sideConversationByScope,
        scope,
        agent,
        inputMode: nativeInputMode!,
        failed: sideRunFailed,
        entryConfirmed: sideEntryConfirmed,
        exitConfirmed: sideExitConfirmed,
        cwd,
      });
    }
    if (previousActivePolicyFingerprint) {
      activePolicyFingerprints.set(scope, previousActivePolicyFingerprint);
    } else {
      activePolicyFingerprints.delete(scope);
    }
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
  // Terminal activity is useful while a run is live, but it is not part of
  // the final answer. Keep only a one-line count for the short fallback and
  // remove it entirely from complete long-reply chunks below.
  const body = renderText(input.state, { activityMode: 'summary' });
  const completeBody = completeReplyText(input.state);
  if (
    isLongReplyText(completeBody) &&
    !looksLikeAgentPicker(completeBody, input.liveInteractionInputRoute === 'agent')
  ) {
    await sendCompleteReplyChunks({
      channel: input.channel,
      chatId: input.chatId,
      sendOpts: input.sendOpts,
      text: completeBody,
      scope: input.scope,
      replyMode: input.replyMode,
    });
    return;
  }

  if (input.replyMode === 'card') {
    if (
      isSkippedLiveInteractionForText(
        body,
        input.skipLiveInteractionSignatures,
        input.liveInteractionInputRoute ?? 'live',
      )
    ) {
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
        isLiveInteractionCardForText(
          body,
          input.liveInteractionInputRoute ?? 'live',
          input.skipLiveInteractionSignatures,
        )
          ? 'live-interaction-card'
          : 'card',
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
  progressHeartbeatMs: number | undefined,
  recordSession: (event: AgentEvent) => void,
  flush: (state: RunState) => Promise<void>,
  observeEvent: (event: AgentEvent) => void = () => {},
): Promise<RunState> {
  const runStart = Date.now();
  let state: RunState = initialState;
  const eventGate = new RunEventGate();
  const delivery = new SerializedDelivery();
  const queueFlush = (snapshot: RunState): Promise<void> => {
    if (handle.detached) return Promise.resolve();
    return delivery.enqueue(async () => {
      // A disconnect can happen while an earlier update is waiting in the
      // serialized delivery queue. Do not let a stale bridge process update a
      // card after its replacement has attached to this conversation.
      if (!handle.detached) await flush(snapshot);
    }).catch((err) => {
      // A transient Feishu patch failure must not abort state reduction. The
      // terminal state is still rendered by the final fallback path.
      log.warn('stream', 'flush-rejected', {
        scope,
        err: err instanceof Error ? err.message : String(err),
      });
    });
  };
  let streamFailure: unknown;
  let sawTerminalEvent = false;
  let lastKeyframeFingerprint = '';

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
      void requestRunStop(handle).catch(() => {
        /* stop errors are non-fatal */
      });
    }, idleTimeoutMs);
  };
  armOrPauseIdle();

  // Progress heartbeat: while a tool is in flight, re-render the card every
  // `progressHeartbeatMs` so the user sees the running tool's elapsed-time
  // suffix tick. Without this, multi-minute tool calls (npm install, train
  // runs, big Bash scripts) leave the card visually frozen between
  // tool_use and tool_result — the SDK Throttle at 400ms absorbs the
  // redundant PATCH calls. The heartbeat's flush() produces a byte-different
  // render (elapsed seconds changed) so it actually goes through.
  let heartbeatTimer: NodeJS.Timeout | undefined;
  let lastHeartbeatFlushMs = 0;
  const startHeartbeat = (): void => {
    if (!progressHeartbeatMs || progressHeartbeatMs <= 0) return;
    if (heartbeatTimer) return;
    heartbeatTimer = setInterval(() => {
      if (handle.detached) return;
      if (state.terminal !== 'running') return;
      if (state.footer !== 'tool_running') return;
      if (state.lastToolStartedAt === undefined) return;
      const now = Date.now();
      const elapsed = now - state.lastToolStartedAt;
      // Throttle to one flush per tick — even if multiple seconds have
      // passed since lastHeartbeatFlushMs, the renderer's footer text only
      // changes when the elapsed-second value crosses an integer boundary,
      // so flushing every tick is enough.
      if (now - lastHeartbeatFlushMs < progressHeartbeatMs) return;
      lastHeartbeatFlushMs = now;
      state = { ...state, currentToolElapsedMs: elapsed, lastEventAt: now };
      log.info('card', 'heartbeat-flush', { scope, elapsedMs: elapsed });
      void queueFlush(state).catch((err) => log.fail('stream', err, { scope, step: 'heartbeat-flush' }));
    }, progressHeartbeatMs);
  };
  startHeartbeat();

  try {
    for await (const rawEvent of events) {
      if (handle.interrupted) break;
      const evt = eventGate.accept(rawEvent);
      if (!evt) continue;

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
      const keyframe = runStateDeliveryFingerprint(state);
      if (keyframe !== lastKeyframeFingerprint || state.terminal !== 'running') {
        lastKeyframeFingerprint = keyframe;
        await queueFlush(state);
      } else {
        log.info('card', 'keyframe-suppressed', { scope, event: evt.type });
      }
      // Stop iterating as soon as we have a terminal state. Some claude
      // versions don't close stdout immediately after the result event, which
      // would leave the for-await waiting forever otherwise.
      if (state.terminal !== 'running') {
        sawTerminalEvent = true;
        break;
      }
    }
  } catch (err) {
    streamFailure = err;
    log.fail('agent', err, { scope, step: 'event-stream' });
  } finally {
    if (timer) clearTimeout(timer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
  }

  // The process is being replaced, not the agent task. The new bridge will
  // reconnect to the persisted profile/scope tmux session on its next turn;
  // never emit a misleading terminal card or write Ctrl-C while detaching.
  if (handle.detached) {
    log.info('card', 'detached', { scope });
    return state;
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
    } else if (streamFailure) {
      state = markRunFailed(
        state,
        'bridge 接收 agent 事件时中断，未收到任务完成状态。请检查 tmux 或重试。',
      );
    } else if (!sawTerminalEvent) {
      state = markRunFailed(
        state,
        'agent 事件流在未报告完成状态时结束。请检查 tmux 或重试。',
      );
    } else {
      // `sawTerminalEvent` and `state.terminal === 'running'` cannot both
      // occur with the current reducer, but keep an explicit failure instead
      // of ever presenting an unknown terminal state as successful.
      state = markRunFailed(state, 'agent 未提供可识别的完成状态。请检查 tmux 或重试。');
    }
  }
  const finalSourceText = runStateTextCursor(state);
  const finalMarkdown = renderText(state);
  const finalCard = JSON.stringify(renderCard(state));
  log.info('card', 'final', {
    scope,
    terminal: state.terminal,
    interrupted: handle.interrupted,
    sourceChars: finalSourceText.length,
    sourceBytes: Buffer.byteLength(finalSourceText, 'utf8'),
    sourceSha256: createHash('sha256').update(finalSourceText).digest('hex'),
    renderedMarkdownBytes: Buffer.byteLength(finalMarkdown, 'utf8'),
    renderedCardBytes: Buffer.byteLength(finalCard, 'utf8'),
  });
  reportMetric('run_e2e_ms', Date.now() - runStart, { terminal: state.terminal });
  await queueFlush(state);
  await delivery.drain();
  return state;
}

/**
 * Stable, append-oriented text projection used as the outbound stream cursor.
 * `RunState` itself is intentionally rich and mutable (tool status, footer,
 * folded content); it is therefore unsuitable as a Feishu segment identity.
 * Agent text blocks only grow during a run, which gives us a deterministic
 * cursor without treating a terminal redraw as fresh chat output.
 */
function runStateTextCursor(state: RunState): string {
  return state.blocks
    .filter((block): block is Extract<RunState['blocks'][number], { kind: 'text' }> => block.kind === 'text')
    .map((block) => block.content)
    .join('');
}

function runStateDeliveryFingerprint(state: RunState): string {
  return JSON.stringify({
    terminal: state.terminal,
    footer: state.footer,
    text: runStateTextCursor(state),
    reasoning: state.reasoning.content,
    tools: state.blocks
      .filter((block): block is Extract<RunState['blocks'][number], { kind: 'tool' }> => block.kind === 'tool')
      .map((block) => ({ id: block.tool.id, status: block.tool.status, output: block.tool.output })),
    error: state.errorMsg,
    idleTimeoutMinutes: state.idleTimeoutMinutes,
    currentToolElapsedMs: state.currentToolElapsedMs,
  });
}

function projectRunStateFromCursor(state: RunState, deliveredText: string): RunState {
  if (!deliveredText) return state;
  const currentText = runStateTextCursor(state);
  const suffix = appendOnlyTextSuffix(deliveredText, currentText);
  return {
    ...state,
    blocks: suffix
      ? [{ kind: 'text', content: suffix, streaming: state.terminal === 'running' }]
      : [],
    reasoning: { content: '', active: false },
  };
}

function appendOnlyTextSuffix(deliveredText: string, currentText: string): string {
  if (!currentText || currentText === deliveredText) return '';
  if (currentText.startsWith(deliveredText)) return currentText.slice(deliveredText.length);
  // Defensive recovery for a provider that rewrites old blocks.  We retain
  // the maximal overlap only; replaying the whole accumulated state is what
  // produced the duplicate Feishu messages this cursor replaces.
  const max = Math.min(deliveredText.length, currentText.length);
  for (let overlap = max; overlap > 0; overlap -= 1) {
    if (deliveredText.endsWith(currentText.slice(0, overlap))) {
      return currentText.slice(overlap);
    }
  }
  return currentText;
}

export async function runRollingReplyStream(input: {
  mode: 'card' | 'markdown';
  renderDone: Promise<RunState>;
  startSegment: (
    segmentDone: Promise<void>,
    markProducerStarted: () => void,
    segment: number,
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
      }, segment))
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
        // The stream producer can remain inside a slow CardKit update after
        // the agent state has already reached terminal. Never return empty in
        // that case: publish the fully rendered final state through the
        // ordinary send path so a late/failed patch cannot erase the answer.
        await runFallbackReply(input.mode, first.state, input.fallback);
        return;
      }
      if (!terminal.ok) throw terminal.err;
      return;
    }

    if (renderSettled) {
      const rendered = await renderResult;
      if (!rendered.ok) throw rendered.err;
      // A continuation may have been waiting for its first new text delta
      // when the agent finished.  No producer means no Feishu message was
      // opened for that segment, so use the normal fresh-final fallback to
      // deliver the terminal state instead of silently returning.
      if (!producerStarted) {
        await runFallbackReply(input.mode, rendered.state, input.fallback);
      }
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

  return buildAgentPrompt({
    userInput: userPart,
    ...(topicContext.length > 0 ? { topicContext: topicContext.map(toPromptTopicMessage) } : {}),
    quotedMessages: quotes.map(toPromptQuote),
    interactiveCards: batch.map(toPromptInteractiveCard).filter(isDefined),
    attachments: attachments.map(toPromptAttachment),
  });
}

function nativeAgentCommandForBatch(batch: NormalizedMessage[]): string | undefined {
  if (batch.length !== 1) return undefined;
  const msg = batch[0];
  if (!msg || !isNativeAgentCommandMessage(msg)) return undefined;
  const text = msg.content.trimStart();
  if (isForceLiveAgentCommandMessage(msg)) return text;
  return isSlashCommandText(text) || isLivePickerInput(text) || isLiveControlInput(text)
    ? text
    : undefined;
}

function liveInputModeForBatch(
  batch: NormalizedMessage[],
  nativeCommand: string,
): LiveInputMode | undefined {
  const mode = batch.map(liveInputModeForMessage).find((item): item is LiveInputMode => Boolean(item));
  if (mode) return mode;
  return nativeCommand.trimStart().startsWith('/') ? 'command' : 'control';
}

function looksLikeAgentPicker(text: string, allowBareConfirmation = false): boolean {
  return (
    isStructuredLiveInteraction(text) ||
    (allowBareConfirmation && isBareAgentConfirmation(text))
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

interface InteractionChoice extends LiveInteractionOption {
  input: string;
  body: string;
  model?: string;
  state?: string;
}

function detectLiveInteraction(
  text: string,
  allowBareConfirmation = false,
  autoConfirmApproval = true,
): LiveInteractionPrompt | undefined {
  const surface = liveInteractionSurface(text);
  if (!surface && !(allowBareConfirmation && isBareAgentConfirmation(text))) return undefined;
  const prompt = surface ?? recentLiveInteractionPrompt(text);
  const choices = extractInteractionChoices(prompt);
  const displayPrompt = formatLiveInteractionPrompt(prompt, choices);
  const buttons: LiveInteractionButton[] = [];
  const seenInputs = new Set<string>();
  const permissionApproval = autoConfirmApproval && isPermissionApprovalPrompt(prompt);
  const add = (label: string, input: string): void => {
    const effectiveInput =
      permissionApproval && /^(?:\d{1,2}|[a-z]|yes|no)$/iu.test(input)
        ? `${input} enter`
        : input;
    if (seenInputs.has(effectiveInput)) return;
    seenInputs.add(effectiveInput);
    buttons.push({ label, input: effectiveInput });
  };

  const arrowNumberedPrompt =
    isClaudeBypassPermissionsPrompt(prompt) ||
    isClaudeModelPicker(prompt) ||
    isCodexUpdatePrompt(prompt);
  const arrowNavigationPrompt =
    /(?:arrow keys?|use\s+(?:the\s+)?(?:up|down|left|right)\s+keys?|↑\s*\/\s*↓|up\s*\/\s*down|navigate\s+with)/iu.test(
      prompt,
    );
  const nativeModelNavigationPrompt =
    arrowNavigationPrompt &&
    (isClaudeModelPicker(prompt) ||
      isCodexModelPickerPrompt(prompt) ||
      isCodexReasoningPickerPrompt(prompt));
  const selectedChoice = choices.findIndex((choice) => choice.selected);
  // Explicit keys (numbers/letters) can be typed directly. Rows represented
  // only by bullets, radios, or checkboxes are reached through the same
  // arrow-key semantics as a native TUI. No model/vendor-specific option
  // count is imposed here; the complete detected surface is retained.
  for (const [index, choice] of choices.entries()) {
    const needsNavigation = arrowNumberedPrompt || arrowNavigationPrompt || choice.navigationOnly;
    const distance = index - (selectedChoice >= 0 ? selectedChoice : 0);
    const navigation = distance < 0 ? 'up '.repeat(-distance) : 'down '.repeat(distance);
    // Native model/reasoning menus are multi-level: selecting a row can open a
    // nested effort picker (for example "More reasoning…"). Send only the
    // cursor movement for non-current rows and leave confirmation to the
    // dedicated Enter button. Appending Enter here skips that intermediate
    // screen and can silently land on its default/max option.
    const input = needsNavigation
      ? nativeModelNavigationPrompt
        ? (navigation.trim() || 'enter')
        : `${navigation}enter`.trim()
      : choice.input;
    const label = choice.key ?? truncateInteractionButtonLabel(choice.label);
    add(label, input);
  }
  const hasChoices = buttons.length > 0;
  const isBinaryConfirmation =
    /\b(?:y\/n|yes\/no|no\/yes)\b|(?:\[y\/n\]|\(y\/n\))/i.test(prompt) ||
    isActionableBinaryConfirmation(prompt);

  if (isCodexResumePicker(prompt)) {
    add('enter', 'enter');
    add('esc', 'esc');
    add('ctrl+c', 'ctrl+c');
    add('tab', 'tab');
    add('left', 'left');
    add('right', 'right');
    add('up', 'up');
    add('down', 'down');
  }
  if (!hasChoices && isBinaryConfirmation) {
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
  if (hasChoices && looksLikeAgentPicker(prompt, allowBareConfirmation)) {
    add('enter', 'enter');
    add('esc', 'esc');
  }
  if (buttons.length === 0 && looksLikeAgentPicker(prompt, allowBareConfirmation)) {
    add('up', 'up');
    add('down', 'down');
    add('enter', 'enter');
    add('esc', 'esc');
  }
  if (buttons.length === 0) return undefined;
  return {
    // A prefix signature made two long menus look identical whenever they
    // shared their title and early choices. Hash the complete current surface
    // so repeated redraws dedupe, while every genuinely nested menu is sent.
    signature: createHash('sha256')
      .update(prompt)
      .update('\0')
      .update(buttons.map((button) => button.input).join('|'))
      .digest('hex'),
    prompt: displayPrompt.slice(0, isCodexModelPickerPrompt(prompt) ? 4_000 : 1_200),
    buttons,
  };
}

function isReadyToPublishLiveInteraction(prompt: string): boolean {
  const options = parseLiveInteractionOptions(prompt);
  const modelOptions = options.filter(
    (option) =>
      Boolean(option.key && /^\d+$/u.test(option.key)) &&
      /\b(?:gpt|claude|gemini|llama|deepseek|qwen|o\d)[a-z0-9._-]*/iu.test(option.label),
  );
  if (modelOptions.length < 2) return true;

  // Model/reasoning rows are painted progressively. The footer is the only
  // vendor-neutral indication that the native picker has finished rendering;
  // without it, wait for the final reply path to use the accumulated frame.
  return /(?:press\s+)?enter\s+to\s+(?:confirm|continue).*esc(?:ape)?\s+to\s+(?:go\s+back|cancel)/iu.test(
    prompt,
  );
}

function isPermissionApprovalPrompt(text: string): boolean {
  return (
    isActionableBinaryConfirmation(text) ||
    /\b(?:command|action|operation)\s+requires?\s+(?:approval|confirmation)\b/iu.test(text) ||
    /\b(?:would\s+you\s+like|do\s+you\s+want)\s+to\s+(?:run|allow|approve|proceed|continue|make|grant|send|edit|update)\b/iu.test(text)
  );
}

function isControlFooterOnly(text: string): boolean {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return (
    lines.length > 0 &&
    lines.some((line) => isLiveInputPromptLine(line)) &&
    lines.every((line) => isLiveInputPromptLine(line) || /^(?:›|❯|>)?\s*$/u.test(line))
  );
}

function recentLiveInteractionPrompt(text: string): string {
  const surface = liveInteractionSurface(text);
  if (surface) return surface;
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

function isClaudeBypassPermissionsPrompt(text: string): boolean {
  return (
    /claude\s+code\s+running\s+in\s+bypass\s+permissions\s+mode/i.test(text) &&
    /\b(?:no,?\s+exit|yes,?\s+i\s+accept)\b/i.test(text)
  );
}

function isClaudeModelPicker(text: string): boolean {
  return (
    /\bselect\s+(?:a\s+)?model\b/i.test(text) &&
    /(?:^|\n)\s*(?:[›❯>▸*+-]\s*)?\d{1,2}[.)、:\s-]+claude-[a-z0-9]/iu.test(text)
  );
}

function isCodexResumePicker(text: string): boolean {
  return (
    /\benter\s+(?:to\s+)?resume\b/i.test(text) &&
    /\besc\s+(?:to\s+)?exit\b/i.test(text)
  );
}

function isCodexUpdatePrompt(text: string): boolean {
  return (
    /\bupdate\s+available\b/i.test(text) &&
    /\bskip(?:\s+until\s+next\s+version)?\b/i.test(text)
  );
}

function extractInteractionChoices(prompt: string): InteractionChoice[] {
  const options = parseLiveInteractionOptions(prompt, {
    // Ambiguous `•`/`-` rows are accepted only when the surrounding frame has
    // prompt evidence. A pair of contiguous rows is still required by the
    // parser, so a lone assistant bullet such as `• Model changed ...` stays
    // ordinary status text.
    includeAmbiguousBullets:
      /(?:choose|select|pick|option|choice|answer|input|confirm|continue|navigate|选择|选项|确认|继续|输入)/iu.test(
        prompt,
      ) ||
      /(?:enter|esc|arrow|按下?|回车|取消|返回)/iu.test(prompt),
  });
  if (isCodexModelPickerPrompt(prompt)) {
    // Some terminal widths reflow adjacent rows into prose, e.g.
    // `... 6.rgpt-5.4-mini ... 7. gpt-5.2`. Recover those explicit model
    // keys without making the generic interaction detector depend on Codex.
    const byKey = new Map(options.flatMap((option) => option.key ? [[option.key, option]] as const : []));
    const inlineModelChoice = /(?:^|[^0-9])(?:[›>▸*+-]\s*)?(\d{1,4})\s*[.)、:]\s*[a-z]{0,3}(gpt-[a-z0-9][a-z0-9._-]*)/giu;
    for (const match of prompt.matchAll(inlineModelChoice)) {
      const key = match[1]!;
      const model = match[2]!;
      const existing = byKey.get(key);
      if (existing) {
        if (!existing.label.includes(model)) existing.label = `${existing.label} ${model}`;
        continue;
      }
      const option: LiveInteractionOption = {
        key,
        label: model,
        selected: /[›>▸]/u.test(match[0]),
        navigationOnly: false,
      };
      options.push(option);
      byKey.set(key, option);
    }
  }
  const out = options.map((option) => ({
    ...option,
    input: option.key ?? option.label,
    body: option.label,
    ...(option.label.match(/\b(gpt-[a-z0-9][a-z0-9._-]*)\b/iu)?.[1]
      ? { model: option.label.match(/\b(gpt-[a-z0-9][a-z0-9._-]*)\b/iu)?.[1] }
      : {}),
    ...(option.label.match(/\b(current|default)\b/iu)?.[1]
      ? { state: option.label.match(/\b(current|default)\b/iu)?.[1]?.toLowerCase() }
      : {}),
  }));
  if (isCodexModelPickerPrompt(prompt)) {
    out.sort((left, right) => Number(left.input) - Number(right.input));
  }
  return out;
}

function formatLiveInteractionPrompt(
  prompt: string,
  choices: InteractionChoice[],
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

function isCodexReasoningPickerPrompt(prompt: string): boolean {
  return (
    /\bselect\s+reasoning\s+(?:effort|level)\b/iu.test(prompt) &&
    /\b(?:low|medium|high|extra\s+high|more\s+reasoning|max)\b/iu.test(prompt)
  );
}

function truncateInteractionButtonLabel(label: string): string {
  const compact = label.replace(/\s+/gu, ' ').trim();
  return compact.length > 48 ? `${compact.slice(0, 45)}...` : compact;
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
  const allowBareConfirmation = inputRoute === 'agent';
  if (!looksLikeAgentPicker(text, allowBareConfirmation)) return undefined;
  const interaction = detectLiveInteraction(text, allowBareConfirmation, inputRoute === 'live');
  if (!interaction || skipSignatures?.has(interaction.signature)) return undefined;
  return liveInteractionCard(interaction, signCallback, inputRoute);
}

export function renderLiveAwareReplyCard(
  state: RunState,
  cardRenderOptions: { signCallback?: (action: string) => string; structuredOnly?: boolean } = {},
  inputRoute: LiveInteractionInputRoute = 'live',
  skipSignatures?: ReadonlySet<string>,
): object {
  // Picker detection must inspect the assistant text, not a long historical
  // tool trace. The card renderer still owns the collapsed activity panel.
  const body = renderText(state, { activityMode: 'none' });
  const liveCard = liveInteractionCardForText(
    body,
    cardRenderOptions.structuredOnly ? undefined : cardRenderOptions.signCallback,
    inputRoute,
    skipSignatures,
  );
  if (liveCard) return liveCard;
  // Keep streaming updates lightweight. Once the run is complete, preserve
  // code fences, diffs, tables and terminal diagrams as collapsed panels so a
  // final answer is never presented as one unreadable wall of Markdown.
  const answerState = finalAnswerOnlyState(state);
  const answerBody = renderText(answerState, { activityMode: 'none' });
  if (state.terminal !== 'running' && answerHasStructuredBlocks(answerBody)) {
    const base = renderCard(state, cardRenderOptions) as {
      body?: { elements?: unknown[] };
    };
    const activityPanels = (base.body?.elements ?? []).filter((element) => {
      if (!element || typeof element !== 'object') return false;
      const candidate = element as {
        tag?: unknown;
        header?: { title?: { content?: unknown } };
      };
      return (
        candidate.tag === 'collapsible_panel' &&
        typeof candidate.header?.title?.content === 'string' &&
        candidate.header.title.content.includes('执行活动')
      );
    });
    const answer = answerCard(parseAnswerBlocks(answerBody)) as {
      body: { elements: object[] };
    };
    // The completed answer is already projected from text-only blocks. Do not
    // prepend the original run card's tool/activity panels here: doing so
    // duplicates terminal output and can make a source listing appear both as
    // a normal paragraph and as a structured answer panel. Running updates
    // still use renderCard(), where the activity panel remains collapsed.
    return {
      ...answer,
      body: { elements: [...(activityPanels as object[]), ...answer.body.elements] },
    };
  }
  return renderCard(state, cardRenderOptions);
}

function isLiveInteractionCardForText(
  text: string,
  inputRoute: LiveInteractionInputRoute,
  skipSignatures?: ReadonlySet<string>,
): boolean {
  const allowBareConfirmation = inputRoute === 'agent';
  if (!looksLikeAgentPicker(text, allowBareConfirmation)) return false;
  const interaction = detectLiveInteraction(text, allowBareConfirmation, inputRoute === 'live');
  return Boolean(interaction && !skipSignatures?.has(interaction.signature));
}

function completeReplyText(state: RunState): string {
  return renderText(state, {
    maxBytes: Number.POSITIVE_INFINITY,
    activityMode: 'none',
  });
}

function buildNativeStatusTmuxFallback(cwd: string, status: TmuxBindingStatus): string {
  const terminal = status.terminal ?? (status.target
    ? {
        socketPath: status.target.socketPath,
        target: status.target.paneId,
        attachCommand: status.target.attachCommand,
        ownership: status.target.ownership,
      }
    : undefined);
  return [
    'Codex live session status',
    `Directory: ${cwd}`,
    `Tmux state: ${status.state}`,
    ...(terminal
      ? [
          `Tmux socket: ${terminal.socketPath}`,
          `Tmux target: ${terminal.target}`,
          `Tmux ownership: ${terminal.ownership}`,
          `Attach command: ${terminal.attachCommand}`,
        ]
      : ['Tmux terminal: unavailable']),
    '',
  ].join('\n');
}

function isLongReplyText(text: string): boolean {
  const bytes = Buffer.byteLength(text, 'utf8');
  // Structured panels carry headers, borders and a code fence in addition to
  // the source text. Promote them earlier so a single final card never grows
  // beyond CardKit's payload ceiling.
  return (
    bytes > LONG_REPLY_CARD_THRESHOLD_BYTES ||
    (answerHasStructuredBlocks(text) && bytes > LONG_REPLY_CARD_THRESHOLD_BYTES - 4_000)
  );
}

function longReplyNoticeCard(text: string): object {
  const chunks = answerHasStructuredBlocks(text)
    ? splitAnswerForDelivery(text, LONG_REPLY_CHUNK_BYTES)
    : splitTextForDelivery(text, LONG_REPLY_CHUNK_BYTES);
  return {
    schema: '2.0',
    config: {
      streaming_mode: false,
      summary: { content: '正文较长，已拆分发送' },
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: `正文较长，已分成 ${chunks.length} 条消息发送。`,
        },
      ],
    },
  };
}

async function sendCompleteReplyChunks(input: {
  channel: LarkChannel;
  chatId: string;
  sendOpts: { replyTo: string; replyInThread?: boolean };
  text: string;
  scope: string;
  replyMode: ReturnType<typeof getMessageReplyMode>;
}): Promise<void> {
  const structured = answerHasStructuredBlocks(input.text);
  const promoteToCards = input.replyMode === 'card' || structured;
  if (promoteToCards) {
    const chunks = splitAnswerForDelivery(input.text, LONG_REPLY_CHUNK_BYTES);
    if (chunks.length === 0) return;
    const failedChunks: number[] = [];
    for (const [index, chunk] of chunks.entries()) {
      try {
        await sendWithRetry(
          () => input.channel.send(
            input.chatId,
            { card: answerCard(chunk, index + 1, chunks.length) },
            input.sendOpts,
          ),
          { scope: input.scope, chunk: index + 1, total: chunks.length },
        );
      } catch {
        failedChunks.push(index + 1);
      }
    }
    await ensureDeliveredTail({
      channel: input.channel,
      chatId: input.chatId,
      sendOpts: input.sendOpts,
      source: input.text,
      delivered: chunks.flat().map((block) => block.content).join('\n'),
      scope: input.scope,
    });
    if (failedChunks.length > 0) {
      await sendWithRetry(
        () => input.channel.send(
          input.chatId,
          { markdown: `⚠️ 部分长消息投递失败（分段 ${failedChunks.join('、')}），已完成自动重试。请发送 /tmux tail 查看原始输出。` },
          input.sendOpts,
        ),
        { scope: input.scope, chunk: 0, total: chunks.length, warning: true },
      ).catch(() => undefined);
    }
    log.info('outbound', 'long-reply-split', {
      scope: input.scope,
      chunks: chunks.length,
      mode: 'card',
      structured,
      bytes: Buffer.byteLength(input.text, 'utf8'),
    });
    return;
  }

  const chunks = splitTextForDelivery(input.text, LONG_REPLY_CHUNK_BYTES);
  if (chunks.length === 0) return;
  const failedChunks: number[] = [];
  for (const [index, chunk] of chunks.entries()) {
    const content =
      chunks.length > 1
        ? `（${index + 1}/${chunks.length}）\n\n${chunk}`
        : chunk;
    try {
      await sendWithRetry(
        () => input.channel.send(input.chatId, { markdown: content }, input.sendOpts),
        { scope: input.scope, chunk: index + 1, total: chunks.length },
      );
    } catch {
      failedChunks.push(index + 1);
    }
  }
  await ensureDeliveredTail({
    channel: input.channel,
    chatId: input.chatId,
    sendOpts: input.sendOpts,
    source: input.text,
    delivered: chunks.join('\n'),
    scope: input.scope,
  });
  if (failedChunks.length > 0) {
    await sendWithRetry(
      () => input.channel.send(
        input.chatId,
        { markdown: `⚠️ 部分长消息投递失败（分段 ${failedChunks.join('、')}），已完成自动重试。请发送 /tmux tail 查看原始输出。` },
        input.sendOpts,
      ),
      { scope: input.scope, chunk: 0, total: chunks.length, warning: true },
    ).catch(() => undefined);
  }
  log.info('outbound', 'long-reply-split', {
    scope: input.scope,
    chunks: chunks.length,
    mode: 'markdown',
    bytes: Buffer.byteLength(input.text, 'utf8'),
  });
}

async function sendWithRetry(
  send: () => Promise<unknown>,
  meta: { scope: string; chunk: number; total: number; warning?: boolean },
): Promise<void> {
  const maxAttempts = 3;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await send();
      if (attempt > 1) log.info('outbound', 'chunk-recovered', { ...meta, attempt });
      return;
    } catch (err) {
      lastError = err;
      log.warn('outbound', 'chunk-send-retry', {
        ...meta,
        attempt,
        maxAttempts,
        err: err instanceof Error ? err.message : String(err),
      });
      if (attempt < maxAttempts) await delay(250 * attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? 'message send failed'));
}

async function ensureDeliveredTail(input: {
  channel: LarkChannel;
  chatId: string;
  sendOpts: { replyTo: string; replyInThread?: boolean };
  source: string;
  delivered: string;
  scope: string;
}): Promise<void> {
  const sourceLines = input.source.replace(/\r\n?/gu, '\n').split('\n').filter((line) => line.trim());
  if (sourceLines.length === 0) return;
  const tailLines = sourceLines.slice(-8);
  const tail = tailLines.join('\n');
  let cursor = 0;
  const covered = tailLines.every((line) => {
    const needle = line.length > LONG_REPLY_CHUNK_BYTES
      ? line.slice(-Math.min(256, line.length))
      : line;
    const index = input.delivered.indexOf(needle, cursor);
    if (index < 0) return false;
    cursor = index + needle.length;
    return true;
  });
  log.info('outbound', 'delivery-integrity', {
    scope: input.scope,
    sourceSha256: createHash('sha256').update(input.source).digest('hex'),
    deliveredSha256: createHash('sha256').update(input.delivered).digest('hex'),
    sourceBytes: Buffer.byteLength(input.source, 'utf8'),
    deliveredBytes: Buffer.byteLength(input.delivered, 'utf8'),
    tailCovered: covered,
  });
  if (covered) return;
  await sendWithRetry(
    () => input.channel.send(
      input.chatId,
      {
        markdown: `⚠️ 正文尾部完整性校验发现缺失，补发最后内容：\n\n${tail.slice(-8_000)}`,
      },
      input.sendOpts,
    ),
    { scope: input.scope, chunk: 0, total: 0, warning: true },
  );
  log.warn('outbound', 'delivery-tail-recovered', { scope: input.scope, tailLines: Math.min(8, sourceLines.length) });
}

function isSkippedLiveInteractionForText(
  text: string,
  skipSignatures?: ReadonlySet<string>,
  inputRoute: LiveInteractionInputRoute = 'live',
): boolean {
  const allowBareConfirmation = inputRoute === 'agent';
  if (!skipSignatures || !looksLikeAgentPicker(text, allowBareConfirmation)) return false;
  const interaction = detectLiveInteraction(text, allowBareConfirmation, inputRoute === 'live');
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
    /^(?:[0-9]{1,2}|[a-z]|yes|no)(?:\s+enter)?$/iu.test(trimmed)
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

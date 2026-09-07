import type {
  CardActionEvent,
  CardActionResponse,
  LarkChannel,
  NormalizedMessage,
} from '@larksuite/channel';
import type { AgentAdapter } from '../agent/types';
import type { ActiveRuns } from '../bot/active-runs';
import type { ChatModeCache } from '../bot/chat-mode-cache';
import type { PendingQueue } from '../bot/pending-queue';
import type { ProcessPool } from '../bot/process-pool';
import type { CallbackAuth } from './callback-auth';
import { runCommandHandler, type CommandContext, type Controls } from '../commands';
import { log } from '../core/logger';
import { canUseDm, canUseGroup } from '../policy/access';
import type { RunExecutor } from '../runtime/run-executor';
import type { SessionCatalog } from '../session/catalog';
import type { SessionStore } from '../session/store';
import type { WorkspaceStore } from '../workspace/store';
import { markNativeAgentCommand } from '../bot/live-input';
import { commandSessionCatalogIdentity } from '../bot/session-catalog-identity';
import { lookupMessageThreadId } from '../bot/thread-id';
import { BRIDGE_PROMPT_CALLBACK_MARKER, PROMPT_CALLBACK_ACTION } from './interactive-prompt';
import { sendStructuredCard } from './structured-interaction';
import type { AgentEvent } from '../agent/types';

/** Marker key on a button's value object that flags the cardAction as
 * a callback that should be forwarded back to the agent instead
 * of dispatched to a built-in command handler. The double-underscore
 * sigils make it virtually impossible to collide with normal payload
 * fields the agent might set.
 */
export const BRIDGE_CALLBACK_MARKER = '__bridge_cb';
const LEGACY_CLAUDE_CALLBACK_MARKER = '__claude_cb';
export const LIVE_INPUT_CALLBACK_ACTION = 'live_input';
export const AGENT_INPUT_CALLBACK_ACTION = 'agent_input';

const staleInteractionResponse = (): CardActionResponse => ({
  toast: {
    type: 'error',
    content: '此交互已失效，请重新发送或等待最新卡片',
  },
});

export interface CardDispatchDeps {
  channel: LarkChannel;
  evt: CardActionEvent;
  sessions: SessionStore;
  sessionCatalog?: SessionCatalog;
  workspaces: WorkspaceStore;
  activeRuns: ActiveRuns;
  agent: AgentAdapter;
  processPool?: ProcessPool;
  runExecutor?: RunExecutor;
  controls: Controls;
  pending: PendingQueue;
  chatModeCache: ChatModeCache;
  callbackAuth?: CallbackAuth;
  callbackPolicyFingerprint?: string;
  callbackPolicyFingerprintForScope?: (scope: string) => string | undefined;
  liveDiagnostics?: NonNullable<CommandContext['liveDiagnostics']> extends () => infer R
    ? (scope: string) => R
    : never;
  liveInteractionGeneration?: (scope: string) => string | undefined;
}

export async function handleCardAction(deps: CardDispatchDeps): Promise<CardActionResponse | undefined> {
  const value = deps.evt.action.value;
  if (!value || typeof value !== 'object') return;
  const payload = value as Record<string, unknown>;

  const operatorId = deps.evt.operator.openId;
  const chatId = deps.evt.chatId;

  // CardKit 2.0 form submits drop user-input values from action.value; they
  // arrive on raw.action.form_value. The SDK forwards the raw event when
  // includeRawEvent: true is set on the channel options.
  const raw = (deps.evt as CardActionEvent & { raw?: unknown }).raw as
    | { action?: { form_value?: Record<string, unknown> } }
    | undefined;
  const formValue = raw?.action?.form_value;

  // Resolve the click's session scope. For topic groups we need to know
  // the message's thread_id so the action targets the right topic's
  // session — look up the carrier message (the card lives on it) once.
  // Done before the access check so we know the chat mode (p2p vs group)
  // and can skip the chat allowlist for DMs.
  const { scope, threadId, mode } = await resolveScope(deps);

  const accessDecision =
    mode === 'p2p'
      ? canUseDm(deps.controls.profileConfig, deps.controls, operatorId)
      : canUseGroup(deps.controls.profileConfig, deps.controls, chatId, operatorId);
  if (!accessDecision.ok) {
    log.info('cardAction', 'skip-not-allowed-user', {
      operator: operatorId.slice(-6),
      reason: accessDecision.reason,
    });
    return;
  }

  if (LEGACY_CLAUDE_CALLBACK_MARKER in payload) {
    log.info('cardAction', 'skip-legacy-callback-marker', { scope });
    return;
  }

  const cmd = typeof payload.cmd === 'string' ? payload.cmd : '';
  if (cmd) {
    if (cmd === 'live.input') {
      if (!verifyDeferredLiveInputToken(deps, payload, scope, operatorId)) {
        return staleInteractionResponse();
      }
      return acknowledgeLiveInput(deps, payload, scope, threadId, mode);
    }
    if (cmd === 'agent.input') {
      if (!verifyDeferredAgentInputToken(deps, payload, scope, operatorId)) {
        return staleInteractionResponse();
      }
      return forwardAgentInput(deps, payload, scope, threadId, mode);
    }
    if (isSignedBridgeCallback(payload) && !verifyBridgeToken(deps, payload, scope, cmd)) {
      return;
    }
    log.info('cardAction', 'cmd', { cmd, scope });
    const msg = makeFakeMsg(deps.evt, threadId);

    const ctx: CommandContext = {
      channel: deps.channel,
      msg,
      scope,
      chatMode: mode,
      sessions: deps.sessions,
      sessionCatalog: deps.sessionCatalog,
      sessionCatalogIdentity: await commandSessionCatalogIdentity({
        msg,
        scope,
        mode,
        workspaces: deps.workspaces,
        controls: deps.controls,
        access: accessDecision,
      }),
      workspaces: deps.workspaces,
      activeRuns: deps.activeRuns,
      agent: deps.agent,
      processPool: deps.processPool,
      runExecutor: deps.runExecutor,
      controls: deps.controls,
      formValue,
      fromCardAction: true,
      liveDiagnostics: deps.liveDiagnostics ? () => deps.liveDiagnostics!(scope) : undefined,
    };

    const [name, ...rest] = cmd.split('.');
    const sub = rest.join(' ');
    const args = composeArgs(sub, payload);

    try {
      const ok = await runCommandHandler(name ?? '', args, ctx);
      if (!ok) log.warn('cardAction', 'unknown', { cmd });
    } catch (err) {
      log.fail('cardAction', err, { cmd });
    }
    return;
  }

  // Deferred prompt-answer callback: the button answers an AskUserQuestion /
  // ExitPlanMode prompt the agent raised in a run that has since ended. Verify
  // without requiring an active run (see verifyPromptToken), then forward the
  // answer so the session resumes as a follow-up turn.
  if (BRIDGE_PROMPT_CALLBACK_MARKER in payload) {
    if (!verifyPromptToken(deps, payload, scope, operatorId)) return;
    return forwardToAgent(deps, payload, formValue, scope, threadId, mode);
  }

  // Agent-driven callback: the button was rendered by an agent via lark-cli,
  // with `__bridge_cb` set on the value. Forward the click back into the
  // scope's pending queue so the agent resumes its session and sees the click
  // as a follow-up message, with full context of what it sent.
  if (BRIDGE_CALLBACK_MARKER in payload) {
    if (!verifyBridgeToken(deps, payload, scope, 'agent_callback')) return;
    return forwardToAgent(deps, payload, formValue, scope, threadId, mode);
  }

  return;
}

function verifyDeferredLiveInputToken(
  deps: CardDispatchDeps,
  payload: Record<string, unknown>,
  scope: string,
  operatorId: string,
): boolean {
  return verifyDeferredInputToken(deps, payload, scope, operatorId, LIVE_INPUT_CALLBACK_ACTION);
}

function verifyDeferredAgentInputToken(
  deps: CardDispatchDeps,
  payload: Record<string, unknown>,
  scope: string,
  operatorId: string,
): boolean {
  return verifyDeferredInputToken(deps, payload, scope, operatorId, AGENT_INPUT_CALLBACK_ACTION);
}

function verifyDeferredInputToken(
  deps: CardDispatchDeps,
  payload: Record<string, unknown>,
  scope: string,
  operatorId: string,
  action: typeof LIVE_INPUT_CALLBACK_ACTION | typeof AGENT_INPUT_CALLBACK_ACTION,
): boolean {
  const token = typeof payload.bridge_token === 'string' ? payload.bridge_token : '';
  if (!deps.callbackAuth || !token || !(BRIDGE_CALLBACK_MARKER in payload)) {
    log.warn('callback', 'denied', {
      scope,
      action,
      reason: 'missing-token',
    });
    return false;
  }
  const result = deps.callbackAuth.verify(token, {
    scope,
    chatId: deps.evt.chatId,
    operatorOpenId: operatorId,
    action: action === LIVE_INPUT_CALLBACK_ACTION && deps.agent.structuredControl
      ? `live_input:${String(payload.input ?? '')}` : action,
  });
  if (!result.ok) {
    log.info('cardAction', 'skip-deferred-input-auth-failed', { scope, action, reason: result.reason });
    log.warn('callback', 'denied', {
      scope,
      action,
      reason: result.reason,
    });
    return false;
  }
  if (action === LIVE_INPUT_CALLBACK_ACTION && deps.liveInteractionGeneration && !deps.agent.structuredControl) {
    const generation = deps.liveInteractionGeneration(scope);
    if (!generation || result.payload.r !== generation) {
      log.info('cardAction', 'skip-stale-live-input-generation', {
        scope,
        tokenGeneration: result.payload.r,
        currentGeneration: generation,
      });
      return false;
    }
  }
  return true;
}

async function acknowledgeLiveInput(
  deps: CardDispatchDeps,
  payload: Record<string, unknown>,
  scope: string,
  threadId: string | undefined,
  mode: 'p2p' | 'group' | 'topic',
): Promise<CardActionResponse | undefined> {
  // Card callbacks have a short response budget. Let slow terminal checks
  // finish independently, while giving the user an accurate receipt (not a
  // claim that the keys were already delivered).
  const operation = forwardLiveInput(deps, payload, scope, threadId, mode);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = Symbol('pending');
  try {
    const result = await Promise.race([
      operation,
      new Promise<typeof pending>((resolve) => { timer = setTimeout(() => resolve(pending), 200); }),
    ]);
    if (result !== pending) return result;
    void operation.then(async (response) => {
      const toast = response?.toast as { type?: string; content?: string } | undefined;
      if (toast?.type !== 'error') return;
      await deps.channel.send(deps.evt.chatId, { markdown: `⚠️ ${toast.content}` }, {
        replyTo: deps.evt.messageId,
        ...(mode === 'topic' && threadId ? { replyInThread: true } : {}),
      });
    }).catch((err) => log.warn('cardAction', 'live-input-background-failed', { scope, err: String(err) }));
    return { toast: { type: 'info', content: '已收到选择，正在确认终端状态' } };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function sendStructuredInteraction(deps: CardDispatchDeps, event: Extract<AgentEvent, { type: 'interactive' }>, scope: string, threadId: string | undefined, mode: string): Promise<void> {
  if (!event.interaction || !deps.callbackAuth) return;
  await sendStructuredCard(deps.channel, deps.evt.chatId, event.interaction, input => deps.callbackAuth!.sign({
    runId: event.interaction!.id, scope, chatId: deps.evt.chatId, operatorOpenId: deps.evt.operator.openId,
    action: `live_input:${input}`, policyFingerprint: 'structured', ttlMs: 30 * 60 * 1000,
  }), { replyTo: deps.evt.messageId, ...(mode === 'topic' && threadId ? { replyInThread: true } : {}) });
}

async function forwardLiveInput(
  deps: CardDispatchDeps,
  payload: Record<string, unknown>,
  scope: string,
  threadId: string | undefined,
  mode: 'p2p' | 'group' | 'topic',
): Promise<CardActionResponse | undefined> {
  const input = typeof payload.input === 'string' ? payload.input.trim() : '';
  if (!input) return;
  log.info('cardAction', 'live-input', { scope, input });
  if (deps.agent.structuredControl) {
    try {
      const events = await deps.agent.structuredControl(scope, input);
      for (const event of events) {
        if (event.type === 'text') await deps.channel.send(deps.evt.chatId, { markdown: event.delta }, { replyTo: deps.evt.messageId });
        if (event.type === 'interactive' && event.interaction) {
          // Queue only presentation of a nested picker through the shared
          // renderer; the choice itself has already reached the provider.
          await sendStructuredInteraction(deps, event, scope, threadId, mode);
        }
      }
      return { toast: { type: 'success', content: '已提交选择' } };
    } catch (error) { return { toast: { type: 'error', content: error instanceof Error ? error.message : String(error) } }; }
  }
  const synthetic: NormalizedMessage = markNativeAgentCommand(
    {
      messageId: deps.evt.messageId,
      chatId: deps.evt.chatId,
      chatType: mode === 'p2p' ? 'p2p' : 'group',
      threadId,
      senderId: deps.evt.operator.openId,
      senderName: deps.evt.operator.name,
      content: input,
      rawContentType: 'card_action',
      resources: [],
      mentions: [],
      mentionAll: false,
      mentionedBot: false,
      createTime: Date.now(),
    },
    'control',
  );
  const activeHandle = [deps.activeRuns.getSide(scope), deps.activeRuns.get(scope)].find(
    (handle) => Boolean(handle && !handle.interrupted && !handle.stopRequested && !handle.detached),
  );
  // Verify the current terminal surface once before choosing between the
  // direct-live lane and the deferred queue. A signed card token proves which
  // picker produced the button, but it does not prove that the same picker is
  // still on screen after a run has completed or the terminal has advanced.
  // This gate prevents an old `1 enter` click from becoming the next ordinary
  // prompt while still allowing a picker that remains visible after observer
  // cleanup to be handled by the normal control run.
  let pickerConfirmed = !deps.liveDiagnostics;
  if (deps.liveDiagnostics) {
    try {
      const diagnostics = await Promise.race([
        deps.liveDiagnostics(scope),
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 2_000)),
      ]);
      if (!diagnostics) {
        log.info('cardAction', 'live-input-diagnostics-timeout', { scope });
        return {
          toast: {
            type: 'error',
            content: '终端状态暂时无法确认，请稍后重试最新选择卡片',
          },
        };
      }
      // Prefer live terminal phase over the persisted marker. The latter is
      // needed for restart recovery, but it can outlive the picker itself.
      pickerConfirmed = diagnostics.live
        ? diagnostics.live.phase === 'picker'
        : Boolean(diagnostics.picker);
    } catch (err) {
      log.warn('cardAction', 'live-input-diagnostics-failed', {
        scope,
        err: err instanceof Error ? err.message : String(err),
      });
      return {
        toast: {
          type: 'error',
          content: '终端状态暂时无法确认，请稍后重试最新选择卡片',
        },
      };
    }
  }
  // If the picker is displayed by an active live turn, reuse that turn's
  // terminal directly. Starting a second RunExecutor job would collide with
  // the scope reservation (and a blocked parent queue would silently defer
  // the click). The main EventFanout remains subscribed and will publish the
  // next picker/result normally.
  if (
    activeHandle &&
    !activeHandle.interrupted &&
    !activeHandle.stopRequested &&
    !activeHandle.detached &&
    deps.agent.tmux?.sendInput
  ) {
    if (pickerConfirmed) {
      const cwd = deps.workspaces.cwdFor(scope) ?? deps.controls.profileConfig.workspaces.default;
      try {
        const stillActive = (): boolean => {
          const currentHandle = [deps.activeRuns.getSide(scope), deps.activeRuns.get(scope)].find(
            (handle) => Boolean(handle && !handle.interrupted && !handle.stopRequested && !handle.detached),
          );
          return currentHandle === activeHandle;
        };
        if (stillActive() && await deps.agent.tmux.sendInput(scope, input, cwd, stillActive)) {
          log.info('cardAction', 'live-input-injected', { scope, input });
          return {
            toast: {
              type: 'success',
              content: '已提交，正在等待终端响应',
            },
          };
        }
      } catch (err) {
        log.warn('cardAction', 'live-input-injection-failed', {
          scope,
          err: err instanceof Error ? err.message : String(err),
        });
      }
      return {
        toast: {
          type: 'error',
          content: '选择按键未送达终端，请等待最新选择卡片后重试',
        },
      };
    } else {
      log.info('cardAction', 'live-input-not-at-picker', { scope });
      // The callback is tied to a specific picker generation. Do not place a
      // stale click into the ordinary queue where it could be replayed later
      // against a normal prompt or remain blocked behind the parent run.
      return {
        toast: {
          type: 'error',
          content: '选择窗已变化，请重新发送命令或等待最新选择卡片',
        },
      };
    }
  }
  if (!activeHandle && deps.liveDiagnostics && !pickerConfirmed) {
    log.info('cardAction', 'live-input-not-at-picker', { scope });
    return {
      toast: {
        type: 'error',
        content: '选择窗已变化，请重新发送命令或等待最新选择卡片',
      },
    };
  }
  // A card click is already a complete control action. Let the queue hand it
  // off on the next event-loop turn instead of waiting for the chat debounce.
  // Picker cards commonly belong to a terminal that is still attached to a
  // running parent task; bypass the conversational block or the click sits at
  // the front of the FIFO but cannot execute until that task finishes.
  deps.pending.pushFront(scope, synthetic, {
    immediate: true,
    bypassBlock: true,
    priorityOrder: 'fifo',
  });
  return {
    toast: {
      type: 'success',
      content: '已提交，正在等待终端响应',
    },
  };
}

function forwardAgentInput(
  deps: CardDispatchDeps,
  payload: Record<string, unknown>,
  scope: string,
  threadId: string | undefined,
  mode: 'p2p' | 'group' | 'topic',
): CardActionResponse | undefined {
  const input = typeof payload.input === 'string' ? payload.input.trim() : '';
  if (!input) return;
  log.info('cardAction', 'agent-input', { scope, input });
  const synthetic: NormalizedMessage = {
    messageId: deps.evt.messageId,
    chatId: deps.evt.chatId,
    chatType: mode === 'p2p' ? 'p2p' : 'group',
    threadId,
    senderId: deps.evt.operator.openId,
    senderName: deps.evt.operator.name,
    content: input,
    rawContentType: 'card_action',
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: false,
    createTime: Date.now(),
  };
  deps.pending.push(scope, synthetic);
  return {
    toast: {
      type: 'success',
      content: '已提交，正在继续任务',
    },
  };
}

async function resolveScope(
  deps: CardDispatchDeps,
): Promise<{ scope: string; threadId: string | undefined; mode: 'p2p' | 'group' | 'topic' }> {
  const chatId = deps.evt.chatId;
  if (deps.agent.structuredControl) {
    const payload = deps.evt.action.value as { cmd?: string; bridge_token?: string } | undefined;
    if (payload?.cmd === 'live.input' && typeof payload.bridge_token === 'string') {
      try {
        // This is only a routing hint. The complete HMAC, scope, chat,
        // operator, input and nonce are verified before the control executes.
        // A topic card already carries its exact scope, avoiding REST lookups
        // that can both time out and drop Feishu's thread_id.
        const hint = JSON.parse(Buffer.from(payload.bridge_token.split('.')[2] ?? '', 'base64url').toString('utf8'));
        if (typeof hint.s === 'string' && hint.s.startsWith(`${chatId}:`) && hint.s.length > chatId.length + 1) {
          return { scope: hint.s, threadId: hint.s.slice(chatId.length + 1), mode: 'topic' };
        }
      } catch { /* Invalid tokens are rejected by the authorization step. */ }
    }
  }
  const mode = await deps.chatModeCache.resolve(deps.channel, chatId);
  if (mode !== 'topic') {
    return { scope: chatId, threadId: undefined, mode };
  }
  // Topic group — need the carrier message's thread_id to compose scope.
  // One API call per click; could cache by messageId if it ever becomes hot.
  const threadId = await lookupMessageThreadId(deps.channel, deps.evt.messageId);
  if (!threadId) {
    // Fall back to plain chatId. Better to land in the chat's "default"
    // scope than fail the click silently.
    return { scope: chatId, threadId: undefined, mode };
  }
  return { scope: `${chatId}:${threadId}`, threadId, mode };
}

function forwardToAgent(
  deps: CardDispatchDeps,
  payload: Record<string, unknown>,
  formValue: Record<string, unknown> | undefined,
  scope: string,
  threadId: string | undefined,
  mode: 'p2p' | 'group' | 'topic',
): CardActionResponse | undefined {
  // Strip the markers/token so the agent only sees the meaningful fields it set.
  const {
    [BRIDGE_CALLBACK_MARKER]: _marker,
    [BRIDGE_PROMPT_CALLBACK_MARKER]: _promptMarker,
    bridge_token: _token,
    ...agentPayload
  } = payload;
  const merged = formValue ? { ...agentPayload, form_value: formValue } : agentPayload;
  log.info('cardAction', 'forward-agent', {
    scope,
    payload: JSON.stringify(merged).slice(0, 200),
  });
  const synthetic: NormalizedMessage = {
    messageId: deps.evt.messageId,
    chatId: deps.evt.chatId,
    chatType: mode === 'p2p' ? 'p2p' : 'group',
    threadId,
    senderId: deps.evt.operator.openId,
    senderName: deps.evt.operator.name,
    content: `[card-click] ${JSON.stringify(merged)}`,
    rawContentType: 'card_action',
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: false,
    createTime: Date.now(),
  };
  deps.pending.push(scope, synthetic);
  return {
    toast: {
      type: 'success',
      content: '已提交，正在继续任务',
    },
  };
}

function verifyBridgeToken(
  deps: CardDispatchDeps,
  payload: Record<string, unknown>,
  scope: string,
  action: string,
): boolean {
  const token = typeof payload.bridge_token === 'string' ? payload.bridge_token : '';
  const active = deps.activeRuns.get(scope);
  if (!deps.callbackAuth || !token || !active) {
    log.info('cardAction', 'skip-callback-auth-missing', { scope, action });
    log.warn('callback', 'denied', { scope, action, reason: 'missing-token-or-run' });
    return false;
  }
  const result = deps.callbackAuth.verify(token, {
    runId: active.run.runId,
    scope,
    chatId: deps.evt.chatId,
    operatorOpenId: deps.evt.operator.openId,
    action,
    policyFingerprint:
      deps.callbackPolicyFingerprintForScope?.(scope) ??
      deps.callbackPolicyFingerprint ??
      '',
  });
  if (!result.ok) {
    log.info('cardAction', 'skip-callback-auth-failed', {
      scope,
      action,
      reason: result.reason,
    });
    log.warn('callback', 'denied', { scope, action, reason: result.reason });
    return false;
  }
  return true;
}

/**
 * Verify a deferred prompt-answer token. Unlike verifyBridgeToken this does
 * NOT require an active run for the scope: the run that raised the prompt has
 * already ended by the time the user clicks. Binding is to the stable
 * scope/chat/operator/action identity; the HMAC still covers the run id and
 * policy fingerprint, and the single-use nonce + expiry prevent replay/forgery.
 */
function verifyPromptToken(
  deps: CardDispatchDeps,
  payload: Record<string, unknown>,
  scope: string,
  operatorId: string,
): boolean {
  const token = typeof payload.bridge_token === 'string' ? payload.bridge_token : '';
  if (!deps.callbackAuth || !token) {
    log.warn('callback', 'denied', {
      scope,
      action: PROMPT_CALLBACK_ACTION,
      reason: 'missing-token',
    });
    return false;
  }
  const result = deps.callbackAuth.verify(token, {
    scope,
    chatId: deps.evt.chatId,
    operatorOpenId: operatorId,
    action: PROMPT_CALLBACK_ACTION,
    // runId + policyFingerprint intentionally omitted (run has ended).
  });
  if (!result.ok) {
    log.info('cardAction', 'skip-prompt-auth-failed', { scope, reason: result.reason });
    log.warn('callback', 'denied', {
      scope,
      action: PROMPT_CALLBACK_ACTION,
      reason: result.reason,
    });
    return false;
  }
  return true;
}

function isSignedBridgeCallback(payload: Record<string, unknown>): boolean {
  return BRIDGE_CALLBACK_MARKER in payload || typeof payload.bridge_token === 'string';
}

/** Turn a button payload like {cmd:'ws.use', name:'proj-a'} into the arg
 * string the text-command handler expects: 'use proj-a'. Accepts `arg`
 * (preferred, generic) or `name` (legacy ws cards). */
function composeArgs(sub: string, payload: Record<string, unknown>): string {
  if (!sub) return '';
  const arg =
    (typeof payload.arg === 'string' && payload.arg) ||
    (typeof payload.name === 'string' && payload.name) ||
    '';
  return arg ? `${sub} ${arg}` : sub;
}

function makeFakeMsg(
  evt: CardActionEvent,
  threadId: string | undefined,
): NormalizedMessage {
  return {
    messageId: evt.messageId,
    chatId: evt.chatId,
    chatType: 'p2p',
    threadId,
    senderId: evt.operator.openId,
    senderName: evt.operator.name,
    content: '',
    rawContentType: 'interactive',
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: false,
    createTime: Date.now(),
  };
}

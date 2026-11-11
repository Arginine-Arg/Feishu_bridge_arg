import { randomUUID } from 'node:crypto';
import type {
  AgentEvent,
  AgentRunOptions,
  AgentSteerCapability,
  AgentSteerRequest,
  AgentSteerResult,
  LiveSessionDiagnostics,
} from '../types';
import { interactionEvent, textEvent, type StructuredSession } from './contracts';
import { RpcClient, type Wire } from './rpc';
import { SIDE_BOUNDARY_PROMPT, SIDE_DEVELOPER_INSTRUCTIONS } from './side-boundary';
import { codexTurnPermissionOverrides } from './permissions';
import type { BrokerToolHost, WriteAuthorization } from '../subagents/broker-tools';
import type { ArtifactDeliveryEnv } from '../lark-channel-env';
import { isTransientProviderError, type ProviderRecoveryConfig } from '../../config/provider-recovery';
import { log } from '../../core/logger';

const toolItems = new Set(['commandExecution', 'fileChange', 'mcpToolCall', 'collabAgentToolCall', 'webSearch', 'imageGeneration', 'dynamicToolCall']);

export class CodexStructuredSession implements StructuredSession {
  private emit?: (event: AgentEvent) => void;
  private complete?: () => void;
  private turnId?: string;
  private phase: LiveSessionDiagnostics['phase'] = 'idle';
  private goalActive = false;
  private lastGoalText?: string;
  private finishedTurns = new Set<string>();
  private selectedSkill?: { name: string; path: string };
  private lastUserText?: string;
  private lastAssistantText = '';
  private lastToolStatus?: string;
  private lastCwd?: string;
  private pending = new Map<string, { choices: Map<string, unknown>; freeText?: boolean; respond(value: unknown): Promise<void> }>();
  private menus = new Set<string>();
  private deltas = new Map<string, string>();
  private completedMessages = new Map<string, string>();
  private recoveryTimer?: NodeJS.Timeout;
  private recoveryEpoch = 0;
  private recoveryAttempts = 0;
  private recoveryStarting = false;
  private recoveryChecking = false;
  private recoveryWork: Promise<void> = Promise.resolve();
  private recoveryTurnIds = new Set<string>();
  private recoveryBlocked = false;
  private internalRetries = 0;
  private lastRetryNoticeAt = 0;
  private providerError?: { turnId: string; error: Wire };
  private retryStallTimer?: NodeJS.Timeout;
  private retryInterruptTurnId?: string;
  private retryInterruptTimer?: NodeJS.Timeout;
  private activeTools = new Set<string>();
  private acknowledgements = new Map<string, { resolve(): void; reject(error: Error): void }>();
  private deferredInteractions: AgentEvent[] = [];
  private usageTotal?: { inputTokens: number; outputTokens: number; cachedInputTokens: number };
  private readonly toolAbort = new AbortController();
  private readonly listener: (message: Wire) => void;
  constructor(
    readonly id: string,
    readonly endpoint: string,
    private readonly rpc: RpcClient,
    private readonly brokerTools?: BrokerToolHost,
    private readonly recovery?: { policy: ProviderRecoveryConfig; providerIds: string[] },
  ) {
    this.listener = message => this.receive(message);
    rpc.on('message', this.listener);
    rpc.on('disconnected', this.disconnected);
  }
  /** False when the underlying App Server channel is gone and must be rebuilt. */
  isAlive(): boolean { return !this.rpc.closed; }
  /** Why the channel died, when it did. */
  get failureReason(): string | undefined { return this.rpc.failureReason?.message; }
  private disconnected = (error: Error) => {
    this.cancelRecovery();
    for (const waiter of this.acknowledgements.values()) waiter.reject(error);
    this.acknowledgements.clear();
    this.phase = 'failed';
    this.emit?.({ type: 'error', message: error.message, terminationReason: 'failed' });
    this.finish();
  };
  private finish(): void {
    for (const id of this.pending.keys()) if (!this.menus.has(id)) this.pending.delete(id);
    this.deferredInteractions = []; this.complete?.(); this.complete = undefined;
    if (this.menus.size && this.phase !== 'failed') this.phase = 'picker';
  }
  private interaction(event: AgentEvent): void {
    if (this.emit) this.emit(event);
    else this.deferredInteractions.push(event);
  }
  private receive(message: Wire): void {
    const p = message.params ?? {};
    if (p.threadId !== this.id) return;
    if (message.id !== undefined && message.method) {
      this.clearRetryStall();
      const requestId = String(message.id);
      if (message.method === 'item/commandExecution/requestApproval' || message.method === 'item/fileChange/requestApproval') {
        const choices = new Map<string, unknown>();
        const decisions = p.availableDecisions ?? ['accept', 'acceptForSession', 'decline', 'cancel'];
        for (const [index, value] of decisions.entries()) choices.set(String(index + 1), value);
        this.pending.set(requestId, { choices, respond: decision => this.respondAcknowledged(message.id, { decision }) });
        this.phase = 'picker';
        this.interaction(interactionEvent({ id: requestId, prompt: `${p.reason ?? 'Codex 请求审批'}\n${p.command ?? JSON.stringify(p.changes ?? {})}`,
          choices: [...choices].map(([value, decision]) => ({ value, label: typeof decision === 'string' ? decision : JSON.stringify(decision) })) }));
      } else if (message.method === 'item/tool/requestUserInput') {
        const questions: Wire[] = p.questions ?? [];
        if (!questions.length) { this.rpc.rejectRequest(message.id, 'Empty question request'); return; }
        const answers: Record<string, { answers: string[] }> = {};
        for (const [index, question] of questions.entries()) {
          const id = `${requestId}.q${index}`;
          const options: Wire[] = question.options ?? [];
          this.pending.set(id, { choices: new Map(options.map((option, i) => [String(i + 1), option.label])), freeText: true, respond: async value => {
            answers[question.id] = { answers: [String(value)] };
            if (Object.keys(answers).length === questions.length) await this.respondAcknowledged(message.id, { answers });
          } });
          this.phase = 'picker';
          this.interaction(interactionEvent({ id, prompt: `${question.question}\n也可用 /answer ${id} 正文 自由回答。`,
            choices: options.map((option, i) => ({ label: option.label, value: String(i + 1) })) }));
        }
      } else if (message.method === 'item/tool/call') {
        void this.handleDynamicToolCall(message.id, p);
      } else {
        this.rpc.rejectRequest(message.id, 'Unsupported control request');
        this.emit?.(textEvent(`未实现的 Codex 控制请求：${message.method}\n`));
      }
      return;
    }
    if (message.method === 'turn/started') {
      if (!p.turn?.id || this.finishedTurns.has(p.turn.id)) return;
      if (!this.recoveryStarting && !this.recoveryTurnIds.has(p.turn?.id)) {
        if (!this.emit && p.turn.id !== this.turnId) this.recoveryBlocked = false;
        this.cancelRecovery(); this.recoveryAttempts = 0;
      }
      this.turnId = p.turn?.id; this.phase = 'busy';
      this.providerError = undefined;
      this.activeTools.clear();
    }
    if (message.method === 'error' && p.turnId === this.turnId) {
      this.providerError = { turnId: p.turnId, error: p.error ?? {} };
      if (p.willRetry === true) {
        this.internalRetries += 1;
        if (!this.lastRetryNoticeAt || Date.now() - this.lastRetryNoticeAt >= 15_000) {
          this.lastRetryNoticeAt = Date.now();
          const timeout = this.recoveryAllowed() ? this.recovery?.policy.retryStallSeconds : 0;
          this.emit?.(textEvent(`\n⏳ Provider 连接异常，Codex 正在重连${timeout ? `；连续 ${timeout} 秒无进展将中断本轮并尝试继续` : ''}。\n`));
        }
        this.watchRetryStall(p.turnId, p.error);
      }
    }
    if (p.turnId === this.turnId && (
      (message.method === 'item/agentMessage/delta' && p.delta) ||
      (message.method === 'item/reasoning/summaryTextDelta' && p.delta) ||
      message.method === 'item/commandExecution/outputDelta' ||
      message.method === 'item/started' || message.method === 'item/completed'
    )) this.clearRetryStall();
    if (message.method === 'item/agentMessage/delta') {
      const key = this.messageKey(p.turnId, p.itemId);
      if (!key) return;
      if (typeof p.delta !== 'string' || this.completedMessages.has(key)) return;
      this.deltas.set(key, (this.deltas.get(key) ?? '') + p.delta);
      this.lastAssistantText = `${this.lastAssistantText}${String(p.delta ?? '')}`.slice(-2000);
      this.emit?.({ type: 'text', source: 'agent', delta: p.delta, itemId: key });
    }
    if (message.method === 'item/started' && toolItems.has(p.item?.type)) {
      this.activeTools.add(p.item.id);
      this.lastToolStatus = `${p.item.type}: started`;
      this.emit?.({ type: 'tool_use', id: p.item.id, name: p.item.type, input: p.item.input ?? p.item.arguments ?? { command: p.item.command, cwd: p.item.cwd } });
    }
    if (message.method === 'item/completed') {
      const item = p.item ?? {};
      if (item.type === 'agentMessage') {
        this.completeMessage(p.turnId, item);
      }
      if (toolItems.has(item.type)) this.emit?.({ type: 'tool_result', id: item.id,
        output: item.aggregatedOutput ?? JSON.stringify(item.result ?? item.error ?? item.changes ?? ''),
        isError: item.status === 'failed' || (item.exitCode != null && item.exitCode !== 0) });
      if (toolItems.has(item.type)) {
        this.activeTools.delete(item.id);
        this.lastToolStatus = `${item.type}: ${item.status ?? (item.exitCode != null && item.exitCode !== 0 ? 'failed' : 'completed')}`;
      }
    }
    if (message.method === 'thread/goal/updated') {
      this.goalActive = p.goal?.status === 'active';
      if (typeof p.goal?.objective === 'string' && p.goal.objective.trim()) {
        this.lastGoalText = p.goal.objective.trim().slice(0, 800);
      }
      if (!this.goalActive) {
        this.cancelAutoRecovery();
        if (!this.turnId) { this.emit?.({ type: 'done', terminationReason: 'interrupted' }); this.finish(); }
      }
    }
    if (message.method === 'thread/goal/cleared') {
      this.goalActive = false;
      this.lastGoalText = undefined;
      this.cancelAutoRecovery();
      if (!this.turnId) this.finish();
    }
    if (message.method === 'thread/tokenUsage/updated') {
      const usage = p.tokenUsage?.last;
      const total = p.tokenUsage?.total;
      if (usage) {
        const previous = this.usageTotal;
        this.emit?.({ type: 'usage',
          inputTokens: total && previous ? Math.max(0, total.inputTokens - previous.inputTokens) : usage.inputTokens,
          outputTokens: total && previous ? Math.max(0, total.outputTokens - previous.outputTokens) : usage.outputTokens,
          cachedInputTokens: total && previous ? Math.max(0, total.cachedInputTokens - previous.cachedInputTokens) : usage.cachedInputTokens });
      }
      if (total) this.usageTotal = total;
    }
    if (message.method === 'serverRequest/resolved') {
      this.acknowledgements.get(String(p.requestId))?.resolve();
      const id = String(p.requestId);
      for (const key of this.pending.keys()) if (key === id || key.startsWith(`${id}.q`)) this.pending.delete(key);
      if (!this.pending.size) this.phase = this.turnId ? 'busy' : 'idle';
    }
    if (message.method === 'turn/completed' && (!this.turnId || p.turn?.id === this.turnId)) {
      if (!p.turn?.id || this.finishedTurns.has(p.turn.id)) return;
      const preempted = this.retryInterruptTurnId === p.turn.id && !this.recoveryBlocked;
      this.clearRetryStall();
      if (this.retryInterruptTimer) clearTimeout(this.retryInterruptTimer);
      this.retryInterruptTimer = undefined;
      this.retryInterruptTurnId = undefined;
      this.activeTools.clear();
      for (const item of p.turn.items ?? []) if (item.type === 'agentMessage') this.completeMessage(p.turn.id, item, true);
      for (const key of this.deltas.keys()) if (key.startsWith(`${p.turn.id}:`)) this.deltas.delete(key);
      this.finishedTurns.add(p.turn.id);
      if (this.finishedTurns.size > 100) this.finishedTurns.delete(this.finishedTurns.values().next().value!);
      this.turnId = undefined; this.phase = 'idle';
      if (p.turn?.status === 'failed' || (preempted && p.turn.status === 'interrupted')) {
        const error = p.turn.error ?? (this.providerError?.turnId === p.turn.id ? this.providerError?.error : undefined);
        if (!this.scheduleRecovery(p.turn.id, error, preempted ? p.turn.status : 'failed', preempted)) {
          this.emit?.({ type: 'error', message: preempted ? 'Provider 重连无进展，已中断；自动恢复次数已耗尽。' : error?.message ?? 'Codex turn failed', terminationReason: this.recoveryBlocked ? 'interrupted' : 'failed' }); this.finish();
        }
      }
      else if (!this.goalActive || p.turn?.status === 'interrupted') {
        this.cancelRecovery(); this.recoveryAttempts = 0;
        if (p.turn?.status === 'interrupted') this.emit?.({ type: 'done', terminationReason: 'interrupted' });
        this.finish();
      }
    }
  }
  private messageKey(turnId: unknown, itemId: unknown): string | undefined {
    const turn = typeof turnId === 'string' ? turnId : this.turnId;
    return turn && typeof itemId === 'string' && itemId ? `${turn}:${itemId}` : undefined;
  }
  private completeMessage(turnId: string, item: Wire, authoritative = false): void {
    const key = this.messageKey(turnId, item.id);
    if (!key || typeof item.text !== 'string' || !item.text) return;
    const draft = this.completedMessages.get(key) ?? this.deltas.get(key) ?? '';
    if (!authoritative && draft.startsWith(item.text) && draft.length > item.text.length) return;
    this.completedMessages.set(key, item.text);
    if (this.completedMessages.size > 1000) this.completedMessages.delete(this.completedMessages.keys().next().value!);
    this.lastAssistantText = item.text.slice(-2000);
    // A provider may normalize or rewrite its final item. Replace the exact
    // draft by identity, rather than dropping a non-prefix completion.
    if (!item.text.startsWith(draft)) {
      this.emit?.({ type: 'text', source: 'agent', itemId: key, replace: true, delta: item.text });
    } else if (item.text.length > draft.length) {
      this.emit?.({ type: 'text', source: 'agent', itemId: key, delta: item.text.slice(draft.length) });
    }
    this.deltas.delete(key);
  }
  private cancelRecovery(): boolean {
    const pending = Boolean(this.recoveryTimer || this.recoveryStarting || this.recoveryChecking);
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = undefined;
    this.clearRetryStall();
    if (this.retryInterruptTimer) clearTimeout(this.retryInterruptTimer);
    this.retryInterruptTimer = undefined;
    this.retryInterruptTurnId = undefined;
    this.recoveryEpoch += 1;
    return pending;
  }
  cancelAutoRecovery(): void { this.recoveryBlocked = true; this.cancelRecovery(); }
  private recoveryAllowed(): boolean {
    const policy = this.recovery?.policy;
    return Boolean(policy?.enabled && !this.recoveryBlocked && this.isAlive() &&
      (!policy.providers.length || this.recovery?.providerIds.some(id => policy.providers.includes(id))));
  }
  private clearRetryStall(): void {
    if (this.retryStallTimer) clearTimeout(this.retryStallTimer);
    this.retryStallTimer = undefined;
  }
  private watchRetryStall(turnId: string, error: Wire): void {
    const seconds = this.recovery?.policy.retryStallSeconds;
    if (!seconds || !this.recoveryAllowed() || !isTransientProviderError(error) ||
      this.retryStallTimer || this.retryInterruptTurnId || this.pending.size || this.activeTools.size) return;
    const epoch = this.recoveryEpoch;
    this.retryStallTimer = setTimeout(() => {
      // Keep the timer identity until preflight finishes; a new token/tool or
      // user interaction clears it and invalidates this specific attempt.
      const timer = this.retryStallTimer;
      void (async () => {
        const turns = await this.rpc.request('thread/turns/list', { threadId: this.id, limit: 1, sortDirection: 'desc' });
        if (!timer || this.retryStallTimer !== timer || epoch !== this.recoveryEpoch ||
          !this.recoveryAllowed() || this.turnId !== turnId || this.pending.size || this.activeTools.size) return;
        if (turns.data?.[0]?.id !== turnId || turns.data[0].status !== 'inProgress') return;
        this.retryInterruptTurnId = turnId;
        this.emit?.(textEvent(`\n⏳ 重连连续 ${seconds} 秒无进展，正在中断本轮；确认结束后才会继续。\n`));
        log.info('agent', 'provider-retry-stalled', { thread: this.id, turn: turnId, seconds });
        // Arm before sending: a notification can arrive before the RPC reply.
        this.retryInterruptTimer = setTimeout(() => {
          if (this.retryInterruptTurnId !== turnId) return;
          this.cancelAutoRecovery();
          this.emit?.({ type: 'error', message: '未收到本轮中断确认，已停止自动恢复；请检查 /status。', terminationReason: 'failed' });
          this.finish();
        }, 15_000);
        await this.rpc.request('turn/interrupt', { threadId: this.id, turnId }, 15_000);
      })().catch(() => {
        if (epoch !== this.recoveryEpoch || this.recoveryBlocked) return;
        this.cancelAutoRecovery();
        this.emit?.({ type: 'error', message: '无法确认重连中的 turn 已停止；未发送继续请求。', terminationReason: 'failed' });
        this.finish();
      }).finally(() => { if (this.retryStallTimer === timer) this.clearRetryStall(); });
    }, seconds * 1000);
    this.retryStallTimer.unref?.();
  }
  private scheduleRecovery(failedTurnId: string, error: Wire | undefined, expectedStatus = 'failed', preempted = false): boolean {
    const policy = this.recovery?.policy;
    if (!policy || !this.recoveryAllowed() || this.pending.size ||
      this.recoveryAttempts >= policy.maxAttempts || !isTransientProviderError(error)) return false;
    this.cancelRecovery();
    const epoch = this.recoveryEpoch;
    const goalWasActive = this.goalActive;
    const attempt = ++this.recoveryAttempts;
    const delay = preempted ? 5 : Math.min(policy.maxDelaySeconds, policy.delaySeconds * 2 ** (attempt - 1));
    this.phase = 'busy';
    this.emit?.(textEvent(`\n⏳ Provider 临时错误，本轮已结束；${delay} 秒后自动继续（${attempt}/${policy.maxAttempts}）。/stop 可取消。\n`));
    log.info('agent', 'provider-recovery-scheduled', { thread: this.id, attempt, delaySeconds: delay });
    const previousWork = this.recoveryWork;
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = undefined;
      this.recoveryWork = (async () => {
        // Completion can precede the turn/start RPC reply. Serialize the next
        // attempt behind that acknowledgement instead of overlapping starts.
        await previousWork;
        if (epoch !== this.recoveryEpoch || this.recoveryBlocked) return;
        this.recoveryChecking = true;
        const turns = await this.rpc.request('thread/turns/list', { threadId: this.id, limit: 1, sortDirection: 'desc' });
        if (epoch !== this.recoveryEpoch || this.recoveryBlocked || this.turnId) return;
        if (this.pending.size) {
          this.emit?.({ type: 'error', message: '自动继续已取消：会话存在待处理交互。', terminationReason: 'failed' }); this.finish(); return;
        }
        const latest = turns.data?.[0];
        if (latest?.id !== failedTurnId || latest.status !== expectedStatus) {
          if (latest?.status === 'inProgress') { this.turnId = latest.id; this.phase = 'busy'; }
          else {
            this.emit?.(latest?.status === 'completed' || latest?.status === 'interrupted'
              ? { type: 'done', terminationReason: latest.status === 'interrupted' ? 'interrupted' : 'normal' }
              : { type: 'error', message: '自动继续已取消：会话状态已变化。', terminationReason: 'failed' });
            this.finish();
          }
          return;
        }
        if (goalWasActive) {
          const result = await this.rpc.request('thread/goal/get', { threadId: this.id });
          if (epoch !== this.recoveryEpoch || this.recoveryBlocked) return;
          if (result.goal?.status !== 'active') {
            this.goalActive = false;
            this.emit?.({ type: 'done', terminationReason: 'interrupted' }); this.finish(); return;
          }
        }
        if (epoch !== this.recoveryEpoch || this.recoveryBlocked || this.turnId) return;
        this.recoveryStarting = true;
        this.emit?.(textEvent(`\n↪ 正在自动继续（${attempt}/${policy.maxAttempts}）。\n`));
        // Never replay the original task: prior tools may already have made
        // changes. Keep the same thread, provider and permission policy.
        const result = await this.rpc.request('turn/start', { threadId: this.id, input: [{ type: 'text',
          text: 'Continue the existing task after the temporary provider/API failure. Check the current state and prior tool results first; do not repeat completed actions. Respect any pause, stop, approval or budget limits already in this conversation.',
        }] });
        if (epoch !== this.recoveryEpoch) {
          if (this.recoveryBlocked && result.turn?.id && !this.finishedTurns.has(result.turn.id)) {
            await this.rpc.request('turn/interrupt', { threadId: this.id, turnId: result.turn.id });
          }
          return;
        }
        if (result.turn?.id) this.recoveryTurnIds.add(result.turn.id);
        if (this.recoveryTurnIds.size > 20) this.recoveryTurnIds.delete(this.recoveryTurnIds.values().next().value!);
        if (!this.finishedTurns.has(result.turn?.id)) this.turnId = result.turn?.id ?? this.turnId;
        if (this.recoveryBlocked && this.turnId) await this.rpc.request('turn/interrupt', { threadId: this.id, turnId: this.turnId });
      })().catch(() => {
        if (epoch !== this.recoveryEpoch) return;
        this.emit?.({ type: 'error', message: '自动继续未能确认会话状态或请求结果；已停止重试，请检查 /status。', terminationReason: 'failed' });
        this.finish();
      }).finally(() => { this.recoveryStarting = false; this.recoveryChecking = false; });
    }, delay * 1000);
    this.recoveryTimer.unref?.();
    return true;
  }
  private async handleDynamicToolCall(id: string | number, params: Wire): Promise<void> {
    const expectedNamespace = this.brokerTools?.specs[0]?.name;
    let result: { success: boolean; text: string };
    if (!this.brokerTools || !expectedNamespace) {
      result = { success: false, text: 'Bridge Broker tools are not configured for this thread.' };
    } else if (params.namespace && params.namespace !== expectedNamespace) {
      result = {
        success: false,
        text: `Unknown dynamic tool namespace: ${String(params.namespace)}; expected ${expectedNamespace}.`,
      };
    } else {
      const tool = typeof params.tool === 'string' ? params.tool : '';
      result = await this.brokerTools.call(tool, params.arguments, this.toolAbort.signal);
    }
    try {
      this.rpc.respond(id, {
        contentItems: [{ type: 'inputText', text: result.text }],
        success: result.success,
      });
    } catch {
      // The App Server channel closed while the worker request was running.
      // Results remain in the persisted worker mailbox for a later reconnect.
    }
  }
  async submit(options: AgentRunOptions, emit: (event: AgentEvent) => void, signal: AbortSignal): Promise<void> {
    if (this.emit) throw new Error('Structured thread already has an active relay');
    if (this.recoveryStarting || this.recoveryChecking) throw new Error('自动恢复请求仍在确认结果，请稍后再发送新任务。');
    if (signal.aborted) return;
    this.cancelRecovery(); this.recoveryAttempts = 0; this.recoveryBlocked = false;
    this.lastUserText = options.prompt.slice(0, 800);
    this.lastCwd = options.cwd;
    this.emit = emit;
    emit({ type: 'system', threadId: this.id, cwd: options.cwd });
    for (const event of this.deferredInteractions.splice(0)) {
      if (event.type === 'interactive' && event.interaction && this.pending.has(event.interaction.id)) emit(event);
    }
    let completion = new Promise<void>(resolve => { this.complete = resolve; });
    const abort = () => { void this.interrupt().catch(error => this.disconnected(error)); };
    signal.addEventListener('abort', abort, { once: true });
    try {
      if (options.liveInputMode === 'command' || options.liveInputMode === 'control') {
        for (const event of [...await this.command(options.prompt), ...this.drainCommands()]) emit(event);
        const startsGoal = this.goalActive && /^\/goal\s+(?!pause\b|clear\b|status\b|edit\b)/.test(options.prompt);
        const continuesTurn = Boolean(this.turnId || this.goalActive) && (/^\/?answer\s/.test(options.prompt) || /^\d+$/.test(options.prompt));
        if (!startsGoal && !continuesTurn) return;
        if (signal.aborted) await this.interrupt();
      } else {
        // Rejoining a running thread never replays its previous prompt or
        // starts a competing turn. Observe it until it finishes, then submit
        // this new user message once.
        if (this.turnId || this.goalActive) {
          await completion;
          if (signal.aborted) return;
          completion = new Promise<void>(resolve => { this.complete = resolve; });
        }
        this.phase = 'submitted';
        const input: Wire[] = [{ type: 'text', text: this.selectedSkill ? `$${this.selectedSkill.name}\n${options.prompt}` : options.prompt }];
        if (this.selectedSkill) { input.push({ type: 'skill', ...this.selectedSkill }); this.selectedSkill = undefined; }
        for (const path of options.images ?? []) input.push({ type: 'localImage', path });
        const result = await this.rpc.request('turn/start', {
          threadId: this.id,
          input,
          ...codexTurnPermissionOverrides(options.sandbox, options.cwd),
        });
        if (!this.finishedTurns.has(result.turn?.id)) this.turnId = result.turn?.id ?? this.turnId;
        if (signal.aborted) await this.interrupt();
      }
      await completion;
    } finally { signal.removeEventListener('abort', abort); this.emit = undefined; this.complete = undefined; }
  }
  setBrokerWriteAuthorization(authorization: WriteAuthorization | undefined): void {
    this.brokerTools?.setWriteAuthorization?.(authorization);
  }
  async refreshBrokerArtifactDelivery(
    artifact: ArtifactDeliveryEnv | undefined,
  ): Promise<void> {
    await this.brokerTools?.refreshArtifactDelivery?.(artifact);
  }
  async command(input: string): Promise<AgentEvent[]> {
    const [name, ...args] = input.trim().split(/\s+/);
    if (name === '/status') return [textEvent(JSON.stringify(await this.rpc.request('thread/read', { threadId: this.id, includeTurns: false }), null, 2))];
    if (name === '/goal') {
      const action = args[0];
      let result: Wire;
      if (!action || action === 'status') result = await this.rpc.request('thread/goal/get', { threadId: this.id });
      else if (action === 'clear') {
        result = await this.rpc.request('thread/goal/clear', { threadId: this.id });
        this.goalActive = false;
        this.lastGoalText = undefined;
      }
      else {
        const state = action === 'pause' ? 'paused' : 'active';
        const objective = input.trim().slice('/goal'.length).trim();
        result = await this.rpc.request('thread/goal/set', { threadId: this.id, ...(action === 'edit' ? {} : { status: state }),
          ...(['pause', 'resume'].includes(action) ? {} : { objective: action === 'edit' ? objective.slice('edit'.length).trimStart() : objective }) });
        this.goalActive = result.goal?.status === 'active';
        if (typeof result.goal?.objective === 'string' && result.goal.objective.trim()) {
          this.lastGoalText = result.goal.objective.trim().slice(0, 800);
        }
      }
      return [textEvent(JSON.stringify(result, null, 2))];
    }
    if (name === '/model') {
      const result = await this.rpc.request('model/list', { limit: 100 });
      const models: Wire[] = result.data ?? [];
      return [this.menu('选择模型', models.map(model => ({ label: model.displayName ?? model.id, apply: async () => {
        const efforts: Wire[] = model.supportedReasoningEfforts ?? [];
        if (!efforts.length) {
          await this.rpc.request('thread/settings/update', { threadId: this.id, model: model.id });
          return [textEvent(`模型已设置为 ${model.id}`)];
        }
        return [this.menu(`选择 ${model.id} 的推理强度`, efforts.map(effort => ({ label: effort.reasoningEffort, apply: async () => {
          await this.rpc.request('thread/settings/update', { threadId: this.id, model: model.id, effort: effort.reasoningEffort });
          return [textEvent(`模型已设置为 ${model.id} / ${effort.reasoningEffort}`)];
        } })))];
      } })))];
    }
    if (name === '/skills') {
      const result = await this.rpc.request('skills/list', {});
      const skills: Wire[] = (result.data ?? []).flatMap((item: Wire) => item.skills ?? []).filter((skill: Wire) => skill.enabled !== false);
      return [this.menu('选择下一条消息使用的 skill', skills.map(skill => ({ label: skill.name, apply: async () => {
        this.selectedSkill = { name: skill.name, path: skill.path }; return [textEvent(`下一条消息将使用 $${skill.name}`)];
      } })))];
    }
    if (name === '/compact') { await this.rpc.request('thread/compact/start', { threadId: this.id }); return [textEvent('已请求压缩上下文')]; }
    if (name === '/stop') { await this.interrupt(); return []; }
    const reply = /^\/?answer\s+(\S+)\s+([\s\S]+)$/.exec(input.trim());
    if (reply) { await this.answer(reply[1]!, reply[2]!); return []; }
    const number = /^(\d+)(?:\s+(?:enter|return|回车|确认))?$/iu.exec(input.trim());
    if (number && this.pending.size === 1) { await this.answer([...this.pending.keys()][0]!, number[1]!); return []; }
    throw new Error(`结构化后端不支持此控制命令：${input}。不会将它当普通提示词发送。`);
  }
  private menu(prompt: string, entries: Array<{ label: string; apply(): Promise<AgentEvent[]> }>): AgentEvent {
    if (!entries.length) return textEvent(`${prompt}：暂无可用选项`);
    for (const id of this.menus) this.pending.delete(id);
    this.menus.clear();
    const id = randomUUID();
    this.menus.add(id);
    const choices = new Map(entries.map((entry, index) => [String(index + 1), entry]));
    this.pending.set(id, { choices, respond: async value => {
      const entry = value as typeof entries[number];
      const events = await entry.apply();
      for (const event of events) this.commandEvents.push(event);
    } });
    this.phase = 'picker';
    return interactionEvent({ id, prompt, choices: entries.map((entry, index) => ({ label: entry.label, value: String(index + 1) })) });
  }
  private commandEvents: AgentEvent[] = [];
  drainCommands(): AgentEvent[] { return this.commandEvents.splice(0); }
  hasRequest(id: string): boolean { return this.pending.has(id); }
  pendingRequestCount(): number { return this.pending.size; }
  freeTextRequest(): string | undefined { const entry = [...this.pending][0]; return this.pending.size === 1 && entry?.[1].freeText ? entry[0] : undefined; }
  async answer(id: string, value: string): Promise<void> {
    const request = this.pending.get(id);
    if (!request) throw new Error('该请求已失效');
    const answer = request.choices.get(value) ?? (request.freeText ? value : undefined);
    if (answer === undefined) throw new Error('无效选项');
    await request.respond(answer); this.pending.delete(id); this.menus.delete(id);
    if (!this.pending.size) this.phase = this.turnId ? 'busy' : 'idle';
  }
  private async respondAcknowledged(id: string | number, result: unknown): Promise<void> {
    const key = String(id);
    let timer: NodeJS.Timeout | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        this.acknowledgements.set(key, { resolve, reject });
        timer = setTimeout(() => reject(new Error('审批回复尚未获得服务端确认；不会自动重发')), 10000);
        this.rpc.respond(id, result);
      });
    } finally { if (timer) clearTimeout(timer); this.acknowledgements.delete(key); }
  }
  /**
   * Stop whatever this thread is doing and report whether anything was
   * actually stopped. The local goal/turn bookkeeping can be stale (a side
   * conversation, a reconnect, or a goal started by the native TUI), so the
   * server is consulted before deciding that a `/stop` had nothing to do.
   */
  async interrupt(): Promise<boolean> {
    let acted = this.cancelRecovery();
    this.recoveryBlocked = true;
    try { await this.syncState(); } catch { /* keep local state */ }
    if (this.goalActive) {
      await this.rpc.request('thread/goal/set', { threadId: this.id, status: 'paused' });
      this.goalActive = false;
      acted = true;
    } else {
      try {
        const goal = await this.rpc.request('thread/goal/get', { threadId: this.id });
        if (goal.goal?.status === 'active') {
          await this.rpc.request('thread/goal/set', { threadId: this.id, status: 'paused' });
          acted = true;
        }
      } catch { /* older servers may not expose goals */ }
    }
    if (this.turnId) {
      await this.rpc.request('turn/interrupt', { threadId: this.id, turnId: this.turnId });
      acted = true;
    } else {
      try {
        const turns = await this.rpc.request('thread/turns/list', { threadId: this.id, limit: 1, sortDirection: 'desc' });
        const active = turns.data?.find((turn: Wire) => turn.status === 'inProgress');
        if (active) {
          await this.rpc.request('turn/interrupt', { threadId: this.id, turnId: active.id });
          acted = true;
        }
      } catch { /* an unmaterialized thread has no turns to list */ }
    }
    if (!this.turnId) {
      if (acted) this.emit?.({ type: 'done', terminationReason: 'interrupted' });
      this.finish();
    }
    return acted;
  }
  diagnostics(): LiveSessionDiagnostics { return { phase: this.goalActive && this.phase === 'idle' ? 'busy' : this.phase, inputState: this.turnId || this.goalActive || this.recoveryTimer || this.recoveryStarting || this.recoveryChecking ? 'submitted' : 'empty', retryCount: this.internalRetries + this.recoveryAttempts }; }
  steerCapability(): AgentSteerCapability {
    if (!this.isAlive()) {
      return { available: false, kind: 'run', reason: 'Codex App Server connection is closed' };
    }
    if (!this.turnId) {
      return { available: false, kind: 'run', reason: 'no active Codex turn to steer' };
    }
    if (this.phase === 'picker' || this.pending.size > 0 || this.menus.size > 0) {
      return {
        available: false,
        kind: 'terminal',
        reason: 'Codex is waiting for an interaction response',
      };
    }
    return { available: true };
  }
  async steer(request: AgentSteerRequest): Promise<AgentSteerResult> {
    const text = request.text.trim();
    if (!text) return { status: 'unavailable', reason: 'empty input' };
    const expectedTurnId = this.turnId;
    if (!expectedTurnId) return { status: 'unavailable', reason: 'no active turn' };
    try {
      const result = await this.rpc.request('turn/steer', {
        threadId: this.id,
        expectedTurnId,
        input: [{ type: 'text', text }],
        ...(request.clientUserMessageId
          ? { clientUserMessageId: request.clientUserMessageId }
          : {}),
      }, 20_000);
      if (typeof result.turnId !== 'string' || !result.turnId) {
        return {
          status: 'uncertain',
          reason: 'turn/steer response did not include a turn id',
        };
      }
      this.lastUserText = text.slice(0, 800);
      return { status: 'steered' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        /no active turn to steer|expected active turn id|cannot steer|input must not be empty|different output schema/iu
          .test(message)
      ) {
        return { status: 'unavailable', reason: message };
      }
      return { status: 'uncertain', reason: message };
    }
  }
  /** Bounded, redactable context for a /btw progress snapshot. */
  snapshot(): {
    threadId: string;
    cwd?: string;
    goalActive: boolean;
    goal?: string;
    turnId?: string;
    phase: string;
    lastUserText?: string;
    lastAssistantText?: string;
    lastToolStatus?: string;
  } {
    return {
      threadId: this.id,
      ...(this.lastCwd ? { cwd: this.lastCwd } : {}),
      goalActive: this.goalActive,
      ...(this.lastGoalText ? { goal: this.lastGoalText } : {}),
      ...(this.turnId ? { turnId: this.turnId } : {}),
      phase: this.phase,
      ...(this.lastUserText ? { lastUserText: this.lastUserText } : {}),
      ...(this.lastAssistantText ? { lastAssistantText: this.lastAssistantText } : {}),
      ...(this.lastToolStatus ? { lastToolStatus: this.lastToolStatus } : {}),
    };
  }
  async syncState(): Promise<void> {
    try {
      const result = await this.rpc.request('thread/goal/get', { threadId: this.id });
      const status = result.goal?.status;
      // A response without a status must not clear a goal that is active in
      // this session; only an explicit absent goal or a concrete status does.
      if (!result.goal) this.goalActive = false;
      else if (typeof status === 'string') this.goalActive = status === 'active';
      if (typeof result.goal?.objective === 'string' && result.goal.objective.trim()) {
        this.lastGoalText = result.goal.objective.trim().slice(0, 800);
      } else if (!result.goal) {
        this.lastGoalText = undefined;
      }
    }
    catch { /* Older servers may lack goals; ordinary turns remain available. */ }
    try {
      const result = await this.rpc.request('thread/turns/list', { threadId: this.id, limit: 1, sortDirection: 'desc' });
      const active = result.data?.find((turn: Wire) => turn.status === 'inProgress');
      if (active) { this.turnId = active.id; this.phase = 'busy'; }
    } catch { /* An unmaterialized new thread has no turns to list. */ }
  }
  async forkSide(cwd?: string): Promise<CodexStructuredSession> {
    // Match the native TUI's boundary, preserving the effective developer policy.
    // Never start a turn just to initialize side context.
    const config = await this.rpc.request('config/read', { ...(cwd ? { cwd } : {}) });
    const existing = config.config?.developer_instructions;
    if (existing != null && typeof existing !== 'string') throw new Error('Cannot preserve native developer instructions');
    const developerInstructions = [existing?.trim() ? existing : '', SIDE_DEVELOPER_INSTRUCTIONS].filter(Boolean).join('\n\n');
    // Ephemeral threads cannot carry goals. Do not combine them with
    // deferGoalContinuation or call goal/clear (both are rejected natively).
    const result = await this.rpc.request('thread/fork', { threadId: this.id, ephemeral: true, excludeTurns: true, developerInstructions });
    const id = result.thread?.id;
    if (typeof id !== 'string' || id === this.id) throw new Error('Side fork did not return a distinct identity');
    try {
      await this.rpc.request('thread/inject_items', { threadId: id, items: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: SIDE_BOUNDARY_PROMPT }] }] });
      return new CodexStructuredSession(id, this.endpoint, this.rpc);
    } catch (error) {
      await this.rpc.request('thread/unsubscribe', { threadId: id }).catch(() => {});
      throw error;
    }
  }
  async discardSide(): Promise<void> {
    await this.interrupt();
    await this.rpc.request('thread/unsubscribe', { threadId: this.id });
    await this.close();
  }
  async close(): Promise<void> {
    this.recoveryBlocked = true; this.cancelRecovery();
    await this.recoveryWork;
    this.toolAbort.abort();
    this.rpc.off('message', this.listener); this.rpc.off('disconnected', this.disconnected);
    for (const waiter of this.acknowledgements.values()) waiter.reject(new Error('Session closed'));
    this.acknowledgements.clear(); this.pending.clear(); this.menus.clear(); this.finish();
    await this.brokerTools?.close().catch(() => {});
  }
  disconnect(): void { this.rpc.close(); }
}

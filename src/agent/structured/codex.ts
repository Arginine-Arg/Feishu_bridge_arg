import { randomUUID } from 'node:crypto';
import type {
  AgentEvent,
  AgentRunOptions,
  AgentSteerCapability,
  AgentSteerRequest,
  AgentSteerResult,
  LiveSessionDiagnostics,
  ProviderRecoveryStatus,
} from '../types';
import { interactionEvent, textEvent, type StructuredSession } from './contracts';
import { RpcClient, type Wire } from './rpc';
import { SIDE_BOUNDARY_PROMPT, SIDE_DEVELOPER_INSTRUCTIONS } from './side-boundary';
import { codexTurnPermissionOverrides } from './permissions';
import type { BrokerToolHost, WriteAuthorization } from '../subagents/broker-tools';
import type { ArtifactDeliveryEnv } from '../lark-channel-env';
import { isTransientProviderError, providerRecoveryDelayMs, type ProviderRecoveryConfig } from '../../config/provider-recovery';
import { log, redactDiagnosticText } from '../../core/logger';
import { RecoveryLedger, type RecoveryPhase } from './recovery-ledger';
import { registerThreadHandoffClient } from './thread-handoff';

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
  private pendingRecoveryTurn?: string;
  private recoveryEpoch = 0;
  private recoveryStarting = false;
  private recoveryChecking = false;
  private recoveryWork: Promise<void> = Promise.resolve();
  private recoveryTurnIds = new Set<string>();
  private recoveryBlocked = false;
  private stopRequested = false;
  private recoveryEnabled = true;
  private recoverySettingVersion = 0;
  private internalRetries = 0;
  private providerError?: { turnId: string; error: Wire };
  private providerRetryTurns = new Set<string>();
  private readonly ledger: RecoveryLedger;
  private ledgerReady: Promise<void> = Promise.resolve();
  private recoveryEvents: Promise<void> = Promise.resolve();
  private deadlineTimer?: NodeJS.Timeout;
  private statusChecks = 0;
  private underlyingTurn: ProviderRecoveryStatus['underlyingTurn'] = 'terminal';
  private recoveryPhase: RecoveryPhase = 'normal';
  private lastActivityAt?: number;
  private lastEventAt?: number;
  private lastStatusNoticeAt = 0;
  private lastNotifiedPhase?: RecoveryPhase;
  private unregisterHandoff?: () => Promise<void>;
  private handoffBlocked = false;
  private lifecycleInitialized = false;
  private retryStallTimer?: NodeJS.Timeout;
  private workingStallTimer?: NodeJS.Timeout;
  private workingStallNoticeTurn?: string;
  private manualContinuationTurn?: string;
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
    private readonly recovery?: {
      policy: ProviderRecoveryConfig; providerIds: string[];
      enabled?: boolean; onEnabledChange?(enabled: boolean): Promise<void>;
    },
  ) {
    this.ledger = new RecoveryLedger(id);
    this.recoveryEnabled = recovery?.enabled ?? recovery?.policy.enabled !== false;
    this.listener = message => this.receive(message);
    rpc.on('message', this.listener);
    rpc.on('disconnected', this.disconnected);
  }
  async initializeLifecycle(codexHome: string, profile: string, generation = this.endpoint, canRelease?: () => void): Promise<void> {
    this.lifecycleInitialized = true;
    this.ledgerReady = this.ledger.persistIn(codexHome, generation);
    await this.ledgerReady;
    this.unregisterHandoff = await registerThreadHandoffClient({
      codexHome, threadId: this.id, endpoint: this.endpoint, profile,
      inspect: async () => {
        canRelease?.();
        if (this.emit || this.turnId || this.goalActive || this.pending.size || this.activeTools.size || this.recoveryStarting || this.recoveryChecking) throw new Error('Bot/relay 仍有任务、目标或交互');
        const result = await this.rpc.request('thread/read', { threadId: this.id, includeTurns: false }, 10_000);
        if (result.thread?.status?.type !== 'idle') throw new Error(`线程状态未确认空闲：${result.thread?.status?.type ?? 'unknown'}`);
      },
      release: async () => {
        this.handoffBlocked = true;
        this.cancelAutoRecovery();
        await this.recoveryWork;
        // Check again after blocking local inputs/recovery. A new diagnostic
        // connection cannot perform this unsubscribe on our behalf.
        const result = await this.rpc.request('thread/read', { threadId: this.id, includeTurns: false }, 10_000);
        if (result.thread?.status?.type !== 'idle') { this.handoffBlocked = false; throw new Error('交接期间线程已开始工作'); }
        await this.rpc.request('thread/unsubscribe', { threadId: this.id }, 10_000);
        await this.close();
        this.rpc.close();
      },
    });
  }
  /** False when the underlying App Server channel is gone and must be rebuilt. */
  isAlive(): boolean { return !this.rpc.closed; }
  /** Why the channel died, when it did. */
  get failureReason(): string | undefined { return this.rpc.failureReason?.message; }
  private disconnected = (error: Error) => {
    this.cancelRecovery();
    this.clearWorkingStall();
    for (const waiter of this.acknowledgements.values()) waiter.reject(error);
    this.acknowledgements.clear();
    this.phase = 'failed';
    this.underlyingTurn = 'unknown';
    this.notifyRecovery('status_unknown', true);
    this.emit?.({ type: 'pending', message: `${error.message}；底层 turn 状态未知，未重放输入。`, taskId: this.id });
    void this.ledger.release().catch(error => log.fail('agent', error, { step: 'recovery-owner-release' }));
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
    this.lastEventAt = Date.now();
    if (message.method === 'turn/started') {
      if (!p.turn?.id || this.finishedTurns.has(p.turn.id)) return;
      if (!this.recoveryStarting && !this.recoveryTurnIds.has(p.turn.id) && p.turn.id !== this.turnId) {
        this.cancelRecovery();
        // An externally-started turn supersedes old continuation callbacks.
        // Merely changing turnId in an automatic continuation does not reset
        // the persisted failure budget.
        // Other subscribers see our automatic turn/started notification too.
        // Only explicit user input may reset/invalidate the shared journal.
      }
      this.turnId = p.turn.id; this.phase = 'busy'; this.underlyingTurn = 'running';
      this.providerError = undefined;
      this.activeTools.clear();
      this.notifyRecovery('normal');
      this.armWorkingStall(p.turn.id);
    }
    if (message.method === 'error' && p.turnId === this.turnId) {
      this.providerError = { turnId: p.turnId, error: p.error ?? {} };
      if (p.willRetry === true) {
        this.internalRetries += 1;
        const first = !this.providerRetryTurns.has(p.turnId);
        this.providerRetryTurns.add(p.turnId);
        if (!first) {
          const expired = this.ledger.record.deadline !== undefined && Date.now() >= this.ledger.record.deadline;
          this.notifyRecovery(expired ? 'recovery_exhausted' : 'provider_retrying');
          if (!expired) this.watchRetryStall(p.turnId, p.error);
        }
        // A retry notice is not a terminal failure. No steer, queued input,
        // interrupt or competing turn/start is permitted here.
        if (first && isTransientProviderError(p.error)) {
          const epoch = this.recoveryEpoch;
          this.queueRecoveryEvent(async () => {
            if (epoch !== this.recoveryEpoch || !this.recoveryAllowed() || this.turnId !== p.turnId) return;
            if (await this.ledger.episode(this.recovery!.policy.budgetSeconds, redactDiagnosticText(p.error?.message ?? 'Provider reconnect'), p.turnId)) {
              if (epoch !== this.recoveryEpoch || !this.recoveryAllowed() || this.turnId !== p.turnId) return;
              this.armRecoveryDeadline();
              this.notifyRecovery('provider_retrying', true);
              this.watchRetryStall(p.turnId, p.error);
            } else this.notifyRecovery(this.ledger.record.phase);
          });
        }
      }
    }
    if (p.turnId === this.turnId && (
      ((message.method === 'item/agentMessage/delta' || message.method === 'item/reasoning/summaryTextDelta' || message.method === 'item/commandExecution/outputDelta') && typeof p.delta === 'string' && p.delta.trim()) ||
      ((message.method === 'item/started' || message.method === 'item/completed') && toolItems.has(p.item?.type))
    )) {
      this.lastActivityAt = Date.now();
      this.clearRetryStall();
      this.armWorkingStall(p.turnId);
      // Activity is observable; task success cannot be inferred from text or
      // periodic tool output. Neither activity nor heartbeats extend a budget.
      if (this.ledger.record.deadline !== undefined && Date.now() >= this.ledger.record.deadline) this.notifyRecovery('recovery_exhausted');
      else this.notifyRecovery(this.activeTools.size || toolItems.has(p.item?.type) ? 'tool_running' : 'normal');
    }
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
        this.queueRecoveryEvent(() => this.ledger.invalidate('goal_paused'));
        if (!this.turnId) { this.emit?.({ type: 'done', terminationReason: 'interrupted' }); this.finish(); }
      }
    }
    if (message.method === 'thread/goal/cleared') {
      this.goalActive = false;
      this.lastGoalText = undefined;
      this.cancelAutoRecovery();
      this.queueRecoveryEvent(() => this.ledger.invalidate('goal_cleared'));
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
      this.clearRetryStall();
      this.activeTools.clear();
      for (const item of p.turn.items ?? []) if (item.type === 'agentMessage') this.completeMessage(p.turn.id, item, true);
      for (const key of this.deltas.keys()) if (key.startsWith(`${p.turn.id}:`)) this.deltas.delete(key);
      this.finishedTurns.add(p.turn.id);
      if (this.finishedTurns.size > 100) this.finishedTurns.delete(this.finishedTurns.values().next().value!);
      this.turnId = undefined; this.phase = 'idle';
      this.providerRetryTurns.delete(p.turn.id);
      this.underlyingTurn = 'terminal';
      const manualContinuation = this.manualContinuationTurn === p.turn.id;
      if (manualContinuation) this.manualContinuationTurn = undefined;
      if (p.turn?.status === 'failed' && !manualContinuation) {
        const error = p.turn.error ?? (this.providerError?.turnId === p.turn.id ? this.providerError?.error : undefined);
        if (!this.scheduleRecovery(p.turn.id, error)) {
          this.cancelRecovery();
          this.emit?.({ type: 'error', message: error?.message ?? 'Codex turn failed', terminationReason: this.recoveryBlocked ? 'interrupted' : 'failed' }); this.finish();
        }
      }
      else {
        this.cancelRecovery();
        this.queueRecoveryEvent(() => p.turn.status === 'completed' ? this.ledger.reset('completed') : this.ledger.invalidate('interrupted'));
        this.notifyRecovery(p.turn.status === 'completed' ? 'normal' : 'stopped', true);
        if (!this.goalActive || p.turn.status === 'interrupted') {
          if (p.turn.status === 'interrupted' && !manualContinuation) this.emit?.({ type: 'done', terminationReason: 'interrupted' });
          if (!manualContinuation) this.finish();
        }
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
  private queueRecoveryEvent(work: () => Promise<void>): void {
    this.recoveryEvents = this.recoveryEvents.then(() => this.ledgerReady).then(work).catch(error => {
      this.cancelRecovery(); this.notifyRecovery('needs_attention', true);
      log.fail('agent', error, { step: 'provider-recovery-state' });
    });
  }
  private recoveryStatus(): ProviderRecoveryStatus {
    const state = this.ledger.record;
    return {
      state: this.recoveryPhase,
      lastActivityAt: this.lastActivityAt, lastEventAt: this.lastEventAt,
      lastError: state.lastError ?? this.providerError?.error.message,
      waitingReason: this.recoveryPhase === 'provider_retrying' ? 'Codex 原生重试；Bridge 未注入输入' :
        this.recoveryPhase === 'bridge_backoff' ? '等待退避和终态复核' :
        this.recoveryPhase === 'recovery_exhausted' ? '故障预算已用尽或不足以下次退避；等待人工处理，底层任务未被中断' :
        this.recoveryPhase === 'status_unknown' ? '状态查询不可用或本次有界监视已结束；底层任务未被中断' :
        this.recoveryPhase === 'needs_attention' ? state.blocked ?? '无法安全确认恢复结果' : undefined,
      attempts: state.attempts,
      budgetSeconds: this.recovery?.policy.budgetSeconds ?? 3600,
      usedSeconds: state.startedAt === undefined ? 0 : Math.max(0, Math.floor((Date.now() - state.startedAt) / 1000)),
      nextRecoveryAt: state.nextAt, underlyingTurn: this.underlyingTurn,
    };
  }
  private notifyRecovery(phase: RecoveryPhase, force = false): void {
    this.recoveryPhase = phase;
    if (!force && phase === this.lastNotifiedPhase && Date.now() - this.lastStatusNoticeAt < 60_000) return;
    this.lastStatusNoticeAt = Date.now(); this.lastNotifiedPhase = phase;
    this.emit?.({ type: 'recovery', status: this.recoveryStatus() });
  }
  private armRecoveryDeadline(): void {
    if (this.deadlineTimer) return;
    const deadline = this.ledger.record.deadline;
    if (deadline === undefined) return;
    this.deadlineTimer = setTimeout(() => {
      this.deadlineTimer = undefined;
      this.cancelRecovery();
      this.queueRecoveryEvent(() => this.ledger.waiting('recovery_exhausted'));
      this.notifyRecovery('recovery_exhausted', true);
      // A running native request is not killed to satisfy Bridge's deadline.
      if (!this.turnId && this.underlyingTurn === 'terminal') this.failRecovery();
    }, Math.max(0, deadline - Date.now()));
    this.deadlineTimer.unref?.();
  }
  private cancelRecovery(): boolean {
    const pending = Boolean(this.pendingRecoveryTurn || this.recoveryTimer || this.recoveryStarting || this.recoveryChecking);
    this.pendingRecoveryTurn = undefined;
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = undefined;
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    this.deadlineTimer = undefined;
    this.clearRetryStall();
    this.recoveryEpoch += 1;
    return pending;
  }
  cancelAutoRecovery(): void {
    this.recoveryBlocked = true; this.providerError = undefined;
    this.providerRetryTurns.clear(); this.cancelRecovery();
  }
  private recoveryAllowed(): boolean {
    const policy = this.recovery?.policy;
    return Boolean(policy && this.recoveryEnabled && !this.recoveryBlocked && !this.handoffBlocked && this.isAlive() &&
      (!policy.providers.length || this.recovery?.providerIds.some(id => policy.providers.includes(id))));
  }
  private clearRetryStall(): void {
    if (this.retryStallTimer) clearTimeout(this.retryStallTimer);
    this.retryStallTimer = undefined;
  }
  private clearWorkingStall(): void {
    if (this.workingStallTimer) clearTimeout(this.workingStallTimer);
    this.workingStallTimer = undefined;
  }
  private armWorkingStall(turnId: string): void {
    this.clearWorkingStall();
    this.workingStallNoticeTurn = undefined;
    const seconds = this.recovery?.policy.workingStallSeconds;
    if (!seconds || !this.recoveryAllowed()) return;
    const epoch = this.recoveryEpoch;
    const timer = setTimeout(() => {
      this.workingStallTimer = undefined;
      void this.checkWorkingStall(turnId, epoch);
    }, seconds * 1000);
    this.workingStallTimer = timer;
    timer.unref?.();
  }
  private async checkWorkingStall(turnId: string, epoch: number): Promise<void> {
    if (epoch !== this.recoveryEpoch || !this.recoveryAllowed() || this.turnId !== turnId ||
      this.pending.size || this.activeTools.size || this.workingStallNoticeTurn === turnId) return;
    try {
      const result = await this.rpc.request('thread/turns/list', { threadId: this.id, limit: 1, sortDirection: 'desc' }, this.recovery!.policy.statusTimeoutSeconds * 1000);
      if (epoch !== this.recoveryEpoch || this.turnId !== turnId) return;
      const latest = result.data?.[0];
      if (latest?.id !== turnId) return;
      if (latest.status === 'inProgress') {
        this.workingStallNoticeTurn = turnId;
        this.notifyRecovery('needs_attention', true);
        this.emit?.({ type: 'pending', taskId: this.id,
          message: '当前 turn 长时间没有文本或工具进展，底层仍报告 Working。未自动中断。确认没有副作用操作后，可发送 /recover continue。' });
      } else if (['failed', 'interrupted', 'completed'].includes(latest.status)) {
        this.receive({ method: 'turn/completed', params: { threadId: this.id, turn: latest } });
      }
    } catch (error) {
      this.notifyRecovery('status_unknown', true);
      log.warn('agent', 'working-stall-status-unavailable', { thread: this.id, reason: String(error) });
    }
  }
  private async manualContinue(): Promise<string> {
    if (this.handoffBlocked) throw new Error('线程正在交接 provider；未发送 continue');
    if (this.pending.size || this.activeTools.size) {
      throw new Error('当前有审批或工具正在执行；请先完成它，Bridge 不会强制 continue。');
    }
    await this.ledgerReady;
    let current = this.turnId;
    if (!current) {
      const result = await this.rpc.request('thread/turns/list', { threadId: this.id, limit: 1, sortDirection: 'desc' }, this.recovery?.policy.statusTimeoutSeconds ? this.recovery.policy.statusTimeoutSeconds * 1000 : 10_000);
      const latest = result.data?.[0];
      if (latest?.status === 'inProgress' && typeof latest.id === 'string') current = latest.id;
      else if (latest && !['failed', 'interrupted', 'completed'].includes(latest.status)) {
        throw new Error('无法确认当前 turn 已结束，未发送 continue。');
      }
    }
    if (current) {
      this.manualContinuationTurn = current;
      await this.rpc.request('turn/interrupt', { threadId: this.id, turnId: current }, this.recovery?.policy.statusTimeoutSeconds ? this.recovery.policy.statusTimeoutSeconds * 1000 : 10_000);
      const deadline = Date.now() + (this.recovery?.policy.statusTimeoutSeconds ?? 10) * 1000;
      for (;;) {
        const result = await this.rpc.request('thread/turns/list', { threadId: this.id, limit: 1, sortDirection: 'desc' }, Math.max(1, deadline - Date.now()));
        const latest = result.data?.[0];
        if (latest?.id === current && latest.status !== 'inProgress') {
          if (!this.finishedTurns.has(current)) this.receive({ method: 'turn/completed', params: { threadId: this.id, turn: latest } });
          break;
        }
        if (Date.now() >= deadline) {
          this.manualContinuationTurn = undefined;
          throw new Error('中断状态确认超时，未发送 continue。');
        }
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    }
    const operationId = 'arg-bridge-manual-continue-' + randomUUID();
    const started = await this.rpc.request('turn/start', {
      threadId: this.id, clientUserMessageId: operationId, input: [{ type: 'text', text: 'continue' }],
    }, this.recovery?.policy.statusTimeoutSeconds ? this.recovery.policy.statusTimeoutSeconds * 1000 : 10_000);
    if (!started.turn?.id) throw new Error('continue 已发送但服务端没有返回新的 turn ID，未自动重发');
    this.recoveryTurnIds.add(started.turn.id);
    this.turnId = started.turn.id;
    this.phase = 'busy';
    this.underlyingTurn = 'running';
    this.recoveryBlocked = false;
    this.stopRequested = false;
    this.armWorkingStall(started.turn.id);
    return '已安全中断当前 turn，并在同一会话发送 continue。';
  }
  /** A finite, non-overlapping metadata monitor. Never fetch full history. */
  private watchRetryStall(turnId: string, error: Wire): void {
    const policy = this.recovery?.policy;
    if (!policy?.retryStallSeconds || !this.recoveryAllowed() || this.retryStallTimer ||
      this.statusChecks >= policy.maxStatusChecks || this.activeTools.size || this.pending.size) return;
    const epoch = this.recoveryEpoch;
    const delay = Math.min(300, policy.retryStallSeconds * 2 ** Math.min(this.statusChecks, 3));
    this.retryStallTimer = setTimeout(() => {
      const timer = this.retryStallTimer;
      this.statusChecks += 1;
      void (async () => {
        const result = await this.rpc.request('thread/turns/list', { threadId: this.id, limit: 1, sortDirection: 'desc' }, policy.statusTimeoutSeconds * 1000);
        if (epoch !== this.recoveryEpoch || this.retryStallTimer !== timer || this.turnId !== turnId) return;
        const latest = result.data?.[0];
        if (latest?.id !== turnId) { this.notifyRecovery('status_unknown'); return; }
        if (['failed', 'interrupted', 'completed'].includes(latest.status)) {
          this.receive({ method: 'turn/completed', params: { threadId: this.id, turn: latest } });
        } else if (latest.status === 'inProgress') {
          this.underlyingTurn = 'running'; this.notifyRecovery('provider_retrying');
        } else this.notifyRecovery('status_unknown');
      })().catch(readError => {
        if (epoch !== this.recoveryEpoch) return;
        this.underlyingTurn = 'unknown'; this.notifyRecovery('status_unknown');
        log.warn('agent', 'provider-retry-state-unavailable', { thread: this.id, reason: String(readError) });
      }).finally(() => {
        if (this.retryStallTimer !== timer) return;
        this.clearRetryStall();
        if (epoch === this.recoveryEpoch && this.turnId === turnId) {
          if (this.statusChecks < policy.maxStatusChecks) this.watchRetryStall(turnId, error);
          else this.notifyRecovery('status_unknown', true);
        }
      });
    }, delay * 1000);
    this.retryStallTimer.unref?.();
  }
  private failRecovery(message?: string): void {
    this.cancelRecovery();
    if (this.underlyingTurn !== 'terminal') this.emit?.({ type: 'pending', message: message ?? '底层任务状态未知，自动恢复待人工确认。', taskId: this.id });
    else this.emit?.({ type: 'error', message: message ?? this.ledger.record.lastError ?? this.providerError?.error.message ?? 'Codex turn failed', terminationReason: this.recoveryBlocked ? 'interrupted' : 'failed' });
    this.finish();
  }
  private scheduleRecovery(failedTurnId: string, error: Wire | undefined): boolean {
    const policy = this.recovery?.policy;
    if (!policy || !this.recoveryAllowed() || this.pending.size || !isTransientProviderError(error)) return false;
    this.clearRetryStall();
    const epoch = this.recoveryEpoch;
    if (this.pendingRecoveryTurn === failedTurnId) return true;
    this.pendingRecoveryTurn = failedTurnId;
    const goalWasActive = this.goalActive;
    this.phase = 'busy';
    this.queueRecoveryEvent(async () => {
      if (epoch !== this.recoveryEpoch || !this.recoveryAllowed()) return;
      const owned = await this.ledger.episode(policy.budgetSeconds, redactDiagnosticText(error?.message ?? 'Codex turn failed'), failedTurnId);
      if (epoch !== this.recoveryEpoch || !this.recoveryAllowed()) return;
      if (!owned) {
        this.notifyRecovery(this.ledger.record.phase, true);
        // Another observer is the owner. This observer must not submit.
        if (this.ledger.record.owner && this.ledger.record.phase !== 'recovery_exhausted') {
          this.notifyRecovery('needs_attention', true);
          this.emit?.({ type: 'pending', taskId: this.id, message: `恢复由另一连接（PID ${this.ledger.record.owner.pid}）负责，未重复提交。请查看 /recover status。` });
          this.finish();
        } else this.failRecovery(error?.message);
        return;
      }
      this.armRecoveryDeadline();
      const operation = this.ledger.record.operations[failedTurnId];
      if (operation) {
        await this.reconcileRecovery(failedTurnId, operation.turnId, operation.id);
        return;
      }
      const delay = providerRecoveryDelayMs(policy, this.ledger.record.attempts + 1, error);
      const nextAt = Date.now() + delay;
      if (nextAt >= this.ledger.record.deadline! || (policy.maxAttempts > 0 && this.ledger.record.attempts >= policy.maxAttempts)) {
        await this.ledger.waiting('recovery_exhausted'); this.notifyRecovery('recovery_exhausted', true); this.failRecovery(error?.message); return;
      }
      await this.ledger.waiting('bridge_backoff', nextAt);
      if (epoch !== this.recoveryEpoch || !this.recoveryAllowed()) return;
      this.notifyRecovery('bridge_backoff', true);
      const ledgerEpoch = this.ledger.record.epoch;
      this.recoveryTimer = setTimeout(() => {
        this.recoveryTimer = undefined;
        this.pendingRecoveryTurn = undefined;
        const previous = this.recoveryWork;
        this.recoveryWork = previous.then(() => this.performRecovery(failedTurnId, error, epoch, ledgerEpoch, goalWasActive));
      }, delay);
      this.recoveryTimer.unref?.();
    });
    return true;
  }
  private async performRecovery(failedTurnId: string, error: Wire | undefined, epoch: number, ledgerEpoch: number, goalWasActive: boolean): Promise<void> {
    if (epoch !== this.recoveryEpoch || !this.recoveryAllowed()) return;
    let submitted = false;
    this.recoveryChecking = true;
    try {
      const result = await this.rpc.request('thread/turns/list', { threadId: this.id, limit: 1, sortDirection: 'desc' }, this.recovery!.policy.statusTimeoutSeconds * 1000);
      if (epoch !== this.recoveryEpoch || !this.recoveryAllowed() || this.turnId) return;
      if (this.pending.size || this.activeTools.size) { this.notifyRecovery('needs_attention', true); this.finish(); return; }
      const latest = result.data?.[0];
      if (latest?.id !== failedTurnId || latest.status !== 'failed') {
        if (latest?.status === 'inProgress') { this.turnId = latest.id; this.underlyingTurn = 'running'; this.notifyRecovery('normal'); }
        else { this.notifyRecovery('needs_attention', true); this.finish(); }
        return;
      }
      if (goalWasActive) {
        const goal = await this.rpc.request('thread/goal/get', { threadId: this.id }, this.recovery!.policy.statusTimeoutSeconds * 1000);
        if (epoch !== this.recoveryEpoch || !this.recoveryAllowed()) return;
        if (goal.goal?.status !== 'active') { await this.ledger.invalidate('goal_paused'); this.notifyRecovery('needs_attention', true); this.finish(); return; }
      }
      const operation = await this.ledger.reserve(failedTurnId, ledgerEpoch, this.recovery!.policy.maxAttempts);
      if (!operation) { this.notifyRecovery(this.ledger.record.phase, true); this.failRecovery(error?.message); return; }
      if (epoch !== this.recoveryEpoch || !this.recoveryAllowed()) return;
      await this.ledger.refresh();
      if (this.ledger.record.epoch !== ledgerEpoch || this.ledger.record.blocked || epoch !== this.recoveryEpoch || !this.recoveryAllowed()) return;
      this.recoveryStarting = true;
      this.recoveryChecking = false;
      submitted = true;
      const started = await this.rpc.request('turn/start', { threadId: this.id, clientUserMessageId: operation.id, input: [{ type: 'text', text: 'continue' }] });
      await this.ledger.acknowledge(failedTurnId, started.turn?.id);
      if (!started.turn?.id) throw new Error('turn/start 缺少确认 ID');
      this.recoveryTurnIds.add(started.turn.id);
      if (!this.finishedTurns.has(started.turn.id)) {
        this.turnId = started.turn.id; this.underlyingTurn = 'running'; this.phase = 'busy';
      }
      if (epoch !== this.recoveryEpoch && this.stopRequested && !this.finishedTurns.has(started.turn.id)) {
        await this.rpc.request('turn/interrupt', { threadId: this.id, turnId: started.turn.id });
      }
      // off/teardown leave an already accepted backend turn intact.
    } catch (failure) {
      if (epoch !== this.recoveryEpoch) return;
      if (submitted) {
        await this.ledger.acknowledge(failedTurnId);
        const op = this.ledger.record.operations[failedTurnId];
        await this.reconcileRecovery(failedTurnId, undefined, op?.id);
      } else {
        // This bounded wait ended pending/unknown. Do not secretly retry the
        // read or convert a connection outage into proof of terminal failure.
        this.underlyingTurn = 'unknown'; this.notifyRecovery('status_unknown', true);
        this.failRecovery(`状态核实未完成，恢复待人工确认：${failure instanceof Error ? failure.message : String(failure)}`);
      }
    } finally { this.recoveryStarting = false; this.recoveryChecking = false; }
  }
  private async reconcileRecovery(failedTurnId: string, turnId?: string, operationId?: string): Promise<void> {
    const epoch = this.recoveryEpoch;
    const deadline = Date.now() + this.recovery!.policy.statusTimeoutSeconds * 1000;
    // A just-accepted turn can temporarily appear as an empty interrupted
    // placeholder before Codex commits its input. Reconcile a bounded number
    // of metadata/item reads; never replay the turn/start mutation.
    for (let check = 0; check < 4 && Date.now() < deadline; check += 1) {
      try {
        const result = await this.rpc.request('thread/turns/list', { threadId: this.id, limit: 2, sortDirection: 'desc' }, Math.max(1, deadline - Date.now()));
        if (epoch !== this.recoveryEpoch) return;
        let accepted = result.data?.find((turn: Wire) => turn.id === turnId || turn.items?.some((item: Wire) => item.type === 'userMessage' && operationId && item.clientId === operationId));
        if (!accepted && operationId) {
          const candidate = result.data?.[0];
          if (candidate?.id && candidate.id !== failedTurnId) {
            const page = await this.rpc.request('thread/items/list', { threadId: this.id, turnId: candidate.id, limit: 1, sortDirection: 'asc' }, Math.max(1, deadline - Date.now()));
            if (epoch !== this.recoveryEpoch) return;
            const item = page.data?.[0]?.item ?? page.data?.[0];
            if (item?.type === 'userMessage' && item.clientId === operationId) accepted = candidate;
          }
        }
        if (accepted && accepted.id !== failedTurnId) {
          await this.ledger.acknowledge(failedTurnId, accepted.id);
          this.recoveryTurnIds.add(accepted.id);
          if (this.finishedTurns.has(accepted.id)) return;
          if (accepted.status === 'inProgress') { this.turnId = accepted.id; this.underlyingTurn = 'running'; this.notifyRecovery('normal'); return; }
          this.turnId = accepted.id;
          this.receive({ method: 'turn/completed', params: { threadId: this.id, turn: accepted } });
          return;
        }
      } catch { break; }
      if (check < 3) await new Promise(resolve => setTimeout(resolve, Math.min(250 * 2 ** check, Math.max(0, deadline - Date.now()))));
      if (epoch !== this.recoveryEpoch) return;
    }
    if (epoch !== this.recoveryEpoch) return;
    this.underlyingTurn = 'unknown';
    this.notifyRecovery('needs_attention', true);
    this.failRecovery('continue 提交结果未知；已保留操作标识，未重发。请检查 /recover status。');
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
    if (this.handoffBlocked) throw new Error('线程正在交接 provider；未发送输入');
    if (this.emit) throw new Error('Structured thread already has an active relay');
    if (this.recoveryStarting || this.recoveryChecking) throw new Error('自动恢复请求仍在确认结果，请稍后再发送新任务。');
    if (signal.aborted) return;
    this.cancelRecovery(); this.statusChecks = 0;
    if (!options.liveInputMode || /^\/goal\s+(?!pause\b|clear\b|status\b|edit\b)/.test(options.prompt)) {
      this.recoveryBlocked = false; this.stopRequested = false;
    }
    this.providerRetryTurns.clear();
    this.lastUserText = options.prompt.slice(0, 800);
    this.lastCwd = options.cwd;
    this.emit = emit;
    try {
      if (this.recovery || this.lifecycleInitialized) {
        await this.ledgerReady;
        if (!options.liveInputMode) await this.ledger.reset('user_input');
      }
    } catch (error) {
      this.emit = undefined;
      throw error;
    }
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
        if (!this.finishedTurns.has(result.turn?.id)) {
          this.turnId = result.turn?.id ?? this.turnId;
          if (this.turnId) this.underlyingTurn = 'running';
        }
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
    if (this.handoffBlocked) throw new Error('线程正在交接 provider；未发送控制请求');
    const [name, ...args] = input.trim().split(/\s+/);
    if (name === '/status') return [textEvent(JSON.stringify(await this.rpc.request('thread/read', { threadId: this.id, includeTurns: false }), null, 2))];
    if (name === '/recover') {
      const action = (args[0] ?? 'status').toLowerCase();
      if (action === 'continue' || action === 'retry') {
        return [textEvent(await this.manualContinue())];
      }
      if (action === 'on' || action === 'enable') {
        const version = ++this.recoverySettingVersion;
        await this.recovery?.onEnabledChange?.(true);
        if (version !== this.recoverySettingVersion) return [textEvent('恢复设置已被后续命令更新。')];
        this.recoveryEnabled = true;
        await this.ledgerReady;
        await this.ledger.enable();
        if (this.turnId && isTransientProviderError(this.providerError?.error)) {
          this.statusChecks = 0;
          this.armRecoveryDeadline();
          this.watchRetryStall(this.turnId, this.providerError!.error);
        }
        return [textEvent(`自动恢复已开启；保留原故障阶段的 ${this.recovery?.policy.budgetSeconds ? this.recovery.policy.budgetSeconds / 60 : 60} 分钟预算，不重置，也不续跑已停止的任务。`)];
      }
      if (action === 'off' || action === 'disable') {
        this.recoverySettingVersion += 1;
        this.recoveryEnabled = false;
        this.cancelRecovery();
        if (!this.turnId && !this.goalActive && !this.recoveryStarting) {
          this.phase = 'idle';
          this.emit?.({ type: 'done', terminationReason: 'interrupted' });
          this.finish();
        }
        await this.ledger.invalidate('off');
        this.notifyRecovery('disabled', true);
        await this.recovery?.onEnabledChange?.(false);
        return [textEvent('持续恢复已关闭；当前 Codex turn 会继续，但 Bridge 不再发送 continue。')];
      }
      if (action === 'status') {
        await this.ledgerReady;
        await this.ledger.refresh();
        const policy = this.recovery?.policy;
        return [textEvent(JSON.stringify({
          enabled: this.recoveryEnabled,
          providerAllowed: Boolean(policy && (!policy.providers.length || this.recovery?.providerIds.some(id => policy.providers.includes(id)))),
          ...this.recoveryStatus(),
          episodeDeadline: this.ledger.record.deadline ?? null,
          recoveryOwnerPid: this.ledger.record.owner?.pid ?? null,
          resetPolicy: 'on does not reset budget; only explicit new user work or successful completed turn resets',
          activeTurnContinueCount: 0,
        }, null, 2))];
      }
      throw new Error('用法：/recover on、/recover off、/recover status 或 /recover continue');
    }
    if (name === '/goal') {
      const action = args[0];
      if (['pause', 'clear', 'resume'].includes(action ?? '')) {
        this.cancelAutoRecovery();
        await this.ledger.invalidate('goal_' + action);
      }
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
      if (['pause', 'clear'].includes(action ?? '') && !this.turnId) {
        this.emit?.({ type: 'done', terminationReason: 'interrupted' }); this.finish();
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
    this.stopRequested = true;
    this.providerError = undefined;
    this.providerRetryTurns.clear();
    await this.ledgerReady;
    await this.ledger.invalidate('stop');
    this.notifyRecovery('stopped', true);
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
  diagnostics(): LiveSessionDiagnostics { return { phase: this.goalActive && this.phase === 'idle' ? 'busy' : this.phase, inputState: this.turnId || this.goalActive || this.recoveryTimer || this.recoveryStarting || this.recoveryChecking ? 'submitted' : 'empty', retryCount: this.internalRetries + this.ledger.record.attempts, recovery: this.recoveryStatus() }; }
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
    if (this.handoffBlocked) return { status: 'unavailable', reason: 'provider handoff in progress' };
    this.cancelRecovery();
    await this.ledgerReady;
    await this.ledger.reset('user_input');
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
    await this.ledgerReady;
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
      if (!Array.isArray(result.data)) return;
      const active = result.data?.find((turn: Wire) => turn.status === 'inProgress');
      if (active) {
        this.turnId = active.id; this.phase = 'busy'; this.underlyingTurn = 'running';
        this.armWorkingStall(active.id);
        if (this.ledger.record.startedAt !== undefined && !this.ledger.record.blocked && this.recoveryAllowed()) this.armRecoveryDeadline();
      } else {
        this.underlyingTurn = 'terminal';
        this.turnId = undefined;
        const latest = result.data?.[0];
        if (latest?.status === 'failed' && this.ledger.record.startedAt !== undefined && !this.ledger.record.blocked && !this.stopRequested) {
          const error = latest.error ?? { message: this.ledger.record.lastError };
          this.scheduleRecovery(latest.id, error);
        }
      }
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
    await this.unregisterHandoff?.(); this.unregisterHandoff = undefined;
    this.recoveryBlocked = true; this.cancelRecovery();
    await this.recoveryEvents;
    await this.recoveryWork;
    await this.ledgerReady;
    await this.ledger.release();
    this.toolAbort.abort();
    this.rpc.off('message', this.listener); this.rpc.off('disconnected', this.disconnected);
    for (const waiter of this.acknowledgements.values()) waiter.reject(new Error('Session closed'));
    this.acknowledgements.clear(); this.pending.clear(); this.menus.clear(); this.finish();
    await this.brokerTools?.close().catch(() => {});
  }
  disconnect(): void { this.rpc.close(); }
}

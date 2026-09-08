import { randomUUID } from 'node:crypto';
import type { AgentEvent, AgentRunOptions, LiveSessionDiagnostics } from '../types';
import { interactionEvent, textEvent, type StructuredSession } from './contracts';
import { RpcClient, type Wire } from './rpc';
import { SIDE_BOUNDARY_PROMPT, SIDE_DEVELOPER_INSTRUCTIONS } from './side-boundary';
import { codexTurnPermissionOverrides } from './permissions';

const toolItems = new Set(['commandExecution', 'fileChange', 'mcpToolCall', 'collabAgentToolCall', 'webSearch', 'imageGeneration', 'dynamicToolCall']);

export class CodexStructuredSession implements StructuredSession {
  private emit?: (event: AgentEvent) => void;
  private complete?: () => void;
  private turnId?: string;
  private phase: LiveSessionDiagnostics['phase'] = 'idle';
  private goalActive = false;
  private finishedTurns = new Set<string>();
  private selectedSkill?: { name: string; path: string };
  private pending = new Map<string, { choices: Map<string, unknown>; freeText?: boolean; respond(value: unknown): Promise<void> }>();
  private menus = new Set<string>();
  private deltas = new Map<string, string>();
  private acknowledgements = new Map<string, { resolve(): void; reject(error: Error): void }>();
  private deferredInteractions: AgentEvent[] = [];
  private usageTotal?: { inputTokens: number; outputTokens: number; cachedInputTokens: number };
  private readonly listener: (message: Wire) => void;
  constructor(readonly id: string, readonly endpoint: string, private readonly rpc: RpcClient) {
    this.listener = message => this.receive(message);
    rpc.on('message', this.listener);
    rpc.on('disconnected', this.disconnected);
  }
  private disconnected = (error: Error) => {
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
      } else {
        this.rpc.rejectRequest(message.id, 'Unsupported control request');
        this.emit?.(textEvent(`未实现的 Codex 控制请求：${message.method}\n`));
      }
      return;
    }
    if (message.method === 'turn/started') { this.turnId = p.turn?.id; this.phase = 'busy'; }
    if (message.method === 'item/agentMessage/delta') {
      const key = `${p.turnId}:${p.itemId}`;
      this.deltas.set(key, (this.deltas.get(key) ?? '') + p.delta);
      this.emit?.(textEvent(p.delta));
    }
    if (message.method === 'item/started' && toolItems.has(p.item?.type)) {
      this.emit?.({ type: 'tool_use', id: p.item.id, name: p.item.type, input: p.item.input ?? p.item.arguments ?? { command: p.item.command, cwd: p.item.cwd } });
    }
    if (message.method === 'item/completed') {
      const item = p.item ?? {};
      if (item.type === 'agentMessage') {
        const key = `${p.turnId}:${item.id}`;
        const sent = this.deltas.get(key) ?? '';
        if (typeof item.text === 'string' && item.text.startsWith(sent) && item.text.length > sent.length) this.emit?.(textEvent(item.text.slice(sent.length)));
        this.deltas.delete(key);
      }
      if (toolItems.has(item.type)) this.emit?.({ type: 'tool_result', id: item.id,
        output: item.aggregatedOutput ?? JSON.stringify(item.result ?? item.error ?? item.changes ?? ''),
        isError: item.status === 'failed' || (item.exitCode != null && item.exitCode !== 0) });
    }
    if (message.method === 'thread/goal/updated') {
      this.goalActive = p.goal?.status === 'active';
      if (!this.goalActive && !this.turnId) this.finish();
    }
    if (message.method === 'thread/goal/cleared') { this.goalActive = false; if (!this.turnId) this.finish(); }
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
      this.finishedTurns.add(p.turn.id);
      if (this.finishedTurns.size > 100) this.finishedTurns.delete(this.finishedTurns.values().next().value!);
      this.turnId = undefined; this.phase = 'idle';
      if (p.turn?.status === 'failed') { this.emit?.({ type: 'error', message: p.turn.error?.message ?? 'Codex turn failed', terminationReason: 'failed' }); this.finish(); }
      else if (!this.goalActive || p.turn?.status === 'interrupted') {
        if (p.turn?.status === 'interrupted') this.emit?.({ type: 'done', terminationReason: 'interrupted' });
        this.finish();
      }
    }
  }
  async submit(options: AgentRunOptions, emit: (event: AgentEvent) => void, signal: AbortSignal): Promise<void> {
    if (this.emit) throw new Error('Structured thread already has an active relay');
    if (signal.aborted) return;
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
  async command(input: string): Promise<AgentEvent[]> {
    const [name, ...args] = input.trim().split(/\s+/);
    if (name === '/status') return [textEvent(JSON.stringify(await this.rpc.request('thread/read', { threadId: this.id, includeTurns: false }), null, 2))];
    if (name === '/goal') {
      const action = args[0];
      let result: Wire;
      if (!action || action === 'status') result = await this.rpc.request('thread/goal/get', { threadId: this.id });
      else if (action === 'clear') { result = await this.rpc.request('thread/goal/clear', { threadId: this.id }); this.goalActive = false; }
      else {
        const state = action === 'pause' ? 'paused' : 'active';
        const objective = input.trim().slice('/goal'.length).trim();
        result = await this.rpc.request('thread/goal/set', { threadId: this.id, ...(action === 'edit' ? {} : { status: state }),
          ...(['pause', 'resume'].includes(action) ? {} : { objective: action === 'edit' ? objective.slice('edit'.length).trimStart() : objective }) });
        this.goalActive = result.goal?.status === 'active';
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
    if (/^\d+$/.test(input.trim()) && this.pending.size === 1) { await this.answer([...this.pending.keys()][0]!, input.trim()); return []; }
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
  async interrupt(): Promise<void> {
    if (this.goalActive) { await this.rpc.request('thread/goal/set', { threadId: this.id, status: 'paused' }); this.goalActive = false; }
    if (this.turnId) await this.rpc.request('turn/interrupt', { threadId: this.id, turnId: this.turnId });
    else this.finish();
  }
  diagnostics(): LiveSessionDiagnostics { return { phase: this.goalActive && this.phase === 'idle' ? 'busy' : this.phase, inputState: this.turnId || this.goalActive ? 'submitted' : 'empty', retryCount: 0 }; }
  async syncState(): Promise<void> {
    try { const result = await this.rpc.request('thread/goal/get', { threadId: this.id }); this.goalActive = result.goal?.status === 'active'; }
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
    this.rpc.off('message', this.listener); this.rpc.off('disconnected', this.disconnected);
    for (const waiter of this.acknowledgements.values()) waiter.reject(new Error('Session closed'));
    this.acknowledgements.clear(); this.pending.clear(); this.menus.clear(); this.finish();
  }
  disconnect(): void { this.rpc.close(); }
}

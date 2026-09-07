import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import type { query as sdkQuery, Query, Options, SDKUserMessage, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { AsyncEventQueue } from '../event-queue';
import { translateEvent } from '../claude/stream-json';
import type { AgentEvent, AgentRunOptions, LiveSessionDiagnostics } from '../types';
import { interactionEvent, textEvent, type StructuredSession } from './contracts';
import type { Wire } from './rpc';

export class ClaudeStructuredSession implements StructuredSession {
  private readonly input = new AsyncEventQueue<SDKUserMessage>();
  private readonly query: Query;
  private emit?: (event: AgentEvent) => void;
  private complete?: () => void;
  private failure?: Error;
  private phase: LiveSessionDiagnostics['phase'] = 'starting';
  private pending = new Map<string, { values: Set<string>; freeText?: boolean; answer(value: string): Promise<AgentEvent[]> }>();
  private menus = new Set<string>();
  private streamingMessages = new Set<string>();
  private streamingThinking = new Set<string>();
  private signal?: AbortSignal;
  private currentMessage = '';
  private sentText = false;
  private readonly reader: Promise<void>;
  private selectedSkill?: string;
  private model?: string;
  private cumulativeCost = 0;

  static async create(id: string, options: Options): Promise<ClaudeStructuredSession> {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    return new ClaudeStructuredSession(id, options, query);
  }
  constructor(readonly id: string, options: Options, query: typeof sdkQuery) {
    this.model = options.model;
    this.query = query({ prompt: this.input, options: {
      ...options,
      // The native preset restores Claude Code's own default instructions.
      // There is deliberately no appended Bridge system prompt.
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      settingSources: ['user', 'project', 'local'], includePartialMessages: true,
      canUseTool: async (tool, input, context) => {
        const id = context.toolUseID;
        if (tool === 'AskUserQuestion' && Array.isArray(input.questions)) return this.askQuestions(id, input, context.signal);
        return new Promise<PermissionResult>(resolve => {
          const cancel = () => { this.pending.delete(id); resolve({ behavior: 'deny', message: '操作已取消' }); };
          if (context.signal.aborted) { cancel(); return; }
          context.signal.addEventListener('abort', cancel, { once: true });
          this.pending.set(id, { values: new Set(['allow', 'deny']), answer: async value => {
            context.signal.removeEventListener('abort', cancel);
            resolve(value === 'allow' ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: '用户拒绝此操作' });
            return [];
          } });
          this.phase = 'picker';
          this.emit?.(interactionEvent({ id, prompt: `${context.title ?? tool}\n${JSON.stringify(input, null, 2)}`,
            choices: [{ label: '允许本次', value: 'allow' }, { label: '拒绝', value: 'deny' }] }));
        });
      },
    } });
    this.reader = this.consume();
  }
  async ready(): Promise<void> { await this.query.initializationResult(); this.phase = 'idle'; }
  private async consume(): Promise<void> {
    try {
      for await (const raw of this.query) {
        const event = raw as unknown as Wire;
        if (event.type === 'system' && event.subtype === 'init') this.model = event.model;
        if (event.parent_tool_use_id) continue;
        if (event.type === 'stream_event') {
          const partial = event.event ?? {};
          if (partial.type === 'message_start') this.currentMessage = partial.message.id;
          if (partial.type === 'content_block_delta' && partial.delta?.type === 'text_delta') {
            this.streamingMessages.add(this.currentMessage); this.sentText = true;
            this.emit?.(textEvent(partial.delta.text));
          }
          if (partial.type === 'content_block_delta' && partial.delta?.type === 'thinking_delta') {
            this.streamingThinking.add(this.currentMessage);
            this.emit?.({ type: 'thinking', delta: partial.delta.thinking });
          }
          continue;
        }
        if (event.type === 'result') {
          if (this.signal?.aborted) this.emit?.({ type: 'done', terminationReason: 'interrupted' });
          else if (event.subtype !== 'success' || event.is_error) this.emit?.({ type: 'error', message: event.result ?? (event.errors ?? []).join('\n') ?? 'Claude turn failed', terminationReason: 'failed' });
          else if (!this.sentText && event.result) this.emit?.(textEvent(event.result));
          for (const translated of translateEvent(event)) if (translated.type === 'usage') {
            const total = event.total_cost_usd;
            const costUsd = typeof total === 'number' ? (total >= this.cumulativeCost ? total - this.cumulativeCost : total) : undefined;
            this.emit?.({ ...translated, costUsd });
            if (typeof total === 'number') this.cumulativeCost = total;
          }
          this.phase = this.menus.size ? 'picker' : 'idle'; this.complete?.(); this.complete = undefined;
          for (const id of this.pending.keys()) if (!this.menus.has(id)) this.pending.delete(id);
          continue;
        }
        for (const translated of translateEvent(event)) {
          if (translated.type === 'text' && this.streamingMessages.has(event.message?.id)) continue;
          if (translated.type === 'thinking' && this.streamingThinking.has(event.message?.id)) continue;
          if (translated.type === 'text') this.sentText = true;
          this.emit?.(translated);
        }
      }
      throw new Error('Claude structured process ended');
    } catch (error) {
      this.failure = error instanceof Error ? error : new Error(String(error));
      this.phase = 'failed';
      this.emit?.({ type: 'error', message: this.failure.message, terminationReason: 'failed' });
      this.complete?.(); this.complete = undefined;
    }
  }
  async submit(options: AgentRunOptions, emit: (event: AgentEvent) => void, signal: AbortSignal): Promise<void> {
    if (this.failure) throw this.failure;
    if (this.emit) throw new Error('Claude session already has an active relay');
    if (signal.aborted) return;
    this.emit = emit; this.signal = signal; this.sentText = false; this.streamingMessages.clear(); this.streamingThinking.clear();
    emit({ type: 'system', sessionId: this.id, cwd: options.cwd });
    const done = new Promise<void>(resolve => { this.complete = resolve; });
    const abort = () => { void this.interrupt().catch(error => { this.emit?.({ type: 'error', message: String(error), terminationReason: 'failed' }); this.complete?.(); }); };
    signal.addEventListener('abort', abort, { once: true });
    try {
      if (options.liveInputMode === 'command' || options.liveInputMode === 'control') {
        for (const event of await this.command(options.prompt)) emit(event);
        return;
      }
      const content: any[] = [{ type: 'text', text: this.selectedSkill ? `/${this.selectedSkill} ${options.prompt}` : options.prompt }];
      this.selectedSkill = undefined;
      for (const path of options.images ?? []) {
        const mime = ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' } as Record<string, string>)[extname(path).toLowerCase()];
        if (!mime) throw new Error('Unsupported image format');
        content.push({ type: 'image', source: { type: 'base64', media_type: mime, data: await readFile(path, 'base64') } });
      }
      if (signal.aborted) return;
      this.phase = 'busy';
      this.input.push({ type: 'user', session_id: this.id, parent_tool_use_id: null, message: { role: 'user', content } });
      await done;
    } finally { signal.removeEventListener('abort', abort); this.emit = undefined; this.signal = undefined; this.complete = undefined; }
  }
  async command(input: string): Promise<AgentEvent[]> {
    if (input === '/status') return [textEvent(JSON.stringify({ sessionId: this.id, phase: this.phase, model: this.model }, null, 2))];
    if (input === '/model') {
      const models = await this.query.supportedModels();
      return [this.menu('选择 Claude 模型', models.map(model => ({ label: model.displayName, action: async () => { await this.query.setModel(model.value); this.model = model.value; return [textEvent(`模型已设置为 ${model.value}`)]; } })))];
    }
    if (input === '/skills') {
      const commands = await this.query.supportedCommands();
      return [this.menu('选择下一条消息使用的 skill', commands.map(command => ({ label: command.name, action: async () => { this.selectedSkill = command.name; return [textEvent(`下一条消息将使用 /${command.name}`)]; } })))];
    }
    const reply = /^\/?answer\s+(\S+)\s+([\s\S]+)$/.exec(input.trim());
    if (reply) { await this.answer(reply[1]!, reply[2]!); return this.drainCommands(); }
    if (/^\d+$/.test(input.trim()) && this.pending.size === 1) {
      const [id, request] = [...this.pending][0]!;
      const value = [...request.values][Number(input.trim()) - 1];
      if (!value) throw new Error('选项无效');
      await this.answer(id, value); return this.drainCommands();
    }
    throw new Error(`Claude 结构化后端暂不支持 ${input}；不会模拟 Codex 的 goal 或 side。`);
  }
  private menu(prompt: string, options: Array<{ label: string; action(): Promise<AgentEvent[]> }>): AgentEvent {
    if (!options.length) return textEvent(`${prompt}：暂无可用选项`);
    for (const id of this.menus) this.pending.delete(id);
    this.menus.clear();
    const id = randomUUID();
    this.menus.add(id);
    this.pending.set(id, { values: new Set(options.map((_, index) => String(index + 1))), answer: value => options[Number(value) - 1]!.action() });
    this.phase = 'picker';
    return interactionEvent({ id, prompt, choices: options.map((option, index) => ({ label: option.label, value: String(index + 1) })) });
  }
  private commandEvents: AgentEvent[] = [];
  drainCommands(): AgentEvent[] { return this.commandEvents.splice(0); }
  hasRequest(id: string): boolean { return this.pending.has(id); }
  freeTextRequest(): string | undefined { const entry = [...this.pending][0]; return this.pending.size === 1 && entry?.[1].freeText ? entry[0] : undefined; }
  async answer(id: string, value: string): Promise<void> {
    const request = this.pending.get(id);
    if (!request || (!request.freeText && !request.values.has(value))) throw new Error('选择已失效或选项无效');
    this.pending.delete(id); this.menus.delete(id); this.commandEvents.push(...await request.answer(value));
    this.phase = this.pending.size ? 'picker' : this.complete ? 'busy' : 'idle';
  }
  async interrupt(): Promise<void> { await this.query.interrupt(); }
  private askQuestions(id: string, input: Record<string, unknown>, signal: AbortSignal): Promise<PermissionResult> {
    const questions = input.questions as Wire[];
    if (!questions.length) return Promise.resolve({ behavior: 'deny', message: '没有可回答的问题' });
    return new Promise(resolve => {
      const ids = questions.map((_, index) => `${id}.q${index}`);
      const answers: Record<string, string> = {};
      const cancel = () => { for (const key of ids) this.pending.delete(key); resolve({ behavior: 'deny', message: '问题已取消' }); };
      if (signal.aborted) { cancel(); return; }
      signal.addEventListener('abort', cancel, { once: true });
      for (const [index, question] of questions.entries()) {
        const options: Wire[] = question.options ?? [];
        const key = ids[index]!;
        this.pending.set(key, { values: new Set(options.map((_, i) => String(i + 1))), freeText: true, answer: async value => {
          answers[question.question] = options[Number(value) - 1]?.label ?? value;
          if (Object.keys(answers).length === questions.length) {
            signal.removeEventListener('abort', cancel);
            resolve({ behavior: 'allow', updatedInput: { ...input, answers } });
          }
          return [];
        } });
        this.phase = 'picker';
        this.emit?.(interactionEvent({ id: key, prompt: `${question.question}\n也可用 /answer ${key} 正文 自由回答。`,
          choices: options.map((option, i) => ({ label: option.label, value: String(i + 1) })) }));
      }
    });
  }
  diagnostics(): LiveSessionDiagnostics { return { phase: this.phase, inputState: this.complete ? 'submitted' : 'empty', retryCount: 0 }; }
  async close(): Promise<void> { this.input.close(); this.query.close(); await this.reader; }
}

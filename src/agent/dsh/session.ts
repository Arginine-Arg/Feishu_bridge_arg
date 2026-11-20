import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import {
  ClientSideConnection, PROTOCOL_VERSION, ndJsonStream,
  type PromptRequest, type RequestPermissionRequest, type RequestPermissionResponse, type SessionNotification,
} from '@agentclientprotocol/sdk';
import { spawnProcess } from '../../platform/spawn';
import { redactDiagnosticText, log } from '../../core/logger';
import { sanitizeAgentEnv } from '../../platform/network-env';
import type { DshConfig, NetworkConfig } from '../../config/profile-schema';
import type { CodexSandboxMode } from '../../config/permissions';
import { withArtifactDeliveryEnv } from '../lark-channel-env';
import type { AgentEvent, AgentRunOptions, LiveSessionDiagnostics } from '../types';
import { interactionEvent, textEvent, type StructuredSession } from '../structured/contracts';
import { dshProfilePatch, resolveDshProvider, type DshProvider } from './provider';
import { readDshSessionModel, saveDshSessionModel } from './model-state';
import { openDshBrokerMcp } from './broker-mcp';
import type { BrokerToolHost } from '../subagents/broker-tools';

interface DshSessionOptions {
  config: DshConfig;
  loadConfig?(): Promise<DshConfig | undefined>;
  cwd: string;
  home: string;
  env: NodeJS.ProcessEnv;
  network?: NetworkConfig;
  sandbox?: CodexSandboxMode;
  sessionId?: string;
  onSessionId(id: string): Promise<void>;
  loadModel(provider: string): Promise<string | undefined>;
  saveModel(provider: string, model?: string): Promise<void>;
  broker?(options: AgentRunOptions): Promise<{
    namespace: string;
    controller(id: string): Promise<BrokerToolHost>;
    release?(controller: BrokerToolHost): void;
  } | undefined>;
  closeBroker?(): Promise<void>;
}

const START_TIMEOUT = 20_000;
const CANCEL_GRACE = 8_000;
const MAX_APPROVAL_LABEL = 180;
const IMAGE_MIMES: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
};

export class DshStructuredSession implements StructuredSession {
  private sessionId: string | undefined;
  private active?: { cancel(): Promise<void> };
  private approval = new Map<string, {
    request: RequestPermissionRequest;
    finish: (response: RequestPermissionResponse) => void;
  }>();
  private lastError?: string;
  private provider?: { id: string; model: string };
  private lastAssistantText?: string;
  private lastUserText?: string;
  private closed = false;
  constructor(private readonly settings: DshSessionOptions) {
    this.sessionId = settings.sessionId;
  }

  get id(): string { return this.sessionId ?? ''; }

  diagnostics(): LiveSessionDiagnostics {
    return {
      phase: this.approval.size ? 'picker' : this.active ? 'busy' : 'idle',
      inputState: this.active ? 'submitted' : 'empty',
      retryCount: 0,
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  snapshot() {
    return { sessionId: this.sessionId, cwd: this.settings.cwd,
      lastUserText: this.lastUserText, lastAssistantText: this.lastAssistantText };
  }

  hasRequest(id: string): boolean { return this.approval.has(id); }
  pendingRequestCount(): number { return this.approval.size; }
  freeTextRequest(): undefined { return undefined; }

  async answer(id: string, value: string): Promise<void> {
    const pending = this.approval.get(id);
    if (!pending) throw new Error('审批已失效，请使用当前审批卡片。');
    const option = pending.request.options.find(item => item.optionId === value);
    if (!option || (option.kind !== 'allow_once' && option.kind !== 'reject_once')) {
      throw new Error('请选择审批卡片中的允许一次或拒绝。');
    }
    this.approval.delete(id);
    pending.finish({ outcome: { outcome: 'selected', optionId: option.optionId } });
  }

  async command(input: string): Promise<AgentEvent[]> {
    const [command, ...parts] = input.trim().split(/\s+/u);
    switch (command?.toLowerCase()) {
      case '/answer': {
        if (parts.length !== 2) throw new Error('使用 /answer <request-id> <option>');
        await this.answer(parts[0]!, parts[1]!);
        return [textEvent('已提交审批选择。')];
      }
      case '/status':
        return [textEvent([
          'DeepSeek Harness',
          `会话 ${this.id || '尚未开始'}`,
          `工作目录 ${this.settings.cwd}`,
          `状态 ${this.diagnostics().phase}`,
          ...(this.provider ? [`正在使用 ${this.provider.id} / ${this.provider.model}`] : []),
        ].join('\n'))];
      case '/stop':
        return [textEvent(await this.interrupt() ? '已停止 DeepSeek Harness 任务。' : '当前没有运行中的任务。')];
      case '/recover':
        return [textEvent('DeepSeek Harness 请用 /stop 停止任务，确认结束后再发一条消息继续当前会话。')];
      case '/model': {
        const config = await this.settings.loadConfig?.() ?? this.settings.config;
        const provider = await resolveDshProvider(config, this.settings.env, true);
        const active = await this.settings.loadModel(provider.id) ?? provider.model;
        if (!parts.length) {
          return [textEvent([
            `${provider.name} · 下一轮模型 ${active}`,
            ...provider.models.map(model => `- \`${model}\``),
            '使用 /model <模型名>，或 /model default 恢复账号默认。',
          ].join('\n'))];
        }
        if (parts.length !== 1 || (parts[0] !== 'default' && !provider.models.includes(parts[0]!))) {
          throw new Error('模型不在当前 provider 的目录里。请用 /model 查看可选模型。');
        }
        const model = parts[0] === 'default' ? undefined : parts[0];
        await this.settings.saveModel(provider.id, model);
        return [textEvent(`DeepSeek Harness 下一轮将使用 ${model ?? provider.model}。`)];
      }
      case '/help':
        return [textEvent('DeepSeek Harness 控制命令\n/status · /model [模型] · /stop · /answer · /btw')];
      default:
        throw new Error(`DeepSeek Harness 的 ACP 接口没有公开 ${command}。输入 /help 可查看可用控制命令。`);
    }
  }

  async submit(options: AgentRunOptions, emit: (event: AgentEvent) => void, signal: AbortSignal): Promise<void> {
    if (this.closed) throw new Error('DeepSeek Harness 会话已关闭');
    if (options.liveInputMode) {
      for (const event of await this.command(options.prompt)) emit(event);
      return;
    }
    if (this.active) throw new Error('DeepSeek Harness 会话已有运行中的任务');
    if (signal.aborted) return;
    const controller = new AbortController();
    const signalToStop = AbortSignal.any([signal, controller.signal]);
    let finish!: () => void;
    const finished = new Promise<void>(resolve => { finish = resolve; });
    this.active = { cancel: async () => { controller.abort(); await finished; } };
    this.lastError = undefined;
    this.lastUserText = options.prompt;
    this.lastAssistantText = undefined;
    try {
      const config = await this.settings.loadConfig?.() ?? this.settings.config;
      const provider = await resolveDshProvider(config, this.settings.env);
      const model = await this.settings.loadModel(provider.id) ?? options.model ?? provider.model;
      const env = await sanitizeAgentEnv(this.settings.env, this.settings.network, { thirdPartyProvider: provider.thirdParty });
      if (signalToStop.aborted) return;
      this.provider = { id: provider.id, model };
      const result = await this.runTurn(provider, model, withArtifactDeliveryEnv(env, options.artifactDelivery),
        options, emit, signalToStop, config.binaryPath);
      emit({ type: 'done', sessionId: this.sessionId, terminationReason: result });
    } catch (error) {
      if (signalToStop.aborted) {
        emit({ type: 'done', sessionId: this.sessionId, terminationReason: 'interrupted' });
        return;
      }
      const message = redactDiagnosticText(error instanceof Error ? error.message : String(error));
      this.lastError = message;
      throw new Error(message);
    } finally {
      this.cancelApprovals();
      this.active = undefined;
      finish();
    }
  }

  async interrupt(): Promise<boolean> {
    if (!this.active) return false;
    await this.active.cancel();
    return true;
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.interrupt();
    await this.settings.closeBroker?.();
  }

  private async runTurn(
    provider: DshProvider, model: string, env: NodeJS.ProcessEnv, options: AgentRunOptions,
    emit: (event: AgentEvent) => void, signal: AbortSignal, binary: string,
  ): Promise<'normal' | 'interrupted'> {
    const directory = await mkdtemp(join(tmpdir(), 'arg-bridge-dsh-'));
    let mcp: Awaited<ReturnType<typeof openDshBrokerMcp>> | undefined;
    let controller: Promise<BrokerToolHost> | undefined;
    let broker: Awaited<ReturnType<NonNullable<DshSessionOptions['broker']>>>;
    try {
      const patch = join(directory, 'bridge.yml');
      const previousModel = this.sessionId ? await readDshSessionModel(this.settings.home, this.sessionId) : undefined;
      await writeFile(patch, dshProfilePatch(provider, model, previousModel), { mode: 0o600 });
      await mkdir(this.settings.home, { recursive: true, mode: 0o700 });
      const turnBroker = await this.settings.broker?.(options);
      broker = turnBroker;
      if (turnBroker) {
        mcp = await openDshBrokerMcp({ namespace: turnBroker.namespace, signal,
          controller: async () => {
            if (!this.sessionId || signal.aborted) throw new Error('DeepSeek Harness has no active session');
            return controller ??= turnBroker.controller(this.sessionId);
          },
        });
      }
      if (signal.aborted) return 'interrupted';
      const child = spawnProcess(binary, ['--profile', 'acp', '--patch', patch], {
        cwd: this.settings.cwd,
        env: { ...env, ...provider.env, DSH_HOME: this.settings.home, DSH_TELEMETRY_DISABLED: '1',
          DSH_PERMISSION_MODE: options.sandbox ?? this.settings.sandbox ?? 'workspace-write' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const exited = new Promise<Error>(resolve => {
        child.once('error', error => resolve(error));
        child.once('close', (code, killedBy) => resolve(new Error(
          `DeepSeek Harness ACP 已退出 (${killedBy ?? code ?? 'unknown'})，请用原会话重试。`,
        )));
      });
      const streamFailure = exited.then(error => { throw error; });
      void streamFailure.catch(() => {});
      child.stderr?.resume();
      child.stdin?.on('error', () => {});
      let promptInFlight = false;
      let sessionId: string | undefined;
      let cancelTimer: NodeJS.Timeout | undefined;
      let cancel: (() => void) | undefined;
      const tools = new Map<string, { title: string; input: unknown }>();
      const connection = new ClientSideConnection(() => ({
        sessionUpdate: async update => {
          if (!promptInFlight || update.sessionId !== sessionId) return;
          const event = update.update;
          if (event.sessionUpdate === 'tool_call') {
            tools.set(event.toolCallId, { title: event.title, input: event.rawInput });
          } else if (event.sessionUpdate === 'tool_call_update' && (event.status === 'completed' || event.status === 'failed')) {
            tools.delete(event.toolCallId);
          }
          this.onUpdate(update, emit);
        },
        requestPermission: async request => {
          if (!promptInFlight || request.sessionId !== sessionId || signal.aborted) {
            return { outcome: { outcome: 'cancelled' } };
          }
          const tool = tools.get(request.toolCall.toolCallId);
          if (!tool || requestsSandboxEscalation(tool.input)) {
            const reject = request.options.find(option => option.kind === 'reject_once');
            return { outcome: reject ? { outcome: 'selected', optionId: reject.optionId } : { outcome: 'cancelled' } };
          }
          return this.ask(request, tool.title, emit);
        },
      }), ndJsonStream(Writable.toWeb(child.stdin!), Readable.toWeb(child.stdout!)));
      const request = async <T>(method: string, op: Promise<T>, ms?: number) => {
        try { return await bounded(Promise.race([op, streamFailure]), ms); }
        catch (error) {
          const data = (error as { data?: { details?: unknown } })?.data?.details;
          const detail = typeof data === 'string' ? data : error instanceof Error ? error.message : String(error);
          const message = Object.values(provider.env).reduce((value, secret) => value.split(secret).join('[REDACTED]'), detail);
          throw new Error(`DeepSeek Harness ${method}: ${message}`);
        }
      };
      try {
        cancel = () => {
          this.cancelApprovals();
          if (sessionId && promptInFlight) void connection.cancel({ sessionId }).catch(() => {});
          cancelTimer ??= setTimeout(() => child.kill('SIGTERM'), CANCEL_GRACE);
        };
        signal.addEventListener('abort', cancel, { once: true });
        if (signal.aborted) return 'interrupted';
        const info = await request('initialize', connection.initialize({
          protocolVersion: PROTOCOL_VERSION,
          clientInfo: { name: 'arg-bridge', version: '1' },
          clientCapabilities: {},
        }), START_TIMEOUT);
        if (!info.agentCapabilities?.sessionCapabilities?.close) throw new Error('当前 DSH 版缺少 ACP 会话关闭支持');
        const mcpServers = mcp ? [mcp.descriptor] : [];
        let configOptions;
        if (this.sessionId) {
          const resumed = await request('session/resume', connection.resumeSession({ sessionId: this.sessionId, cwd: this.settings.cwd, mcpServers }), START_TIMEOUT);
          configOptions = resumed.configOptions;
          sessionId = this.sessionId;
        } else {
          const created = await request('session/new', connection.newSession({ cwd: this.settings.cwd, mcpServers }), START_TIMEOUT);
          configOptions = created.configOptions;
          sessionId = created.sessionId;
          await this.settings.onSessionId(created.sessionId);
          this.sessionId = created.sessionId;
        }
        const modelSelection = JSON.stringify([provider.route, model]);
        if (!configOptions?.some(option => option.id === 'model' && option.type === 'select' && option.currentValue === modelSelection)) {
          const updated = await request('session/set_config_option', connection.setSessionConfigOption({ sessionId, configId: 'model', value: modelSelection }), START_TIMEOUT);
          if (!updated.configOptions.some(option => option.id === 'model' && option.type === 'select' && option.currentValue === modelSelection)) {
            throw new Error('DeepSeek Harness 未确认所选模型');
          }
        }
        await saveDshSessionModel(this.settings.home, sessionId, model);
        emit({ type: 'system', sessionId, cwd: this.settings.cwd, model });
        if (signal.aborted) return 'interrupted';
        const prompt: PromptRequest['prompt'] = [{ type: 'text', text: options.prompt }];
        if (options.images?.length) {
          if (!info.agentCapabilities.promptCapabilities?.image) throw new Error('当前 DeepSeek Harness 模型未声明图片输入支持');
          for (const path of options.images) {
            const mimeType = IMAGE_MIMES[extname(path).toLowerCase()];
            if (!mimeType) throw new Error('图片格式需为 PNG、JPEG、GIF 或 WebP');
            prompt.push({ type: 'image', mimeType, data: (await readFile(path)).toString('base64') });
          }
        }
        if (signal.aborted) return 'interrupted';
        promptInFlight = true;
        const result = await request('session/prompt', connection.prompt({ sessionId, prompt }));
        return signal.aborted || result.stopReason === 'cancelled' ? 'interrupted' : 'normal';
      } catch (error) {
        if (/already owned|already active|already locked|session.*held/i.test(String(error))) {
          throw new Error(`DeepSeek Harness 会话 ${this.sessionId ?? ''} 已有写入客户端。关闭该客户端后可以继续原会话。`);
        }
        throw error;
      } finally {
        promptInFlight = false;
        this.cancelApprovals();
        if (cancel) signal.removeEventListener('abort', cancel);
        if (cancelTimer) clearTimeout(cancelTimer);
        if (sessionId) {
          try { await request('session/close', connection.closeSession({ sessionId }), 5_000); }
          catch { log.warn('agent', 'dsh-close-failed', { sessionId }); }
        }
        child.stdin?.end();
        await bounded(exited, 2_000).catch(async () => {
          child.kill('SIGTERM');
          await bounded(exited, 3_000).catch(async () => {
            child.kill('SIGKILL');
            await exited;
          });
        });
      }
    } finally {
      await mcp?.close().catch(() => {});
      await controller?.then(host => broker?.release ? broker.release(host) : host.close()).catch(() => {});
      await rm(directory, { recursive: true, force: true }).catch(() => {});
    }
  }

  private ask(request: RequestPermissionRequest, title: string, emit: (event: AgentEvent) => void): Promise<RequestPermissionResponse> {
    const id = randomUUID();
    const choices = request.options.filter(option => option.kind === 'allow_once' || option.kind === 'reject_once');
    if (!choices.length) return Promise.resolve({ outcome: { outcome: 'cancelled' } });
    return new Promise(finish => {
      this.approval.set(id, { request, finish });
      emit(interactionEvent({
        id,
        prompt: `DeepSeek Harness 请求审批 ${redactDiagnosticText(request.toolCall.title ?? title).slice(0, MAX_APPROVAL_LABEL)}`,
        choices: choices.map(option => ({ label: option.name, value: option.optionId })),
      }));
    });
  }

  private cancelApprovals(): void {
    for (const pending of this.approval.values()) pending.finish({ outcome: { outcome: 'cancelled' } });
    this.approval.clear();
  }

  private onUpdate(note: SessionNotification, emit: (event: AgentEvent) => void): void {
    const { update } = note;
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        if (update.content.type === 'text') {
          this.lastAssistantText = ((this.lastAssistantText ?? '') + update.content.text).slice(-8_000);
          emit(textEvent(update.content.text));
        }
        break;
      case 'agent_thought_chunk':
        if (update.content.type === 'text') emit({ type: 'thinking', delta: update.content.text });
        break;
      case 'tool_call':
        emit({ type: 'tool_use', id: update.toolCallId, name: update.title, input: update.rawInput });
        break;
      case 'tool_call_update':
        if (update.status === 'completed' || update.status === 'failed') {
          const output = update.content?.flatMap(entry =>
            entry.type === 'content' && entry.content.type === 'text' ? [entry.content.text] : []).join('\n') ?? '';
          emit({ type: 'tool_result', id: update.toolCallId, output, isError: update.status === 'failed' });
        }
        break;
    }
  }
}

function requestsSandboxEscalation(input: unknown): boolean {
  return Boolean(input && typeof input === 'object' && Object.hasOwn(input, 'sandbox_permissions'));
}

async function bounded<T>(operation: Promise<T>, ms?: number): Promise<T> {
  if (ms === undefined) return operation;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('DeepSeek Harness ACP 请求超时')), ms);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

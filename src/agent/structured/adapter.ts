import { createHash, randomUUID } from 'node:crypto';
import { readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { AsyncEventQueue } from '../event-queue';
import type { AgentAdapter, AgentEvent, AgentRun, AgentRunOptions } from '../types';
import { checkAgentAvailability } from '../preflight';
import { ensureBundledCodexSkill } from '../bundled-skill';
import { captureTmuxPaneTail, type AgentTmuxControl } from '../tmux-control';
import { buildLarkChannelEnv, withArtifactDeliveryEnv, type LarkChannelEnvContext } from '../lark-channel-env';
import { writeFileAtomic } from '../../platform/atomic-write';
import { connectCodexHost } from './host';
import { CodexStructuredSession } from './codex';
import { ClaudeStructuredSession } from './claude';
import type { StructuredSession } from './contracts';
import { textEvent } from './contracts';
import { StructuredView } from './view';
import { RpcClient } from './rpc';
import type { TmuxBindingStatus } from '../tmux-control';

interface ScopeSession { main: StructuredSession; view: StructuredView; side?: CodexStructuredSession; sideView?: StructuredView; cwd: string }
export interface StructuredAdapterOptions {
  kind: 'codex' | 'claude'; binary: string; profileDir: string; codexHome?: string;
  larkChannel?: LarkChannelEnvContext; nativeView?: boolean;
}

export class StructuredAdapter implements AgentAdapter {
  readonly id: 'codex' | 'claude';
  readonly displayName: string;
  readonly tmux: AgentTmuxControl;
  private sessions = new Map<string, ScopeSession>();
  private starting = new Map<string, Promise<ScopeSession>>();
  constructor(private readonly options: StructuredAdapterOptions) {
    this.id = options.kind;
    this.displayName = options.kind === 'codex' ? 'Codex App Server' : 'Claude Agent SDK';
    this.tmux = {
      list: async () => [],
      bind: async () => { throw new Error('结构化后端不绑定旧终端；请使用该会话的 /tmux attach'); },
      unbind: async () => false,
      status: async (scope, cwd) => {
        const current = this.sessions.get(scope);
        return (current?.sideView ?? current?.view)?.status() ?? (cwd ? (await this.saved(scope, cwd))?.view : undefined) ?? { state: 'none' };
      },
      diagnostics: async scope => {
        const current = this.sessions.get(scope);
        return { ...(current?.side ?? current?.main)?.diagnostics() ?? { phase: 'idle', inputState: 'unknown', retryCount: 0 }, sideConversation: Boolean(current?.side) };
      },
      tail: async (scope, lines, cwd) => {
        const status = await this.tmux.status(scope, cwd);
        if (!status.terminal) throw new Error('当前会话尚未建立终端显示');
        return captureTmuxPaneTail(status.terminal, lines);
      },
      interrupt: async (scope, cwd, options) => {
        const current = this.sessions.get(scope);
        if (options?.sideOnly && !current?.side) return false;
        if (current) { await (current.side ?? current.main).interrupt(); return true; }
        if (this.id !== 'codex' || !cwd) return false;
        const saved = await this.saved(scope, cwd);
        if (!saved?.endpoint?.startsWith('unix://')) return false;
        // A stop must never start a new server or resurrect a dormant thread.
        const rpc = await RpcClient.connect(`ws+unix://${saved.endpoint.slice('unix://'.length)}:/`);
        try {
          await rpc.initialize();
          const loaded = await rpc.request('thread/loaded/list', {});
          if (!loaded.data?.includes(saved.id)) return false;
          const session = new CodexStructuredSession(saved.id, saved.endpoint, rpc);
          try { await session.syncState(); await session.interrupt(); return true; }
          finally { await session.close(); }
        } finally { rpc.close(); }
      },
    };
  }
  async isAvailable(): Promise<boolean> { return (await this.checkAvailability()).ok; }
  checkAvailability() { return checkAgentAvailability({ agentId: this.id, agentName: this.displayName, command: this.options.binary, binaryPath: this.options.binary }); }
  async prepareRun(): Promise<void> {
    const available = await this.checkAvailability();
    if (!available.ok) throw available.error;
    if (this.id === 'codex') await ensureBundledCodexSkill(this.options.codexHome ?? process.env.CODEX_HOME);
  }
  structuredControl = async (scope: string, input: string): Promise<AgentEvent[]> => {
    const current = this.sessions.get(scope);
    if (!current) throw new Error('当前结构化会话尚未建立');
    const requestId = /^\/answer\s+(\S+)/.exec(input)?.[1];
    const target = requestId
      ? [current.main, current.side].find(session => session?.hasRequest(requestId))
      : current.side ?? current.main;
    if (!target) throw new Error('请求已失效或不属于此会话');
    const events = await target.command(input);
    const extra = target instanceof CodexStructuredSession || target instanceof ClaudeStructuredSession ? target.drainCommands() : [];
    for (const event of [...events, ...extra]) (current.sideView ?? current.view).event(event);
    return [...events, ...extra];
  };
  structuredQuestion = (scope: string): string | undefined => {
    const current = this.sessions.get(scope);
    return (current?.side ?? current?.main)?.freeTextRequest();
  };
  run(options: AgentRunOptions): AgentRun { return this.createRun(options, false); }
  runSide(options: AgentRunOptions): AgentRun { return this.createRun(options, true); }
  private createRun(options: AgentRunOptions, side: boolean): AgentRun {
    const events = new AsyncEventQueue<AgentEvent>();
    const abort = new AbortController();
    let detached = false;
    let terminal = false;
    const emit = (event: AgentEvent) => {
      if (detached) return;
      if (event.type === 'error' || event.type === 'done') terminal = true;
      events.push(event);
      const current = this.sessions.get(options.scopeId ?? options.cwd ?? '');
      (side ? current?.sideView : current?.view)?.event(event);
    };
    void (async () => {
      try {
        if (side && options.liveInputMode === 'side-exit' && !this.sessions.get(options.scopeId ?? options.cwd ?? '')?.side) {
          emit(textEvent('当前没有已打开的结构化 side，会话未改变。')); return;
        }
        const current = await this.session(options);
        if (abort.signal.aborted) return;
        let target = current.main;
        let prompt = options.prompt;
        if (side) {
          if (!(current.main instanceof CodexStructuredSession)) throw new Error('Claude 结构化 side 尚未验证，请保留原生后端使用此功能');
          if (options.liveInputMode === 'side-exit') {
            if (current.side) { await current.side.interrupt(); await current.side.close(); current.side = undefined; current.sideView = undefined; }
            emit({ type: 'system', sideConversation: 'exited' }); emit(textEvent('已退出 side，主任务继续运行。')); return;
          }
          if (!current.side) {
            current.side = await current.main.forkSide();
            current.sideView = this.makeView(`${options.scopeId}:side:${current.side.id}`);
            await current.sideView.start(this.options.nativeView !== false ? { binary: this.options.binary, endpoint: current.side.endpoint, threadId: current.side.id } : undefined, current.cwd);
          }
          target = current.side;
          prompt = options.prompt.replace(/^\/btw(?:\s+|$)/i, '');
          emit({ type: 'system', sideConversation: 'entered' });
          if (!prompt) { emit(textEvent('已进入 side，请发送正文。')); return; }
        }
        if (!options.liveInputMode || side) (side ? current.sideView : current.view)?.event(textEvent(`\n[user]\n${prompt}\n`));
        await target.submit({ ...options, prompt, ...(side ? { liveInputMode: undefined } : {}) }, emit, abort.signal);
      } catch (error) { emit({ type: 'error', message: error instanceof Error ? error.message : String(error), terminationReason: 'failed' }); }
      finally { if (!terminal && !detached) emit({ type: 'done', terminationReason: abort.signal.aborted ? 'interrupted' : 'normal' }); events.close(); }
    })();
    return { runId: options.runId, events,
      stop: async () => { abort.abort(); },
      detach: async () => { detached = true; events.close(); },
      waitForExit: async () => true };
  }
  private makeView(scope: string): StructuredView {
    const key = `${this.options.profileDir}\0${scope}`;
    const directory = join(tmpdir(), `ab-view-${process.getuid?.() ?? 'user'}-${createHash('sha256').update(key).digest('hex').slice(0, 12)}`);
    return new StructuredView(directory, key);
  }
  private stateFile(scope: string, cwd: string): string {
    return join(this.options.profileDir, 'structured', `${createHash('sha256').update(scope).update('\0').update(cwd).digest('hex')}.json`);
  }
  private async saved(scope: string, cwd: string): Promise<{ id: string; endpoint?: string; view?: TmuxBindingStatus } | undefined> {
    try {
      const value = JSON.parse(await readFile(this.stateFile(scope, cwd), 'utf8'));
      return value.scope === scope && value.cwd === cwd && value.kind === this.id && typeof value.id === 'string' ? value : undefined;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return undefined; }
  }
  private async session(options: AgentRunOptions): Promise<ScopeSession> {
    const scope = options.scopeId ?? options.cwd;
    if (!scope || !options.cwd) throw new Error('Structured session requires scope and cwd');
    const found = this.sessions.get(scope);
    if (found) {
      if (found.cwd === options.cwd) return found;
      if (found.main.diagnostics().inputState === 'submitted' || found.side) throw new Error('当前会话仍有任务或 side，请结束后再切换工作目录');
      await found.main.close();
      if (found.main instanceof CodexStructuredSession) found.main.disconnect();
      this.sessions.delete(scope);
    }
    const starting = this.starting.get(scope);
    if (starting) return starting;
    const operation = this.createSession(scope, options);
    this.starting.set(scope, operation);
    try { const result = await operation; this.sessions.set(scope, result); return result; }
    finally { this.starting.delete(scope); }
  }
  private async createSession(scope: string, options: AgentRunOptions): Promise<ScopeSession> {
    const cwd = options.cwd!;
    const directory = join(this.options.profileDir, 'structured');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const stateFile = this.stateFile(scope, cwd);
    let saved: { id: string } | undefined;
    try { saved = JSON.parse(await readFile(stateFile, 'utf8')); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const env = withArtifactDeliveryEnv({ ...process.env, ...buildLarkChannelEnv(this.options.larkChannel) }, options.artifactDelivery);
    let main: StructuredSession;
    const view = this.makeView(`${scope}\0${cwd}`);
    if (this.id === 'codex') {
      if (this.options.codexHome) env.CODEX_HOME = this.options.codexHome;
      const { rpc, endpoint } = await connectCodexHost({ binary: this.options.binary, profileDir: this.options.profileDir, scope, cwd, env });
      const restored = saved ? new CodexStructuredSession(saved.id, endpoint, rpc) : undefined;
      try {
        const result = await rpc.request(saved ? 'thread/resume' : 'thread/start', {
          ...(saved ? { threadId: saved.id, excludeTurns: true } : {}), cwd,
          ...(!saved && options.model ? { model: options.model } : {}), sandbox: options.sandbox ?? 'read-only',
          ...(!saved && options.reasoningEffort ? { config: { model_reasoning_effort: options.reasoningEffort } } : {}),
          approvalPolicy: 'on-request',
        });
        const id = result.thread?.id;
        if (typeof id !== 'string') throw new Error('Codex did not return a thread ID');
        main = restored ?? new CodexStructuredSession(id, endpoint, rpc);
        await (main as CodexStructuredSession).syncState();
        await view.start(this.options.nativeView !== false ? { binary: this.options.binary, endpoint, threadId: id, env } : undefined, cwd);
        await writeFileAtomic(stateFile, JSON.stringify({ id, cwd, scope, kind: this.id, endpoint, view: view.status() }));
      } catch (error) { await restored?.close(); rpc.close(); throw error; }
    } else {
      const id = saved?.id ?? randomUUID();
      const permissionMode = options.permissionMode ?? 'default';
      const sdkOptions: Options = { cwd, env, pathToClaudeCodeExecutable: this.options.binary,
        ...(saved ? { resume: id } : { sessionId: id }), ...(!saved && options.model ? { model: options.model } : {}),
        permissionMode, allowDangerouslySkipPermissions: permissionMode === 'bypassPermissions' };
      const claude = await ClaudeStructuredSession.create(id, sdkOptions);
      await claude.ready(); main = claude;
      await view.start(undefined, cwd);
      await writeFileAtomic(stateFile, JSON.stringify({ id, cwd, scope, kind: this.id, view: view.status() }));
    }
    return { main, view, cwd };
  }
  async shutdown(): Promise<void> {
    for (const current of this.sessions.values()) {
      await current.side?.close(); await current.main.close(); await current.view.close();
      if (current.main instanceof CodexStructuredSession) current.main.disconnect();
    }
    this.sessions.clear();
  }
}

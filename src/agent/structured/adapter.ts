import { createHash, randomUUID } from 'node:crypto';
import { readFile, mkdir, lstat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { AsyncEventQueue } from '../event-queue';
import type { AgentAdapter, AgentEvent, AgentRun, AgentRunOptions } from '../types';
import { checkAgentAvailability } from '../preflight';
import { ensureBundledCodexSkill } from '../bundled-skill';
import { captureTmuxPaneTail, discoverTmuxSockets, listTmuxAgentPanes, type AgentTmuxControl, type TmuxPaneTarget } from '../tmux-control';
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
import { activeStructuredTmuxPane, listStructuredTmuxPanes } from './tmux-discovery';
import { spawnProcessSync } from '../../platform/spawn';

interface StructuredBinding { target: TmuxPaneTarget; endpoint: string; threadId: string; cwd: string; updatedAt: number }
interface ScopeSession { main: StructuredSession; view: StructuredView; bound?: StructuredBinding; side?: CodexStructuredSession; sideOpening?: Promise<CodexStructuredSession>; sideExit?: Promise<void>; sideClosing?: boolean; sideView?: StructuredView; cwd: string }
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
  private bindings = new Map<string, StructuredBinding>();
  private autoDiscoveryDisabled = new Set<string>();
  private readonly bindingsFile: string;
  constructor(private readonly options: StructuredAdapterOptions) {
    this.id = options.kind;
    this.displayName = options.kind === 'codex' ? 'Codex App Server' : 'Claude Agent SDK';
    this.bindingsFile = join(options.profileDir, 'structured', 'tmux-bindings.json');
    this.loadBindings();
    this.tmux = {
      list: async (socket?: string) => this.listStructuredPanes(socket),
      bind: async (scope, selector) => this.bindTmuxPane(scope, selector),
      unbind: async scope => {
        const removed = this.bindings.delete(scope);
        if (removed) this.autoDiscoveryDisabled.add(scope);
        if (removed) await this.saveBindings();
        return removed;
      },
      status: async (scope, cwd) => {
        const current = this.sessions.get(scope);
        const binding = this.bindings.get(scope) ?? current?.bound;
        if (binding) {
          const pane = this.refreshBindingTarget(binding);
          return pane ? { state: 'external', target: pane } : { state: 'invalid', target: binding.target, message: '结构化 pane 已关闭或 resume 到其他会话' };
        }
        return (current?.sideView ?? current?.view)?.status() ?? (cwd ? (await this.saved(scope, cwd))?.view : undefined) ?? { state: 'none' };
      },
      diagnostics: async scope => {
        const current = this.sessions.get(scope);
        return { ...(current?.side ?? current?.main)?.diagnostics() ?? { phase: 'idle', inputState: 'unknown', retryCount: 0 }, sideConversation: Boolean(current?.side) };
      },
      tail: async (scope, lines, cwd) => {
        const status = await this.tmux.status(scope, cwd);
        const terminal = status.terminal ?? (status.target ? {
          socketPath: status.target.socketPath,
          target: status.target.paneId,
          attachCommand: status.target.attachCommand,
          ownership: status.target.ownership,
        } : undefined);
        if (!terminal) throw new Error('当前会话尚未建立终端显示');
        return captureTmuxPaneTail(terminal, lines);
      },
      interrupt: async (scope, cwd, options) => {
        const current = this.sessions.get(scope);
        if (options?.sideOnly && !current?.side) return false;
        if (current) { await (current.side ?? current.main).interrupt(); return true; }
        const binding = this.bindings.get(scope);
        if (binding) return this.interruptBinding(binding);
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
  private listStructuredPanes(socket?: string): TmuxPaneTarget[] {
    if (this.id !== 'codex') return listTmuxAgentPanes(socket);
    const sockets = socket
      ? [socket]
      : [...new Set([
          ...discoverTmuxSockets(),
          ...[...this.sessions.values()].flatMap(current => {
            const terminal = current.view.status().terminal;
            return terminal?.socketPath ? [terminal.socketPath] : [];
          }),
          ...[...this.bindings.values()].map(binding => binding.target.socketPath),
        ])];
    const seen = new Set<string>();
    const result = sockets.flatMap(item => listStructuredTmuxPanes(item));
    return result.filter(pane => {
      if (seen.has(`${pane.socketPath}\0${pane.paneId}`)) return false;
      seen.add(`${pane.socketPath}\0${pane.paneId}`);
      return true;
    });
  }
  async isAvailable(): Promise<boolean> { return (await this.checkAvailability()).ok; }
  checkAvailability() { return checkAgentAvailability({ agentId: this.id, agentName: this.displayName, command: this.options.binary, binaryPath: this.options.binary }); }
  async prepareRun(): Promise<void> {
    const available = await this.checkAvailability();
    if (!available.ok) throw available.error;
    if (this.id === 'codex') await ensureBundledCodexSkill(this.options.codexHome ?? process.env.CODEX_HOME);
  }
  private loadBindings(): void {
    try {
      const parsed = JSON.parse(readFileSync(this.bindingsFile, 'utf8')) as { version?: number; bindings?: Record<string, StructuredBinding>; disabled?: string[] };
      if (parsed.version !== 1) return;
      for (const scope of parsed.disabled ?? []) if (typeof scope === 'string') this.autoDiscoveryDisabled.add(scope);
      for (const [scope, binding] of Object.entries(parsed.bindings ?? {})) {
        if (binding?.cwd && binding.endpoint?.startsWith('unix://') && binding.threadId && binding.target?.paneId) this.bindings.set(scope, binding);
      }
    } catch { /* first run or stale state */ }
  }
  private async saveBindings(): Promise<void> {
    await mkdir(join(this.options.profileDir, 'structured'), { recursive: true, mode: 0o700 });
    await writeFileAtomic(this.bindingsFile, JSON.stringify({ version: 1, bindings: Object.fromEntries(this.bindings), disabled: [...this.autoDiscoveryDisabled] }, null, 2) + '\n', { mode: 0o600 });
  }
  private async bindTmuxPane(scope: string, selector: string): Promise<TmuxPaneTarget> {
    if (this.id !== 'codex') throw new Error('Claude 结构化会话暂不支持接管任意 tmux resume；请使用 terminal 后端。');
    const explicitSocket = selector.includes('::') ? selector.slice(0, selector.lastIndexOf('::')) : undefined;
    const candidates = this.listStructuredPanes(explicitSocket);
    const key = selector.trim();
    const target = /^\d+$/u.test(key)
      ? candidates[Number.parseInt(key, 10) - 1]
      : candidates.find(item => item.paneId === key || `${item.socketPath}::${item.paneId}` === key);
    if (!target?.structured) throw new Error(`未找到可接管的 Codex pane：${selector}。先运行 /tmux list。`);
    if (!target.structured.endpoint && target.structured.legacy) return this.adoptLegacyPane(scope, target);
    if (!target.structured.endpoint) throw new Error('该 pane 尚未连接 App Server，无法结构化接管');
    const binding: StructuredBinding = { target, endpoint: target.structured.endpoint, threadId: target.structured.threadId, cwd: target.paneCurrentPath, updatedAt: Date.now() };
    await this.verifyBinding(binding);
    this.autoDiscoveryDisabled.delete(scope);
    this.bindings.set(scope, binding);
    await this.saveBindings();
    return target;
  }
  private async adoptLegacyPane(scope: string, target: TmuxPaneTarget & { structured?: { threadId: string; legacy?: boolean; codexHome?: string } }): Promise<TmuxPaneTarget> {
    if (this.id !== 'codex' || !target.structured?.threadId) throw new Error('只有 Codex legacy resume pane 可以自动迁移');
    const env = { ...process.env };
    if (target.structured.codexHome) env.CODEX_HOME = target.structured.codexHome;
    else if (this.options.codexHome) env.CODEX_HOME = this.options.codexHome;
    const { rpc, endpoint } = await connectCodexHost({ binary: this.options.binary, profileDir: this.options.profileDir, scope, cwd: target.paneCurrentPath, env });
    try {
      const command = [this.options.binary, '-c', 'check_for_update_on_startup=false', '--remote', endpoint, 'resume', target.structured.threadId, '--no-alt-screen'].map(value => `'${value.replace(/'/g, `'\\''`)}'`).join(' ');
      const created = spawnProcessSync('tmux', ['-S', target.socketPath, 'split-window', '-d', '-P', '-F', '#{pane_id}', '-t', target.sessionName, '-c', target.paneCurrentPath, command], { encoding: 'utf8' });
      if (created.status !== 0 || typeof created.stdout !== 'string' || !created.stdout.trim()) throw new Error(`无法在 tmux 中创建 structured pane${typeof created.stderr === 'string' && created.stderr.trim() ? `：${created.stderr.trim()}` : ''}`);
      const paneId = created.stdout.trim();
      let current: TmuxPaneTarget | undefined;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        current = listStructuredTmuxPanes(target.socketPath).find(pane => pane.paneId === paneId && pane.structured?.threadId === target.structured!.threadId && pane.structured.endpoint === endpoint);
        if (current) break;
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      if (!current?.structured?.endpoint) throw new Error('structured pane 启动超时，请检查新 pane 输出');
      const binding: StructuredBinding = { target: current, endpoint, threadId: target.structured.threadId, cwd: current.paneCurrentPath, updatedAt: Date.now() };
      const loaded = await rpc.request('thread/loaded/list', {});
      if (!Array.isArray(loaded.data) || !loaded.data.includes(binding.threadId)) throw new Error('App Server 未加载旧 thread，未创建绑定');
      this.autoDiscoveryDisabled.delete(scope);
      this.bindings.set(scope, binding);
      await this.saveBindings();
      return current;
    } finally { rpc.close(); }
  }
  private refreshBindingTarget(binding: StructuredBinding): TmuxPaneTarget | undefined {
    const target = listStructuredTmuxPanes(binding.target.socketPath).find(item => item.paneId === binding.target.paneId);
    if (!target?.structured || target.structured.threadId !== binding.threadId || target.structured.endpoint !== binding.endpoint) return undefined;
    binding.target = target;
    return target;
  }
  private async verifyBinding(binding: StructuredBinding): Promise<void> {
    const rpc = await this.connectExisting(binding.endpoint);
    try {
      await rpc.initialize();
      const loaded = await rpc.request('thread/loaded/list', {});
      if (!Array.isArray(loaded.data) || !loaded.data.includes(binding.threadId)) throw new Error('App Server 未加载该 thread，未创建绑定');
    } finally { rpc.close(); }
  }
  private async interruptBinding(binding: StructuredBinding): Promise<boolean> {
    if (!this.refreshBindingTarget(binding)) return false;
    const rpc = await this.connectExisting(binding.endpoint);
    try {
      await rpc.initialize();
      const loaded = await rpc.request('thread/loaded/list', {});
      if (!Array.isArray(loaded.data) || !loaded.data.includes(binding.threadId)) return false;
      const session = new CodexStructuredSession(binding.threadId, binding.endpoint, rpc);
      try { await session.syncState(); await session.interrupt(); return true; } finally { await session.close(); }
    } finally { rpc.close(); }
  }
  private async connectExisting(endpoint: string): Promise<RpcClient> {
    if (process.platform === 'win32' || !endpoint.startsWith('unix://')) throw new Error('结构化 pane 必须使用本机 Unix App Server socket');
    const path = endpoint.slice('unix://'.length);
    if (!path.startsWith('/') || path.includes('\0')) throw new Error('App Server endpoint 不安全');
    const stat = await lstat(path);
    if (!stat.isSocket() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) throw new Error('App Server socket 不安全');
    return RpcClient.connect(`ws+unix://${path}:/`);
  }
  structuredControl = async (scope: string, input: string): Promise<AgentEvent[]> => {
    const current = this.sessions.get(scope) ?? await this.starting.get(scope);
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
  structuredReady = (scope: string): boolean => this.sessions.has(scope);
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
        const known = this.sessions.get(options.scopeId ?? options.cwd ?? '');
        if (side && options.liveInputMode === 'side-exit' && !known?.side && !known?.sideOpening) {
          emit(textEvent('当前没有已打开的结构化 side，会话未改变。')); return;
        }
        const current = await this.session(options);
        if (abort.signal.aborted) return;
        let target = current.main;
        if (!side && options.liveInputMode) {
          const requestId = /^\/answer\s+(\S+)/.exec(options.prompt)?.[1];
          const controlTarget = requestId
            ? [current.main, current.side].find(session => session?.hasRequest(requestId))
            : current.side ?? current.main;
          if (!controlTarget) throw new Error('选择请求已失效，请使用最新卡片');
          target = controlTarget;
        }
        let prompt = options.prompt;
        if (side) {
          if (!(current.main instanceof CodexStructuredSession)) throw new Error('Claude 结构化 side 尚未验证，请保留原生后端使用此功能');
          if (options.liveInputMode === 'side-exit') {
            current.sideExit ??= (async () => {
              current.sideClosing = true;
              try {
                if (current.sideOpening) await current.sideOpening;
                if (current.side) { await current.side.discardSide(); current.side = undefined; await current.sideView?.dispose(); current.sideView = undefined; }
              } finally { current.sideClosing = false; }
            })();
            try { await current.sideExit; } finally { current.sideExit = undefined; }
            emit({ type: 'system', sideConversation: 'exited' }); emit(textEvent('已退出 side，主任务继续运行。')); return;
          }
          if (!current.side) {
            current.sideOpening ??= current.main.forkSide(current.cwd).then(async session => {
              current.side = session;
              current.sideView = this.makeView(`${options.scopeId}:side:${session.id}`);
              // A separate native TUI would retain a subscription after /btw out.
              // The side view observes the same events read-only; main stays native.
              await current.sideView.start(undefined, current.cwd);
              return session;
            });
            try { await current.sideOpening; } finally { current.sideOpening = undefined; }
          }
          if (current.sideClosing) return;
          if (abort.signal.aborted) {
            if (current.side) { await current.side.discardSide(); current.side = undefined; await current.sideView?.dispose(); current.sideView = undefined; }
            return;
          }
          if (!current.side) throw new Error('Side closed before submission; text was not sent');
          target = current.side;
          prompt = options.prompt.replace(/^\/btw(?:\s+|$)/i, '');
          emit({ type: 'system', sideConversation: 'entered' });
          if (!prompt) { emit(textEvent('已进入 side，请发送正文。')); return; }
        }
        if (!options.liveInputMode || side) (side ? current.sideView : current.view)?.event(textEvent(`\n[user]\n${prompt}\n`));
        await target.submit({ ...options, prompt, ...(side ? { liveInputMode: undefined } : {}) }, emit, abort.signal);
        if (!side && target === current.main && this.id === 'codex' && this.options.nativeView !== false) await current.view.ensureNative();
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
    let found = this.sessions.get(scope);
    let binding = this.bindings.get(scope);
    if (found && !this.autoDiscoveryDisabled.has(scope) && this.id === 'codex' && found.main.diagnostics().inputState === 'empty' && !found.side) {
      const terminal = found.bound?.target
        ? { socketPath: found.bound.target.socketPath, target: found.bound.target.sessionName }
        : found.view.status().terminal;
      // An explicit binding to a different tmux session must not be replaced
      // by the old managed view's active pane. Auto-discovery is limited to
      // the session that owns the current structured view.
      const canInspectCurrentView = !binding || found.bound?.target.sessionName === terminal?.target || binding.target.sessionName === terminal?.target;
      const pane = canInspectCurrentView && terminal ? activeStructuredTmuxPane(terminal.socketPath, terminal.target) : undefined;
      if (pane?.structured) {
        const discovered = { target: pane, endpoint: pane.structured.endpoint!, threadId: pane.structured.threadId, cwd: pane.paneCurrentPath, updatedAt: Date.now() };
        if (!binding || binding.threadId !== discovered.threadId || binding.endpoint !== discovered.endpoint || binding.target.paneId !== discovered.target.paneId) {
          binding = discovered;
          this.bindings.set(scope, binding);
          await this.saveBindings();
        } else {
          binding.target = pane;
        }
      }
    }
    if (binding && resolve(binding.cwd) !== resolve(options.cwd)) throw new Error(`tmux pane workspace (${binding.cwd}) 与当前 workspace (${options.cwd}) 不一致`);
    if (found) {
      if (this.autoDiscoveryDisabled.has(scope) && found.bound) {
        await found.main.close();
        if (found.main instanceof CodexStructuredSession) found.main.disconnect();
        this.sessions.delete(scope);
        found = undefined;
      }
    }
    if (found) {
      const currentThreadId = found.main instanceof CodexStructuredSession ? found.main.id : undefined;
      const currentEndpoint = found.main instanceof CodexStructuredSession ? found.main.endpoint : undefined;
      if (found.cwd === options.cwd && (!binding || found.bound?.threadId === binding.threadId || (currentThreadId === binding.threadId && currentEndpoint === binding.endpoint))) return found;
      if (found.main.diagnostics().inputState === 'submitted' || found.side) throw new Error('当前会话仍有任务或 side，请结束后再切换工作目录');
      await found.main.close();
      if (found.main instanceof CodexStructuredSession) found.main.disconnect();
      this.sessions.delete(scope);
      found = undefined;
    }
    const starting = this.starting.get(scope);
    if (starting) return starting;
    const operation = this.createSession(scope, options, binding);
    this.starting.set(scope, operation);
    try { const result = await operation; this.sessions.set(scope, result); return result; }
    finally { this.starting.delete(scope); }
  }
  private async createSession(scope: string, options: AgentRunOptions, bound?: StructuredBinding): Promise<ScopeSession> {
    const cwd = options.cwd!;
    const directory = join(this.options.profileDir, 'structured');
    const stateFile = this.stateFile(scope, cwd);
    let saved: { id: string; endpoint?: string; view?: TmuxBindingStatus } | undefined;
    try { saved = JSON.parse(await readFile(stateFile, 'utf8')); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (!saved && options.liveInputMode === 'control') throw new Error('没有可恢复的结构化会话；选择操作未启动新任务');
    const env = withArtifactDeliveryEnv({ ...process.env, ...buildLarkChannelEnv(this.options.larkChannel) }, options.artifactDelivery);
    let main: StructuredSession;
    const view = this.makeView(`${scope}\0${cwd}`);
    if (this.id === 'codex') {
      if (this.options.codexHome) env.CODEX_HOME = this.options.codexHome;
      if (!bound && !this.autoDiscoveryDisabled.has(scope) && saved?.view?.terminal) {
        const pane = activeStructuredTmuxPane(saved.view.terminal.socketPath, saved.view.terminal.target);
        if (pane?.structured) {
          bound = { target: pane, endpoint: pane.structured.endpoint!, threadId: pane.structured.threadId, cwd: pane.paneCurrentPath, updatedAt: Date.now() };
          this.bindings.set(scope, bound);
          await this.saveBindings();
        }
      }
      if (bound) {
        const rpc = await this.connectExisting(bound.endpoint);
        try {
          await rpc.initialize();
          const loaded = await rpc.request('thread/loaded/list', {});
          if (!Array.isArray(loaded.data) || !loaded.data.includes(bound.threadId)) throw new Error('tmux 当前 resume 的 thread 不在对应 App Server 中');
          const resumed = await rpc.request('thread/resume', { threadId: bound.threadId, excludeTurns: true, cwd });
          if (resumed.thread?.id !== bound.threadId) throw new Error('App Server 返回了不同的 thread');
          const attached = new CodexStructuredSession(bound.threadId, bound.endpoint, rpc);
          await attached.syncState();
          await writeFileAtomic(stateFile, JSON.stringify({ id: bound.threadId, cwd, scope, kind: this.id, endpoint: bound.endpoint, bound: true }, null, 2));
          return { main: attached, view, bound, cwd };
        } catch (error) { rpc.close(); throw error; }
      }
      const readOnlyReconnect = saved && options.liveInputMode && !/^\/goal\s+(?!pause\b|clear\b|edit\b|status\b)/.test(options.prompt);
      let rpc: RpcClient;
      let endpoint: string;
      if (readOnlyReconnect) {
        if (!saved?.endpoint?.startsWith('unix://')) throw new Error('旧连接信息不足，控制操作未启动任何新服务');
        endpoint = saved.endpoint;
        rpc = await RpcClient.connect(`ws+unix://${endpoint.slice('unix://'.length)}:/`);
        try {
          await rpc.initialize();
          const loaded = await rpc.request('thread/loaded/list', {});
          if (!loaded.data?.includes(saved.id)) throw new Error('原会话未运行；控制操作不会自动恢复任务');
        } catch (error) { rpc.close(); throw error; }
      } else ({ rpc, endpoint } = await connectCodexHost({ binary: this.options.binary, profileDir: this.options.profileDir, scope, cwd, env }));
      const restored = saved ? new CodexStructuredSession(saved.id, endpoint, rpc) : undefined;
      try {
        const result = await rpc.request(saved ? 'thread/resume' : 'thread/start', {
          ...(saved ? { threadId: saved.id, excludeTurns: true } : {}), cwd,
          ...(!saved && options.model ? { model: options.model } : {}), ...(!readOnlyReconnect ? { sandbox: options.sandbox ?? 'read-only', approvalPolicy: 'on-request' } : {}),
          ...(!saved && options.reasoningEffort ? { config: { model_reasoning_effort: options.reasoningEffort } } : {}),
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
      await current.side?.close(); await current.sideView?.dispose(); await current.main.close(); await current.view.close();
      if (current.main instanceof CodexStructuredSession) current.main.disconnect();
    }
    this.sessions.clear();
  }
}

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import type { AgentAdapter, AgentRun, AgentRunOptions } from '../types';
import { AsyncEventQueue } from '../event-queue';
import { listTmuxAgentPanes, type AgentTmuxControl, type TmuxPaneTarget } from '../tmux-control';
import { listStructuredTmuxPanes } from './tmux-discovery';
import { writeFileAtomic } from '../../platform/atomic-write';

/** Choose once before submission. An uncertain submission never gets replayed
 * through another transport. Ordinary native processes keep their own writer. */
export class PreferredStructuredAdapter implements AgentAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly tmux: AgentTmuxControl;
  private targets = new Map<string, TmuxPaneTarget>();
  private readonly file: string;
  constructor(private structured: AgentAdapter, private live: AgentAdapter, private directory: string) {
    this.id = structured.id;
    this.displayName = `${structured.displayName} (live fallback)`;
    this.file = join(directory, 'preferred-panes.json');
    try {
      const data = JSON.parse(readFileSync(this.file, 'utf8'));
      if (data.version === 1) for (const [scope, target] of Object.entries(data.targets ?? {})) this.targets.set(scope, target as TmuxPaneTarget);
    } catch {
      try {
        const old = JSON.parse(readFileSync(join(directory, 'structured', 'tmux-bindings.json'), 'utf8'));
        if (old.version === 1) for (const [scope, binding] of Object.entries(old.bindings ?? {})) {
          const target = (binding as { target?: TmuxPaneTarget }).target;
          if (target?.paneId) this.targets.set(scope, target);
        }
      } catch { /* first run */ }
    }
    this.tmux = {
      list: async socket => {
        const protocol = (await this.structured.tmux!.list(socket)).filter(pane => !pane.structured?.persisted && pane.agentKind === this.id);
        const raw = [...listTmuxAgentPanes(socket).filter(pane => pane.agentKind === this.id), ...protocol];
        const merged = new Map<string, TmuxPaneTarget>();
        for (const pane of raw) merged.set(`${pane.socketPath}::${pane.paneId}`, protocol.find(item => item.socketPath === pane.socketPath && item.paneId === pane.paneId) ?? pane);
        return [...merged.values()];
      },
      bind: async (scope, selector) => {
        const socket = selector.includes('::') ? selector.slice(0, selector.lastIndexOf('::')) : undefined;
        const panes = await this.tmux.list(socket);
        const pane = /^\d+$/.test(selector) ? panes[Number(selector) - 1] : panes.find(item => item.paneId === selector || `${item.socketPath}::${item.paneId}` === selector);
        if (!pane) throw new Error('未找到正在运行的 agent；请在该 pane 启动或 resume 后重新 /tmux list。');
        // Binding never launches a second agent. Record the live target too so
        // a later manual native resume can safely use the same pane.
        await this.live.tmux!.bind(scope, `${pane.socketPath}::${pane.paneId}`);
        if (pane.structured?.endpoint) await this.structured.tmux!.bind(scope, `${pane.socketPath}::${pane.paneId}`);
        this.targets.set(scope, pane);
        await this.save();
        return pane;
      },
      unbind: async scope => {
        const removed = this.targets.delete(scope);
        await this.live.tmux!.unbind(scope);
        await this.structured.tmux!.unbind(scope);
        await this.save();
        return removed;
      },
      status: async (scope, cwd) => {
        const saved = this.targets.get(scope);
        if (!saved) return this.structured.tmux!.status(scope, cwd);
        const current = this.current(scope);
        return current ? { state: 'external', target: current, message: current.structured?.endpoint ? 'structured' : 'live fallback: native process has no shared endpoint' }
          : { state: 'invalid', target: saved, message: 'pane 已退出 agent；绑定保留，等待手动 resume' };
      },
      tail: (scope, lines, cwd) => this.selected(scope).tmux!.tail!(scope, lines, cwd),
      diagnostics: (scope, cwd) => this.selected(scope).tmux!.diagnostics!(scope, cwd),
      sendInput: (scope, input, cwd, active) => this.selected(scope).tmux!.sendInput?.(scope, input, cwd, active) ?? Promise.resolve(false),
      interrupt: (scope, cwd, options) => this.selected(scope).tmux!.interrupt!(scope, cwd, options),
    };
  }
  private async save() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await writeFileAtomic(this.file, JSON.stringify({ version: 1, targets: Object.fromEntries(this.targets) }), { mode: 0o600 });
  }
  private current(scope: string) {
    const target = this.targets.get(scope);
    if (!target) return undefined;
    const raw = listTmuxAgentPanes(target.socketPath).find(pane => pane.paneId === target.paneId && pane.sessionName === target.sessionName && pane.agentKind === this.id);
    if (!raw) return undefined;
    return this.id === 'codex' ? listStructuredTmuxPanes(target.socketPath).find(pane => pane.paneId === raw.paneId) ?? raw : raw;
  }
  private selected(scope: string): AgentAdapter {
    if (!this.targets.has(scope)) return this.structured;
    return this.current(scope)?.structured?.endpoint ? this.structured : this.live;
  }
  forScope(scope: string): AgentAdapter {
    const selected = this.selected(scope);
    const identity = this.current(scope)?.structured;
    return {
      id: this.id, displayName: this.displayName, tmux: this.tmux,
      isAvailable: () => selected.isAvailable(),
      prepareRun: options => selected.prepareRun?.(options) ?? Promise.resolve(),
      run: options => this.run(options), runSide: options => this.runSide(options),
      ...(selected.structuredControl ? {
        structuredControl: async (scopeId: string, input: string) => {
          const now = this.current(scopeId)?.structured;
          if (this.targets.has(scopeId) && (!now?.endpoint || now.endpoint !== identity?.endpoint || now.threadId !== identity?.threadId)) {
            throw new Error('pane 中的会话已经改变，旧选择未发送。请使用当前会话的新卡片。');
          }
          return selected.structuredControl!(scopeId, input);
        },
        structuredReady: (scopeId: string) => selected.structuredReady?.(scopeId) ?? false,
        structuredQuestion: (scopeId: string) => selected.structuredQuestion?.(scopeId),
      } : {}),
    };
  }
  isAvailable() { return this.structured.isAvailable(); }
  prepareRun(options: AgentRunOptions) { return this.selected(options.scopeId ?? options.cwd ?? '').prepareRun?.(options) ?? Promise.resolve(); }
  run(options: AgentRunOptions) { return this.submit(options, false); }
  runSide(options: AgentRunOptions) { return this.submit(options, true); }
  private submit(options: AgentRunOptions, side: boolean): AgentRun {
    const events = new AsyncEventQueue<import('../types').AgentEvent>();
    let actual: AgentRun | undefined;
    let stopped = false;
    let detached = false;
    const operation = (async () => {
      try {
        const scope = options.scopeId ?? options.cwd ?? '';
        const pane = this.current(scope);
        if (this.targets.has(scope) && !pane) throw new Error('绑定 pane 当前没有 agent。请在原 shell 中启动或 resume；正文尚未发送。');
        const selected = !this.targets.has(scope) || pane?.structured?.endpoint ? this.structured : this.live;
        if (pane?.structured?.endpoint) {
          const status = await this.structured.tmux!.status(scope, options.cwd);
          if (status.target?.structured?.endpoint !== pane.structured.endpoint || status.target?.structured?.threadId !== pane.structured.threadId) {
            await this.structured.tmux!.bind(scope, `${pane.socketPath}::${pane.paneId}`);
          }
        } else if (pane) {
          const status = await this.live.tmux!.status(scope, options.cwd);
          if (status.target?.paneId !== pane.paneId || status.target?.socketPath !== pane.socketPath) {
            await this.live.tmux!.bind(scope, `${pane.socketPath}::${pane.paneId}`);
          }
        }
        if (stopped || detached) return;
        actual = side ? selected.runSide!({ ...options, sessionMode: 'live' }) : selected.run({ ...options, sessionMode: 'live' });
        for await (const event of actual.events) if (!detached) events.push(event);
      } catch (error) {
        if (!detached) events.push({ type: 'error', message: error instanceof Error ? error.message : String(error), terminationReason: 'failed' });
      } finally { events.close(); }
    })();
    return { runId: options.runId, events,
      stop: async opts => { stopped = true; await actual?.stop(opts); },
      detach: async () => { detached = true; await actual?.detach?.(); events.close(); },
      waitForExit: async timeout => { if (actual) return actual.waitForExit(timeout); await operation; return true; },
    };
  }
  async shutdown() { await this.structured.shutdown?.(); await this.live.shutdown?.(); }
}

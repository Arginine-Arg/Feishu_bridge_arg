import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { log } from '../../core/logger';
import { AsyncEventQueue } from '../event-queue';
import { mergeProcessEnv, spawnProcess, type SpawnedProcessByStdio } from '../../platform/spawn';
import {
  buildLarkChannelEnv,
  withArtifactDeliveryEnv,
  type LarkChannelEnvContext,
} from '../lark-channel-env';
import { LiveSessionPool, type LiveTerminalBackend } from '../live-session';
import {
  captureTmuxPaneTail,
  TmuxBindingController,
  type AgentTmuxControl,
  type ManagedTmuxTerminal,
  type TmuxBindingStatus,
  type TmuxTerminalTarget,
} from '../tmux-control';
import { checkAgentAvailability, type AgentAvailability } from '../preflight';
import type {
  AgentAdapter,
  AgentBotIdentity,
  AgentEvent,
  AgentRun,
  AgentRunOptions,
} from '../types';
import { translateEvent } from './stream-json';

export interface AgyAdapterOptions {
  binary?: string;
  profileStateDir?: string;
  larkChannel?: LarkChannelEnvContext;
  sessionMode?: 'turn' | 'live';
  liveUsePty?: boolean;
  liveTerminalBackend?: LiveTerminalBackend;
  liveIdleMs?: number;
}

type AgyChild = SpawnedProcessByStdio<Writable, Readable, Readable>;

export class AgyAdapter implements AgentAdapter {
  readonly id = 'agy';
  readonly displayName = 'Antigravity CLI';
  readonly tmux: AgentTmuxControl;

  private readonly binary: string;
  private readonly larkChannel: LarkChannelEnvContext | undefined;
  private readonly sessionMode: 'turn' | 'live';
  private readonly liveUsePty: boolean | undefined;
  private readonly liveTerminalBackend: LiveTerminalBackend | undefined;
  private readonly liveIdleMs: number | undefined;
  private readonly liveSessions = new LiveSessionPool();
  private readonly tmuxBindings: TmuxBindingController;

  constructor(opts: AgyAdapterOptions = {}) {
    this.binary = opts.binary ?? process.env.LARK_CHANNEL_AGY_BIN ?? 'agy';
    this.larkChannel = opts.larkChannel;
    this.sessionMode = opts.sessionMode ?? 'turn';
    this.liveUsePty = opts.liveUsePty;
    this.liveTerminalBackend = opts.liveTerminalBackend;
    this.liveIdleMs = opts.liveIdleMs;
    const profileStateDir = opts.profileStateDir ?? join(tmpdir(), `arg-bridge-${process.pid}-agy`);
    this.tmuxBindings = new TmuxBindingController(
      profileStateDir,
      opts.larkChannel?.profile ?? 'agy',
      'agy',
    );
    this.tmux = {
      list: (socket) => this.tmuxBindings.list(socket),
      bind: async (scopeId, selector) => {
        const target = await this.tmuxBindings.bind(scopeId, selector);
        await this.liveSessions.close(scopeId, 'tmux-bind');
        return target;
      },
      unbind: async (scopeId) => {
        const removed = await this.tmuxBindings.unbind(scopeId);
        if (removed) await this.liveSessions.close(scopeId, 'tmux-unbind');
        return removed;
      },
      status: (scopeId, cwd) => this.tmuxStatus(scopeId, cwd),
      tail: async (scopeId, lineCount, cwd) => {
        const terminal = tmuxTerminalForStatus(await this.tmuxStatus(scopeId, cwd));
        return captureTmuxPaneTail(terminal, lineCount);
      },
      restoreArtifactDelivery: (scopeId, artifact) =>
        this.tmuxBindings.restoreManagedArtifactDelivery(scopeId, artifact),
    };
  }

  setBotIdentity(_identity: AgentBotIdentity): void {
    // Identity remains bridge-owned metadata.
  }

  private async tmuxStatus(scopeId: string, cwd?: string): Promise<TmuxBindingStatus> {
    const binding = await this.tmuxBindings.status(scopeId);
    if (binding.state !== 'none') return binding;
    const terminal = this.liveSessions.terminalInfo(scopeId);
    if (terminal?.attachCommand && terminal.socketPath && terminal.target) {
      return {
        state: terminal.ownership === 'external' ? ('external' as const) : ('managed' as const),
        terminal: {
          socketPath: terminal.socketPath,
          target: terminal.target,
          attachCommand: terminal.attachCommand,
          ownership: terminal.ownership ?? 'managed',
        },
      };
    }
    return this.tmuxBindings.managedStatus(scopeId, cwd);
  }

  async isAvailable(): Promise<boolean> {
    return (await this.checkAvailability()).ok;
  }

  async checkAvailability(): Promise<AgentAvailability> {
    return checkAgentAvailability({
      agentId: 'agy',
      agentName: 'Antigravity CLI',
      command: this.binary,
      binaryPath: this.binary,
    });
  }

  run(opts: AgentRunOptions): AgentRun {
    if (!opts.cwd) {
      throw new Error('cwd is required for AgyAdapter.run');
    }
    const sessionMode = opts.sessionMode ?? this.sessionMode;
    if (sessionMode === 'live') {
      return this.runLive(opts);
    }

    const args = [
      '-p',
      '--output-format',
      'stream-json',
      '--dangerously-skip-permissions',
    ];
    if (opts.sessionId) args.push('--conversation', opts.sessionId);
    if (opts.model) args.push('--model', opts.model);
    if (opts.reasoningEffort) args.push('--effort', opts.reasoningEffort);

    const child = spawnProcess(this.binary, args, {
      cwd: opts.cwd,
      env: mergeProcessEnv(
        process.env,
        withArtifactDeliveryEnv(buildLarkChannelEnv(this.larkChannel), opts.artifactDelivery),
      ),
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as AgyChild;

    log.info('agent', 'spawn', {
      pid: child.pid ?? null,
      cwd: opts.cwd ?? process.cwd(),
      hasSession: Boolean(opts.sessionId),
      promptChars: opts.prompt.length,
      model: opts.model,
    });

    const stderrChunks: Buffer[] = [];
    let runtimeError: Error | null = null;
    let stderrBuffer = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
      stderrBuffer += chunk.toString('utf8');
      let nl = stderrBuffer.indexOf('\n');
      while (nl !== -1) {
        const line = stderrBuffer.slice(0, nl);
        stderrBuffer = stderrBuffer.slice(nl + 1);
        if (line.trim()) log.warn('agent', 'stderr', { line });
        if (isWindowsCommandNotFoundLine(line)) {
          runtimeError = new Error(`failed to spawn agy: ${line.trim()}`);
          child.stdout.destroy();
          child.kill();
        }
        nl = stderrBuffer.indexOf('\n');
      }
    });

    child.on('error', (err) => {
      runtimeError = err;
    });
    child.on('exit', (code, signal) => {
      log.info('agent', 'exit', { pid: child.pid ?? null, code, signal });
    });
    child.stdin.on('error', (err) => {
      log.warn('agent', 'stdin-error', { message: err.message });
    });
    const events = createEventStream(child, stderrChunks, () => runtimeError);
    child.stdin.end(opts.prompt, 'utf8');

    const stopGraceMs = opts.stopGraceMs ?? 5000;

    return {
      runId: opts.runId,
      events,
      async stop() {
        if (child.exitCode !== null || child.signalCode !== null) return;
        log.info('agent', 'stop-sigterm', { pid: child.pid ?? null, graceMs: stopGraceMs });
        child.kill('SIGTERM');
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) {
              log.warn('agent', 'stop-sigkill', {
                pid: child.pid ?? null,
                graceMs: stopGraceMs,
                reason: 'grace-period-expired',
              });
              child.kill('SIGKILL');
            }
            resolve();
          }, stopGraceMs);
          child.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
        });
      },
      waitForExit(timeoutMs: number): Promise<boolean> {
        if (child.exitCode !== null || child.signalCode !== null) {
          return Promise.resolve(true);
        }
        return new Promise<boolean>((resolve) => {
          const onExit = (): void => {
            clearTimeout(timer);
            resolve(true);
          };
          const timer = setTimeout(() => {
            child.removeListener('exit', onExit);
            resolve(false);
          }, timeoutMs);
          child.once('exit', onExit);
        });
      },
    };
  }

  async shutdown(): Promise<void> {
    await this.liveSessions.detachAll();
  }

  private runLive(opts: AgentRunOptions): AgentRun {
    if (!opts.cwd) {
      throw new Error('cwd is required for AgyAdapter.run');
    }
    const args = ['--dangerously-skip-permissions'];
    if (opts.model) args.push('--model', opts.model);
    if (opts.reasoningEffort) args.push('--effort', opts.reasoningEffort);
    const signature = JSON.stringify({
      cwd: opts.cwd,
      model: opts.model ?? null,
      effort: opts.reasoningEffort ?? null,
    });
    const scopeKey = opts.scopeId ?? opts.cwd;
    const tmuxTarget = this.tmuxBindings.bindingFor(scopeKey, opts.cwd);
    const liveSignature = `${signature}:${tmuxTarget ? `${tmuxTarget.socketPath}:${tmuxTarget.paneId}` : 'managed'}`;
    const managedTerminal: ManagedTmuxTerminal | undefined = tmuxTarget
      ? undefined
      : this.tmuxBindings.managedTerminalFor(scopeKey, opts.cwd, liveSignature);
    const session = this.liveSessions.getOrCreate(scopeKey, {
      command: this.binary,
      args,
      cwd: opts.cwd,
      env: withArtifactDeliveryEnv(buildLarkChannelEnv(this.larkChannel), opts.artifactDelivery),
      signature: liveSignature,
      usePty: this.liveUsePty,
      backend: this.liveTerminalBackend ?? 'tmux',
      idleMs: this.liveIdleMs,
      tmuxSessionName: this.tmuxBindings.managedSessionName(scopeKey),
      tmuxProfile: this.larkChannel?.profile ?? 'agy',
      tmuxScopeId: scopeKey,
      tmuxAgentKind: 'agy',
      tmuxManagedTerminal: managedTerminal,
      tmuxTarget,
      onTerminal: async (terminal) => {
        if (
          tmuxTarget ||
          terminal.backend !== 'tmux' ||
          terminal.ownership !== 'managed' ||
          !terminal.socketPath ||
          !terminal.sessionName ||
          !terminal.attachCommand
        )
          return;
        await this.tmuxBindings.rememberManaged(scopeKey, opts.cwd!, liveSignature, {
          socketPath: terminal.socketPath,
          sessionName: terminal.sessionName,
          attachCommand: terminal.attachCommand,
        });
      },
    });
    return session.run(opts.runId, opts.prompt, opts.cwd, opts.liveInputMode);
  }
}

function tmuxTerminalForStatus(status: TmuxBindingStatus): TmuxTerminalTarget {
  if (status.state === 'invalid') {
    throw new Error(status.message ?? '当前 tmux 绑定已失效');
  }
  if (status.terminal) return status.terminal;
  if (status.target) {
    return {
      socketPath: status.target.socketPath,
      target: status.target.paneId,
      attachCommand: status.target.attachCommand,
      ownership: status.target.ownership,
    };
  }
  throw new Error('当前 scope 尚未创建或绑定 tmux terminal');
}

function createEventStream(
  child: AgyChild,
  stderrChunks: Buffer[],
  getError: () => Error | null,
): AsyncIterable<AgentEvent> {
  const events = new AsyncEventQueue<AgentEvent>();
  if (!child.pid) {
    const err = getError();
    queueMicrotask(() => {
      events.push({
        type: 'error',
        message: err ? `failed to spawn agy: ${err.message}` : 'spawn returned no pid',
        terminationReason: 'failed',
      });
      events.close();
    });
    return events;
  }

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  let outputClosed = false;
  let exitCode: number | null = null;
  let exited = false;
  let finalized = false;

  const finalize = (): void => {
    if (finalized || !outputClosed || !exited) return;
    finalized = true;
    const runtimeError = getError();
    if (exitCode !== 0 && exitCode !== null) {
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
      const detail = stderr ? `: ${stderr.slice(0, 500)}` : '';
      events.push({
        type: 'error',
        message: `agy exited with code ${exitCode}${detail}`,
        terminationReason: 'failed',
      });
    } else if (runtimeError) {
      events.push({
        type: 'error',
        message: `agy runtime error: ${runtimeError.message}`,
        terminationReason: 'failed',
      });
    }
    events.close();
  };

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      for (const event of translateEvent(JSON.parse(trimmed))) events.push(event);
    } catch {
      // agy can emit terminal noise around stream-json output.
    }
  });
  rl.once('close', () => {
    outputClosed = true;
    finalize();
  });
  child.once('exit', (code) => {
    exitCode = code;
    exited = true;
    finalize();
  });
  child.once('error', () => {
    if (child.stdout.readableEnded) {
      outputClosed = true;
      finalize();
    }
  });
  return events;
}

function isWindowsCommandNotFoundLine(line: string): boolean {
  return (
    process.platform === 'win32' &&
    /is not recognized as an internal or external command|operable program or batch file/i.test(line)
  );
}

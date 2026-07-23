import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { join } from 'node:path';
import type { SandboxMode } from '../../config/profile-schema';
import { log } from '../../core/logger';
import { AsyncEventQueue } from '../event-queue';
import { mergeProcessEnv, spawnProcess, type SpawnedProcessByStdio } from '../../platform/spawn';
import { SpawnFailed } from '../../runtime/errors';
import { prefixBridgeSystemPrompt } from '../bridge-system-prompt';
import { buildLarkChannelEnv, type LarkChannelEnvContext } from '../lark-channel-env';
import { LiveSessionPool, type LiveTerminalBackend } from '../live-session';
import {
  captureTmuxPaneTail,
  TmuxBindingController,
  type AgentTmuxControl,
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
import { buildCodexArgs } from './argv';
import { CodexJsonlTranslator, type CodexFinishReason } from './jsonl';

export interface CodexAdapterOptions {
  binary: string;
  profileStateDir: string;
  codexHome?: string;
  inheritCodexHome?: boolean;
  ignoreUserConfig?: boolean;
  ignoreRules?: boolean;
  sandbox?: SandboxMode;
  stopGraceMs?: number;
  larkChannel?: LarkChannelEnvContext;
  sessionMode?: 'turn' | 'live';
  liveUsePty?: boolean;
  liveTerminalBackend?: LiveTerminalBackend;
  liveIdleMs?: number;
}

type CodexChild = SpawnedProcessByStdio<Writable, Readable, Readable>;

export class CodexAdapter implements AgentAdapter {
  readonly id = 'codex';
  readonly displayName = 'Codex CLI';
  readonly tmux: AgentTmuxControl;

  private readonly binary: string;
  private readonly profileStateDir: string;
  private readonly codexHome: string | undefined;
  private readonly inheritCodexHome: boolean;
  private readonly ignoreUserConfig: boolean;
  private readonly ignoreRules: boolean;
  private readonly sandbox: SandboxMode;
  private readonly defaultStopGraceMs: number;
  private readonly larkChannel: LarkChannelEnvContext | undefined;
  private readonly sessionMode: 'turn' | 'live';
  private readonly liveUsePty: boolean | undefined;
  private readonly liveTerminalBackend: LiveTerminalBackend | undefined;
  private readonly liveIdleMs: number | undefined;
  private readonly liveSessions = new LiveSessionPool();
  private readonly tmuxBindings: TmuxBindingController;
  private botIdentity: AgentBotIdentity | undefined;

  constructor(opts: CodexAdapterOptions) {
    this.binary = opts.binary;
    this.profileStateDir = opts.profileStateDir;
    this.codexHome = opts.codexHome;
    this.inheritCodexHome = opts.inheritCodexHome !== false;
    this.ignoreUserConfig = opts.ignoreUserConfig === true;
    this.ignoreRules = opts.ignoreRules !== false;
    this.sandbox = opts.sandbox ?? 'danger-full-access';
    this.defaultStopGraceMs = opts.stopGraceMs ?? 5000;
    this.larkChannel = opts.larkChannel;
    this.sessionMode = opts.sessionMode ?? 'turn';
    this.liveUsePty = opts.liveUsePty;
    this.liveTerminalBackend = opts.liveTerminalBackend;
    this.liveIdleMs = opts.liveIdleMs;
    this.tmuxBindings = new TmuxBindingController(
      opts.profileStateDir,
      opts.larkChannel?.profile ?? 'codex',
      'codex',
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
      status: (scopeId) => this.tmuxStatus(scopeId),
      tail: async (scopeId, lineCount) => {
        const terminal = tmuxTerminalForStatus(await this.tmuxStatus(scopeId));
        return captureTmuxPaneTail(terminal, lineCount);
      },
    };
  }

  setBotIdentity(identity: AgentBotIdentity): void {
    this.botIdentity = identity;
  }

  private async tmuxStatus(scopeId: string): Promise<TmuxBindingStatus> {
    const binding = await this.tmuxBindings.status(scopeId);
    if (binding.state !== 'none') return binding;
    const terminal = this.liveSessions.terminalInfo(scopeId);
    if (!terminal?.attachCommand || !terminal.socketPath || !terminal.target) return binding;
    return {
      state: terminal.ownership === 'external' ? 'external' as const : 'managed' as const,
      terminal: {
        socketPath: terminal.socketPath,
        target: terminal.target,
        attachCommand: terminal.attachCommand,
        ownership: terminal.ownership ?? 'managed',
      },
    };
  }

  async isAvailable(): Promise<boolean> {
    return (await this.checkAvailability()).ok;
  }

  async checkAvailability(): Promise<AgentAvailability> {
    return checkAgentAvailability({
      agentId: 'codex',
      agentName: 'Codex CLI',
      command: this.binary,
      binaryPath: this.binary,
    });
  }

  async prepareRun(): Promise<void> {
    const availability = await this.checkAvailability();
    if (!availability.ok) {
      throw new SpawnFailed(
        'codex binary check failed',
        availability.error,
        availability.diagnostic.code,
        availability.diagnostic,
      );
    }
  }

  run(opts: AgentRunOptions): AgentRun {
    if (!opts.cwd) {
      throw new Error('cwd is required for CodexAdapter.run');
    }
    const sessionMode = opts.sessionMode ?? this.sessionMode;
    if (sessionMode === 'live') {
      return this.runLive(opts);
    }

    const args = buildCodexArgs({
      cwd: opts.cwd,
      sandbox: opts.sandbox ?? this.sandbox,
      threadId: opts.threadId,
      images: opts.images,
      ignoreUserConfig: this.ignoreUserConfig,
      ignoreRules: this.ignoreRules,
      model: opts.model,
      reasoningEffort: opts.reasoningEffort,
    });
    const envOverrides: NodeJS.ProcessEnv = buildLarkChannelEnv(this.larkChannel);
    if (this.codexHome) {
      envOverrides.CODEX_HOME = this.codexHome;
    } else if (!this.inheritCodexHome) {
      envOverrides.CODEX_HOME = join(this.profileStateDir, 'codex-home');
    }
    const child = spawnProcess(this.binary, args, {
      cwd: opts.cwd,
      env: mergeProcessEnv(process.env, envOverrides),
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as CodexChild;

    log.info('agent', 'spawn', {
      pid: child.pid ?? null,
      cwd: opts.cwd,
      hasThread: Boolean(opts.threadId),
      promptChars: opts.prompt.length,
      images: opts.images?.length ?? 0,
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
          runtimeError = new Error(`failed to spawn codex: ${line.trim()}`);
          child.stdout.destroy();
          child.kill();
        }
        nl = stderrBuffer.indexOf('\n');
      }
    });

    let stopReason: CodexFinishReason | undefined;
    child.on('error', (err) => {
      runtimeError = err;
    });
    child.on('exit', (code, signal) => {
      log.info('agent', 'exit', { pid: child.pid ?? null, code, signal });
    });
    child.stdin.on('error', (err) => {
      log.warn('agent', 'stdin-error', { message: err.message });
    });
    const events = createEventStream(child, stderrChunks, () => runtimeError, () => stopReason);
    child.stdin.end(
      opts.threadId ? opts.prompt : prefixBridgeSystemPrompt(opts.prompt, this.botIdentity),
      'utf8',
    );

    const stopGraceMs = opts.stopGraceMs ?? this.defaultStopGraceMs;

    return {
      runId: opts.runId,
      events,
      async stop() {
        if (child.exitCode !== null || child.signalCode !== null) return;
        stopReason = 'interrupted';
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
      throw new Error('cwd is required for CodexAdapter.run');
    }
    const sandbox = opts.sandbox ?? this.sandbox;
    const args = [
      '--sandbox',
      sandbox,
      ...(opts.model ? ['--model', opts.model] : []),
      ...(opts.reasoningEffort
        ? ['-c', `model_reasoning_effort="${opts.reasoningEffort}"`]
        : []),
      '-C',
      opts.cwd,
    ];
    const envOverrides: NodeJS.ProcessEnv = buildLarkChannelEnv(this.larkChannel);
    if (this.codexHome) {
      envOverrides.CODEX_HOME = this.codexHome;
    } else if (!this.inheritCodexHome) {
      envOverrides.CODEX_HOME = join(this.profileStateDir, 'codex-home');
    }
    const signature = JSON.stringify({
      cwd: opts.cwd,
      sandbox,
      codexHome: envOverrides.CODEX_HOME ?? null,
    });
    const scopeKey = opts.scopeId ?? opts.cwd;
    const tmuxTarget = this.tmuxBindings.bindingFor(scopeKey, opts.cwd);
    const session = this.liveSessions.getOrCreate(scopeKey, {
      command: this.binary,
      args,
      cwd: opts.cwd,
      env: envOverrides,
      signature: `${signature}:${tmuxTarget ? `${tmuxTarget.socketPath}:${tmuxTarget.paneId}` : 'managed'}`,
      usePty: this.liveUsePty,
      backend: this.liveTerminalBackend ?? 'tmux',
      idleMs: this.liveIdleMs,
      tmuxSessionName: this.tmuxBindings.managedSessionName(scopeKey),
      tmuxProfile: this.larkChannel?.profile ?? 'codex',
      tmuxScopeId: scopeKey,
      tmuxTarget,
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
  child: CodexChild,
  stderrChunks: Buffer[],
  getError: () => Error | null,
  getStopReason: () => CodexFinishReason | undefined,
): AsyncIterable<AgentEvent> {
  const events = new AsyncEventQueue<AgentEvent>();
  const translator = new CodexJsonlTranslator();
  if (!child.pid) {
    const err = getError();
    queueMicrotask(() => {
      events.push({
        type: 'error',
        message: err ? `failed to spawn codex: ${err.message}` : 'spawn returned no pid',
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
    const stopReason = getStopReason();
    if (stopReason) {
      for (const event of translator.finish(stopReason)) events.push(event);
    } else {
      const runtimeError = getError();
      if (exitCode !== 0 && exitCode !== null) {
        if (!translator.terminalEmitted()) {
          const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
          const detail = stderr ? `: ${stderr.slice(0, 500)}` : '';
          events.push(terminalError(`codex exited with code ${exitCode}${detail}`));
        }
      } else if (runtimeError && !translator.terminalEmitted()) {
        events.push(terminalError(`codex runtime error: ${runtimeError.message}`));
      } else {
        for (const event of translator.finish()) events.push(event);
      }
    }
    events.close();
  };

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      for (const event of translator.translate(JSON.parse(trimmed))) events.push(event);
    } catch {
      // Codex occasionally writes non-JSON terminal noise to stdout.
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

function terminalError(message: string): AgentEvent {
  return {
    type: 'error',
    message,
    terminationReason: 'failed',
  };
}

function isWindowsCommandNotFoundLine(line: string): boolean {
  return (
    process.platform === 'win32' &&
    /is not recognized as an internal or external command|operable program or batch file/i.test(line)
  );
}

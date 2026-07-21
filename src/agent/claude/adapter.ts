import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { log } from '../../core/logger';
import { AsyncEventQueue } from '../event-queue';
import { mergeProcessEnv, spawnProcess, type SpawnedProcessByStdio } from '../../platform/spawn';
import { buildBridgeSystemPrompt } from '../bridge-system-prompt';
import { buildLarkChannelEnv, type LarkChannelEnvContext } from '../lark-channel-env';
import { LiveSessionPool, type LiveTerminalBackend } from '../live-session';
import { TmuxBindingController, type AgentTmuxControl } from '../tmux-control';
import { checkAgentAvailability, type AgentAvailability } from '../preflight';
import {
  CLAUDE_DEFAULT_PERMISSION_MODE,
  type AgentAdapter,
  type AgentBotIdentity,
  type AgentEvent,
  type AgentRun,
  type AgentRunOptions,
} from '../types';
import { translateEvent } from './stream-json';

export interface ClaudeAdapterOptions {
  binary?: string;
  profileStateDir?: string;
  larkChannel?: LarkChannelEnvContext;
  sessionMode?: 'turn' | 'live';
  liveUsePty?: boolean;
  liveTerminalBackend?: LiveTerminalBackend;
  liveIdleMs?: number;
}

type ClaudeChild = SpawnedProcessByStdio<Writable, Readable, Readable>;

export class ClaudeAdapter implements AgentAdapter {
  readonly id = 'claude';
  readonly displayName = 'Claude Code';
  readonly tmux: AgentTmuxControl;

  private readonly binary: string;
  private readonly larkChannel: LarkChannelEnvContext | undefined;
  private readonly sessionMode: 'turn' | 'live';
  private readonly liveUsePty: boolean | undefined;
  private readonly liveTerminalBackend: LiveTerminalBackend | undefined;
  private readonly liveIdleMs: number | undefined;
  private readonly liveSessions = new LiveSessionPool();
  private readonly tmuxBindings: TmuxBindingController;
  private botIdentity: AgentBotIdentity | undefined;

  constructor(opts: ClaudeAdapterOptions = {}) {
    this.binary = opts.binary ?? 'claude';
    this.larkChannel = opts.larkChannel;
    this.sessionMode = opts.sessionMode ?? 'turn';
    this.liveUsePty = opts.liveUsePty;
    this.liveTerminalBackend = opts.liveTerminalBackend;
    this.liveIdleMs = opts.liveIdleMs;
    const profileStateDir = opts.profileStateDir ?? join(tmpdir(), `arg-bridge-${process.pid}-claude`);
    this.tmuxBindings = new TmuxBindingController(
      profileStateDir,
      opts.larkChannel?.profile ?? 'claude',
      'claude',
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
      status: async (scopeId) => {
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
      },
    };
  }

  setBotIdentity(identity: AgentBotIdentity): void {
    this.botIdentity = identity;
  }

  async isAvailable(): Promise<boolean> {
    return (await this.checkAvailability()).ok;
  }

  async checkAvailability(): Promise<AgentAvailability> {
    return checkAgentAvailability({
      agentId: 'claude',
      agentName: 'Claude Code',
      command: this.binary,
      binaryPath: this.binary,
    });
  }

  run(opts: AgentRunOptions): AgentRun {
    if (!opts.cwd) {
      throw new Error('cwd is required for ClaudeAdapter.run');
    }
    const sessionMode = opts.sessionMode ?? this.sessionMode;
    if (sessionMode === 'live') {
      return this.runLive(opts);
    }

    // The prompt and bridge system prompt must NOT go through argv. On Windows,
    // `claude` resolves to a `claude.cmd` shim and cross-spawn routes it through
    // `cmd.exe /d /s /c`, which interprets `<` and `>` as redirection operators
    // — that silently eats the prompt's `<bridge_context>` XML, so claude runs
    // with an empty request and replies with its default greeting instead of a
    // stream-json response. Pass the prompt via stdin and the appended system
    // prompt via a temp file (the same approach the Codex adapter uses) so no
    // special characters ever reach the shell.
    const systemPromptFile = writeSystemPromptFile(buildBridgeSystemPrompt(this.botIdentity));

    const args = [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      opts.permissionMode ?? CLAUDE_DEFAULT_PERMISSION_MODE,
      '--append-system-prompt-file',
      systemPromptFile.path,
    ];
    if (opts.sessionId) args.push('--resume', opts.sessionId);
    if (opts.model) args.push('--model', opts.model);

    const child = spawnProcess(this.binary, args, {
      cwd: opts.cwd,
      env: mergeProcessEnv(process.env, buildLarkChannelEnv(this.larkChannel)),
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ClaudeChild;

    log.info('agent', 'spawn', {
      pid: child.pid ?? null,
      cwd: opts.cwd ?? process.cwd(),
      hasSession: Boolean(opts.sessionId),
      promptChars: opts.prompt.length,
      model: opts.model,
    });

    // Listeners MUST be attached synchronously here, before we return.
    // The 'error' and exit-related events can fire in the next tick; if we
    // defer attachment to the async-generator body, those events fire into
    // the void and the generator hangs.
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
          runtimeError = new Error(`failed to spawn claude: ${line.trim()}`);
          child.stdout.destroy();
          child.kill();
        }
        nl = stderrBuffer.indexOf('\n');
      }
    });

    child.on('error', (err) => {
      runtimeError = err;
      systemPromptFile.cleanup();
    });
    child.on('exit', (code, signal) => {
      log.info('agent', 'exit', { pid: child.pid ?? null, code, signal });
      systemPromptFile.cleanup();
    });
    child.stdin.on('error', (err) => {
      log.warn('agent', 'stdin-error', { message: err.message });
    });
    const events = createEventStream(child, stderrChunks, () => runtimeError);
    child.stdin.end(opts.prompt, 'utf8');

    // Default 5s if caller didn't specify — claude often has live
    // subprocesses (lark-cli waiting for OAuth, long Bash, etc.) and the
    // old 500ms was nowhere near enough for them to flush state before the
    // SIGKILL cascade. Callers (channel.ts, /doctor) override per-run with
    // a value derived from preferences.
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
      throw new Error('cwd is required for ClaudeAdapter.run');
    }
    const args = [
      '--permission-mode',
      opts.permissionMode ?? CLAUDE_DEFAULT_PERMISSION_MODE,
    ];
    if (opts.model) args.push('--model', opts.model);
    const signature = JSON.stringify({
      cwd: opts.cwd,
      model: opts.model ?? null,
      permissionMode: opts.permissionMode ?? CLAUDE_DEFAULT_PERMISSION_MODE,
    });
    const scopeKey = opts.scopeId ?? opts.cwd;
    const tmuxTarget = this.tmuxBindings.bindingFor(scopeKey, opts.cwd);
    const session = this.liveSessions.getOrCreate(scopeKey, {
      command: this.binary,
      args,
      cwd: opts.cwd,
      env: buildLarkChannelEnv(this.larkChannel),
      signature: `${signature}:${tmuxTarget ? `${tmuxTarget.socketPath}:${tmuxTarget.paneId}` : 'managed'}`,
      usePty: this.liveUsePty,
      backend: this.liveTerminalBackend ?? 'tmux',
      idleMs: this.liveIdleMs,
      tmuxSessionName: this.tmuxBindings.managedSessionName(scopeKey),
      tmuxProfile: this.larkChannel?.profile ?? 'claude',
      tmuxScopeId: scopeKey,
      tmuxTarget,
    });
    return session.run(opts.runId, opts.prompt, opts.cwd, opts.liveInputMode);
  }
}

function createEventStream(
  child: ClaudeChild,
  stderrChunks: Buffer[],
  getError: () => Error | null,
): AsyncIterable<AgentEvent> {
  const events = new AsyncEventQueue<AgentEvent>();
  // If fork itself failed synchronously, child.pid is undefined. The 'error'
  // event (ENOENT etc.) fires in the next tick, so also check getError().
  if (!child.pid) {
    const err = getError();
    queueMicrotask(() => {
      events.push({
        type: 'error',
        message: err ? `failed to spawn claude: ${err.message}` : 'spawn returned no pid',
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
        message: `claude exited with code ${exitCode}${detail}`,
        terminationReason: 'failed',
      });
    } else if (runtimeError) {
      events.push({
        type: 'error',
        message: `claude runtime error: ${runtimeError.message}`,
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
      // Claude can emit terminal noise around stream-json output.
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

/**
 * Persist the appended system prompt to a throwaway temp file so it can be
 * passed via `--append-system-prompt-file` instead of argv. Returns the path
 * plus an idempotent, best-effort cleanup that removes the temp directory.
 */
function writeSystemPromptFile(content: string): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'lark-claude-'));
  const path = join(dir, 'append-system-prompt.md');
  writeFileSync(path, content, 'utf8');
  return {
    path,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort: the OS will reclaim the temp dir eventually
      }
    },
  };
}

function isWindowsCommandNotFoundLine(line: string): boolean {
  return (
    process.platform === 'win32' &&
    /is not recognized as an internal or external command|operable program or batch file/i.test(line)
  );
}

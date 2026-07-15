import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { Readable, Writable } from 'node:stream';
import { log } from '../core/logger';
import {
  mergeProcessEnv,
  spawnProcess,
  spawnProcessSync,
  type SpawnedProcessByStdio,
} from '../platform/spawn';
import type { AgentEvent, AgentRun } from './types';

export type LiveTerminalInputMode = 'command' | 'control';

type LiveChild = SpawnedProcessByStdio<Writable, Readable, Readable>;
type LiveOutput = {
  mode: 'append' | 'snapshot';
  /** Cleaned content eligible for delivery to the chat. */
  text: string;
  /** Terminal snapshot before presentation-only chrome is stripped. */
  terminalText?: string;
};
export type LiveTerminalBackend = 'auto' | 'tmux' | 'pty' | 'pipe';

interface LiveTerminalInfo {
  backend: 'tmux' | 'pty' | 'pipe';
  socketName?: string;
  sessionName?: string;
  target?: string;
  attachCommand?: string;
}

export interface LiveSessionCommand {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  signature: string;
  usePty?: boolean;
  backend?: LiveTerminalBackend;
  idleMs?: number;
  outputFlushMs?: number;
  startupTimeoutMs?: number;
  cleanup?: () => void;
}

const DEFAULT_IDLE_MS = 3500;
const DEFAULT_OUTPUT_FLUSH_MS = 500;
const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const STARTUP_INPUT_GRACE_MS = 25;
const COMMAND_FRESH_SESSION_GRACE_MS = 1200;
const FRESH_TERMINAL_GRACE_MS = 2500;
const CONTROL_KEY_GAP_MS = 40;
const COMMAND_ESCAPE_SETTLE_MS = 250;
const COMMAND_CLEAR_SETTLE_MS = 500;
const COMMAND_STARTUP_TIMEOUT_MS = 25_000;
const COMMAND_IDLE_MS = 2_500;
const COMMAND_NO_OUTPUT_IDLE_MS = 8_000;
const COMPACT_NO_OUTPUT_IDLE_MS = 60_000;
const CONTROL_LITERAL_CONFIRM_DELAY_MS = 900;
const MAX_TURN_OUTPUT_CHARS = 120_000;
const DEFAULT_PTY_ROWS = '48';
const DEFAULT_PTY_COLUMNS = '120';
const LIVE_DIAG_PREVIEW_CHARS = 800;
const LIVE_DIAG_MAX_FRAMES = 8;

export class LiveSessionPool {
  private readonly sessions = new Map<string, LiveTerminalSession>();

  getOrCreate(key: string, command: LiveSessionCommand): LiveTerminalSession {
    const existing = this.sessions.get(key);
    if (existing && existing.signature === command.signature && existing.isAlive()) {
      command.cleanup?.();
      return existing;
    }
    if (existing) void existing.close('replace').catch(() => {});
    const session = new LiveTerminalSession(command, () => {
      if (this.sessions.get(key) === session) this.sessions.delete(key);
    });
    this.sessions.set(key, session);
    return session;
  }

  async closeAll(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(sessions.map((session) => session.close('shutdown')));
  }
}

export class LiveTerminalSession {
  readonly signature: string;

  private readonly opts: LiveSessionCommand;
  private readonly onClose: () => void;
  private readonly emitter = new EventEmitter();
  private readonly cleaner = new TerminalOutputCleaner();
  private child: LiveChild | undefined;
  private terminalInfo: LiveTerminalInfo | undefined;
  private closed = false;
  private primed = false;
  private startedAt = 0;
  private activeTurnCleanup: (() => void) | undefined;
  private lastTerminalSnapshot = '';

  constructor(opts: LiveSessionCommand, onClose: () => void = () => {}) {
    this.opts = opts;
    this.signature = opts.signature;
    this.onClose = onClose;
  }

  isAlive(): boolean {
    return Boolean(this.child?.pid && this.child.exitCode === null && this.child.signalCode === null);
  }

  /**
   * Returns true exactly once per session (the first call), false afterwards.
   * A persistent live session retains conversation context across turns, so
   * the (large) bridge system prompt only needs to be sent on the first turn —
   * re-sending it every turn floods the CLI's TUI (it gets echoed) and buries
   * the real answer. The pool creates a fresh session (primed=false) whenever
   * the process is replaced/dies, so priming re-runs when needed.
   */
  takePrimeSlot(): boolean {
    if (this.primed) return false;
    this.primed = true;
    return true;
  }

  run(runId: string, prompt: string, cwd: string, inputMode?: LiveTerminalInputMode): AgentRun {
    void this.ensureStarted();
    const events = this.turnEvents(prompt, cwd, inputMode);
    return {
      runId,
      events,
      stop: async () => {
        this.write('\x03');
      },
      waitForExit: async () => true,
    };
  }

  async close(reason: string): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const child = this.child;
    if (child && child.exitCode === null && child.signalCode === null) {
      log.info('agent-live', 'close', { pid: child.pid ?? null, reason });
      child.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
          resolve();
        }, 2000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    this.opts.cleanup?.();
    this.onClose();
  }

  private async ensureStarted(): Promise<void> {
    if (this.isAlive()) return;
    if (this.closed) throw new Error('live session is closed');

    const spawned = spawnLiveProcess(this.opts);
    this.child = spawned.child;
    this.terminalInfo = spawned.terminal;
    this.startedAt = Date.now();
    const child = spawned.child;
    log.info('agent-live', 'spawn', {
      pid: child.pid ?? null,
      cwd: this.opts.cwd,
      command: spawned.command,
      pty: spawned.pty,
      terminal: spawned.terminal,
    });
    this.cleaner.setScreenMode(spawned.pty);

    child.stdout.on('data', (chunk: Buffer) => this.emitData(chunk));
    child.stderr.on('data', (chunk: Buffer) => this.emitData(chunk));
    child.on('error', (err) => {
      this.emitter.emit('error', err);
      void this.close('error').catch(() => {});
    });
    child.on('exit', (code, signal) => {
      log.info('agent-live', 'exit', { pid: child.pid ?? null, code, signal });
      this.emitter.emit('exit', { code, signal });
      this.opts.cleanup?.();
      this.onClose();
    });
    child.stdin.on('error', (err) => {
      log.warn('agent-live', 'stdin-error', { message: err.message });
    });
  }

  private emitData(chunk: Buffer): void {
    const output = this.cleaner.push(chunk.toString('utf8'));
    if (output.mode === 'snapshot' && output.text.trim()) {
      this.lastTerminalSnapshot = output.text;
    }
    if (!output.text.trim() && !output.terminalText?.trim()) return;
    this.emitter.emit('data', output);
  }

  private write(input: string): void {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.stdin.write(
      this.terminalInfo?.backend === 'tmux' ? encodeTmuxInputFrame(input) : input,
    );
  }

  private async *turnEvents(
    prompt: string,
    cwd: string,
    inputMode?: LiveTerminalInputMode,
  ): AsyncGenerator<AgentEvent> {
    yield { type: 'system', cwd };

    const commandMode = inputMode === 'command';
    const idleMs =
      commandMode
        ? Math.max(this.opts.idleMs ?? DEFAULT_IDLE_MS, COMMAND_IDLE_MS)
        : (this.opts.idleMs ?? DEFAULT_IDLE_MS);
    const outputFlushMs = this.opts.outputFlushMs ?? DEFAULT_OUTPUT_FLUSH_MS;
    const startupTimeoutMs =
      commandMode
        ? Math.max(this.opts.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS, COMMAND_STARTUP_TIMEOUT_MS)
        : (this.opts.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS);
    const output = new TurnOutputBuffer(MAX_TURN_OUTPUT_CHARS, prompt, commandMode || inputMode === 'control');
    const queue: AgentEvent[] = [];
    let done = false;
    let wake: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let outputTimer: ReturnType<typeof setTimeout> | undefined;
    let slashConfirmTimer: ReturnType<typeof setTimeout> | undefined;
    let controlLiteralConfirmTimer: ReturnType<typeof setTimeout> | undefined;
    let acceptingOutput = false;
    let diagFrames = 0;
    let sawAcceptedOutput = false;
    let sawCommandResultOutput = false;
    let deliveredText = false;
    let slashConfirmCount = 0;
    let terminalWasBusy = false;
    const inputGraceMs = this.inputGraceMs(commandMode);
    const inputReadyAt = Date.now() + inputGraceMs;

    if (commandMode) {
      log.info('agent-live', 'command-start', {
        commandText: prompt,
        idleMs,
        startupTimeoutMs,
        outputFlushMs,
      });
    }

    const push = (event: AgentEvent): void => {
      queue.push(event);
      wake?.();
    };
    const flushOutput = (): void => {
      if (outputTimer) clearTimeout(outputTimer);
      outputTimer = undefined;
      const delta = output.take();
      if (commandMode) {
        log.info('agent-live', 'command-flush', {
          hasDelta: Boolean(delta),
          chars: delta.length,
          deltaPreview: previewLiveText(delta),
        });
      }
      if (delta) {
        deliveredText = true;
        push({ type: 'text', delta });
      }
    };
    const scheduleOutputFlush = (): void => {
      if (outputTimer) return;
      outputTimer = setTimeout(flushOutput, outputFlushMs);
    };
    const finish = (): void => {
      if (done) return;
      done = true;
      if (commandMode) log.info('agent-live', 'command-finish', { reason: 'idle-or-startup' });
      if (timer) clearTimeout(timer);
      if (controlLiteralConfirmTimer) clearTimeout(controlLiteralConfirmTimer);
      flushOutput();
      if (commandMode && !deliveredText && isStatusLiveCommand(prompt)) {
        push({ type: 'text', delta: buildLiveStatusFallback(this.opts, cwd, this.terminalInfo) });
      }
      push({ type: 'done', terminationReason: 'normal' });
    };
    const arm = (ms: number): void => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(finish, ms);
    };
    const suspendIdle = (): void => {
      if (timer) clearTimeout(timer);
      timer = undefined;
    };
    const scheduleSlashCommandConfirm = (): void => {
      if (!commandMode || slashConfirmCount >= 2 || slashConfirmTimer || sawCommandResultOutput) return;
      if (!prompt.trim().startsWith('/')) return;
      slashConfirmTimer = setTimeout(() => {
        slashConfirmTimer = undefined;
        if (done || sawCommandResultOutput || slashConfirmCount >= 2) return;
        slashConfirmCount += 1;
        log.info('agent-live', 'command-confirm', { commandText: prompt, attempt: slashConfirmCount });
        this.write('\r');
        if (isStatusLiveCommand(prompt) && slashConfirmCount >= 2) arm(idleMs);
      }, 200);
    };

    const onData = (event: LiveOutput): void => {
      if (!acceptingOutput) {
        if (commandMode && diagFrames < LIVE_DIAG_MAX_FRAMES) {
          diagFrames += 1;
          log.info('agent-live', 'command-pre-output', {
            mode: event.mode,
            textPreview: previewLiveText(event.text),
          });
        }
        arm(startupTimeoutMs + Math.max(0, inputReadyAt - Date.now()));
        return;
      }
      // Only PTY/tmux screen snapshots carry terminal lifecycle state. Pipe
      // adapters can legitimately print words such as "Working" as ordinary
      // task output and must retain the normal idle completion behavior.
      const terminalState = event.terminalText;
      const terminalBusy = terminalState ? isLiveTerminalBusy(terminalState) : false;
      if (terminalBusy) {
        terminalWasBusy = true;
        suspendIdle();
      } else if (terminalWasBusy) {
        // A full-screen terminal can publish an intermediate redraw that
        // temporarily omits Codex's Working footer. Do not release the turn
        // (and let the next queued chat message type into the active editor)
        // until the CLI has rendered its fresh, empty input prompt.
        if (terminalState && (isLiveTerminalReady(terminalState) || isLiveTerminalInteraction(terminalState))) {
          terminalWasBusy = false;
          arm(idleMs);
        } else {
          suspendIdle();
        }
      }
      const text = sanitizeLiveTurnOutput(event.text, prompt);
      const beforeAppendFrame = commandMode && diagFrames < LIVE_DIAG_MAX_FRAMES;
      if (beforeAppendFrame) diagFrames += 1;
      if (!text) {
        if (terminalWasBusy) return;
        if (commandMode) {
          arm(isStatusLiveCommand(prompt) || sawAcceptedOutput || isKnownSilentLiveCommand(prompt)
            ? idleMs
            : noOutputIdleMs(prompt, idleMs));
        }
        return;
      }
      const accepted = event.mode === 'snapshot' ? output.replace(text) : output.append(text);
      if (beforeAppendFrame) {
        log.info('agent-live', 'command-output', {
          mode: event.mode,
          accepted,
          rawPreview: previewLiveText(event.text),
          sanitizedPreview: previewLiveText(text),
        });
      }
      if (accepted) {
        const resultOutput = isLiveCommandResultOutput(text, prompt);
        if (controlLiteralConfirmTimer) {
          clearTimeout(controlLiteralConfirmTimer);
          controlLiteralConfirmTimer = undefined;
          log.info('agent-live', 'control-literal-output-before-enter', { input: prompt });
        }
        sawAcceptedOutput = true;
        if (resultOutput) sawCommandResultOutput = true;
        scheduleOutputFlush();
        if (!terminalWasBusy) arm(idleMs);
        if (commandMode && !resultOutput) scheduleSlashCommandConfirm();
      } else if (commandMode) {
        scheduleSlashCommandConfirm();
        if (!terminalWasBusy) {
          arm(sawAcceptedOutput ? idleMs : noOutputIdleMs(prompt, idleMs));
        }
      }
    };
    const onExit = (evt: { code: number | null; signal: NodeJS.Signals | null }): void => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      flushOutput();
      const detail = evt.signal ? `signal ${evt.signal}` : `code ${evt.code ?? 0}`;
      push({
        type: evt.code && evt.code !== 0 ? 'error' : 'done',
        ...(evt.code && evt.code !== 0
          ? { message: `live agent exited with ${detail}`, terminationReason: 'failed' as const }
          : { terminationReason: 'normal' as const }),
      } as AgentEvent);
    };
    const onError = (err: Error): void => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      flushOutput();
      push({ type: 'error', message: `live agent failed: ${err.message}`, terminationReason: 'failed' });
    };

    let turnCleaned = false;
    const cleanupTurn = (): void => {
      if (turnCleaned) return;
      turnCleaned = true;
      done = true;
      if (timer) clearTimeout(timer);
      if (outputTimer) clearTimeout(outputTimer);
      if (slashConfirmTimer) clearTimeout(slashConfirmTimer);
      if (controlLiteralConfirmTimer) clearTimeout(controlLiteralConfirmTimer);
      this.emitter.off('data', onData);
      this.emitter.off('exit', onExit);
      this.emitter.off('error', onError);
      if (this.activeTurnCleanup === cleanupTurn) this.activeTurnCleanup = undefined;
      wake?.();
    };

    this.activeTurnCleanup?.();
    this.activeTurnCleanup = cleanupTurn;
    this.emitter.on('data', onData);
    this.emitter.once('exit', onExit);
    this.emitter.once('error', onError);
    try {
      arm(startupTimeoutMs + inputGraceMs);
      await delay(inputGraceMs);
      if (!done) {
        this.cleaner.resetTurn();
        output.setSnapshotBaseline(this.lastTerminalSnapshot);
        if (commandMode) {
          log.info('agent-live', 'command-clear', { sequence: 'esc ctrl-a ctrl-k' });
          await this.clearPendingInput();
          this.cleaner.resetTurn();
        }
        acceptingOutput = true;
        const controlKeys = inputMode === 'control' ? parseLiveControlSequence(prompt) : null;
        if (controlKeys) {
          // Send each key as its own write so the tmux backend (which matches a
          // single key per stdin chunk) sees them individually; a small gap keeps
          // the writes from coalescing into one unrecognized chunk.
          for (let i = 0; i < controlKeys.length; i++) {
            if (i > 0) await delay(CONTROL_KEY_GAP_MS);
            this.write(controlKeys[i]!);
          }
        } else {
          if (commandMode) log.info('agent-live', 'command-submit', { commandText: prompt });
          if (inputMode === 'control' && shouldDeferControlLiteralSubmit(prompt)) {
            log.info('agent-live', 'control-literal-type', { input: prompt });
            this.write(prompt);
            controlLiteralConfirmTimer = setTimeout(() => {
              controlLiteralConfirmTimer = undefined;
              if (done || sawAcceptedOutput) return;
              log.info('agent-live', 'control-literal-confirm', { input: prompt });
              this.write('\r');
            }, CONTROL_LITERAL_CONFIRM_DELAY_MS);
          } else {
            this.write(`${prompt}\r`);
            scheduleSlashCommandConfirm();
          }
        }
        if (commandMode && isKnownSilentLiveCommand(prompt)) arm(idleMs);
        else if (commandMode && isSlowSilentLiveCommand(prompt)) {
          arm(noOutputIdleMs(prompt, idleMs));
        }
      }

      while (!done || queue.length > 0) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          wake = undefined;
          continue;
        }
        const event = queue.shift();
        if (event) yield event;
      }
    } finally {
      cleanupTurn();
    }
  }

  private async clearPendingInput(): Promise<void> {
    this.write('\x1B');
    await delay(COMMAND_ESCAPE_SETTLE_MS);
    this.write('\x01');
    await delay(CONTROL_KEY_GAP_MS);
    this.write('\x0B');
    await delay(COMMAND_CLEAR_SETTLE_MS);
  }

  private inputGraceMs(commandMode: boolean): number {
    if (!this.startedAt) return STARTUP_INPUT_GRACE_MS;
    const ageMs = Date.now() - this.startedAt;
    if (this.terminalInfo?.backend !== 'pipe') {
      return Math.max(STARTUP_INPUT_GRACE_MS, FRESH_TERMINAL_GRACE_MS - ageMs);
    }
    if (!commandMode) return STARTUP_INPUT_GRACE_MS;
    const freshSessionGraceMs = COMMAND_FRESH_SESSION_GRACE_MS;
    return Math.max(STARTUP_INPUT_GRACE_MS, freshSessionGraceMs - ageMs);
  }
}

function spawnLiveProcess(opts: LiveSessionCommand): {
  child: LiveChild;
  command: string;
  pty: boolean;
  terminal: LiveTerminalInfo;
} {
  const ptyRows = positiveIntString(opts.env?.LINES) ?? DEFAULT_PTY_ROWS;
  const ptyColumns = positiveIntString(opts.env?.COLUMNS) ?? DEFAULT_PTY_COLUMNS;
  const { COLUMNS: _ignoredColumns, LINES: _ignoredLines, ...agentEnv } = opts.env ?? {};
  const env = mergeProcessEnv(process.env, {
    TERM: process.env.TERM || 'xterm-256color',
    ...agentEnv,
    COLUMNS: ptyColumns,
    LINES: ptyRows,
  });
  const backend = opts.usePty === false ? 'pipe' : opts.backend ?? 'auto';
  if (backend !== 'pipe' && process.platform === 'linux') {
    const commandLine = liveCommandLine(opts.command, opts.args, ptyRows, ptyColumns);
    if ((backend === 'auto' || backend === 'tmux') && isTmuxAvailable()) {
      return spawnTmuxLiveProcess(opts.cwd, env, commandLine, ptyRows, ptyColumns);
    }
    if (backend === 'tmux') {
      log.warn('agent-live', 'tmux-unavailable-fallback', { fallback: 'pty' });
    }
    return {
      command: 'script',
      pty: true,
      terminal: { backend: 'pty' },
      child: spawnProcess('script', ['-qfec', commandLine, '/dev/null'], {
        cwd: opts.cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      }) as LiveChild,
    };
  }
  return {
    command: opts.command,
    pty: false,
    terminal: { backend: 'pipe' },
    child: spawnProcess(opts.command, opts.args, {
      cwd: opts.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as LiveChild,
  };
}

function liveCommandLine(command: string, args: string[], rows: string, columns: string): string {
  return `stty rows ${shellQuote(rows)} cols ${shellQuote(columns)} -echo 2>/dev/null; ${[
    command,
    ...args,
  ]
    .map(shellQuote)
    .join(' ')}`;
}

export function encodeTmuxInputFrame(input: string): string {
  return `${Buffer.from(input, 'utf8').toString('base64')}\n`;
}

function spawnTmuxLiveProcess(
  cwd: string,
  env: NodeJS.ProcessEnv,
  commandLine: string,
  rows: string,
  columns: string,
): {
  child: LiveChild;
  command: string;
  pty: boolean;
  terminal: LiveTerminalInfo;
} {
  const socketName = `lark-channel-${process.pid}-${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const sessionName = 'main';
  const target = `${sessionName}:0.0`;
  const child = spawnProcess(
    process.execPath,
    [
      '-e',
      TMUX_BRIDGE_HELPER,
      socketName,
      Buffer.from(commandLine, 'utf8').toString('base64'),
      cwd,
      rows,
      columns,
    ],
    {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  ) as LiveChild;
  return {
    command: 'tmux',
    pty: true,
    terminal: {
      backend: 'tmux',
      socketName,
      sessionName,
      target,
      attachCommand: `tmux -L ${shellQuote(socketName)} attach -t ${shellQuote(sessionName)}`,
    },
    child,
  };
}

function isTmuxAvailable(): boolean {
  const result = spawnProcessSync('tmux', ['-V'], { stdio: 'ignore' });
  return result.status === 0;
}

function positiveIntString(value: string | undefined): string | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return undefined;
  return String(parsed);
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const TMUX_BRIDGE_HELPER = String.raw`
const { spawnSync } = require('node:child_process');

const [socketName, commandBase64, cwd, rows, columns] = process.argv.slice(1);
const session = 'main';
const target = session + ':0.0';
const commandLine = Buffer.from(commandBase64, 'base64').toString('utf8');
let closed = false;
let lastSnapshot = '';
let inputBuffer = '';

function tmux(args, options = {}) {
  return spawnSync('tmux', ['-L', socketName, ...args], {
    cwd,
    env: process.env,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    ...options,
  });
}

function writeError(prefix, result) {
  const message = (result.stderr || result.error?.message || '').trim();
  process.stderr.write(prefix + (message ? ': ' + message : '') + '\n');
}

function cleanup() {
  if (closed) return;
  closed = true;
  tmux(['kill-server'], { stdio: 'ignore' });
}

const created = tmux([
  'new-session',
  '-d',
  '-x',
  columns,
  '-y',
  rows,
  '-s',
  session,
  '-c',
  cwd,
  commandLine,
]);
if (created.status !== 0) {
  writeError('failed to start tmux live session', created);
  process.exit(1);
}

function sendKeys(args) {
  const result = tmux(['send-keys', '-t', target, ...args]);
  if (result.status !== 0) writeError('failed to send keys to tmux live session', result);
}

function sendLiteral(text) {
  if (!text) return;
  sendKeys(['-l', text]);
}

function sendBracketedPaste(text) {
  if (!text) return;
  sendKeys(['-l', '\x1b[200~' + text + '\x1b[201~']);
}

function sendInput(input) {
  if (input === '\x03') {
    sendKeys(['C-c']);
    return;
  }
  if (input === '\x01') {
    sendKeys(['C-a']);
    return;
  }
  if (input === '\x0B') {
    sendKeys(['C-k']);
    return;
  }
  if (input === '\x1B[A') {
    sendKeys(['Up']);
    return;
  }
  if (input === '\x1B[B') {
    sendKeys(['Down']);
    return;
  }
  if (input === '\x1B[C') {
    sendKeys(['Right']);
    return;
  }
  if (input === '\x1B[D') {
    sendKeys(['Left']);
    return;
  }
  if (input === '\x1B') {
    sendKeys(['Escape']);
    return;
  }

  const shouldSubmit = input.endsWith('\r') || input.endsWith('\n');
  const body = shouldSubmit ? input.replace(/[\r\n]+$/u, '') : input;
  const normalized = body.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (normalized.includes('\n')) sendBracketedPaste(normalized);
  else sendLiteral(normalized);
  if (shouldSubmit) sendKeys(['Enter']);
}

function capture() {
  if (closed) return;
  const hasSession = tmux(['has-session', '-t', session], { stdio: 'ignore' });
  if (hasSession.status !== 0) {
    cleanup();
    process.exit(0);
  }
  const result = tmux(['capture-pane', '-p', '-t', target]);
  if (result.status !== 0) {
    writeError('failed to capture tmux live session', result);
    cleanup();
    process.exit(1);
  }
  const snapshot = result.stdout.replace(/\s+$/u, '');
  if (snapshot && snapshot !== lastSnapshot) {
    lastSnapshot = snapshot;
    process.stdout.write('\x1b[2J\x1b[H' + snapshot);
  }
}

const timer = setInterval(capture, 160);
capture();

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  inputBuffer += chunk;
  let newline;
  while ((newline = inputBuffer.indexOf('\n')) !== -1) {
    const frame = inputBuffer.slice(0, newline);
    inputBuffer = inputBuffer.slice(newline + 1);
    if (!frame) continue;
    try {
      sendInput(Buffer.from(frame, 'base64').toString('utf8'));
    } catch (error) {
      process.stderr.write('failed to decode tmux input frame: ' + String(error) + '\n');
    }
  }
});
process.stdin.on('end', () => {
  clearInterval(timer);
  cleanup();
});
process.on('SIGTERM', () => {
  clearInterval(timer);
  cleanup();
  process.exit(0);
});
process.on('SIGINT', () => {
  clearInterval(timer);
  cleanup();
  process.exit(0);
});
process.on('exit', cleanup);
`;

// Word → terminal key. Lets users drive an agent's interactive picker
// (e.g. Codex `/model`) from chat by sending navigation words.
const CONTROL_KEYS: Record<string, string> = {
  up: '\x1B[A', '↑': '\x1B[A', 上: '\x1B[A',
  down: '\x1B[B', '↓': '\x1B[B', 下: '\x1B[B',
  left: '\x1B[D', '←': '\x1B[D', 左: '\x1B[D',
  right: '\x1B[C', '→': '\x1B[C', 右: '\x1B[C',
  enter: '\r', return: '\r', 回车: '\r', 确认: '\r',
  esc: '\x1B', escape: '\x1B', 取消: '\x1B', 返回: '\x1B',
  space: ' ', tab: '\t',
};

/**
 * If `input` is composed ENTIRELY of navigation/control words (single or
 * space-separated, e.g. "up", "down down enter", "esc"), return the ordered
 * list of terminal key sequences to send. Otherwise null (ordinary text).
 * Enables multi-key picker control in one message — "up enter" moves then
 * confirms, instead of being typed literally and confirming the default.
 */
export function parseLiveControlSequence(input: string): string[] | null {
  const tokens = input.trim().split(/\s+/u).filter(Boolean);
  if (tokens.length === 0) return null;
  const keys: string[] = [];
  for (const token of tokens) {
    const key = CONTROL_KEYS[token.toLowerCase()] ?? CONTROL_KEYS[token];
    if (key === undefined) return null;
    keys.push(key);
  }
  return keys;
}

/** True when the whole message is a navigation/control key sequence. */
export function isLiveControlInput(input: string): boolean {
  return parseLiveControlSequence(input) !== null;
}

function shouldDeferControlLiteralSubmit(input: string): boolean {
  const trimmed = input.trim();
  return /^\d{1,2}$/u.test(trimmed) || /^(?:y|yes|n|no)$/iu.test(trimmed);
}

function isKnownSilentLiveCommand(input: string): boolean {
  return /^\/(?:clear|cls)\s*$/iu.test(input.trim());
}

function isSlowSilentLiveCommand(input: string): boolean {
  return /^\/compact\s*$/iu.test(input.trim());
}

function noOutputIdleMs(input: string, idleMs: number): number {
  return Math.max(
    idleMs,
    isSlowSilentLiveCommand(input) ? COMPACT_NO_OUTPUT_IDLE_MS : COMMAND_NO_OUTPUT_IDLE_MS,
  );
}

function isStatusLiveCommand(input: string): boolean {
  return /^\/status\s*$/iu.test(input.trim());
}

function isLiveCommandResultOutput(text: string, prompt: string): boolean {
  const command = prompt.trim().toLowerCase();
  if (!command.startsWith('/')) return true;
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (command === '/model') return isModelPickerOutput(trimmed);
  if (command === '/skills') {
    return (
      /\bchoose an action\b/i.test(trimmed) ||
      /\bavailable skills\b/i.test(trimmed) ||
      /(?:^|\n)\s*(?:[›>▸*+-]\s*)?\d{1,2}[.)、:\s-]+\S/u.test(trimmed) &&
        /\b(?:skills?|enable|disable|action)\b/i.test(trimmed)
    );
  }
  return true;
}

function isModelPickerOutput(text: string): boolean {
  return (
    /\bselect model and effort\b/i.test(text) ||
    /\bselect\s+(?:a\s+)?model\b/i.test(text) ||
    /\breasoning effort\b/i.test(text) ||
    /press\s+enter\s+to\s+confirm/i.test(text) ||
    /(?:^|\n)\s*(?:[›>▸*+-]\s*)?\d{1,2}[.)、:\s-]+(?:gpt-|low|medium|high)\S*/iu.test(text)
  );
}

function buildLiveStatusFallback(
  opts: LiveSessionCommand,
  cwd: string,
  terminal?: LiveTerminalInfo,
): string {
  const lines = [
    'Codex live session status',
    `Directory: ${cwd}`,
    `Model: ${argValue(opts.args, '--model') ?? 'default'}`,
    `Reasoning effort: ${configValue(opts.args, 'model_reasoning_effort') ?? 'default'}`,
    `Sandbox: ${argValue(opts.args, '--sandbox') ?? 'default'}`,
    `Approval policy: ${configValue(opts.args, 'approval_policy') ?? 'default'}`,
    `Backend: ${opts.backend ?? (opts.usePty === false ? 'pipe' : 'auto')}`,
    `Terminal backend: ${terminal?.backend ?? 'unknown'}`,
    ...(terminal?.attachCommand
      ? [
          `Tmux socket: ${terminal.socketName}`,
          `Tmux target: ${terminal.target}`,
          `Attach command: ${terminal.attachCommand}`,
        ]
      : []),
    'Token usage: unavailable from Codex TUI fallback',
    '',
  ];
  return lines.join('\n');
}

function argValue(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  const value = idx >= 0 ? args[idx + 1] : undefined;
  return value && !value.startsWith('-') ? value : undefined;
}

function configValue(args: string[], key: string): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] !== '-c') continue;
    const raw = args[i + 1];
    if (!raw) continue;
    const match = raw.match(/^([^=]+)=(.*)$/);
    if (!match || match[1] !== key) continue;
    return match[2]?.replace(/^"|"$/g, '');
  }
  return undefined;
}

function previewLiveText(input: string): string {
  return input
    .replace(/\x1B/g, '<ESC>')
    .replace(/\r/g, '<CR>')
    .replace(/\t/g, '<TAB>')
    .slice(0, LIVE_DIAG_PREVIEW_CHARS);
}

export function cleanTerminalOutput(input: string): string {
  const withoutAnsi = input
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, '')
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1B[@-Z\\-_]/g, '')
    .replace(/(^|[\r\n])\d{1,4}G(?=\S)/g, '$1')
    .replace(/(\S)78\s+(?=\S)/g, '$1')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\r\n/g, '\n');
  return normalizeScatteredCursorLines(collapseCarriageReturns(withoutAnsi)).replace(/\n{4,}/g, '\n\n\n');
}

class TerminalOutputCleaner {
  private carry = '';
  private screenMode = false;
  private lastTerminalSnapshot = '';
  private readonly screen = new VirtualTerminalScreen();

  setScreenMode(enabled: boolean): void {
    this.screenMode = enabled;
    this.carry = '';
    this.lastTerminalSnapshot = '';
    this.screen.reset();
  }

  resetTurn(): void {
    this.carry = '';
    this.lastTerminalSnapshot = '';
    if (this.screenMode) this.screen.reset();
  }

  push(input: string): LiveOutput {
    if (this.screenMode) {
      this.screen.write(input);
      const terminalText = this.screen.snapshot();
      const snapshot = stripKnownLiveNoise(terminalText);
      if (!terminalText.trim() || terminalText === this.lastTerminalSnapshot) {
        return { mode: 'snapshot', text: '' };
      }
      this.lastTerminalSnapshot = terminalText;
      return { mode: 'snapshot', text: snapshot, terminalText };
    }

    const combined = this.carry + input;
    const splitAt = completePrefixEnd(combined);
    this.carry = combined.slice(splitAt);
    return { mode: 'append', text: cleanTerminalOutput(combined.slice(0, splitAt)) };
  }
}

class VirtualTerminalScreen {
  private readonly width: number;
  private readonly height: number;
  private rows: string[][];
  private row = 0;
  private col = 0;
  private savedRow = 0;
  private savedCol = 0;
  private state: 'normal' | 'esc' | 'csi' | 'osc' | 'osc-esc' = 'normal';
  private seq = '';

  constructor(width = 120, height = 48) {
    this.width = width;
    this.height = height;
    this.rows = this.emptyRows();
  }

  reset(): void {
    this.rows = this.emptyRows();
    this.row = 0;
    this.col = 0;
    this.savedRow = 0;
    this.savedCol = 0;
    this.state = 'normal';
    this.seq = '';
  }

  write(input: string): void {
    for (const char of input) this.writeChar(char);
  }

  snapshot(): string {
    return this.rows
      .map((row) => row.join('').trimEnd())
      .join('\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{4,}/g, '\n\n\n')
      .trim();
  }

  private writeChar(char: string): void {
    if (this.state === 'osc') {
      if (char === '\x07') this.state = 'normal';
      else if (char === '\x1B') this.state = 'osc-esc';
      return;
    }
    if (this.state === 'osc-esc') {
      this.state = char === '\\' ? 'normal' : 'osc';
      return;
    }
    if (this.state === 'esc') {
      if (char === '[') {
        this.seq = '';
        this.state = 'csi';
      } else if (char === ']') {
        this.state = 'osc';
      } else {
        this.state = 'normal';
      }
      return;
    }
    if (this.state === 'csi') {
      this.seq += char;
      const code = char.charCodeAt(0);
      if (code >= 0x40 && code <= 0x7e) {
        this.applyCsi(this.seq);
        this.seq = '';
        this.state = 'normal';
      }
      return;
    }

    if (char === '\x1B') {
      this.state = 'esc';
      return;
    }
    if (char === '\r') {
      this.col = 0;
      return;
    }
    if (char === '\n') {
      this.newLine();
      return;
    }
    if (char === '\b') {
      this.col = Math.max(0, this.col - 1);
      return;
    }
    const code = char.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return;
    this.put(char);
  }

  private applyCsi(seq: string): void {
    const final = seq.at(-1) ?? '';
    const privateMode = seq.includes('?');
    const raw = seq.slice(0, -1).replace(/[?=>]/g, '');
    const nums = raw
      .split(';')
      .filter((item) => item !== '')
      .map((item) => Number.parseInt(item, 10))
      .map((item) => (Number.isFinite(item) ? item : 0));
    const first = nums[0] ?? 0;

    if (final === 'A') this.row = clamp(this.row - (first || 1), 0, this.height - 1);
    else if (final === 'B') this.row = clamp(this.row + (first || 1), 0, this.height - 1);
    else if (final === 'C') this.col = clamp(this.col + (first || 1), 0, this.width - 1);
    else if (final === 'D') this.col = clamp(this.col - (first || 1), 0, this.width - 1);
    else if (final === 'G') this.col = clamp((first || 1) - 1, 0, this.width - 1);
    else if (final === 'H' || final === 'f') {
      this.row = clamp((nums[0] || 1) - 1, 0, this.height - 1);
      this.col = clamp((nums[1] || 1) - 1, 0, this.width - 1);
    } else if (final === 'J') {
      this.clearScreen(first);
    } else if (final === 'K') {
      this.clearLine(first);
    } else if (final === 'm') {
      return;
    } else if (final === 's') {
      this.savedRow = this.row;
      this.savedCol = this.col;
    } else if (final === 'u') {
      this.row = this.savedRow;
      this.col = this.savedCol;
    } else if ((final === 'h' || final === 'l') && privateMode && nums.some(isAlternateScreenMode)) {
      this.clearScreen(2);
    }
  }

  private put(char: string): void {
    this.rows[this.row]![this.col] = char;
    this.col += 1;
    if (this.col >= this.width) {
      this.col = 0;
      this.newLine();
    }
  }

  private newLine(): void {
    this.row += 1;
    this.col = 0;
    if (this.row < this.height) return;
    this.rows.shift();
    this.rows.push(this.emptyRow());
    this.row = this.height - 1;
  }

  private clearScreen(mode: number): void {
    if (mode === 2 || mode === 3) {
      this.rows = this.emptyRows();
      this.row = 0;
      this.col = 0;
      return;
    }
    if (mode === 1) {
      for (let row = 0; row <= this.row; row += 1) this.rows[row] = this.emptyRow();
      return;
    }
    for (let row = this.row; row < this.height; row += 1) this.rows[row] = this.emptyRow();
  }

  private clearLine(mode: number): void {
    const row = this.rows[this.row] ?? this.emptyRow();
    if (mode === 1) {
      for (let col = 0; col <= this.col; col += 1) row[col] = ' ';
    } else if (mode === 2) {
      this.rows[this.row] = this.emptyRow();
    } else {
      for (let col = this.col; col < this.width; col += 1) row[col] = ' ';
    }
  }

  private emptyRows(): string[][] {
    return Array.from({ length: this.height }, () => this.emptyRow());
  }

  private emptyRow(): string[] {
    return Array.from({ length: this.width }, () => ' ');
  }
}

class TurnOutputBuffer {
  private emitted = '';
  private pending = '';
  private lastCompleteLine = '';
  private truncated = false;
  private snapshotBaseline = '';

  constructor(
    private readonly maxChars: number,
    private readonly promptEcho: string = '',
    private readonly stripInputLines = false,
  ) {}

  setSnapshotBaseline(snapshot: string): void {
    this.snapshotBaseline = snapshot;
  }

  append(raw: string): boolean {
    const compacted = stripPromptMismatchedLiveContent(this.compact(raw), this.promptEcho);
    if (!compacted.trim()) return false;
    if (isStalePickerSnapshotForPrompt(compacted, this.promptEcho)) return false;
    if (isStaleStatusSnapshotForPrompt(compacted, this.promptEcho)) return false;
    if (isStaleGoalUsageSnapshotForPrompt(compacted, this.promptEcho)) return false;
    if (isSlashCompletionSnapshotForPrompt(compacted, this.promptEcho)) return false;
    const existing = this.emitted + this.pending;
    if (existing.endsWith(compacted)) return false;

    this.pending += compacted;
    this.enforceLimit();
    return true;
  }

  replace(raw: string): boolean {
    const scoped = scopeLiveSnapshotToPrompt(raw, this.promptEcho, this.snapshotBaseline);
    this.snapshotBaseline = raw;
    const compacted = stripPromptMismatchedLiveContent(this.compact(scoped), this.promptEcho);
    if (!compacted.trim()) return false;
    if (isStalePickerSnapshotForPrompt(compacted, this.promptEcho)) return false;
    if (isStaleStatusSnapshotForPrompt(compacted, this.promptEcho)) return false;
    if (isStaleGoalUsageSnapshotForPrompt(compacted, this.promptEcho)) return false;
    if (isSlashCompletionSnapshotForPrompt(compacted, this.promptEcho)) return false;
    if (this.pending === compacted || this.emitted.endsWith(compacted)) return false;
    if (shouldKeepRicherSnapshot(this.pending, compacted)) return false;
    this.pending = compacted.endsWith('\n') ? compacted : `${compacted}\n`;
    this.enforceLimit();
    return true;
  }

  take(): string {
    const out = stripKnownLiveNoise(this.pending, this.promptEcho);
    this.emitted += out;
    this.pending = '';
    return out;
  }

  private compact(text: string): string {
    const withoutEcho = stripPromptEcho(cleanTerminalOutput(text), this.promptEcho);
    const normalized = this.stripInputLines
      ? stripStaleSlashEchoLines(stripLiveInputLines(withoutEcho), this.promptEcho)
      : withoutEcho;
    if (!normalized.trim()) return '';
    const parts = normalized.split(/(\n)/);
    let out = '';
    let currentLine = '';
    for (const part of parts) {
      if (part === '\n') {
        const comparable = currentLine.trim();
        if (comparable && comparable === this.lastCompleteLine) {
          currentLine = '';
          continue;
        }
        out += `${currentLine}\n`;
        if (comparable) this.lastCompleteLine = comparable;
        currentLine = '';
        continue;
      }
      currentLine += part;
    }
    if (currentLine) out += currentLine;
    return out;
  }

  private enforceLimit(): void {
    const total = this.emitted.length + this.pending.length;
    if (total <= this.maxChars) return;
    const overflow = total - this.maxChars;
    if (overflow >= this.pending.length) {
      this.pending = '';
      return;
    }
    this.pending = this.pending.slice(overflow);
    if (!this.truncated) {
      this.truncated = true;
      this.pending = `[live output truncated to ${this.maxChars} chars]\n${this.pending}`;
    }
  }
}

function collapseCarriageReturns(input: string): string {
  let out = '';
  let line = '';
  for (const char of input) {
    if (char === '\r') {
      line = '';
      continue;
    }
    if (char === '\n') {
      out += `${line}\n`;
      line = '';
      continue;
    }
    line += char;
  }
  return out + line;
}

function normalizeScatteredCursorLines(input: string): string {
  const lines = input.split('\n');
  const out: string[] = [];
  let chars: string[] = [];
  let originals: string[] = [];
  let hasCursorColumn = false;

  const flush = (): void => {
    if (chars.length >= 8 && (hasCursorColumn || chars.includes('⚠'))) {
      out.push(chars.join(''));
    } else {
      out.push(...originals);
    }
    chars = [];
    originals = [];
    hasCursorColumn = false;
  };

  for (const line of lines) {
    if (!line.trim() && chars.length > 0) {
      originals.push(line);
      continue;
    }
    const scattered = line.match(/^\s*(?:(\d{2,4})\s+|(\d{2,4})G)?(\S)\s*$/u);
    if (scattered) {
      if ((scattered[1] || scattered[2]) && chars.length === 0 && out.length > 0) {
        out[out.length - 1] = `${out[out.length - 1]}${scattered[3] ?? ''}`;
        originals = [];
        hasCursorColumn = false;
        continue;
      }
      chars.push(scattered[3] ?? '');
      originals.push(line);
      if (scattered[1] || scattered[2]) hasCursorColumn = true;
      continue;
    }
    flush();
    out.push(line);
  }
  flush();
  return out.join('\n');
}

function stripKnownLiveNoise(input: string, prompt = ''): string {
  return stripPromptMismatchedLiveContent(stripTerminalChrome(stripCompactNoise(input, [
    '⚠Ignoringmalformedagentroledefinition:duplicateagentrolenameweb-researcherdeclaredinthesameconfiglayer',
    'Ignoringmalformedagentroledefinition:duplicateagentrolenameweb-researcherdeclaredinthesameconfiglayer',
    'nfiglayer⚠Ignoringmalforntrole',
    'nfiglayerIgnoringmalforntrole',
    'Ignoringmalforntrole',
    '⚠Ignoringmalformedagentroledefinition:agentroleweb-researchermustdefineadescription',
    'Ignoringmalformedagentroledefinition:agentroleweb-researchermustdefineadescription',
    'web-researchermustdefineadescription',
    'researchermustdefineadescription',
    'rmustdefineadescription',
    'mustdefineadescription',
    'Tip:Use/inittocreateanAGENTS.mdwithproject-specificguidance.',
    'Tip:Use/inittocreateanAGENTS.mdwithproject-specificguidance',
    'Tip:NewBuildfasterwithCodex.',
    'Tip:NewBuildfasterwithCodex',
    '•Nopreviousmessagetoedit.',
    'Nopreviousmessagetoedit.',
  ]), prompt), prompt)
    .replace(/(^|\n)\s*`\s*(?=\n|$)/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\n{2,}$/g, '\n')
    .trimStart();
}

function sanitizeLiveTurnOutput(input: string, prompt = ''): string {
  const stripped = stripKnownLiveNoise(input, prompt);
  if (!stripped.trim()) return '';
  return isLikelyCodexRoleWarningFragment(stripped) ? '' : stripped;
}

function isLikelyCodexRoleWarningFragment(input: string): boolean {
  const compact = compactForNoiseMatch(input);
  if (!compact) return false;
  return (
    compact.includes('ignoringmalfor') ||
    compact.includes('malformedagentrole') ||
    compact.includes('agentroledefi') ||
    compact.includes('duplicateagentrole') ||
    compact.includes('mustdefineadescription') ||
    compact.includes('nfiglayer') ||
    compact.includes('webresearcher')
  );
}

function stripPromptEcho(input: string, prompt: string): string {
  const echo = prompt.trim();
  if (!echo) return input;
  const trimmed = input.trimStart();
  if (trimmed === echo) return '';
  if (trimmed.startsWith(`${echo}\n`)) return trimmed.slice(echo.length + 1);
  return input
    .split('\n')
    .filter((line) => !isPromptEchoLine(line, echo))
    .filter((line) => !isPromptScopedTerminalChromeLine(line.trim(), echo))
    .join('\n')
    .trimStart();
}

export function scopeLiveSnapshotToPrompt(
  input: string,
  prompt: string,
  previousSnapshot = '',
): string {
  const echo = prompt.trim();
  if (!echo) return input;
  const lines = input.split('\n');
  const commandResult = scopeKnownLiveCommandResultSnapshot(lines, echo);
  if (commandResult !== undefined) return commandResult;
  const controlResult = scopeKnownLiveControlResultSnapshot(lines, echo);
  if (controlResult !== undefined) return controlResult;
  const picker = scopeExpectedLivePickerSnapshot(lines, echo);
  if (picker !== undefined) return picker;
  const controlPicker = scopeControlLiteralPickerSnapshot(lines, echo);
  if (controlPicker !== undefined) return controlPicker;
  const delta = scopeSnapshotDelta(lines, previousSnapshot);
  if (delta !== undefined) return delta;
  const promptLines = echo.split('\n');
  const anchorIndex = promptLines.findIndex((line) => line.trim().length > 0);
  const anchor = promptLines[anchorIndex]?.trim() ?? echo;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!isPromptEchoLine(lines[index] ?? '', anchor)) continue;
    let cursor = index + 1;
    for (const promptLine of promptLines.slice(anchorIndex + 1)) {
      if (!promptLine.trim()) {
        if (!lines[cursor]?.trim()) cursor += 1;
        continue;
      }
      if (lines[cursor]?.trim() === promptLine.trim()) cursor += 1;
      else break;
    }
    return lines.slice(cursor).join('\n');
  }
  // Native approval and picker rows can begin with the same arrow glyph as a
  // prompt (for example "› 1. Yes, proceed"). They are current terminal
  // interactions, not stale conversation history, and must reach the card
  // router so the user can answer them from Lark.
  if (isLiveTerminalInteraction(input) && !hasForeignTerminalPrompt(lines)) return input;
  // A tmux snapshot with another prompt belongs to an earlier turn. Codex also
  // renders built-in suggestion rows with the same glyph, which are terminal
  // chrome rather than user prompts and must not hide current task output.
  return lines.some((line) => {
    const trimmed = line.trimStart();
    return trimmed.startsWith('›') && !isTerminalChromeLine(trimmed);
  }) ? '' : input;
}

function scopeKnownLiveControlResultSnapshot(lines: string[], prompt: string): string | undefined {
  if (!isLiveControlInput(prompt) && !shouldDeferControlLiteralSubmit(prompt)) return undefined;
  const index = findLastLine(
    lines,
    (line) => /^(?:[•*+-]\s*)?Model changed to\b/i.test(line.trim()),
  );
  return index >= 0 ? lines[index]!.trim() : undefined;
}

function scopeSnapshotDelta(lines: string[], previousSnapshot: string): string | undefined {
  const previous = previousSnapshot.trim();
  if (!previous) return undefined;

  const priorLines = previous.split('\n');
  let prefix = 0;
  while (prefix < priorLines.length && prefix < lines.length && priorLines[prefix] === lines[prefix]) {
    prefix += 1;
  }
  if (prefix === priorLines.length && prefix < lines.length) {
    return lines.slice(prefix).join('\n');
  }

  const maxOverlap = Math.min(priorLines.length, lines.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    const priorTail = priorLines.slice(priorLines.length - overlap);
    const nextHead = lines.slice(0, overlap);
    if (priorTail.every((line, index) => line === nextHead[index])) {
      const delta = lines.slice(overlap).join('\n');
      if (delta.trim()) return delta;
    }
  }
  return undefined;
}

function scopeKnownLiveCommandResultSnapshot(lines: string[], prompt: string): string | undefined {
  const command = prompt.trim().toLowerCase();
  let start = -1;

  if (/^\/fast(?:\s|$)/u.test(command)) {
    start = findLastLine(lines, (line) => /^•\s+Service tier set to\b/i.test(line.trim()));
  } else if (/^\/compact(?:\s|$)/u.test(command)) {
    start = findLastLine(lines, (line) => /^•\s+Context compacted$/i.test(line.trim()));
  } else if (/^\/(?:status|usage|limits)(?:\s|$)/u.test(command)) {
    start = findLastCodexStatusPanel(lines);
  }

  return start >= 0 ? lines.slice(start).join('\n') : undefined;
}

function findLastLine(lines: string[], predicate: (line: string) => boolean): number {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (predicate(lines[index] ?? '')) return index;
  }
  return -1;
}

function findLastCodexStatusPanel(lines: string[]): number {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!/^╭[─\s]*╮?$/u.test((lines[index] ?? '').trim())) continue;
    const panel = lines.slice(index, index + 24).join('\n');
    if (/\b(?:OpenAI )?Codex\b/i.test(panel) && /\bToken usage:/i.test(panel)) return index;
  }
  return -1;
}

/**
 * Native Codex pickers redraw the active input line in-place (for example,
 * `› /model` becomes `› 1. gpt-...`). The command echo therefore disappears
 * from a tmux capture even though the picker belongs to the current turn.
 */
function scopeExpectedLivePickerSnapshot(lines: string[], prompt: string): string | undefined {
  if (!isLivePickerCommand(prompt)) return undefined;

  return scopeLivePickerSnapshot(lines);
}

function scopeControlLiteralPickerSnapshot(lines: string[], prompt: string): string | undefined {
  if (!shouldDeferControlLiteralSubmit(prompt)) return undefined;

  return scopeLivePickerSnapshot(lines);
}

function scopeLivePickerSnapshot(lines: string[]): string | undefined {
  let start = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (isLivePickerStartLine(lines[index] ?? '')) start = index;
  }
  if (start < 0) return undefined;

  const picker = lines.slice(start).join('\n');
  return isLikelyLivePickerOutput(picker) ? picker : undefined;
}

function isLivePickerCommand(input: string): boolean {
  return /^\/(?:model|skills|permissions|resume)(?:\s|$)/iu.test(input.trim());
}

function isLivePickerStartLine(line: string): boolean {
  const trimmed = line.trim();
  return (
    /\bselect\s+(?:a\s+)?(?:model|reasoning|option|permission|session)\b/i.test(trimmed) ||
    /\bchoose an action\b/i.test(trimmed) ||
    /\bcommand requires approval\b/i.test(trimmed) ||
    /\bresume previous conversation\b/i.test(trimmed) ||
    /^skills?$/i.test(trimmed)
  );
}

function isLikelyLivePickerOutput(text: string): boolean {
  return (
    /press\s+enter\s+to\s+(?:confirm|continue)/i.test(text) ||
    /esc\s+to\s+(?:go\s+back|cancel)/i.test(text) ||
    /\b(?:y\/n|yes\/no|no\/yes)\b/i.test(text) ||
    /(?:↑|↓|up\/down|arrow keys?|use .*arrows?)/i.test(text) ||
    /(?:^|\n)\s*(?:[›>▸*+-]\s*)?\d{1,2}[.)、:\s-]+\S/u.test(text)
  );
}

function isPromptEchoLine(line: string, echo: string): boolean {
  const normalized = line.trim();
  const slashless = echo.startsWith('/') ? echo.slice(1) : echo;
  return (
    normalized === echo ||
    normalized === `› ${echo}` ||
    (slashless !== echo && (normalized === slashless || normalized === `› ${slashless}`))
  );
}

function stripLiveInputLines(input: string): string {
  return input
    .split('\n')
    .filter((line) => !isLiveInputChromeLine(line.trim()))
    .join('\n')
    .trimStart();
}

function stripStaleSlashEchoLines(input: string, prompt: string): string {
  const echo = prompt.trim();
  return input
    .split('\n')
    .filter((line) => !isStaleSlashEchoLine(line.trim(), echo))
    .join('\n')
    .trimStart();
}

function isStaleSlashEchoLine(trimmed: string, echo: string): boolean {
  if (!/^\/[A-Za-z][\w-]*(?:\s+\S.*)?$/.test(trimmed)) return false;
  return !isPromptEchoLine(trimmed, echo);
}

function isLiveInputChromeLine(trimmed: string): boolean {
  if (!trimmed.startsWith('›')) return false;
  return !/^›\s*\d{1,2}[.)、:\s-]/u.test(trimmed);
}

function isPromptScopedTerminalChromeLine(trimmed: string, prompt: string): boolean {
  if (prompt.trim() === '/fast') return false;
  if (prompt.trim().startsWith('/') && /^•\s+Model changed to\b/i.test(trimmed)) return true;
  return /^•\s+Service tier set to\b/i.test(trimmed);
}

function stripTerminalChrome(input: string, prompt = ''): string {
  const preserveBoxes = prompt.trim().toLowerCase().startsWith('/status');
  const out: string[] = [];
  const lines = input.split('\n');
  let inBox = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (preserveBoxes) {
      if (isTerminalChromeLine(trimmed)) continue;
      out.push(line);
      continue;
    }
    if (!inBox && /^╭[─\s]*╮?$/.test(trimmed)) {
      inBox = true;
      continue;
    }
    if (inBox) {
      if (/^╰[─\s]*╯?$/.test(trimmed)) inBox = false;
      continue;
    }
    if (isTerminalChromeLine(trimmed)) continue;
    out.push(line);
  }
  return out.join('\n');
}

function stripPromptMismatchedLiveContent(input: string, prompt: string): string {
  const command = prompt.trim().toLowerCase();
  let out = stripNoPreviousMessageLines(input);
  if (!isStatusCommand(command)) out = stripCodexStatusPanelLines(out);
  if (!isGoalCommand(command)) out = stripGoalUsageLines(out);
  if (isCodexControlCommand(command) && !isCompactCommand(command)) out = stripContextCompactedNotice(out);
  if (command.startsWith('/')) out = stripModelChangedLines(out);
  return out;
}

function isGoalCommand(command: string): boolean {
  return /^\/goal(?:\s|$)/.test(command);
}

function isStatusCommand(command: string): boolean {
  return command.startsWith('/status');
}

function isCompactCommand(command: string): boolean {
  return /^\/compact(?:\s|$)/.test(command);
}

function isCodexControlCommand(command: string): boolean {
  return /^\/(?:clear|compact|fast|goal|help|init|limits|login|logout|model|new|permissions|resume|skills|status|usage)(?:\s|$)/.test(
    command,
  );
}

function stripNoPreviousMessageLines(input: string): string {
  return input
    .split('\n')
    .filter((line) => !/^•?\s*No previous message to edit\./i.test(line.trim()))
    .join('\n')
    .trimStart();
}

function stripContextCompactedNotice(input: string): string {
  const lines = input.split('\n');
  const out: string[] = [];
  let skippingCompactWarning = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^(?:cause the model to be less accurate|possible to keep threads small and targeted)/i.test(trimmed)) {
      continue;
    }
    if (/^•\s+Context compacted$/i.test(trimmed)) {
      skippingCompactWarning = true;
      continue;
    }
    if (/^⚠\s*Heads up:/i.test(trimmed)) {
      skippingCompactWarning = true;
      continue;
    }
    if (skippingCompactWarning) {
      if (!trimmed) continue;
      skippingCompactWarning = false;
    }
    out.push(line);
  }
  return out.join('\n').trimStart();
}

function stripCodexStatusPanelLines(input: string): string {
  return input
    .split('\n')
    .filter((line) => !isCodexStatusPanelLine(line.trim()))
    .join('\n')
    .trimStart();
}

function isCodexStatusPanelLine(trimmed: string): boolean {
  if (!trimmed.startsWith('│')) return false;
  return (
    /(?:>_\s*)?OpenAI Codex/i.test(trimmed) ||
    /\b(?:Model|Model provider|Directory|Permissions|Agents\.md|Account|Collaboration mode|Session|Token usage|Limits):/i.test(trimmed) ||
    /chatgpt\.com\/codex\/settings\/usage/i.test(trimmed) ||
    /information on rate limits and credits/i.test(trimmed) ||
    /^│\s*│?$/.test(trimmed)
  );
}

function stripGoalUsageLines(input: string): string {
  return input
    .split('\n')
    .filter((line) => !/^•\s+Usage:\s+\/goal\b/i.test(line.trim()))
    .join('\n')
    .trimStart();
}

function stripModelChangedLines(input: string): string {
  return input
    .split('\n')
    .filter((line) => !/^•\s+Model changed to\b/i.test(line.trim()))
    .join('\n')
    .trimStart();
}

function isStalePickerSnapshotForPrompt(text: string, prompt: string): boolean {
  const command = prompt.trim().toLowerCase();
  if (!command.startsWith('/') || isLivePickerCommand(command)) return false;
  const compact = compactForNoiseMatch(text);
  return (
    compact.includes('selectmodelandeffort') ||
    compact.includes('accesslegacymodels') ||
    compact.includes('pressentertoconfirmoresctogoback') ||
    /(?:^|\n)\s*(?:[›>▸*+-]\s*)?\d{1,2}[.)、:\s-]+gpt-/iu.test(text)
  );
}

function isStaleStatusSnapshotForPrompt(text: string, prompt: string): boolean {
  const command = prompt.trim().toLowerCase();
  if (isStatusCommand(command)) return false;
  const compact = compactForNoiseMatch(text);
  return (
    compact.includes('openaicodex') &&
    compact.includes('model:') &&
    compact.includes('directory:') &&
    compact.includes('tokenusage:')
  );
}

function isStaleGoalUsageSnapshotForPrompt(text: string, prompt: string): boolean {
  const command = prompt.trim().toLowerCase();
  if (command === '/goal') return false;
  const stripped = stripGoalUsageLines(text);
  return Boolean(text.trim()) && !stripped.trim();
}

function isSlashCompletionSnapshotForPrompt(text: string, prompt: string): boolean {
  const command = prompt.trim().toLowerCase();
  if (!command.startsWith('/') || command.length < 2) return false;
  const escaped = escapeRegExp(command);
  return text
    .split('\n')
    .map((line) => line.trim().toLowerCase())
    .some((line) => new RegExp(`^${escaped}\\s{2,}\\S`).test(line));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function shouldKeepRicherSnapshot(current: string, next: string): boolean {
  const currentScore = snapshotInformationScore(current);
  const nextScore = snapshotInformationScore(next);
  return currentScore >= 120 && nextScore > 0 && nextScore < currentScore * 0.35;
}

function snapshotInformationScore(input: string): number {
  return input
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^[╭╰╮╯─│\s]+$/u.test(line))
    .join('\n').length;
}

function isTerminalChromeLine(trimmed: string): boolean {
  return (
    /^Tip:/i.test(trimmed) ||
    /^[•◦]\s+Working\s+\(\d+s\b.*\)$/i.test(trimmed) ||
    /^tab to queue message\b.*context left$/i.test(trimmed) ||
    /^\d+%\s+context left$/i.test(trimmed) ||
    /^[╭╰╮╯─│\s]+$/u.test(trimmed) ||
    /^[›❯]\s*$/.test(trimmed) ||
    isTerminalSuggestionLine(trimmed) ||
    /^[A-Za-z0-9_.-]+(?:\s+[A-Za-z][A-Za-z0-9_.-]*)?\s+·\s+.+$/.test(trimmed)
  );
}

function isTerminalSuggestionLine(trimmed: string): boolean {
  return /^›\s*(?:Implement \{feature\}|Summarize recent commits|Find and fix a bug in @filename|Improve documentation in @filename|Explain this codebase|Write tests for @filename|Run \/review on my current changes)\s*$/i.test(
    trimmed,
  );
}

function hasForeignTerminalPrompt(lines: string[]): boolean {
  return lines.some((line) => {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith('›')) return false;
    if (isTerminalChromeLine(trimmed)) return false;
    return !/^›\s*\d{1,2}[.)、:\s-]+\S/u.test(trimmed);
  });
}

export function isLiveTerminalBusy(input: string): boolean {
  const recent = cleanTerminalOutput(input).split('\n').slice(-12).join('\n');
  return /(?:tab\s+to\s+queue\s+message|working\s*\([^)]*(?:esc|escape)\s+to\s+interrupt|esc(?:ape)?\s+to\s+interrupt|compacting(?:\s+context)?)/iu.test(
    recent,
  );
}

function isLiveTerminalReady(input: string): boolean {
  const recent = cleanTerminalOutput(input).split('\n').slice(-6);
  return recent.some((line) => {
    const trimmed = line.trim();
    return /^[›❯]\s*$/.test(trimmed) || isTerminalSuggestionLine(trimmed);
  });
}

function isLiveTerminalInteraction(input: string): boolean {
  const recent = cleanTerminalOutput(input).split('\n').slice(-40).join('\n');
  return (
    /\b(?:select\s+(?:a\s+)?(?:model|reasoning|option|permission|session)|choose\s+an\s+action|command\s+requires?\s+(?:approval|confirmation)|resume\s+previous\s+conversation)\b/i.test(recent) ||
    /\b(?:do\s+you\s+want\s+to|would\s+you\s+like\s+to|shall\s+i|waiting\s+for\s+(?:user|your)\s+(?:input|confirmation)|requires?\s+(?:approval|confirmation))\b/i.test(recent) ||
    /\b(?:y\/n|yes\/no|no\/yes)\b|\[(?:y|yes)\/(?:n|no)\]|press\s+enter\s+to\s+(?:confirm|continue)|esc\s+to\s+(?:go\s+back|cancel)/i.test(recent) ||
    /(?:请选择|请(?:输入|回复).*(?:选项|编号|是|否)|等待(?:你|用户)(?:的)?(?:输入|选择|确认)|是否.*[？?]|(?:按下?|点击)回车(?:键)?.*确认)/i.test(recent)
  );
}

function stripCompactNoise(input: string, patterns: string[]): string {
  const { compact, map } = compactWithIndex(input);
  const ranges: Array<[number, number]> = [];
  for (const pattern of patterns) {
    const needle = pattern.replace(/\s|`/g, '').toLowerCase();
    let from = 0;
    let idx = compact.indexOf(needle, from);
    while (idx !== -1) {
      const start = map[idx] ?? 0;
      const end = (map[idx + needle.length - 1] ?? start) + 1;
      ranges.push([start, end]);
      from = idx + needle.length;
      idx = compact.indexOf(needle, from);
    }
  }
  if (ranges.length === 0) return input;

  ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged: Array<[number, number]> = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) {
      last[1] = Math.max(last[1], range[1]);
    } else {
      merged.push([...range]);
    }
  }

  let out = '';
  let cursor = 0;
  for (const [start, end] of merged) {
    out += input.slice(cursor, start);
    cursor = end;
  }
  return out + input.slice(cursor);
}

function compactForNoiseMatch(input: string): string {
  return compactWithIndex(input).compact;
}

function compactWithIndex(input: string): { compact: string; map: number[] } {
  const compactChars: string[] = [];
  const map: number[] = [];
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i] ?? '';
    if (/\s|`/.test(char)) continue;
    compactChars.push(char.toLowerCase());
    map.push(i);
  }
  return { compact: compactChars.join(''), map };
}

function completePrefixEnd(input: string): number {
  const esc = input.lastIndexOf('\x1B');
  if (esc === -1) return input.length;
  return isIncompleteEscapeSequence(input.slice(esc)) ? esc : input.length;
}

function isIncompleteEscapeSequence(seq: string): boolean {
  if (seq.length === 1) return true;
  const second = seq[1];
  if (second === '[') {
    for (let i = 2; i < seq.length; i += 1) {
      const code = seq.charCodeAt(i);
      if (code >= 0x40 && code <= 0x7e) return false;
    }
    return true;
  }
  if (second === ']') {
    return !/\x07|\x1B\\/.test(seq.slice(2));
  }
  return false;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function isAlternateScreenMode(value: number): boolean {
  return value === 47 || value === 1047 || value === 1049;
}

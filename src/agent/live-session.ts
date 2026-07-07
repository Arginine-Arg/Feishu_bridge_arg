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

type LiveChild = SpawnedProcessByStdio<Writable, Readable, Readable>;
type LiveOutput = { mode: 'append' | 'snapshot'; text: string };
export type LiveTerminalBackend = 'auto' | 'tmux' | 'pty' | 'pipe';

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
const MAX_TURN_OUTPUT_CHARS = 120_000;
const DEFAULT_PTY_ROWS = '48';
const DEFAULT_PTY_COLUMNS = '120';

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
  private closed = false;

  constructor(opts: LiveSessionCommand, onClose: () => void = () => {}) {
    this.opts = opts;
    this.signature = opts.signature;
    this.onClose = onClose;
  }

  isAlive(): boolean {
    return Boolean(this.child?.pid && this.child.exitCode === null && this.child.signalCode === null);
  }

  run(runId: string, prompt: string, cwd: string): AgentRun {
    void this.ensureStarted();
    const events = this.turnEvents(prompt, cwd);
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
    const child = spawned.child;
    log.info('agent-live', 'spawn', {
      pid: child.pid ?? null,
      cwd: this.opts.cwd,
      command: spawned.command,
      pty: spawned.pty,
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
    if (!output.text.trim()) return;
    this.emitter.emit('data', output);
  }

  private write(input: string): void {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.stdin.write(input);
  }

  private async *turnEvents(prompt: string, cwd: string): AsyncGenerator<AgentEvent> {
    yield { type: 'system', cwd };

    const idleMs = this.opts.idleMs ?? DEFAULT_IDLE_MS;
    const outputFlushMs = this.opts.outputFlushMs ?? DEFAULT_OUTPUT_FLUSH_MS;
    const startupTimeoutMs = this.opts.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    const output = new TurnOutputBuffer(MAX_TURN_OUTPUT_CHARS, prompt);
    const queue: AgentEvent[] = [];
    let done = false;
    let wake: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let outputTimer: ReturnType<typeof setTimeout> | undefined;
    let acceptingOutput = false;

    const push = (event: AgentEvent): void => {
      queue.push(event);
      wake?.();
    };
    const flushOutput = (): void => {
      if (outputTimer) clearTimeout(outputTimer);
      outputTimer = undefined;
      const delta = output.take();
      if (delta) push({ type: 'text', delta });
    };
    const scheduleOutputFlush = (): void => {
      if (outputTimer) return;
      outputTimer = setTimeout(flushOutput, outputFlushMs);
    };
    const finish = (): void => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      flushOutput();
      push({ type: 'done', terminationReason: 'normal' });
    };
    const arm = (ms: number): void => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(finish, ms);
    };

    const onData = (event: LiveOutput): void => {
      if (!acceptingOutput) {
        arm(startupTimeoutMs);
        return;
      }
      const text = sanitizeLiveTurnOutput(event.text);
      if (!text) return;
      if (event.mode === 'snapshot' ? output.replace(text) : output.append(text)) {
        scheduleOutputFlush();
        arm(idleMs);
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

    this.emitter.on('data', onData);
    this.emitter.once('exit', onExit);
    this.emitter.once('error', onError);
    arm(startupTimeoutMs);
    await delay(STARTUP_INPUT_GRACE_MS);
    if (!done) {
      this.cleaner.resetTurn();
      acceptingOutput = true;
      this.write(translateLiveInput(prompt));
    }

    try {
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
      if (timer) clearTimeout(timer);
      if (outputTimer) clearTimeout(outputTimer);
      this.emitter.off('data', onData);
      this.emitter.off('exit', onExit);
      this.emitter.off('error', onError);
    }
  }
}

function spawnLiveProcess(opts: LiveSessionCommand): {
  child: LiveChild;
  command: string;
  pty: boolean;
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
} {
  const socketName = `lark-channel-${process.pid}-${randomUUID().replace(/-/g, '').slice(0, 16)}`;
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

function sendInput(input) {
  if (input === '\x03') {
    sendKeys(['C-c']);
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

  let current = '';
  for (const char of input) {
    if (char === '\r' || char === '\n') {
      sendLiteral(current);
      current = '';
      sendKeys(['Enter']);
    } else {
      current += char;
    }
  }
  sendLiteral(current);
}

function capture() {
  if (closed) return;
  const hasSession = tmux(['has-session', '-t', session], { stdio: 'ignore' });
  if (hasSession.status !== 0) {
    cleanup();
    process.exit(0);
  }
  const result = tmux(['capture-pane', '-p', '-J', '-t', target]);
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
process.stdin.on('data', sendInput);
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

function translateLiveInput(input: string): string {
  const trimmed = input.trim().toLowerCase();
  if (trimmed === 'up' || trimmed === '↑' || trimmed === '上') return '\x1B[A';
  if (trimmed === 'down' || trimmed === '↓' || trimmed === '下') return '\x1B[B';
  if (trimmed === 'left' || trimmed === '←' || trimmed === '左') return '\x1B[D';
  if (trimmed === 'right' || trimmed === '→' || trimmed === '右') return '\x1B[C';
  if (trimmed === 'enter' || trimmed === 'return' || trimmed === '回车') return '\r';
  if (trimmed === 'esc' || trimmed === 'escape' || trimmed === '取消') return '\x1B';
  return `${input}\r`;
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
  private lastSnapshot = '';
  private readonly screen = new VirtualTerminalScreen();

  setScreenMode(enabled: boolean): void {
    this.screenMode = enabled;
    this.carry = '';
    this.lastSnapshot = '';
    this.screen.reset();
  }

  resetTurn(): void {
    this.carry = '';
    this.lastSnapshot = '';
    if (this.screenMode) this.screen.reset();
  }

  push(input: string): LiveOutput {
    if (this.screenMode) {
      this.screen.write(input);
      const snapshot = stripKnownLiveNoise(this.screen.snapshot());
      if (!snapshot.trim() || snapshot === this.lastSnapshot) {
        return { mode: 'snapshot', text: '' };
      }
      this.lastSnapshot = snapshot;
      return { mode: 'snapshot', text: snapshot };
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

  constructor(
    private readonly maxChars: number,
    private readonly promptEcho: string = '',
  ) {}

  append(raw: string): boolean {
    const compacted = this.compact(raw);
    if (!compacted.trim()) return false;
    const existing = this.emitted + this.pending;
    if (existing.endsWith(compacted)) return false;

    this.pending += compacted;
    this.enforceLimit();
    return true;
  }

  replace(raw: string): boolean {
    const compacted = this.compact(raw);
    if (!compacted.trim()) return false;
    if (this.pending === compacted || this.emitted.endsWith(compacted)) return false;
    this.pending = compacted.endsWith('\n') ? compacted : `${compacted}\n`;
    this.enforceLimit();
    return true;
  }

  take(): string {
    const out = stripKnownLiveNoise(this.pending);
    this.emitted += out;
    this.pending = '';
    return out;
  }

  private compact(text: string): string {
    const normalized = stripPromptEcho(cleanTerminalOutput(text), this.promptEcho);
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

function stripKnownLiveNoise(input: string): string {
  return stripCompactNoise(input, [
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
  ])
    .replace(/(^|\n)\s*`\s*(?=\n|$)/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trimStart();
}

function sanitizeLiveTurnOutput(input: string): string {
  const stripped = stripKnownLiveNoise(input);
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
  return input;
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

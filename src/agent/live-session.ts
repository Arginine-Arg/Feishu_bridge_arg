import { EventEmitter } from 'node:events';
import type { Readable, Writable } from 'node:stream';
import { log } from '../core/logger';
import { mergeProcessEnv, spawnProcess, type SpawnedProcessByStdio } from '../platform/spawn';
import type { AgentEvent, AgentRun } from './types';

type LiveChild = SpawnedProcessByStdio<Writable, Readable, Readable>;

export interface LiveSessionCommand {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  signature: string;
  usePty?: boolean;
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
    const text = this.cleaner.push(chunk.toString('utf8'));
    if (!text.trim()) return;
    this.emitter.emit('data', text);
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
    const output = new TurnOutputBuffer(MAX_TURN_OUTPUT_CHARS);
    const queue: AgentEvent[] = [];
    let done = false;
    let wake: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let outputTimer: ReturnType<typeof setTimeout> | undefined;

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

    const onData = (text: string): void => {
      if (output.append(text)) scheduleOutputFlush();
      arm(idleMs);
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
    if (!done) this.write(`${prompt}\r`);

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
  const env = mergeProcessEnv(process.env, {
    TERM: process.env.TERM || 'xterm-256color',
    ...opts.env,
  });
  if (opts.usePty !== false && process.platform === 'linux') {
    const commandLine = `stty -echo 2>/dev/null; ${[opts.command, ...opts.args].map(shellQuote).join(' ')}`;
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

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
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

  push(input: string): string {
    const combined = this.carry + input;
    const splitAt = completePrefixEnd(combined);
    this.carry = combined.slice(splitAt);
    return cleanTerminalOutput(combined.slice(0, splitAt));
  }
}

class TurnOutputBuffer {
  private emitted = '';
  private pending = '';
  private lastCompleteLine = '';
  private truncated = false;

  constructor(private readonly maxChars: number) {}

  append(raw: string): boolean {
    const compacted = this.compact(raw);
    if (!compacted.trim()) return false;
    const existing = this.emitted + this.pending;
    if (existing.endsWith(compacted)) return false;

    this.pending += compacted;
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
    const normalized = cleanTerminalOutput(text);
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
    '⚠Ignoringmalformedagentroledefinition:agentroleweb-researchermustdefineadescription',
    'Ignoringmalformedagentroledefinition:agentroleweb-researchermustdefineadescription',
    'Tip:Use/inittocreateanAGENTS.mdwithproject-specificguidance.',
    'Tip:Use/inittocreateanAGENTS.mdwithproject-specificguidance',
  ])
    .replace(/\n{3,}/g, '\n\n')
    .trimStart();
}

function stripCompactNoise(input: string, patterns: string[]): string {
  const compactChars: string[] = [];
  const map: number[] = [];
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i] ?? '';
    if (/\s|`/.test(char)) continue;
    compactChars.push(char.toLowerCase());
    map.push(i);
  }
  const compact = compactChars.join('');
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

import { createHash } from 'node:crypto';
import { mkdir, appendFile, lstat, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnProcessSync } from '../../platform/spawn';
import type { AgentEvent } from '../types';
import type { TmuxBindingStatus } from '../tmux-control';

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/** A view consumes events only. Opening or closing it never starts/stops a turn. */
export class StructuredView {
  private tail: Promise<void> = Promise.resolve();
  private statusValue: TmuxBindingStatus = { state: 'none' };
  private logPath = '';
  private nativeSpec?: { binary: string; endpoint: string; threadId: string; env?: NodeJS.ProcessEnv };
  private nativeCwd?: string;
  constructor(private readonly directory: string, private readonly key: string) {}
  async start(native?: { binary: string; endpoint: string; threadId: string; env?: NodeJS.ProcessEnv }, cwd?: string): Promise<void> {
    if (native) this.nativeSpec = native;
    if (cwd) this.nativeCwd = cwd;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.directory);
    if (info.isSymbolicLink() || !info.isDirectory() || (process.getuid && info.uid !== process.getuid())) throw new Error('Unsafe terminal view directory');
    await chmod(this.directory, 0o700);
    const name = `argbridge-api-${createHash('sha256').update(this.key).digest('hex').slice(0, 16)}`;
    this.logPath = join(this.directory, `${name}.log`);
    await appendFile(this.logPath, '', { mode: 0o600 });
    if (process.platform === 'win32' || spawnProcessSync('tmux', ['-V'], { stdio: 'ignore' }).status !== 0) return;
    const socket = join(this.directory, 'view.sock');
    if (Buffer.byteLength(socket) > 100) return;
    const exists = spawnProcessSync('tmux', ['-S', socket, 'has-session', '-t', name], { stdio: 'ignore' });
    if (exists.status === 0 && native) {
      const dead = spawnProcessSync('tmux', ['-S', socket, 'list-panes', '-t', name, '-F', '#{pane_dead}'], { encoding: 'utf8' });
      if (dead.status === 0 && typeof dead.stdout === 'string' && dead.stdout.trim().split(/\s+/u).every(value => value === '1')) {
        spawnProcessSync('tmux', ['-S', socket, 'kill-session', '-t', name], { stdio: 'ignore' });
      }
    }
    const sessionExists = spawnProcessSync('tmux', ['-S', socket, 'has-session', '-t', name], { stdio: 'ignore' });
    if (sessionExists.status !== 0) {
      const command = native
        ? [native.binary, '-c', 'check_for_update_on_startup=false', '--remote', native.endpoint, 'resume', native.threadId, '--no-alt-screen'].map(quote).join(' ')
        : `tail -n 200 -F ${quote(this.logPath)}`;
      const created = spawnProcessSync('tmux', ['-S', socket, '-f', '/dev/null', 'new-session', '-d', '-s', name, '-x', '120', '-y', '40', '-c', cwd ?? this.directory, command], { encoding: 'utf8', env: native?.env ?? process.env });
      if (created.status !== 0) return;
      spawnProcessSync('tmux', ['-S', socket, 'set-option', '-t', name, 'remain-on-exit', 'on'], { stdio: 'ignore' });
    }
    this.statusValue = { state: 'managed', terminal: {
      socketPath: socket, target: name, ownership: 'managed',
      attachCommand: `tmux -S ${quote(socket)} attach -t ${quote(name)}`,
    }, message: native ? 'Shared Codex App Server terminal' : 'Read-only structured event view; input is controlled from Feishu' };
  }
  async ensureNative(): Promise<void> {
    if (this.nativeSpec) await this.start(this.nativeSpec, this.nativeCwd);
  }
  event(event: AgentEvent): void {
    if (!this.logPath) return;
    let text = '';
    if (event.type === 'text') text = event.delta;
    else if (event.type === 'interactive') text = `\n[等待选择] ${event.text}\n`;
    else if (event.type === 'tool_use') text = `\n[${event.name}] ${JSON.stringify(event.input)}\n`;
    else if (event.type === 'tool_result') text = `\n${event.output}\n`;
    else if (event.type === 'done') text = `\n[${event.terminationReason}]\n`;
    else if (event.type === 'error') text = `\n[错误] ${event.message}\n`;
    if (text) this.tail = this.tail.then(() => appendFile(this.logPath, text.replace(/\x1b/g, ''))).catch(() => {});
  }
  status(): TmuxBindingStatus { return this.statusValue; }
  async close(): Promise<void> { await this.tail; }
  async dispose(): Promise<void> {
    await this.close();
    const terminal = this.statusValue.terminal;
    if (terminal?.socketPath && terminal.ownership === 'managed') {
      spawnProcessSync('tmux', ['-S', terminal.socketPath, 'kill-session', '-t', terminal.target], { stdio: 'ignore' });
    }
    this.statusValue = { state: 'none' };
  }
}

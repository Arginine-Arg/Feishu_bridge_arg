import { createHash } from 'node:crypto';
import {
  lstatSync,
  readFileSync,
  readdirSync,
  unlinkSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { writeFileAtomic } from '../platform/atomic-write';
import { spawnProcessSync } from '../platform/spawn';
import { resolveWorkingDirectory } from '../policy/workspace';

export type TmuxAgentKind = 'codex' | 'claude';
export type TmuxOwnership = 'managed' | 'external';

export interface TmuxPaneTarget {
  socketPath: string;
  sessionName: string;
  windowIndex: string;
  paneIndex: string;
  paneId: string;
  panePid: number;
  paneCurrentCommand: string;
  paneCurrentPath: string;
  agentKind: TmuxAgentKind;
  ownership: TmuxOwnership;
  attachCommand: string;
}

export interface TmuxTerminalTarget {
  socketPath: string;
  target: string;
  attachCommand: string;
  ownership: TmuxOwnership;
}

export interface TmuxPaneTail {
  terminal: TmuxTerminalTarget;
  requestedLines: number;
  text: string;
}

export interface TmuxBindingStatus {
  state: 'managed' | 'external' | 'none' | 'invalid';
  target?: TmuxPaneTarget;
  terminal?: TmuxTerminalTarget;
  message?: string;
}

export interface AgentTmuxControl {
  list(socket?: string): Promise<TmuxPaneTarget[]>;
  bind(scopeId: string, selector: string): Promise<TmuxPaneTarget>;
  unbind(scopeId: string): Promise<boolean>;
  status(scopeId: string): Promise<TmuxBindingStatus>;
  /** Captures only the current scope's active or bound pane. */
  tail?(scopeId: string, lineCount: number): Promise<TmuxPaneTail>;
}

interface TmuxBindingsFile {
  version: 1;
  bindings: Record<string, TmuxPaneTarget>;
}

const BINDINGS_FILE = 'tmux-bindings.json';
const MAX_TMUX_TAIL_CHARS = 12_000;
const TMUX_FORMAT = [
  '#{session_name}',
  '#{window_index}',
  '#{pane_index}',
  '#{pane_id}',
  '#{pane_pid}',
  '#{pane_current_command}',
  '#{pane_current_path}',
  '#{@argbridge_managed}',
].join('\t');

export class TmuxBindingController {
  private readonly file: string;
  private readonly bindings: Record<string, TmuxPaneTarget>;

  constructor(
    private readonly profileStateDir: string,
    private readonly profile: string,
    private readonly agentKind: TmuxAgentKind,
  ) {
    this.file = join(profileStateDir, BINDINGS_FILE);
    this.bindings = loadBindings(this.file);
  }

  managedSessionName(scopeId: string): string {
    const profile = safeTmuxName(this.profile).slice(0, 24) || this.agentKind;
    const scopeHash = createHash('sha256').update(scopeId).digest('hex').slice(0, 12);
    return `argbridge-${this.agentKind}-${profile}-${scopeHash}`.slice(0, 96);
  }

  async list(socket?: string): Promise<TmuxPaneTarget[]> {
    return listTmuxAgentPanes(socket);
  }

  async bind(scopeId: string, selector: string): Promise<TmuxPaneTarget> {
    const explicitSocket = selector.includes('::') ? selector.slice(0, selector.lastIndexOf('::')) : undefined;
    const candidates = await this.list(explicitSocket);
    const target = selectTmuxTarget(candidates, selector);
    if (!target) {
      throw new Error(`未找到 tmux pane：${selector}。先运行 /tmux list。`);
    }
    if (target.ownership !== 'external') {
      throw new Error('不能绑定 bridge 托管的 tmux pane。');
    }
    if (target.agentKind !== this.agentKind) {
      throw new Error(
        `当前 profile 是 ${this.agentKind}，不能绑定 ${target.agentKind} pane。`,
      );
    }
    const workspace = await resolveWorkingDirectory(target.paneCurrentPath);
    if (!workspace.ok) throw new Error(workspace.userVisible);

    const existingScope = this.findBoundScope(target);
    if (existingScope && existingScope !== scopeId) {
      throw new Error(`该 pane 已绑定到 scope ${existingScope}。`);
    }
    const crossProfile = findCrossProfileBinding(this.profileStateDir, target, scopeId);
    if (crossProfile) {
      throw new Error(`该 pane 已被 profile ${crossProfile} 绑定。`);
    }

    const binding = {
      ...target,
      paneCurrentPath: workspace.cwdRealpath,
    };
    this.bindings[scopeId] = binding;
    await this.flush();
    return binding;
  }

  async unbind(scopeId: string): Promise<boolean> {
    if (!this.bindings[scopeId]) return false;
    delete this.bindings[scopeId];
    await this.flush();
    return true;
  }

  async status(scopeId: string): Promise<TmuxBindingStatus> {
    const saved = this.bindings[scopeId];
    if (!saved) return { state: 'none' };
    try {
      const target = revalidateTmuxTarget(saved, this.agentKind);
      return { state: 'external', target };
    } catch (err) {
      return {
        state: 'invalid',
        target: saved,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  bindingFor(scopeId: string, cwd: string): TmuxPaneTarget | undefined {
    const saved = this.bindings[scopeId];
    if (!saved) return undefined;
    let target: TmuxPaneTarget;
    try {
      target = revalidateTmuxTarget(saved, this.agentKind);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`tmux 绑定已失效：${detail}。请运行 /tmux unbind。`);
    }
    if (resolve(target.paneCurrentPath) !== resolve(cwd)) {
      throw new Error(
        `tmux pane cwd (${target.paneCurrentPath}) 与当前 workspace (${cwd}) 不一致。请运行 /tmux unbind 或 /cd。`,
      );
    }
    return target;
  }

  private findBoundScope(target: TmuxPaneTarget): string | undefined {
    return Object.entries(this.bindings).find(([, item]) => samePane(item, target))?.[0];
  }

  private async flush(): Promise<void> {
    const content: TmuxBindingsFile = { version: 1, bindings: this.bindings };
    await writeFileAtomic(this.file, `${JSON.stringify(content, null, 2)}\n`, { mode: 0o600 });
  }
}

export function defaultTmuxSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  const current = env.TMUX?.split(',')[0];
  if (current && isAbsolute(current)) return current;
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  return join(env.TMUX_TMPDIR || tmpdir(), `tmux-${uid}`, 'default');
}

export function tmuxAttachCommand(target: Pick<TmuxPaneTarget, 'socketPath' | 'sessionName' | 'windowIndex' | 'paneIndex'>): string {
  const pane = `${target.sessionName}:${target.windowIndex}.${target.paneIndex}`;
  return `tmux -S ${shellQuote(target.socketPath)} attach -t ${shellQuote(pane)}`;
}

export function listTmuxAgentPanes(socket?: string): TmuxPaneTarget[] {
  const sockets = socket
    ? [resolveSocketSelector(socket)]
    : discoverTmuxSockets();
  const panes: TmuxPaneTarget[] = [];
  for (const socketPath of sockets) {
    if (!isSafeTmuxSocket(socketPath)) continue;
    panes.push(...listPanesOnSocket(socketPath));
  }
  return panes.sort((a, b) =>
    `${a.socketPath}\0${a.sessionName}\0${a.windowIndex}\0${a.paneIndex}`.localeCompare(
      `${b.socketPath}\0${b.sessionName}\0${b.windowIndex}\0${b.paneIndex}`,
    ),
  );
}

export function discoverTmuxSockets(): string[] {
  const found = new Set<string>();
  found.add(defaultTmuxSocketPath());
  const current = process.env.TMUX?.split(',')[0];
  if (current && isAbsolute(current)) found.add(current);

  if (process.platform === 'linux') {
    try {
      const standardDir = dirname(defaultTmuxSocketPath({ ...process.env, TMUX: undefined }));
      const lines = readFileSync('/proc/net/unix', 'utf8').split('\n');
      for (const line of lines) {
        const path = line.trim().split(/\s+/).at(-1);
        if (path?.startsWith(`${standardDir}/`)) found.add(path);
      }
    } catch {
      // Fall through to the directory scan below.
    }
  }

  const standardDir = dirname(defaultTmuxSocketPath({ ...process.env, TMUX: undefined }));
  try {
    for (const name of readdirSync(standardDir)) found.add(join(standardDir, name));
  } catch {
    // No tmux server has created the standard directory yet.
  }
  for (const path of [...found]) {
    if (!basename(path).startsWith('lark-channel-')) continue;
    if (!isSafeTmuxSocket(path) || tmuxServerAlive(path)) continue;
    try {
      unlinkSync(path);
      found.delete(path);
    } catch {
      // A concurrent bridge may own the socket; leave it for the next scan.
    }
  }
  return [...found].filter(isSafeTmuxSocket).sort();
}

function tmuxServerAlive(socketPath: string): boolean {
  const result = spawnProcessSync('tmux', ['-S', socketPath, 'list-sessions', '-F', '#{session_name}'], {
    stdio: 'ignore',
  });
  return result.status === 0;
}

export function isSafeTmuxSocket(path: string): boolean {
  if (!isAbsolute(path)) return false;
  try {
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isSocket()) return false;
    return typeof process.getuid !== 'function' || info.uid === process.getuid();
  } catch {
    return false;
  }
}

export function tmuxTargetKey(target: Pick<TmuxPaneTarget, 'socketPath' | 'paneId'>): string {
  return `${target.socketPath}::${target.paneId}`;
}

/**
 * Capture the visible end of a known bridge terminal. The caller supplies the
 * terminal from a live session or a revalidated binding; this helper never
 * discovers or selects arbitrary panes.
 */
export function captureTmuxPaneTail(
  terminal: TmuxTerminalTarget,
  requestedLines: number,
): TmuxPaneTail {
  if (!Number.isSafeInteger(requestedLines) || requestedLines <= 0) {
    throw new Error('行数必须是正整数');
  }
  if (!isSafeTmuxSocket(terminal.socketPath)) {
    throw new Error('tmux socket 不存在或不安全');
  }
  const result = spawnProcessSync(
    'tmux',
    ['-S', terminal.socketPath, 'capture-pane', '-p', '-S', `-${requestedLines}`, '-t', terminal.target],
    { encoding: 'utf8', maxBuffer: 1024 * 1024 },
  );
  if (result.status !== 0) {
    const detail = typeof result.stderr === 'string'
      ? result.stderr.trim()
      : result.error?.message;
    throw new Error(`无法读取当前 tmux pane${detail ? `：${detail}` : ''}`);
  }
  const output = typeof result.stdout === 'string' ? result.stdout : result.stdout?.toString('utf8') ?? '';
  return {
    terminal,
    requestedLines,
    text: normalizeTmuxTail(output, requestedLines),
  };
}

function normalizeTmuxTail(output: string, requestedLines: number): string {
  const cleaned = output
    .replace(/\r/g, '')
    .replace(/\x1B(?:\][\s\S]*?(?:\x07|\x1B\\)|\[[0-?]*[ -/]*[@-~]|[@-_])/gu, '')
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/gu, '');
  const lines = cleaned.split('\n');
  while (lines.at(-1) === '') lines.pop();
  const tail = lines.slice(-requestedLines).join('\n').replace(/[ \t]+$/gmu, '');
  if (tail.length <= MAX_TMUX_TAIL_CHARS) return tail;
  return `…（输出过长，仅显示最后 ${MAX_TMUX_TAIL_CHARS} 个字符）\n${tail.slice(-MAX_TMUX_TAIL_CHARS)}`;
}

function resolveSocketSelector(selector: string): string {
  const trimmed = selector.trim();
  if (isAbsolute(trimmed)) return trimmed;
  if (/^[A-Za-z0-9_.-]+$/.test(trimmed)) {
    return join(dirname(defaultTmuxSocketPath({ ...process.env, TMUX: undefined })), trimmed);
  }
  return trimmed;
}

function listPanesOnSocket(socketPath: string): TmuxPaneTarget[] {
  const result = spawnProcessSync('tmux', ['-S', socketPath, 'list-panes', '-a', '-F', TMUX_FORMAT], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0 || typeof result.stdout !== 'string') return [];
  const processAgents = linuxProcessAgents();
  const out: TmuxPaneTarget[] = [];
  for (const line of result.stdout.split('\n')) {
    if (!line.trim()) continue;
    const [sessionName, windowIndex, paneIndex, paneId, rawPid, command, cwd, managed] = line.split('\t');
    if (!sessionName || !windowIndex || !paneIndex || !paneId || !rawPid || !command || !cwd) continue;
    const panePid = Number.parseInt(rawPid, 10);
    if (!Number.isSafeInteger(panePid) || panePid <= 0) continue;
    const agentKind = detectTmuxAgent(command, panePid, processAgents);
    if (!agentKind) continue;
    const target: TmuxPaneTarget = {
      socketPath,
      sessionName,
      windowIndex,
      paneIndex,
      paneId,
      panePid,
      paneCurrentCommand: command,
      paneCurrentPath: cwd,
      agentKind,
      ownership: managed === '1' ? 'managed' : 'external',
      attachCommand: '',
    };
    target.attachCommand = tmuxAttachCommand(target);
    out.push(target);
  }
  return out;
}

function detectTmuxAgent(
  paneCommand: string,
  panePid: number,
  processAgents: Map<number, { ppid: number; agent?: TmuxAgentKind }>,
): TmuxAgentKind | undefined {
  const direct = agentFromCommand(paneCommand);
  if (direct) return direct;
  if (process.platform !== 'linux') return undefined;
  const descendants = new Set<number>([panePid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, item] of processAgents) {
      if (!descendants.has(pid) && descendants.has(item.ppid)) {
        descendants.add(pid);
        changed = true;
      }
    }
  }
  for (const pid of descendants) {
    const agent = processAgents.get(pid)?.agent;
    if (agent) return agent;
  }
  return undefined;
}

function linuxProcessAgents(): Map<number, { ppid: number; agent?: TmuxAgentKind }> {
  const out = new Map<number, { ppid: number; agent?: TmuxAgentKind }>();
  if (process.platform !== 'linux') return out;
  const result = spawnProcessSync('ps', ['-eo', 'pid=,ppid=,comm=,args='], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.status !== 0 || typeof result.stdout !== 'string') return out;
  for (const line of result.stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/u.exec(line);
    if (!match) continue;
    const pid = Number.parseInt(match[1]!, 10);
    const ppid = Number.parseInt(match[2]!, 10);
    const comm = match[3]!;
    const args = match[4] ?? '';
    out.set(pid, { ppid, agent: agentFromCommand(comm) ?? agentFromArgv(args) });
  }
  return out;
}

function agentFromCommand(command: string): TmuxAgentKind | undefined {
  const base = command.toLowerCase().split('/').at(-1)?.replace(/\.(?:exe|cmd)$/u, '');
  if (base === 'codex') return 'codex';
  if (base === 'claude') return 'claude';
  return undefined;
}

function agentFromArgv(args: string): TmuxAgentKind | undefined {
  const words = args.trim().split(/\s+/).slice(0, 3);
  for (const word of words) {
    const agent = agentFromCommand(word.replace(/^['"]|['"]$/g, ''));
    if (agent) return agent;
  }
  return undefined;
}

function selectTmuxTarget(candidates: TmuxPaneTarget[], selector: string): TmuxPaneTarget | undefined {
  const trimmed = selector.trim();
  if (/^[1-9]\d*$/.test(trimmed)) return candidates[Number.parseInt(trimmed, 10) - 1];
  const exact = candidates.filter((item) =>
    tmuxTargetKey(item) === trimmed || item.paneId === trimmed,
  );
  if (exact.length === 1) return exact[0];
  return undefined;
}

function revalidateTmuxTarget(saved: TmuxPaneTarget, expectedAgent: TmuxAgentKind): TmuxPaneTarget {
  if (!isSafeTmuxSocket(saved.socketPath)) throw new Error('socket 不存在或不安全');
  const current = listPanesOnSocket(saved.socketPath).find((item) => item.paneId === saved.paneId);
  if (!current) throw new Error(`pane ${saved.paneId} 不存在`);
  if (current.ownership !== 'external') throw new Error('目标现在是 bridge 托管 pane');
  if (current.agentKind !== expectedAgent) {
    throw new Error(`目标 agent 已变为 ${current.agentKind}`);
  }
  return current;
}

function loadBindings(file: string): Record<string, TmuxPaneTarget> {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<TmuxBindingsFile>;
    if (parsed.version !== 1 || !parsed.bindings || typeof parsed.bindings !== 'object') return {};
    return parsed.bindings;
  } catch {
    return {};
  }
}

function findCrossProfileBinding(
  profileStateDir: string,
  target: TmuxPaneTarget,
  scopeId: string,
): string | undefined {
  const profilesDir = dirname(profileStateDir);
  try {
    for (const profile of readdirSync(profilesDir)) {
      const dir = join(profilesDir, profile);
      if (resolve(dir) === resolve(profileStateDir)) continue;
      const bindings = loadBindings(join(dir, BINDINGS_FILE));
      if (Object.entries(bindings).some(([scope, item]) => scope !== scopeId && samePane(item, target))) {
        return profile;
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function samePane(a: Pick<TmuxPaneTarget, 'socketPath' | 'paneId'>, b: Pick<TmuxPaneTarget, 'socketPath' | 'paneId'>): boolean {
  return resolve(a.socketPath) === resolve(b.socketPath) && a.paneId === b.paneId;
}

function safeTmuxName(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

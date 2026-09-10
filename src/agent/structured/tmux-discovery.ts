import { basename, resolve as resolvePath } from 'node:path';
import { readFileSync, readlinkSync } from 'node:fs';
import { spawnProcessSync } from '../../platform/spawn';
import {
  listTmuxAgentPanes,
  type TmuxPaneTarget,
} from '../tmux-control';

export interface StructuredTmuxPane extends TmuxPaneTarget {
  structured: {
    endpoint?: string;
    threadId: string;
    legacy?: boolean;
    codexHome?: string;
    persisted?: boolean;
  };
}

/**
 * Discover native sessions from process argv, never from rendered terminal
 * text. Codex structured sessions must expose both --remote and resume <id>;
 * a normal `codex resume` process is deliberately not attachable here because
 * it belongs to a different backend.
 */
export function listStructuredTmuxPanes(socket?: string): StructuredTmuxPane[] {
  return listTmuxAgentPanes(socket).flatMap(pane => {
    // Inspect each live process separately. A shell's original launch string
    // can still mention the old thread after the user resumes a different one.
    const processArgs = [
      ...processArgvTree(pane.panePid),
      ...processArgvForPane(pane),
    ];
    const identities = [
      ...processArgs,
      ...(pane.paneStartCommand ? [shellWords(pane.paneStartCommand)] : []),
    ]
      .map(argv => parseStructuredAgentArgv(argv, pane.agentKind))
      .filter((identity): identity is NonNullable<typeof identity> => Boolean(identity));
    const unique = new Map(identities.map(identity => [JSON.stringify(identity), identity]));
    const remote = new Map(
      identities.filter(identity => identity.endpoint).map(identity => [JSON.stringify(identity), identity]),
    );
    const identity = unique.size === 1
      ? [...unique.values()][0]
      : remote.size === 1
        ? [...remote.values()][0]
        : undefined;
    if (!identity) return [];
    const codexHome = pane.agentKind === 'codex' ? processEnvironmentForPidTree(pane.panePid).CODEX_HOME : undefined;
    return [{ ...pane, structured: { ...identity, ...(codexHome ? { codexHome } : {}) } }];
  });
}

export function activeStructuredTmuxPane(socket: string, sessionName: string): StructuredTmuxPane | undefined {
  const active = spawnProcessSync(
    'tmux',
    ['-S', socket, 'display-message', '-p', '-t', sessionName, '#{pane_id}'],
    { encoding: 'utf8' },
  );
  const paneId = active.status === 0 && typeof active.stdout === 'string' ? active.stdout.trim() : '';
  if (!paneId) return undefined;
  return listStructuredTmuxPanes(socket).find(pane => pane.sessionName === sessionName && pane.paneId === paneId);
}

export function parseStructuredAgentArgv(argv: readonly string[], kind: 'codex' | 'claude'): { endpoint?: string; threadId: string; legacy?: boolean } | undefined {
  const normalized = argv.map(item => item.trim()).filter(Boolean);
  const agentIndex = normalized.findIndex(item => {
    const name = basename(item).replace(/\.(?:cmd|exe)$/iu, '').toLowerCase();
    return name === kind;
  });
  if (agentIndex < 0) return undefined;
  const resumeIndex = normalized.findIndex((item, index) => index > agentIndex && (item === 'resume' || item === '--resume'));
  if (resumeIndex < 0 || !normalized[resumeIndex + 1]) return undefined;
  const threadId = normalized[resumeIndex + 1]!;
  // `codex resume` without an explicit id may be followed by options such as
  // `-m`/`--model`; those are not session identities. Never bind a pane to a
  // CLI flag, otherwise a model choice can be mistaken for a thread.
  if (threadId.startsWith('-')) return undefined;
  const remoteIndex = normalized.findIndex(item => item === '--remote' || item.startsWith('--remote='));
  const endpoint = remoteIndex >= 0
    ? (normalized[remoteIndex]!.slice('--remote='.length) || normalized[remoteIndex + 1])
    : undefined;
  if (kind === 'codex' && !endpoint) return { threadId, legacy: true };
  return { ...(endpoint ? { endpoint } : {}), threadId };
}

function shellWords(value: string): string[] {
  return value.split(/\s+/u).map(item => item.replace(/^['"]|['"]$/gu, '')).filter(Boolean);
}

export function processEnvironmentForPidTree(rootPid: number): NodeJS.ProcessEnv {
  if (process.platform !== 'linux') return {};
  const result = spawnProcessSync('ps', ['-ww', '-eo', 'pid=,ppid='], { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
  const rows = new Map<number, number>();
  if (result.status === 0 && typeof result.stdout === 'string') {
    for (const line of result.stdout.split('\n')) {
      const match = /^\s*(\d+)\s+(\d+)\s*$/u.exec(line);
      if (match) rows.set(Number(match[1]), Number(match[2]));
    }
  }
  const ids = new Set<number>([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, ppid] of rows) if (!ids.has(pid) && ids.has(ppid)) { ids.add(pid); changed = true; }
  }
  let fallback: NodeJS.ProcessEnv = {};
  for (const pid of ids) {
    try {
      const raw = readFileSync(`/proc/${pid}/environ`, 'utf8');
      const env = Object.fromEntries(raw.split('\0').flatMap(item => {
        const index = item.indexOf('=');
        return index > 0 ? [[item.slice(0, index), item.slice(index + 1)]] : [];
      }));
      if (!Object.keys(fallback).length) fallback = env;
      const argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
      if (argv.slice(0, 2).some(arg => basename(arg) === 'codex')) return env;
    } catch { /* process exited between ps and /proc read */ }
  }
  return fallback;
}

function processArgvTree(rootPid: number): string[][] {
  if (process.platform === 'win32') return [];
  const result = spawnProcessSync('ps', ['-ww', '-eo', 'pid=,ppid=,args='], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0 || typeof result.stdout !== 'string') return [];
  const rows = new Map<number, { ppid: number; args: string }>();
  for (const line of result.stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/u.exec(line);
    if (!match) continue;
    rows.set(Number(match[1]), { ppid: Number(match[2]), args: match[3] ?? '' });
  }
  const ids = new Set<number>([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, row] of rows) {
      if (!ids.has(pid) && ids.has(row.ppid)) { ids.add(pid); changed = true; }
    }
  }
  return [...ids].flatMap(pid => {
    if (process.platform === 'linux') {
      try {
        const argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
        if (argv.length) return [argv];
      } catch { /* systemd/hidepid may deny /proc; use ps below */ }
    }
    const args = rows.get(pid)?.args;
    return args ? [args.split(/\s+/u)] : [];
  });
}

/**
 * A tmux server can launch a shell under a different PID namespace or with a
 * restricted /proc mount. In that case the pane's parent tree is incomplete
 * even though `ps` still shows the Codex child (the same situation seen on
 * some worker hosts). Use tmux's inherited TMUX_PANE marker as the primary
 * association, and cwd only as a conservative fallback.
 */
function processArgvForPane(pane: TmuxPaneTarget): string[][] {
  if (process.platform !== 'linux') return [];
  const result = spawnProcessSync('ps', ['-ww', '-eo', 'pid=,args='], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0 || typeof result.stdout !== 'string') return [];
  const candidates: Array<{ pid: number; args: string; paneMatch: boolean; tmuxMatch: boolean; cwdMatch: boolean }> = [];
  for (const line of result.stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/u.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const args = match[2] ?? '';
    if (!Number.isSafeInteger(pid) || !/(?:^|[\s/])codex(?:\.js)?(?:[\s]|$)/iu.test(args)) continue;
    if (!/(?:^|\s)(?:--remote(?:=|\s)|resume(?:\s|$))/iu.test(args)) continue;
    let paneMatch = false;
    let tmuxMatch = false;
    let cwdMatch = false;
    try {
      const env = readFileSync(`/proc/${pid}/environ`, 'utf8');
      const values = new Map<string, string>();
      for (const item of env.split('\0')) {
        const equals = item.indexOf('=');
        if (equals > 0) values.set(item.slice(0, equals), item.slice(equals + 1));
      }
      paneMatch = values.get('TMUX_PANE') === pane.paneId;
      // Pane IDs are only unique inside one tmux server. `%0` can therefore
      // occur in several sockets on the same host; require the server socket
      // from TMUX as well whenever it is available, otherwise a worker with
      // multiple native sessions gets an ambiguous identity and is hidden.
      const tmuxSocket = values.get('TMUX')?.split(',', 1)[0]?.trim();
      tmuxMatch = paneMatch && Boolean(tmuxSocket) && resolvePath(tmuxSocket!) === resolvePath(pane.socketPath);
    } catch { /* hidepid or process exited */ }
    try { cwdMatch = readlinkSync(`/proc/${pid}/cwd`) === pane.paneCurrentPath; }
    catch { /* process exited or inaccessible */ }
    if (paneMatch || cwdMatch) candidates.push({ pid, args, paneMatch, tmuxMatch, cwdMatch });
  }
  const tmuxMatches = candidates.filter(candidate => candidate.tmuxMatch);
  const paneMatches = candidates.filter(candidate => candidate.paneMatch);
  const selected = tmuxMatches.length > 0
    ? tmuxMatches
    : paneMatches.length > 0
      ? paneMatches
      : candidates.filter(candidate => candidate.cwdMatch);
  selected.sort((a, b) => Number(b.tmuxMatch) - Number(a.tmuxMatch) || Number(b.paneMatch) - Number(a.paneMatch) || Number(b.cwdMatch) - Number(a.cwdMatch));
  return selected.map(candidate => candidate.args.split(/\s+/u));
}

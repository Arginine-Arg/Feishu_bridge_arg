import { basename } from 'node:path';
import { spawnProcessSync } from '../../platform/spawn';
import {
  listTmuxAgentPanes,
  type TmuxPaneTarget,
} from '../tmux-control';

export interface StructuredTmuxPane extends TmuxPaneTarget {
  structured: {
    endpoint?: string;
    threadId: string;
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
    const argv = processArgvTree(pane.panePid);
    const identity = parseStructuredAgentArgv(argv, pane.agentKind);
    return identity ? [{ ...pane, structured: identity }] : [];
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

export function parseStructuredAgentArgv(argv: readonly string[], kind: 'codex' | 'claude'): { endpoint?: string; threadId: string } | undefined {
  const normalized = argv.map(item => item.trim()).filter(Boolean);
  const hasAgent = normalized.some(item => {
    const name = basename(item).replace(/\.(?:cmd|exe)$/iu, '').toLowerCase();
    return name === kind;
  });
  if (!hasAgent) return undefined;
  const resumeIndex = normalized.findIndex(item => item === 'resume' || item === '--resume');
  if (resumeIndex < 0 || !normalized[resumeIndex + 1]) return undefined;
  const threadId = normalized[resumeIndex + 1]!;
  const remoteIndex = normalized.findIndex(item => item === '--remote' || item.startsWith('--remote='));
  const endpoint = remoteIndex >= 0
    ? (normalized[remoteIndex]!.slice('--remote='.length) || normalized[remoteIndex + 1])
    : undefined;
  if (kind === 'codex' && !endpoint) return undefined;
  return { ...(endpoint ? { endpoint } : {}), threadId };
}

function processArgvTree(rootPid: number): string[] {
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
    const args = rows.get(pid)?.args;
    return args ? args.split(/\s+/u) : [];
  });
}

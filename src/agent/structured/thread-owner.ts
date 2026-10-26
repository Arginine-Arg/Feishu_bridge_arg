import {
  existsSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';

const MAX_PROCESS_FAMILY_DEPTH = 8;
const MAX_ANCESTOR_DEPTH = 4;

export interface CodexThreadWriterOwners {
  lockPath?: string;
  /** Processes that hold Codex's cross-process writer lock. */
  pids: number[];
  /** Unix App Server sockets exposed by the owner process family. */
  endpoints: string[];
}

/**
 * Find the real writer owner for a Codex thread.
 *
 * Codex persists a per-thread `flock` under
 * `$CODEX_HOME/thread-writer-locks/<thread-id>.lock`. Reading
 * `/proc/locks` identifies the process directly, without scanning every
 * `/proc/<pid>/fd` entry or trusting a profile registry that may contain many
 * servers sharing the same CODEX_HOME.
 */
export function discoverCodexThreadWriterOwners(
  codexHome: string,
  threadId: string,
): CodexThreadWriterOwners {
  if (process.platform !== 'linux') return { pids: [], endpoints: [] };
  const lockPath = join(codexHome, 'thread-writer-locks', `${threadId}.lock`);
  if (!existsSync(lockPath)) return { lockPath, pids: [], endpoints: [] };

  const pids = findLockOwnerPids(lockPath);
  if (pids.length === 0) return { lockPath, pids, endpoints: [] };

  const family = processFamily(pids);
  const endpoints = [...new Set(
    family.flatMap(pid => endpointsForProcess(pid)),
  )].sort();
  return { lockPath, pids, endpoints };
}

/** PIDs named by active `flock` records for one inode in `/proc/locks`. */
export function findLockOwnerPids(lockPath: string): number[] {
  if (process.platform !== 'linux') return [];
  let inode: number;
  try {
    inode = statSync(lockPath).ino;
  } catch {
    return [];
  }
  let table: string;
  try {
    table = readFileSync('/proc/locks', 'utf8');
  } catch {
    return [];
  }
  const pids = new Set<number>();
  for (const line of table.split('\n')) {
    // Example:
    // 80: FLOCK  ADVISORY  WRITE 3735428 08:02:7657193 0 EOF
    // Blocked records contain `->`; the owner PID is on the left side.
    const match = /^\d+:\s+\S+\s+\S+\s+\S+\s+(\d+)\s+[0-9a-f]+:[0-9a-f]+:(\d+)\s+/iu
      .exec(line);
    if (!match || Number(match[2]) !== inode) continue;
    const pid = Number(match[1]);
    if (Number.isSafeInteger(pid) && pid > 0 && processOwnedByCurrentUser(pid)) pids.add(pid);
  }
  return [...pids].sort((a, b) => a - b);
}

/**
 * Parse a Codex `--listen` value. An empty `unix://` uses Codex's managed
 * control socket, which is discovered from the process's socket file
 * descriptors instead.
 */
export function parseUnixListenEndpoint(argv: readonly string[]): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    let value: string | undefined;
    if (arg === '--listen') value = argv[index + 1];
    else if (arg.startsWith('--listen=')) value = arg.slice('--listen='.length);
    if (value === undefined) continue;
    if (!value.startsWith('unix://')) return undefined;
    const path = value.slice('unix://'.length);
    return path.startsWith('/') ? path : undefined;
  }
  return undefined;
}

function endpointsForProcess(pid: number): string[] {
  if (!processOwnedByCurrentUser(pid)) return [];
  let argv: string[] = [];
  try {
    argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
  } catch {
    return [];
  }
  const parsed = parseUnixListenEndpoint(argv);
  if (parsed) {
    const endpoint = safeSocketEndpoint(parsed);
    if (endpoint) return [endpoint];
  }
  return socketPathsHeldByProcess(pid);
}

function socketPathsHeldByProcess(pid: number): string[] {
  const inodePaths = unixSocketInodePaths();
  if (inodePaths.size === 0) return [];
  const result = new Set<string>();
  try {
    for (const fd of readdirSync(`/proc/${pid}/fd`)) {
      const match = /^socket:\[(\d+)\]$/u.exec(readlinkSync(`/proc/${pid}/fd/${fd}`));
      if (!match) continue;
      for (const socketPath of inodePaths.get(match[1]!) ?? []) {
        const endpoint = safeSocketEndpoint(socketPath);
        if (endpoint) result.add(endpoint);
      }
    }
  } catch {
    // The owner exited between /proc/locks and fd inspection.
  }
  return [...result].sort();
}

function unixSocketInodePaths(): Map<string, string[]> {
  const result = new Map<string, string[]>();
  let table: string;
  try {
    table = readFileSync('/proc/net/unix', 'utf8');
  } catch {
    return result;
  }
  for (const line of table.split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/u);
    if (fields.length < 8) continue;
    const inode = fields[6]!;
    const socketPath = fields.slice(7).join(' ');
    if (!socketPath.startsWith('/')) continue;
    const paths = result.get(inode) ?? [];
    paths.push(socketPath);
    result.set(inode, paths);
  }
  return result;
}

function safeSocketEndpoint(path: string): string | undefined {
  try {
    const resolved = realpathSync(path);
    const info = statSync(resolved);
    if (!info.isSocket()) return undefined;
    if (process.getuid !== undefined && info.uid !== process.getuid()) return undefined;
    return resolved;
  } catch {
    return undefined;
  }
}

function processFamily(roots: number[]): number[] {
  const parents = readProcessParents();
  const family = new Set<number>();
  const addAncestors = (pid: number) => {
    let current = pid;
    for (let depth = 0; depth < MAX_ANCESTOR_DEPTH; depth += 1) {
      family.add(current);
      const parent = parents.get(current);
      if (!parent || parent <= 1) break;
      current = parent;
    }
  };
  for (const root of roots) addAncestors(root);

  let frontier = [...roots];
  for (let depth = 0; depth < MAX_PROCESS_FAMILY_DEPTH && frontier.length > 0; depth += 1) {
    const children = new Set<number>();
    for (const [pid, parent] of parents) {
      if (!frontier.includes(parent)) continue;
      children.add(pid);
      family.add(pid);
    }
    frontier = [...children];
  }
  return [...family].filter(processOwnedByCurrentUser);
}

function readProcessParents(): Map<number, number> {
  const result = new Map<number, number>();
  let entries: string[];
  try {
    entries = readdirSync('/proc');
  } catch {
    return result;
  }
  for (const name of entries) {
    if (!/^\d+$/u.test(name)) continue;
    const pid = Number(name);
    if (!processOwnedByCurrentUser(pid)) continue;
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const commandEnd = stat.lastIndexOf(')');
      if (commandEnd < 0) continue;
      const parent = Number(stat.slice(commandEnd + 2).split(/\s+/u)[1]);
      if (Number.isSafeInteger(parent)) result.set(pid, parent);
    } catch {
      // Process exited while /proc was being inspected.
    }
  }
  return result;
}

function processOwnedByCurrentUser(pid: number): boolean {
  try {
    return process.getuid === undefined || statSync(`/proc/${pid}`).uid === process.getuid();
  } catch {
    return false;
  }
}

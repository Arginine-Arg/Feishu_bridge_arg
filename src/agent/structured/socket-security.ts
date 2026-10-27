import { lstat, realpath, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/**
 * Directories already verified as owner-only; sockets do not move between runs.
 */
const trustedSocketParents = new Set<string>();
const MAX_SOCKET_PARENT_LEVELS = 20;

/**
 * Resolve an App Server endpoint to a socket path that is safe to connect to.
 *
 * The socket itself must be a Unix socket owned by the current user. Codex's
 * own app-server daemon exposes its control socket as a symlink to the real
 * socket under `codex-daemon-<uid>/`, so following that link is legitimate -
 * but only when the link target and every parent directory is owner-private
 * (no group/other write), which removes the symlink-swap risk.
 */
export async function resolveAppServerSocketPath(candidate: string): Promise<string> {
  if (!candidate.startsWith('/') || candidate.includes('\0')) {
    throw new Error('App Server endpoint 不安全');
  }
  const requested = resolve(candidate);
  const resolvedPath = await realpath(requested);
  await assertOwnedParents(resolvedPath);
  // macOS exposes system paths through symlinks such as `/var -> /private/var`.
  // Validate the canonical directory chain rather than rejecting that system
  // symlink, while still rejecting a group/world-writable real parent.
  if (requested !== resolvedPath) {
    const requestedParent = await realpath(join(requested, '..'));
    await assertOwnedParents(requestedParent);
  }
  const info = await stat(resolvedPath);
  if (!info.isSocket()) throw new Error('App Server socket 不安全');
  if (process.getuid && info.uid !== process.getuid()) {
    throw new Error('App Server socket 不安全');
  }
  return resolvedPath;
}

/**
 * Canonicalize Unix App Server endpoints before ownership checks. Bindings,
 * writer-lock discovery and tmux metadata can describe the same socket through
 * different symlinked paths; those are one endpoint, not competing writers.
 */
export async function canonicalAppServerEndpoints(
  candidates: Iterable<string>,
): Promise<string[]> {
  const endpoints: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate.startsWith('unix:///')) continue;
    try {
      const socketPath = await resolveAppServerSocketPath(candidate.slice('unix://'.length));
      const endpoint = `unix://${socketPath}`;
      if (seen.has(endpoint)) continue;
      seen.add(endpoint);
      endpoints.push(endpoint);
    } catch {
      // A stale tmux/binding advertisement grants no ownership.
    }
  }
  return endpoints;
}

async function assertOwnedParents(target: string): Promise<void> {
  let current = join(target, '..');
  for (let level = 0; level < MAX_SOCKET_PARENT_LEVELS; level += 1) {
    const directory = resolve(current);
    if (directory === '/') return;
    if (trustedSocketParents.has(directory)) return;
    const info = await lstat(directory);
    if (!isSafeSocketParent(info)) throw new Error('App Server socket 不安全');
    trustedSocketParents.add(directory);
    current = join(directory, '..');
  }
  throw new Error('App Server socket 不安全');
}

/**
 * A parent directory is safe when other users cannot replace entries inside it:
 * either the current user owns it without group/other write access, or it is a
 * sticky directory such as `/tmp` where only the owner may unlink.
 */
function isSafeSocketParent(info: {
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  uid: number;
  mode: number;
}): boolean {
  if (!info.isDirectory() || info.isSymbolicLink()) return false;
  if (process.getuid === undefined) return true;
  if ((info.mode & 0o022) === 0) return true;
  return (info.mode & 0o1000) !== 0;
}

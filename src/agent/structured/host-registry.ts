import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileAtomic } from '../../platform/atomic-write';

/**
 * Lifecycle bookkeeping for bridge-spawned Codex App Servers.
 *
 * An App Server is a detached, long-lived process: it keeps the provider,
 * credentials, proxy and model catalog resolved when it started. That is the
 * design intent (a paused native TUI can reconnect to it), but it also means a
 * `cc-switch` provider change is invisible until the process is replaced, and
 * that a bridge restart can leave a server holding an old environment. Each
 * profile therefore records, per runtime directory, an environment
 * fingerprint plus the owners that asked for the server, so the next
 * connection can tell whether the running server is still the one the current
 * configuration wants.
 */

export interface CodexHostEnvironmentFingerprint {
  /** Credential variables injected into the server, sorted for comparison. */
  credentials: Record<string, string>;
  /** Effective network mode, including the third-party auto policy. */
  networkMode: string;
  /** File stamps for config.toml / auth.json; content-free and cheap. */
  configStamp?: string;
  authStamp?: string;
}

export interface CodexHostRegistration {
  directory: string;
  pid: number;
  startedAt: number;
  binary: string;
  fingerprint: CodexHostEnvironmentFingerprint;
}

interface CodexHostRegistryFile {
  version: 1;
  hosts: CodexHostRegistration[];
}

export function registryFile(profileDir: string): string {
  return join(profileDir, 'structured', 'app-server-registry.json');
}

/**
 * Owner-private runtime directory for one profile/scope/cwd combination. The
 * socket path stays stable across restarts so a paused native TUI reconnects.
 */
export function codexHostRuntimeDirectory(
  profileDir: string,
  scope: string,
  cwd: string,
  uid: number | undefined = process.getuid?.(),
): string {
  const hash = createHash('sha256')
    .update(profileDir)
    .update('\0')
    .update(scope)
    .update('\0')
    .update(cwd)
    .digest('hex')
    .slice(0, 20);
  return join(tmpdir(), `argbridge-rpc-${uid ?? 'user'}-${hash}`);
}

export function ownerDirectory(profileDir: string): string {
  return join(profileDir, 'structured', 'app-server-owners');
}

export function fingerprintCredentialEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const entries: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    // Only a digest is persisted: the registry compares environments across
    // runs, and must never become a copy of the API key.
    entries.push([key, `sha256:${createHash('sha256').update(value).digest('hex').slice(0, 32)}`]);
  }
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return Object.fromEntries(entries);
}

/** File stamp that changes when the file is rewritten, without hashing it. */
export function fileStamp(path: string): string | undefined {
  try {
    const stat = statSync(path);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return undefined;
  }
}

export function sameFingerprint(
  a: CodexHostEnvironmentFingerprint | undefined,
  b: CodexHostEnvironmentFingerprint,
): boolean {
  if (!a) return false;
  return (
    a.networkMode === b.networkMode &&
    a.configStamp === b.configStamp &&
    a.authStamp === b.authStamp &&
    sameCredentials(a.credentials, b.credentials)
  );
}

export function sameCredentials(
  a: Record<string, string>,
  b: Record<string, string>,
): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

export function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export async function readHostRegistry(profileDir: string): Promise<CodexHostRegistration[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(registryFile(profileDir), 'utf8'));
    if (!parsed || typeof parsed !== 'object') return [];
    const file = parsed as Partial<CodexHostRegistryFile>;
    if (file.version !== 1 || !Array.isArray(file.hosts)) return [];
    return file.hosts.filter(isRegistration);
  } catch {
    return [];
  }
}

export async function writeHostRegistry(
  profileDir: string,
  hosts: CodexHostRegistration[],
): Promise<void> {
  const file: CodexHostRegistryFile = { version: 1, hosts };
  await mkdir(join(profileDir, 'structured'), { recursive: true, mode: 0o700 });
  await writeFileAtomic(registryFile(profileDir), `${JSON.stringify(file, null, 2)}\n`, {
    mode: 0o600,
  });
}

/** Record (or refresh) the App Server this directory currently runs. */
export async function recordHost(
  profileDir: string,
  registration: CodexHostRegistration,
): Promise<void> {
  const hosts = (await readHostRegistry(profileDir)).filter(
    (host) => host.directory !== registration.directory,
  );
  hosts.push(registration);
  await writeHostRegistry(profileDir, hosts);
}

export async function forgetHost(profileDir: string, directory: string): Promise<void> {
  const hosts = (await readHostRegistry(profileDir)).filter((host) => host.directory !== directory);
  await writeHostRegistry(profileDir, hosts);
}

/**
 * Owners are recorded as `pid` marker files. A live owner keeps a server
 * reusable (a paused native TUI); once the last owner is gone the next
 * connection replaces the server instead of inheriting a stale environment.
 */
export async function recordOwner(profileDir: string, pid = process.pid): Promise<void> {
  try {
    await mkdir(ownerDirectory(profileDir), { recursive: true, mode: 0o700 });
    await writeFile(join(ownerDirectory(profileDir), String(pid)), `${Date.now()}\n`, {
      mode: 0o600,
    });
  } catch {
    // Bookkeeping must never break a working agent.
  }
}

export async function liveOwners(
  profileDir: string,
  excludePid?: number,
): Promise<number[]> {
  let names: string[];
  try {
    names = await readdir(ownerDirectory(profileDir));
  } catch {
    return [];
  }
  const owners: number[] = [];
  for (const name of names) {
    if (!/^\d+$/u.test(name)) continue;
    const pid = Number.parseInt(name, 10);
    if (pid === excludePid) continue;
    if (processAlive(pid)) owners.push(pid);
    else await pruneOwner(profileDir, pid);
  }
  return owners;
}

export async function dropOwner(profileDir: string, pid = process.pid): Promise<boolean> {
  const remaining = await liveOwners(profileDir, pid);
  await pruneOwner(profileDir, pid);
  return remaining.length === 0;
}

async function pruneOwner(profileDir: string, pid: number): Promise<void> {
  try {
    await rm(join(ownerDirectory(profileDir), String(pid)), { force: true });
  } catch {
    // Nothing to clean up.
  }
}

export function terminateHost(pid: number, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (!processAlive(pid)) return;
  try {
    process.kill(pid, signal);
  } catch {
    // Already gone between the check and the signal.
  }
}

export async function waitForExit(pid: number, timeoutMs = 2_000): Promise<boolean> {
  if (!processAlive(pid)) return true;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (!processAlive(pid)) return true;
  }
  terminateHost(pid, 'SIGKILL');
  return !processAlive(pid);
}

/**
 * Kill every App Server recorded for this profile. Used by `arg-bridge
 * restart` so a provider switch cannot be served by a process that still holds
 * the previous provider and credentials.
 */
export async function terminateProfileHosts(profileDir: string): Promise<number> {
  const hosts = await readHostRegistry(profileDir);
  let terminated = 0;
  for (const host of hosts) {
    if (!processAlive(host.pid)) continue;
    terminateHost(host.pid);
    await waitForExit(host.pid);
    terminated += 1;
  }
  await writeHostRegistry(profileDir, hosts.filter((host) => processAlive(host.pid)));
  return terminated;
}

function isRegistration(value: unknown): value is CodexHostRegistration {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<CodexHostRegistration>;
  return (
    typeof record.directory === 'string' &&
    typeof record.pid === 'number' &&
    typeof record.binary === 'string' &&
    !!record.fingerprint &&
    typeof record.fingerprint === 'object'
  );
}

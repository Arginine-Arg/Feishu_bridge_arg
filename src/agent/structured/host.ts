import { mkdir, lstat, chmod, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnProcess } from '../../platform/spawn';
import { RpcClient } from './rpc';
import { log } from '../../core/logger';
import {
  codexHostRuntimeDirectory,
  dropOwner,
  fingerprintCredentialEnv,
  forgetHost,
  liveOwners,
  processAlive,
  readHostRegistry,
  recordHost,
  recordOwner,
  sameFingerprint,
  terminateHost,
  waitForExit,
  writeHostRegistry,
  type CodexHostEnvironmentFingerprint,
} from './host-registry';

const HOST_FAILURE_BASE_MS = 3_000;
const HOST_FAILURE_MAX_MS = 60_000;
const HOST_BREAKER_PAUSE_AT = 5;
const HOST_BREAKER_RESET_MS = 10 * 60_000;

interface HostBreaker {
  failures: number;
  nextAttemptAt: number;
  lastFailureAt: number;
}

const hostBreakers = new Map<string, HostBreaker>();

/** Exponential backoff with jitter: 3s, 6s, 12s, 24s, capped at 60s + 1s. */
export function nextHostRetryDelayMs(failures: number, random: () => number = Math.random): number {
  const exponent = Math.max(0, failures - 1);
  const delay = Math.min(HOST_FAILURE_BASE_MS * 2 ** exponent, HOST_FAILURE_MAX_MS);
  return delay + Math.floor(random() * 1_000);
}

export function hostBreakerState(directory: string): HostBreaker | undefined {
  return hostBreakers.get(directory);
}

export function resetHostBreakers(): void {
  hostBreakers.clear();
}

function recordHostFailure(directory: string): HostBreaker {
  const now = Date.now();
  const previous = hostBreakers.get(directory);
  const failures = previous && now - previous.lastFailureAt < HOST_BREAKER_RESET_MS
    ? previous.failures + 1
    : 1;
  const breaker = {
    failures,
    nextAttemptAt: now + nextHostRetryDelayMs(failures),
    lastFailureAt: now,
  };
  hostBreakers.set(directory, breaker);
  if (failures >= HOST_BREAKER_PAUSE_AT) {
    log.warn('agent', 'app-server-degraded-paused', {
      directory,
      failures,
      retryInMs: Math.max(0, breaker.nextAttemptAt - now),
    });
  }
  return breaker;
}

function clearHostFailure(directory: string): void {
  hostBreakers.delete(directory);
}

export async function connectCodexHost(options: {
  binary: string; profileDir: string; scope: string; cwd: string; env: NodeJS.ProcessEnv;
  /**
   * Environment identity of the App Server. When it changes (provider switch,
   * credential rotation, network policy) a still-running server is replaced
   * instead of silently serving the previous configuration.
   */
  fingerprint?: CodexHostEnvironmentFingerprint;
}): Promise<{ rpc: RpcClient; endpoint: string }> {
  if (process.platform === 'win32') throw new Error('Codex structured shared-terminal backend currently requires Unix sockets; keep terminal transport on Windows');
  const directory = codexHostRuntimeDirectory(options.profileDir, options.scope, options.cwd);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory() || (process.getuid && stat.uid !== process.getuid())) throw new Error('Unsafe structured runtime directory');
  await chmod(directory, 0o700);
  const path = join(directory, 'server.sock');
  const endpoint = `unix://${path}`;
  const url = `ws+unix://${path}:/`;
  let stale: { directory: string; pid: number; reason: string } | undefined;
  if (options.fingerprint) {
    stale = await findStaleHost(
      options.profileDir,
      directory,
      options.binary,
      options.fingerprint,
    );
    if (stale) {
      // Claim the replacement by removing the registration first: concurrent
      // owners then see no record and reuse whichever server lands first
      // instead of racing over the same socket.
      await forgetHost(options.profileDir, stale.directory);
      terminateHost(stale.pid);
      await waitForExit(stale.pid);
      await rm(stale.directory, { recursive: true, force: true }).catch(() => {});
      log.info('agent', 'app-server-replaced', { directory, reason: stale.reason });
    }
  }
  let rpc: RpcClient;
  try { rpc = await RpcClient.connect(url); clearHostFailure(directory); }
  catch {
    const paused = hostBreakers.get(directory);
    const pausedForMs = paused ? paused.nextAttemptAt - Date.now() : 0;
    if (pausedForMs > 0) {
      throw new Error(
        `Codex App Server 连续启动失败 ${paused!.failures} 次；已暂停 ${Math.ceil(pausedForMs / 1000)}s，` +
        '避免继续建立新会话触发供应商风控。请检查 profile 的网络/代理配置，或修复后运行 `arg-bridge restart`。',
      );
    }
    // A replaced App Server leaves its socket file behind, and its old process
    // may still be draining. Clear both before spawning the successor so it
    // cannot bind to a dead socket or race the shutdown.
    if (stale) {
      await rm(path, { force: true }).catch(() => {});
      await mkdir(directory, { recursive: true, mode: 0o700 });
    }
    const logFile = await open(join(directory, 'server.log'), 'a', 0o600);
    const child = spawnProcess(options.binary, ['app-server', '--listen', endpoint], {
      cwd: options.cwd, env: options.env, detached: true,
      stdio: ['ignore', logFile.fd, logFile.fd],
    });
    let failure: Error | undefined;
    child.once('error', error => { failure = error; });
    child.unref(); await logFile.close();
    const deadline = Date.now() + 20000;
    let connected: RpcClient | undefined;
    while (Date.now() < deadline && !failure) {
      try { connected = await RpcClient.connect(url); break; } catch { await new Promise(resolve => setTimeout(resolve, 150)); }
    }
    if (!connected) {
      child.kill('SIGTERM');
      const breaker = recordHostFailure(directory);
      const retryInMs = Math.max(0, breaker.nextAttemptAt - Date.now());
      throw failure ?? new Error(
        `Codex App Server did not become ready (failure ${breaker.failures}); ` +
        `next attempt in ${Math.ceil(retryInMs / 1000)}s; inspect ${join(directory, 'server.log')}`,
      );
    }
    clearHostFailure(directory);
    rpc = connected;
    if (options.fingerprint) {
      await recordHost(options.profileDir, {
        directory,
        pid: child.pid ?? 0,
        startedAt: Date.now(),
        binary: options.binary,
        fingerprint: options.fingerprint,
      });
    }
  }
  await recordOwner(options.profileDir);
  try { await rpc.initialize(); } catch (error) { rpc.close(); throw error; }
  return { rpc, endpoint };
}

/**
 * Drop this process as an owner and, when nobody else is using a directory,
 * stop the detached App Server instead of leaving an orphan that holds the
 * environment it was started with.
 */
export async function shutdownProfileHosts(profileDir: string): Promise<void> {
  // Drop this process first: when a paused native TUI or another bridge still
  // owns the profile, the detached servers stay available for reconnection.
  const lastOwner = await dropOwner(profileDir);
  if (!lastOwner) return;
  for (const host of await readHostRegistry(profileDir)) {
    if (processAlive(host.pid)) {
      terminateHost(host.pid);
      await waitForExit(host.pid);
    }
    await rm(host.directory, { recursive: true, force: true }).catch(() => {});
  }
  await writeHostRegistry(profileDir, []);
}

/**
 * Compare the recorded environment with the one the current configuration
 * resolves to. A server is replaced when the fingerprint changed or when every
 * process that asked for it is gone.
 */
export async function findStaleHost(
  profileDir: string,
  directory: string,
  binary: string,
  fingerprint: CodexHostEnvironmentFingerprint,
): Promise<{ directory: string; pid: number; reason: string } | undefined> {
  const host = (await readHostRegistry(profileDir)).find((item) => item.directory === directory);
  if (!host) return undefined;
  const result = { directory: host.directory, pid: host.pid };
  if (host.pid <= 0 || !processAlive(host.pid)) return { ...result, reason: 'process-gone' };
  if (!sameFingerprint(host.fingerprint, fingerprint)) {
    return { ...result, reason: 'environment-changed' };
  }
  const owners = await liveOwners(profileDir);
  if (owners.length === 0) return { ...result, reason: 'owner-dead' };
  if (host.binary !== binary) return { ...result, reason: 'binary-changed' };
  return undefined;
}

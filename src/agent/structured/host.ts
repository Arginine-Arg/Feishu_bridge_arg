import { createHash } from 'node:crypto';
import { mkdir, lstat, chmod, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnProcess } from '../../platform/spawn';
import { RpcClient } from './rpc';
import { log } from '../../core/logger';

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
}): Promise<{ rpc: RpcClient; endpoint: string }> {
  if (process.platform === 'win32') throw new Error('Codex structured shared-terminal backend currently requires Unix sockets; keep terminal transport on Windows');
  const hash = createHash('sha256').update(options.profileDir).update('\0').update(options.scope).update('\0').update(options.cwd).digest('hex').slice(0, 20);
  const directory = join(tmpdir(), `argbridge-rpc-${process.getuid?.() ?? 'user'}-${hash}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory() || (process.getuid && stat.uid !== process.getuid())) throw new Error('Unsafe structured runtime directory');
  await chmod(directory, 0o700);
  const path = join(directory, 'server.sock');
  const endpoint = `unix://${path}`;
  const url = `ws+unix://${path}:/`;
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
  }
  try { await rpc.initialize(); } catch (error) { rpc.close(); throw error; }
  return { rpc, endpoint };
}

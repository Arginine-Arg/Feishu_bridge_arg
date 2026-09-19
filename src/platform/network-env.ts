import { connect } from 'node:net';
import type { NetworkConfig } from '../config/profile-schema';
import { log } from '../core/logger';

export const PROXY_ENV_KEYS = [
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  'SOCKS_PROXY', 'SOCKS5_PROXY', 'socks_proxy', 'socks5_proxy',
] as const;

export const DEFAULT_NO_PROXY = 'localhost,127.0.0.1,::1';

export type ProxyProbeResult = 'open' | 'refused' | 'unreachable';
export type ProxyProbe = (host: string, port: number, timeoutMs: number) => Promise<ProxyProbeResult>;

export class NetworkProxyUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkProxyUnavailableError';
  }
}

export interface NetworkEnvDiagnostic {
  type: 'stripped' | 'unavailable';
  mode: string;
  proxy?: string;
  reason?: string;
  /** Proxy keys removed from the child environment. */
  keys?: string[];
}

export interface SanitizeNetworkEnvOptions {
  probe?: ProxyProbe;
  /** Per-probe timeout. Kept short because this runs on the spawn path. */
  timeoutMs?: number;
  onDiagnostic?: (diagnostic: NetworkEnvDiagnostic) => void;
}

/**
 * Build the environment for an agent child process.
 *
 * - `direct`: remove every inherited proxy variable.
 * - `proxy`: remove inherited proxies, apply one explicit proxy, and verify it
 *   is reachable before the agent is started. A dead proxy fails closed so a
 *   crash loop cannot hammer the model provider with new sessions.
 * - `inherit`: keep the host environment, but drop a loopback proxy that is
 *   provably dead (connection refused/unreachable). This is the common stale
 *   `clash`/systemd case that otherwise poisons every child process after the
 *   local proxy exits.
 */
export async function sanitizeAgentEnv(
  base: NodeJS.ProcessEnv,
  config: NetworkConfig | undefined,
  options: SanitizeNetworkEnvOptions = {},
): Promise<NodeJS.ProcessEnv> {
  const mode = config?.mode ?? 'inherit';
  const diagnostic = options.onDiagnostic ?? ((item: NetworkEnvDiagnostic) => {
    if (item.type === 'stripped') {
      log.warn('network', 'proxy-stripped', {
        mode: item.mode,
        proxy: item.proxy ?? null,
        reason: item.reason ?? null,
      });
    } else {
      log.warn('network', 'proxy-unavailable', {
        mode: item.mode,
        proxy: item.proxy ?? null,
        reason: item.reason ?? null,
      });
    }
  });

  if (mode === 'direct') {
    const keys = PROXY_ENV_KEYS.filter((key) => base[key] !== undefined);
    if (keys.length > 0) diagnostic({ type: 'stripped', mode, reason: 'direct', keys });
    return stripProxyEnv(base);
  }

  if (mode === 'proxy') {
    const proxyUrl = config?.proxyUrl;
    if (!proxyUrl) {
      throw new NetworkProxyUnavailableError('network.mode="proxy" requires network.proxyUrl');
    }
    const target = parseProxyUrl(proxyUrl);
    if (target) {
      const result = await (options.probe ?? probeProxy)(target.host, target.port, options.timeoutMs ?? 800);
      if (result !== 'open') {
        diagnostic({ type: 'unavailable', mode, proxy: proxyUrl, reason: result });
        throw new NetworkProxyUnavailableError(
          `network proxy ${target.host}:${target.port} is not reachable (${result}); ` +
          'agent start is paused to avoid a retry storm. Fix network.proxyUrl or set network.mode="direct".',
        );
      }
    }
    const env = stripProxyEnv(base);
    applyProxyEnv(env, proxyUrl, config?.noProxy ?? DEFAULT_NO_PROXY);
    return env;
  }

  const env: NodeJS.ProcessEnv = { ...base };
  const proxy = firstProxyUrl(base);
  if (!proxy) return env;
  const target = parseProxyUrl(proxy);
  if (!target || !isLoopbackHost(target.host)) return env;
  const result = await (options.probe ?? probeProxy)(target.host, target.port, options.timeoutMs ?? 400);
  if (result === 'open') return env;
  const keys = PROXY_ENV_KEYS.filter((key) => base[key] !== undefined);
  diagnostic({ type: 'stripped', mode, proxy, reason: result, keys });
  return stripProxyEnv(base);
}

export function stripProxyEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of PROXY_ENV_KEYS) delete env[key];
  return env;
}

/**
 * Build `tmux -e KEY=VALUE` arguments that pin every proxy variable for a
 * newly created pane. Missing values are pinned as empty strings so a stale
 * value in the tmux server environment cannot leak back in.
 */
export function proxyEnvironmentArgs(
  env: NodeJS.ProcessEnv,
  options: { mode?: string; strippedKeys?: readonly string[] } = {},
): string[] {
  const mode = options.mode ?? 'inherit';
  const stripped = new Set(options.strippedKeys ?? []);
  return PROXY_ENV_KEYS.flatMap((key) => {
    const value = env[key];
    if (value !== undefined) return ['-e', `${key}=${value}`];
    // Explicit modes own the pane environment. In `inherit` mode, only clear
    // keys that sanitization actually removed; a key the bridge never owned
    // may legitimately come from the tmux server environment.
    if (mode === 'direct' || mode === 'proxy' || stripped.has(key)) return ['-e', `${key}=`];
    return [];
  });
}

export function applyProxyEnv(
  env: NodeJS.ProcessEnv,
  proxyUrl: string,
  noProxy: string = DEFAULT_NO_PROXY,
): NodeJS.ProcessEnv {
  env.HTTP_PROXY = proxyUrl;
  env.HTTPS_PROXY = proxyUrl;
  env.ALL_PROXY = proxyUrl;
  env.NO_PROXY = noProxy;
  env.http_proxy = proxyUrl;
  env.https_proxy = proxyUrl;
  env.all_proxy = proxyUrl;
  env.no_proxy = noProxy;
  return env;
}

export function hasProxyEnv(env: NodeJS.ProcessEnv): boolean {
  return PROXY_ENV_KEYS.some((key) => typeof env[key] === 'string' && env[key]!.trim() !== '');
}

export function firstProxyUrl(env: NodeJS.ProcessEnv): string | undefined {
  for (const key of ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'HTTP_PROXY', 'http_proxy'] as const) {
    const value = env[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

export function parseProxyUrl(value: string): { host: string; port: number } | undefined {
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^\[|\]$/gu, '');
    const port = url.port
      ? Number.parseInt(url.port, 10)
      : url.protocol === 'https:'
        ? 443
        : url.protocol === 'http:'
          ? 80
          : 1080;
    if (!host || !Number.isSafeInteger(port) || port <= 0 || port > 65_535) return undefined;
    return { host, port };
  } catch {
    return undefined;
  }
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase();
  return (
    normalized === 'localhost' ||
    normalized === '::1' ||
    normalized === '0:0:0:0:0:0:0:1' ||
    /^127(?:\.\d{1,3}){3}$/u.test(normalized)
  );
}

export function probeProxy(host: string, port: number, timeoutMs: number): Promise<ProxyProbeResult> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    let settled = false;
    const finish = (result: ProxyProbeResult): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish('open'));
    socket.once('timeout', () => finish('unreachable'));
    socket.once('error', (error: NodeJS.ErrnoException) => {
      finish(error.code === 'ECONNREFUSED' ? 'refused' : 'unreachable');
    });
  });
}

import { chmod, mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { writeFileAtomic } from '../platform/atomic-write';

export interface BrokerRouteMap {
  version: 1;
  defaultReadRoute?: string;
  providers: Record<string, { readRoute?: string }>;
}

export interface BrokerRouteMapState {
  path: string;
  config?: BrokerRouteMap;
  error?: string;
}

export function brokerRoutesPath(env: NodeJS.ProcessEnv = process.env): string {
  const configHome = env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config');
  return join(configHome, 'arg-bridge', 'broker-routes.json');
}

/**
 * Route mapping is arg-bridge-owned metadata: it never contains provider keys,
 * base URLs, or any other credential material.
 */
export async function loadBrokerRouteMap(
  env: NodeJS.ProcessEnv = process.env,
): Promise<BrokerRouteMapState> {
  const path = brokerRoutesPath(env);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path };
    return { path, error: `无法读取 ${path}: ${errorMessage(error)}` };
  }
  try {
    return { path, config: parseBrokerRouteMap(JSON.parse(raw)) };
  } catch (error) {
    return { path, error: `broker-routes.json 无效：${errorMessage(error)}` };
  }
}

export function parseBrokerRouteMap(input: unknown): BrokerRouteMap {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('root must be an object');
  }
  const raw = input as Record<string, unknown>;
  if (raw.version !== 1) throw new Error('version must be 1');
  for (const key of Object.keys(raw)) {
    if (key !== 'version' && key !== 'defaultReadRoute' && key !== 'providers') {
      throw new Error(`unsupported field: ${key}`);
    }
  }
  const defaultReadRoute = routeId(raw.defaultReadRoute, 'defaultReadRoute');
  if (raw.providers !== undefined && (typeof raw.providers !== 'object' || raw.providers === null || Array.isArray(raw.providers))) {
    throw new Error('providers must be an object');
  }
  const providers: BrokerRouteMap['providers'] = {};
  for (const [provider, value] of Object.entries((raw.providers ?? {}) as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9._-]+$/u.test(provider)) throw new Error(`invalid provider id: ${provider}`);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`providers.${provider} must be an object`);
    }
    const entry = value as Record<string, unknown>;
    for (const key of Object.keys(entry)) {
      if (key !== 'readRoute') throw new Error(`providers.${provider}.${key} is not allowed`);
    }
    providers[provider] = { readRoute: routeId(entry.readRoute, `providers.${provider}.readRoute`) };
  }
  return {
    version: 1,
    ...(defaultReadRoute ? { defaultReadRoute } : {}),
    providers,
  };
}

export async function saveBrokerRouteMap(
  config: BrokerRouteMap,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const path = brokerRoutesPath(env);
  const checked = parseBrokerRouteMap(config);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFileAtomic(path, `${JSON.stringify(checked, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600).catch(() => {});
  return path;
}

export function resolveRouteForProvider(
  map: BrokerRouteMap | undefined,
  providerCode: string | undefined,
): { routeId?: string; source?: 'cc-switch' | 'default' } {
  if (!map) return {};
  if (providerCode && map.providers[providerCode]?.readRoute) {
    return { routeId: map.providers[providerCode]!.readRoute, source: 'cc-switch' };
  }
  if (map.defaultReadRoute) return { routeId: map.defaultReadRoute, source: 'default' };
  return {};
}

function routeId(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(value.trim())) {
    throw new Error(`${label} must be a valid route id`);
  }
  return value.trim();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

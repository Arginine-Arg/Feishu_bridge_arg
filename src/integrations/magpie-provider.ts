import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { processAlive } from '../agent/structured/host-registry';
import { validSubagentModel } from '../config/profile-schema';
import {
  CcSwitchProviderError,
  type CcSwitchProviderSummary,
  type ResolvedCcSwitchProvider,
} from './cc-switch-provider';

/**
 * Magpie keeps provider credentials and exposes every configured model behind
 * one local Responses-compatible gateway. Bridge only needs the gateway
 * address and the provider/model ids; keys never leave Magpie.
 */
export const MAGPIE_ENV_KEY = 'MAGPIE_API_KEY';
const MAGPIE_PLACEHOLDER_KEY = 'magpie';
const MAX_CATALOG_BYTES = 2 * 1024 * 1024;

export interface MagpieGateway {
  addr: string;
  baseUrl: string;
  pid: number;
}

export interface MagpieProvider {
  id: string;
  name: string;
  models: string[];
  current: boolean;
  /** Synthetic provider holding Magpie routing groups. */
  router?: boolean;
}

export interface MagpieCatalog {
  gateway: MagpieGateway;
  providers: MagpieProvider[];
  error?: string;
}

export function magpieConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(
    env.MAGPIE_CONFIG_DIR?.trim() ||
      join(env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config'), 'magpie'),
  );
}

function gatewayBaseUrl(addr: string): string {
  const trimmed = addr.trim().replace(/\/+$/u, '');
  const withScheme = /^https?:\/\//u.test(trimmed) ? trimmed : `http://${trimmed}`;
  return `${withScheme}/v1`;
}

export async function readMagpieGateway(
  env: NodeJS.ProcessEnv = process.env,
): Promise<MagpieGateway> {
  const path = join(magpieConfigDir(env), 'gateway.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new CcSwitchProviderError(
      'magpie-unavailable',
      `Magpie 网关未运行或没有写入 ${path}；请先启动 magpie。`,
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }
  const record = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  const addr = typeof record.addr === 'string' ? record.addr.trim() : '';
  const pid = typeof record.pid === 'number' ? record.pid : Number(record.pid);
  if (!addr || !Number.isSafeInteger(pid) || pid <= 0) {
    throw new CcSwitchProviderError('magpie-unavailable', 'Magpie gateway.json 缺少 addr 或 pid');
  }
  if (!processAlive(pid)) {
    throw new CcSwitchProviderError(
      'magpie-unavailable',
      `Magpie 网关进程 ${pid} 已退出；请重新启动 magpie。`,
    );
  }
  return { addr, baseUrl: gatewayBaseUrl(addr), pid };
}

async function fetchJson(
  url: string,
  options: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<unknown> {
  const response = await (options.fetch ?? fetch)(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
    redirect: 'error',
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`HTTP ${response.status}`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('空响应');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_CATALOG_BYTES) throw new Error('模型目录超过 2 MiB');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function modelIds(payload: unknown): Array<{ id: string; contextWindow: number | null }> {
  const data = payload && typeof payload === 'object'
    ? (payload as Record<string, unknown>).data ?? (payload as Record<string, unknown>).models
    : undefined;
  if (!Array.isArray(data)) return [];
  const result: Array<{ id: string; contextWindow: number | null }> = [];
  for (const item of data) {
    const id = typeof item === 'string'
      ? item
      : item && typeof item === 'object'
        ? (item as Record<string, unknown>).id
        : undefined;
    if (!validSubagentModel(id)) continue;
    const context = item && typeof item === 'object'
      ? (item as Record<string, unknown>).context_window ??
        (item as Record<string, unknown>).context_length
      : undefined;
    result.push({
      id,
      contextWindow: typeof context === 'number' && context > 0 ? context : null,
    });
  }
  return result;
}

async function currentCodexModel(env: NodeJS.ProcessEnv): Promise<string | null> {
  const home = env.CODEX_HOME?.trim() || join(homedir(), '.codex');
  try {
    const text = await readFile(join(home, 'config.toml'), 'utf8');
    const match = /^model\s*=\s*"([^"]+)"/mu.exec(text);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

export async function readMagpieProviderCatalog(
  env: NodeJS.ProcessEnv = process.env,
  options: { fetch?: typeof fetch } = {},
): Promise<MagpieCatalog> {
  const gateway = await readMagpieGateway(env);
  const path = join(magpieConfigDir(env), 'providers.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new CcSwitchProviderError(
      'magpie-unavailable',
      `Magpie 还没有 provider 配置（${path}）。请先在 magpie 添加 API 账号。`,
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }
  const rows = parsed && typeof parsed === 'object' && Array.isArray((parsed as any).providers)
    ? (parsed as any).providers as unknown[]
    : [];
  const groupRows = parsed && typeof parsed === 'object' && Array.isArray((parsed as any).groups)
    ? (parsed as any).groups as unknown[]
    : [];
  const declared = new Map<string, { name: string; models: string[] }>();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const record = row as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    if (!id) continue;
    const models = Array.isArray(record.models)
      ? record.models.filter(validSubagentModel)
      : [];
    declared.set(id, {
      name: typeof record.name === 'string' && record.name.trim() ? record.name.trim() : id,
      models,
    });
  }
  if (declared.size === 0) {
    throw new CcSwitchProviderError('magpie-unavailable', 'Magpie 没有可用的 provider');
  }
  let exposed: Array<{ id: string; contextWindow: number | null }> = [];
  let error: string | undefined;
  try {
    exposed = modelIds(await fetchJson(`${gateway.baseUrl}/models`, options));
  } catch (caught) {
    error = `Magpie 模型目录不可读：${caught instanceof Error ? caught.message : String(caught)}`;
  }
  const byProvider = new Map<string, string[]>();
  for (const model of exposed) {
    const slash = model.id.indexOf('/');
    if (slash <= 0) continue;
    const providerId = model.id.slice(0, slash);
    if (!declared.has(providerId)) continue;
    const list = byProvider.get(providerId) ?? [];
    list.push(model.id);
    byProvider.set(providerId, list);
  }
  const currentModel = await currentCodexModel(env);
  const currentProvider = currentModel?.includes('/')
    ? currentModel.slice(0, currentModel.indexOf('/'))
    : null;
  const providers: MagpieProvider[] = [...declared].map(([id, value]) => ({
    id,
    name: value.name,
    models: [...new Set(byProvider.get(id) ?? value.models)],
    current: id === currentProvider,
  }));
  const routers = groupRows
    .map(row => {
      if (!row || typeof row !== 'object') return undefined;
      const record = row as Record<string, unknown>;
      const id = typeof record.id === 'string' ? record.id.trim() : '';
      if (!id) return undefined;
      return {
        id: `group/${id}`,
        name: typeof record.name === 'string' && record.name.trim() ? record.name.trim() : id,
        members: Array.isArray(record.members) ? record.members.filter(validSubagentModel) : [],
      };
    })
    .filter((item): item is { id: string; name: string; members: string[] } => Boolean(item));
  if (routers.length > 0) {
    providers.push({
      id: 'group',
      name: 'Magpie 路由组（自动切换）',
      models: routers.map(router => router.id),
      current: currentProvider === 'group',
      router: true,
    });
  }
  return { gateway, providers, ...(error ? { error } : {}) };
}

export async function discoverMagpieModels(
  providerId: string,
  env: NodeJS.ProcessEnv = process.env,
  options: { fetch?: typeof fetch } = {},
): Promise<string[]> {
  const catalog = await readMagpieProviderCatalog(env, options);
  const provider = catalog.providers.find(item => item.id === providerId);
  if (!provider) {
    throw new CcSwitchProviderError('provider-not-found', `Magpie provider 不存在：${providerId}`);
  }
  if (provider.models.length === 0) {
    throw new CcSwitchProviderError(
      'model-missing',
      `Magpie provider ${providerId} 没有已开放的模型；请先在 magpie 勾选模型。`,
    );
  }
  return provider.models;
}

export async function resolveMagpieProvider(input: {
  env?: NodeJS.ProcessEnv;
  providerId?: string;
  model?: string;
  fetch?: typeof fetch;
} = {}): Promise<ResolvedCcSwitchProvider> {
  const env = input.env ?? process.env;
  const catalog = await readMagpieProviderCatalog(env, { ...(input.fetch ? { fetch: input.fetch } : {}) });
  const selected = input.providerId?.trim()
    ? catalog.providers.find(provider => provider.id === input.providerId)
    : catalog.providers.find(provider => provider.current) ?? catalog.providers[0];
  if (!selected) {
    throw new CcSwitchProviderError(
      'provider-not-found',
      `Magpie provider 不存在：${input.providerId ?? '(current)'}`,
    );
  }
  if (selected.models.length === 0) {
    throw new CcSwitchProviderError(
      'model-missing',
      `Magpie provider ${selected.id} 没有已开放的模型；请先在 magpie 勾选模型。`,
    );
  }
  const currentModel = await currentCodexModel(env);
  const model = input.model?.trim() ||
    (currentModel?.startsWith(`${selected.id}/`) ? currentModel : undefined) ||
    selected.models[0]!;
  if (!validSubagentModel(model)) {
    throw new CcSwitchProviderError('model-missing', `Magpie 模型 ID 无效：${model}`);
  }
  const configFingerprint = createHash('sha256').update(JSON.stringify({
    gateway: catalog.gateway.baseUrl,
    provider: selected.id,
    models: selected.models,
  })).digest('hex');
  const summary: CcSwitchProviderSummary = {
    id: selected.id,
    name: selected.name,
    source: 'magpie',
    codexProviderId: 'magpie',
    model,
    configuredModels: selected.models,
    baseUrl: catalog.gateway.baseUrl,
    baseUrlHost: new URL(catalog.gateway.baseUrl).hostname,
    wireApi: 'responses',
    envKey: MAGPIE_ENV_KEY,
    envHttpHeaders: {},
    reasoningEffort: null,
    contextWindow: null,
    thirdParty: true,
    requiresOpenAiAuth: false,
    supportsStandaloneWebSearch: null,
    credential: {
      status: 'present',
      sourcePath: join(magpieConfigDir(env), 'providers.json'),
      fingerprint: createHash('sha256').update(selected.id).digest('hex').slice(0, 16),
    },
    configFingerprint,
    parentProviderId: null,
    providerSwitchPending: false,
    configMismatches: [],
  };
  const config: ResolvedCcSwitchProvider['config'] = {
    model,
    modelProvider: 'magpie',
    providers: new Map(),
  };
  return {
    summary,
    config,
    providerConfig: {},
    credentials: { [MAGPIE_ENV_KEY]: MAGPIE_PLACEHOLDER_KEY },
  };
}

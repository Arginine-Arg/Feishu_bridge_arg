import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { chmod, mkdir, readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join, parse, resolve } from 'node:path';
import {
  parseCodexConfigSummary,
  isOfficialBaseUrl,
  isThirdPartyProvider,
  type CodexConfigSummary,
  type CodexProviderEntry,
} from '../agent/codex/credentials';
import type { SubagentRoute } from '../agent/subagents/types';
import type {
  SubagentReasoningEffort,
  SubagentWebSearchMode,
} from '../config/profile-schema';
import { spawnProcess } from '../platform/spawn';
import { writeFileAtomic } from '../platform/atomic-write';

const DEFAULT_CODEX_ENV_KEY = 'OPENAI_API_KEY';
const MAX_DB_ROW_BYTES = 8 * 1024 * 1024;
const require = createRequire(import.meta.url);

export type CcSwitchProviderSource = 'sqlite' | 'legacy-json';

export interface CcSwitchProviderMetadata {
  id: string;
  appType: string;
  name: string;
  current: boolean;
  providerType?: string;
  category?: string;
  source: CcSwitchProviderSource;
}

export interface CcSwitchProviderCatalog {
  provider: 'codex';
  currentProviderId?: string;
  providers: CcSwitchProviderMetadata[];
  settingsPath: string;
  databasePath: string;
  source: CcSwitchProviderSource;
  error?: string;
}

export interface CcSwitchProviderRecord extends CcSwitchProviderMetadata {
  settingsConfig: Record<string, unknown>;
  endpointUrls: string[];
}

export interface CcSwitchProviderSummary {
  id: string;
  name: string;
  source: CcSwitchProviderSource;
  codexProviderId: string;
  model: string;
  baseUrl: string;
  baseUrlHost: string | null;
  wireApi: string;
  envKey: string | null;
  envHttpHeaders: Record<string, string>;
  reasoningEffort: string | null;
  contextWindow: number | null;
  thirdParty: boolean;
  requiresOpenAiAuth: boolean | null;
  supportsStandaloneWebSearch: boolean | null;
  credential: {
    status: 'present' | 'missing' | 'oauth-only';
    sourcePath: string | null;
    fingerprint: string | null;
  };
  configFingerprint: string;
  parentProviderId: string | null;
  providerSwitchPending: boolean;
  configMismatches: string[];
}

export interface ResolvedCcSwitchProvider {
  summary: CcSwitchProviderSummary;
  config: CodexConfigSummary;
  providerConfig: CodexProviderEntry;
  credentials: Record<string, string>;
}

export interface CcSwitchBrokerRuntime {
  summary: CcSwitchProviderSummary;
  route: SubagentRoute;
  credentials: Record<string, string>;
  brokerConfigPath: string;
  fingerprint: string;
  webSearch: {
    mode: SubagentWebSearchMode;
    providerSupported: boolean | null;
    effective: 'enabled' | 'disabled';
    reason: string;
  };
}

export interface CcSwitchRuntimePolicy {
  role: 'side' | 'worker' | 'reviewer';
  webSearch: SubagentWebSearchMode;
  sideReasoningEffort?: SubagentReasoningEffort;
}

export class CcSwitchProviderError extends Error {
  constructor(
    readonly code:
      | 'settings-unreadable'
      | 'database-unreadable'
      | 'provider-not-found'
      | 'provider-ambiguous'
      | 'provider-current-mismatch'
      | 'config-invalid'
      | 'model-missing'
      | 'base-url-missing'
      | 'wire-api-unsupported'
      | 'credential-missing'
      | 'oauth-broker-unsupported'
      | 'endpoint-invalid'
      | 'workspace-invalid',
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'CcSwitchProviderError';
  }
}

export function ccSwitchPaths(env: NodeJS.ProcessEnv = process.env): {
  root: string;
  settingsPath: string;
  databasePath: string;
} {
  const root = resolve(env.CC_SWITCH_HOME?.trim() || join(homedir(), '.cc-switch'));
  return {
    root,
    settingsPath: join(root, 'settings.json'),
    databasePath: join(root, 'cc-switch.db'),
  };
}

export async function readCcSwitchProviderCatalog(
  env: NodeJS.ProcessEnv = process.env,
): Promise<CcSwitchProviderCatalog> {
  const paths = ccSwitchPaths(env);
  const settings = await readSettingsJson(paths.settingsPath);
  const currentProviderId = typeof settings?.currentProviderCodex === 'string'
    ? settings.currentProviderCodex.trim() || undefined
    : undefined;
  try {
    const providers = await readSqliteProviders(paths.databasePath, 'codex', currentProviderId);
    if (providers.length > 0) {
      return {
        provider: 'codex',
        ...(currentProviderId ? { currentProviderId } : {}),
        providers,
        settingsPath: paths.settingsPath,
        databasePath: paths.databasePath,
        source: 'sqlite',
      };
    }
  } catch (error) {
    const legacy = readLegacyProviders(settings, 'codex', currentProviderId);
    if (legacy.length > 0) {
      return {
        provider: 'codex',
        ...(currentProviderId ? { currentProviderId } : {}),
        providers: legacy,
        settingsPath: paths.settingsPath,
        databasePath: paths.databasePath,
        source: 'legacy-json',
      };
    }
    return {
      provider: 'codex',
      ...(currentProviderId ? { currentProviderId } : {}),
      providers: [],
      settingsPath: paths.settingsPath,
      databasePath: paths.databasePath,
      source: 'sqlite',
      error: safeCcSwitchError(error),
    };
  }
  const legacy = readLegacyProviders(settings, 'codex', currentProviderId);
  return {
    provider: 'codex',
    ...(currentProviderId ? { currentProviderId } : {}),
    providers: legacy,
    settingsPath: paths.settingsPath,
    databasePath: paths.databasePath,
    source: legacy.length > 0 ? 'legacy-json' : 'sqlite',
  };
}

export async function resolveCurrentCcSwitchCodexProvider(input: {
  env?: NodeJS.ProcessEnv;
  codexHome?: string;
  parentProviderId?: string;
  /** Optional fixed provider selected for subagents. */
  providerId?: string;
} = {}): Promise<ResolvedCcSwitchProvider> {
  const env = input.env ?? process.env;
  const catalog = await readCcSwitchProviderCatalog(env);
  if (catalog.error) {
    throw new CcSwitchProviderError('database-unreadable', catalog.error);
  }
  const currentRows = catalog.providers.filter(provider => provider.current);
  if (currentRows.length > 1) {
    throw new CcSwitchProviderError(
      'provider-ambiguous',
      `cc-switch 有多个 Codex current provider：${currentRows.map(provider => provider.id).join(', ')}`,
    );
  }
  const sqliteCurrent = currentRows[0]?.id;
  if (
    catalog.currentProviderId &&
    sqliteCurrent &&
    catalog.currentProviderId !== sqliteCurrent
  ) {
    throw new CcSwitchProviderError(
      'provider-current-mismatch',
      `cc-switch settings.currentProviderCodex=${catalog.currentProviderId}，` +
        `但数据库 is_current=${sqliteCurrent}`,
    );
  }
  const selectedId =
    input.providerId?.trim() ||
    catalog.currentProviderId ||
    sqliteCurrent ||
    input.parentProviderId;
  if (!selectedId) {
    throw new CcSwitchProviderError(
      'provider-not-found',
      '无法确定 cc-switch 当前 Codex provider',
    );
  }
  const metadata = catalog.providers.find(provider => provider.id === selectedId);
  if (!metadata) {
    throw new CcSwitchProviderError(
      'provider-not-found',
      `cc-switch 当前 Codex provider 不存在：${selectedId}`,
    );
  }
  const record = await readSelectedProviderRecord(
    catalog.source,
    ccSwitchPaths(env),
    metadata,
    env,
  );
  const parsed = parseSelectedConfig(record, input.codexHome);
  const providerId = parsed.config.modelProvider?.trim() || metadata.id;
  const provider = parsed.config.providers.get(providerId) ?? {};
  const configText = settingsConfigText(record.settingsConfig);
  const credential = resolveCredential(providerId, provider, record.settingsConfig, configText);
  const baseUrl = normalizeBaseUrl(
    provider.baseUrl ?? chooseEndpoint(record.endpointUrls),
    providerId,
    provider.requiresOpenAiAuth,
  );
  if (provider.httpHeaders && Object.keys(provider.httpHeaders).length > 0) {
    for (const [header, value] of Object.entries(provider.httpHeaders)) {
      if (!value.trim()) continue;
      const envName = `ARG_BRIDGE_CCSWITCH_HEADER_${createHash('sha256')
        .update(header)
        .digest('hex')
        .slice(0, 12)
        .toUpperCase()}`;
      credential.envHttpHeaders[header] = envName;
      credential.credentials[envName] = value;
    }
  }
  if (provider.envHttpHeaders) {
    for (const [header, envName] of Object.entries(provider.envHttpHeaders)) {
      credential.envHttpHeaders[header] = envName;
      const value = findCredentialValue(record.settingsConfig, [envName]);
      if (value) credential.credentials[envName] = value.value;
    }
  }
  const model = parsed.config.model?.trim();
  if (!model) {
    throw new CcSwitchProviderError(
      'model-missing',
      `cc-switch provider ${selectedId} 的配置中没有 model`,
    );
  }
  const wireApi = provider.wireApi?.trim() || 'responses';
  const thirdParty = isThirdPartyProvider(providerId, provider);
  const activeConfig = parsed.activeConfig;
  const mismatches = configMismatches(parsed.config, activeConfig, providerId);
  const credentialStatus = credential.status;
  const credentialFingerprint = credential.value
    ? createHash('sha256').update(credential.value).digest('hex').slice(0, 16)
    : null;
  const credentialSetFingerprint = createHash('sha256')
    .update(JSON.stringify(Object.entries(credential.credentials).sort()))
    .digest('hex')
    .slice(0, 16);
  const configFingerprint = createHash('sha256').update(JSON.stringify({
    providerId: selectedId,
    codexProviderId: providerId,
    model,
    baseUrl,
    wireApi,
    envKey: provider.envKey ?? credential.envKey ?? null,
    envHttpHeaders: credential.envHttpHeaders,
    supportsStandaloneWebSearch: provider.supportsStandaloneWebSearch ?? null,
    reasoningEffort: parsed.config.modelReasoningEffort ?? null,
    contextWindow: parsed.config.modelContextWindow ?? null,
    credentialFingerprint,
    credentialSetFingerprint,
  })).digest('hex');
  const summary: CcSwitchProviderSummary = {
    id: selectedId,
    name: metadata.name,
    source: metadata.source,
    codexProviderId: providerId,
    model,
    baseUrl,
    baseUrlHost: safeHostname(baseUrl),
    wireApi,
    envKey: provider.envKey ?? credential.envKey ?? null,
    envHttpHeaders: { ...credential.envHttpHeaders },
    reasoningEffort: parsed.config.modelReasoningEffort ?? null,
    contextWindow: parsed.config.modelContextWindow ?? null,
    thirdParty,
    requiresOpenAiAuth: provider.requiresOpenAiAuth ?? null,
    supportsStandaloneWebSearch:
      provider.supportsStandaloneWebSearch ?? (thirdParty ? null : true),
    credential: {
      status: credentialStatus,
      sourcePath: credential.sourcePath,
      fingerprint: credentialFingerprint,
    },
    configFingerprint,
    parentProviderId: input.parentProviderId ?? null,
    providerSwitchPending: Boolean(
      input.parentProviderId && input.parentProviderId !== selectedId
    ),
    configMismatches: mismatches,
  };
  return {
    summary,
    config: parsed.config,
    providerConfig: provider,
    credentials: credential.credentials,
  };
}

export async function materializeCcSwitchBrokerRuntime(input: {
  env?: NodeJS.ProcessEnv;
  codexHome?: string;
  parentProviderId?: string;
  /** Optional fixed provider selected for subagents. */
  providerId?: string;
  cwd: string;
  codexBin: string;
  stateDir: string;
  runtimePolicy?: CcSwitchRuntimePolicy;
}): Promise<CcSwitchBrokerRuntime> {
  const resolved = await resolveCurrentCcSwitchCodexProvider(input);
  const summary = resolved.summary;
  if (summary.credential.status === 'oauth-only') {
    throw new CcSwitchProviderError(
      'oauth-broker-unsupported',
      '当前 cc-switch provider 只有 ChatGPT OAuth token，MixAgents 0.1.1 无法安全复用该登录；' +
        '请为该 provider 配置 API Key，官方主会话不受影响。',
    );
  }
  if (summary.credential.status !== 'present') {
    throw new CcSwitchProviderError(
      'credential-missing',
      `cc-switch provider ${summary.id} 缺少 Broker 凭据` +
        (summary.envKey ? `（${summary.envKey}）` : ''),
    );
  }
  if (summary.wireApi !== 'responses') {
    throw new CcSwitchProviderError(
      'wire-api-unsupported',
      `MixAgents 0.1.1 只支持 wire_api=responses，当前 provider 为 ${summary.wireApi}`,
    );
  }
  const runtimePolicy = input.runtimePolicy ?? {
    role: 'worker' as const,
    webSearch: 'auto' as const,
  };
  const webSearch = resolveWebSearchPolicy(summary, runtimePolicy.webSearch);
  const policyFingerprint = createHash('sha256').update(JSON.stringify({
    config: summary.configFingerprint,
    role: runtimePolicy.role,
    webSearch: runtimePolicy.webSearch,
    effectiveWebSearch: webSearch.effective,
    sideReasoningEffort: runtimePolicy.sideReasoningEffort ?? null,
  })).digest('hex');
  const routeId = ccSwitchRouteId(summary);
  const route: SubagentRoute = {
    id: routeId,
    description: `${summary.name} current cc-switch Codex provider`,
    provider: summary.codexProviderId,
    model: summary.model,
    maxAccess: 'workspace-write',
    available: true,
    missingEnvironment: [],
    tags: [
      'cc-switch',
      ...(summary.thirdParty ? ['third-party'] : ['official']),
      `web-search:${webSearch.effective}`,
    ],
    backend: 'mixagents',
    default: true,
    selectionReason: 'Current cc-switch Codex provider resolved automatically',
    revision: policyFingerprint.slice(0, 16),
    targetFingerprint: policyFingerprint,
    ccSwitchProviderId: summary.id,
    source: 'cc-switch',
  };
  const workspaceRoot = await realpath(input.cwd).catch(() => resolve(input.cwd));
  if (
    !workspaceRoot ||
    workspaceRoot === parse(workspaceRoot).root ||
    workspaceRoot === resolve(homedir())
  ) {
    throw new CcSwitchProviderError(
      'workspace-invalid',
      'Broker workspace 不能是文件系统根目录或用户 home；请在具体项目目录中启动子代理',
    );
  }
  const configPath = join(
    input.stateDir,
    'cc-switch',
    `broker-${policyFingerprint.slice(0, 16)}-${runtimePolicy.role}.json`,
  );
  await mkdir(resolve(input.stateDir, 'cc-switch'), { recursive: true, mode: 0o700 });
  await chmod(resolve(input.stateDir, 'cc-switch'), 0o700).catch(() => {});
  const dataDir = join(
    input.stateDir,
    'cc-switch',
    'mixagents-data',
    policyFingerprint.slice(0, 16),
  );
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await chmod(dataDir, 0o700).catch(() => {});
  const codexBin = await materializeManagedCodexLauncher({
    stateDir: input.stateDir,
    codexBin: input.codexBin,
    fingerprint: policyFingerprint,
    role: runtimePolicy.role,
    provider: summary.codexProviderId,
    providerConfigurable: !['openai', 'codex'].includes(
      summary.codexProviderId.toLowerCase(),
    ),
    webSearch: webSearch.effective,
    sideReasoningEffort: runtimePolicy.sideReasoningEffort,
  });
  const brokerConfig = {
    version: 1,
    defaultRoute: route.id,
    workspaceRoots: [workspaceRoot],
    dataDir,
    codexBin,
    routes: {
      [route.id]: {
        description: route.description,
        provider: route.provider,
        providerName: summary.name,
        model: route.model,
        ...(summary.contextWindow ? { contextWindow: summary.contextWindow } : {}),
        baseUrl: summary.baseUrl,
        ...(summary.envKey ? { envKey: summary.envKey } : {}),
        ...(Object.keys(summary.envHttpHeaders).length > 0
          ? { envHttpHeaders: summary.envHttpHeaders }
          : {}),
        tags: route.tags,
        maxAccess: 'workspace-write',
        ccSwitchProviderId: summary.id,
        source: 'cc-switch',
        ...(runtimePolicy.role === 'side' &&
            runtimePolicy.sideReasoningEffort &&
            runtimePolicy.sideReasoningEffort !== 'inherit'
          ? { reasoningEffort: runtimePolicy.sideReasoningEffort }
          : summary.reasoningEffort
          ? { reasoningEffort: normalizeReasoningEffort(summary.reasoningEffort) }
          : {}),
      },
    },
  };
  await writeFileAtomic(configPath, `${JSON.stringify(brokerConfig, null, 2)}\n`, {
    mode: 0o600,
  });
  return {
    summary,
    route,
    credentials: resolved.credentials,
    brokerConfigPath: configPath,
    fingerprint: policyFingerprint,
    webSearch,
  };
}

async function materializeManagedCodexLauncher(input: {
  stateDir: string;
  codexBin: string;
  fingerprint: string;
  role: CcSwitchRuntimePolicy['role'];
  provider: string;
  providerConfigurable: boolean;
  webSearch: 'enabled' | 'disabled';
  sideReasoningEffort?: SubagentReasoningEffort;
}): Promise<string> {
  const wrapperDir = join(input.stateDir, 'cc-switch', 'codex-wrapper');
  await mkdir(wrapperDir, { recursive: true, mode: 0o700 });
  await chmod(wrapperDir, 0o700).catch(() => {});
  const overrides = [
    ...(input.webSearch === 'disabled'
      ? ['-c', 'web_search="disabled"']
      : []),
    ...(input.role === 'side' &&
        input.sideReasoningEffort &&
        input.sideReasoningEffort !== 'inherit'
      ? ['-c', `model_reasoning_effort="${input.sideReasoningEffort}"`]
      : []),
    ...(input.role === 'side' && input.providerConfigurable
      ? [
          '-c',
          `model_providers.${input.provider}.request_max_retries=1`,
          '-c',
          `model_providers.${input.provider}.stream_max_retries=1`,
          '-c',
          `model_providers.${input.provider}.stream_idle_timeout_ms=45000`,
        ]
      : []),
  ];
  if (overrides.length === 0) return input.codexBin;
  const name = `managed-${input.role}-${input.fingerprint.slice(0, 16)}`;
  const launcherPath = join(wrapperDir, `${name}.mjs`);
  const launcher = [
    '#!/usr/bin/env node',
    "import { spawn } from 'node:child_process';",
    '',
    `const codexBin = ${JSON.stringify(input.codexBin)};`,
    `const managedArgs = ${JSON.stringify(overrides)};`,
    "const child = spawn(codexBin, [...managedArgs, ...process.argv.slice(2)], {",
    '  stdio: "inherit",',
    '  env: process.env,',
    '  windowsHide: true,',
    '});',
    '',
    "for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {",
    '  process.on(signal, () => {',
    '    if (child.exitCode === null && child.signalCode === null) child.kill(signal);',
    '  });',
    '}',
    'child.once("error", error => {',
    '  console.error(`arg-bridge Codex wrapper: ${error.message}`);',
    '  process.exit(127);',
    '});',
    'child.once("exit", (code, signal) => {',
    '  if (signal) {',
    '    process.kill(process.pid, signal);',
    '    return;',
    '  }',
    '  process.exit(code ?? 1);',
    '});',
    '',
  ].join('\n');
  await writeFileAtomic(launcherPath, launcher, { mode: 0o700 });
  await chmod(launcherPath, 0o700).catch(() => {});
  if (process.platform !== 'win32') return launcherPath;

  const commandPath = join(wrapperDir, `${name}.cmd`);
  await writeFileAtomic(
    commandPath,
    `@echo off\r\n"${process.execPath}" "${launcherPath}" %*\r\n`,
    { mode: 0o700 },
  );
  return commandPath;
}

export function resolveWebSearchPolicy(
  summary: Pick<CcSwitchProviderSummary, 'id' | 'thirdParty' | 'supportsStandaloneWebSearch'>,
  mode: SubagentWebSearchMode,
): CcSwitchBrokerRuntime['webSearch'] {
  const providerSupported = summary.supportsStandaloneWebSearch;
  if (mode === 'disabled') {
    return {
      mode,
      providerSupported,
      effective: 'disabled',
      reason: 'native web search disabled by profile policy',
    };
  }
  if (mode === 'native') {
    return {
      mode,
      providerSupported,
      effective: 'enabled',
      reason: providerSupported === true
        ? 'provider declares native web search support'
        : 'native web search forced by profile policy; provider capability is not proven',
    };
  }
  if (providerSupported === true) {
    return {
      mode,
      providerSupported,
      effective: 'enabled',
      reason: 'provider declares native web search support',
    };
  }
  return {
    mode,
    providerSupported,
    effective: 'disabled',
    reason: providerSupported === false
      ? 'provider declares that native web search is unsupported'
      : `provider ${summary.id} does not declare supports_standalone_web_search; switch to a web-search-capable provider or set subagents.webSearch=native explicitly`,
  };
}

export function ccSwitchSummaryFromCatalog(
  catalog: CcSwitchProviderCatalog,
): Array<Pick<CcSwitchProviderMetadata, 'id' | 'name' | 'current'>> {
  return catalog.providers.map(provider => ({
    id: provider.id,
    name: provider.name,
    current: provider.current || provider.id === catalog.currentProviderId,
  }));
}

async function readSqliteProviders(
  databasePath: string,
  appType: string,
  currentProviderId: string | undefined,
): Promise<CcSwitchProviderMetadata[]> {
  const sql = [
    'SELECT id, app_type, name, is_current, provider_type, category',
    'FROM providers',
    `WHERE app_type = '${appType.replace(/'/g, "''")}'`,
    'ORDER BY sort_index, id',
  ].join(' ');
  const rows = await querySqlite(databasePath, sql);
  return rows.flatMap(row => {
    const id = string(row.id);
    const name = string(row.name);
    if (!id || !name) return [];
    const isCurrent = Number(row.is_current) === 1;
    return [{
      id,
      appType: string(row.app_type) ?? appType,
      name,
      current: isCurrent,
      ...(string(row.provider_type) ? { providerType: string(row.provider_type)! } : {}),
      ...(string(row.category) ? { category: string(row.category)! } : {}),
      source: 'sqlite' as const,
    }];
  });
}

async function readSelectedProviderRecord(
  source: CcSwitchProviderSource,
  paths: ReturnType<typeof ccSwitchPaths>,
  metadata: CcSwitchProviderMetadata,
  env: NodeJS.ProcessEnv,
): Promise<CcSwitchProviderRecord> {
  if (source === 'sqlite') {
    const sql = [
      'SELECT settings_config',
      'FROM providers',
      `WHERE app_type = '${metadata.appType.replace(/'/g, "''")}'`,
      `AND id = '${metadata.id.replace(/'/g, "''")}'`,
      'LIMIT 1',
    ].join(' ');
    const rows = await querySqlite(paths.databasePath, sql);
    const raw = string(rows[0]?.settings_config);
    if (!raw) {
      throw new CcSwitchProviderError(
        'provider-not-found',
        `cc-switch provider ${metadata.id} 没有 settings_config`,
      );
    }
    const settingsConfig = parseJsonRecord(raw, 'settings_config');
    const endpointUrls = await readSqliteEndpoints(paths.databasePath, metadata);
    return { ...metadata, settingsConfig, endpointUrls };
  }
  const settings = await readSettingsJson(paths.settingsPath);
  const legacy = readLegacyProviderRecords(settings, metadata.appType, metadata.id);
  const found = legacy.find(record => record.id === metadata.id);
  if (!found) {
    throw new CcSwitchProviderError(
      'provider-not-found',
      `旧版 cc-switch settings.json 中找不到 provider ${metadata.id}`,
    );
  }
  void env;
  return found;
}

async function readSqliteEndpoints(
  databasePath: string,
  metadata: CcSwitchProviderMetadata,
): Promise<string[]> {
  try {
    const rows = await querySqlite(
      databasePath,
      [
        'SELECT url FROM provider_endpoints',
        `WHERE app_type = '${metadata.appType.replace(/'/g, "''")}'`,
        `AND provider_id = '${metadata.id.replace(/'/g, "''")}'`,
        'ORDER BY id',
      ].join(' '),
    );
    return rows.flatMap(row => {
      const url = string(row.url);
      return url ? [url] : [];
    });
  } catch {
    return [];
  }
}

async function querySqlite(
  databasePath: string,
  sql: string,
): Promise<Array<Record<string, unknown>>> {
  try {
    const sqlite = require('node:sqlite') as {
      DatabaseSync: new (
        path: string,
        options?: { readOnly?: boolean },
      ) => {
        prepare(query: string): { all(): Array<Record<string, unknown>> };
        close(): void;
      };
    };
    const database = new sqlite.DatabaseSync(databasePath, { readOnly: true });
    try {
      return database.prepare(sql).all();
    } finally {
      database.close();
    }
  } catch (nodeSqliteError) {
    try {
      return await querySqliteCli(databasePath, `${sql};`);
    } catch (cliError) {
      throw new CcSwitchProviderError(
        'database-unreadable',
        `无法读取 cc-switch SQLite：${safeCcSwitchError(cliError ?? nodeSqliteError)}`,
      );
    }
  }
}

async function querySqliteCli(
  databasePath: string,
  sql: string,
): Promise<Array<Record<string, unknown>>> {
  const child = spawnProcess('sqlite3', ['-readonly', '-json', databasePath, sql], {
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let bytes = 0;
  child.stdout?.on('data', chunk => {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes <= MAX_DB_ROW_BYTES) stdout.push(buffer);
  });
  child.stderr?.on('data', chunk => stderr.push(Buffer.from(chunk)));
  const code = await new Promise<number | null>((resolvePromise, reject) => {
    child.once('error', reject);
    child.once('exit', resolvePromise);
  });
  if (code !== 0 || bytes > MAX_DB_ROW_BYTES) {
    throw new Error(
      `sqlite3 exited ${code ?? 'signal'}${bytes > MAX_DB_ROW_BYTES ? '; output exceeded limit' : ''}` +
        (stderr.length ? `: ${Buffer.concat(stderr).toString('utf8').slice(0, 500)}` : ''),
    );
  }
  const parsed: unknown = JSON.parse(Buffer.concat(stdout).toString('utf8') || '[]');
  if (!Array.isArray(parsed)) throw new Error('sqlite3 returned invalid JSON');
  return parsed.filter(isRecord);
}

function readLegacyProviders(
  settings: Record<string, unknown> | undefined,
  appType: string,
  currentProviderId: string | undefined,
): CcSwitchProviderMetadata[] {
  return readLegacyProviderRecords(settings, appType, currentProviderId)
    .map(({ settingsConfig: _settingsConfig, endpointUrls: _endpointUrls, ...metadata }) => metadata);
}

function readLegacyProviderRecords(
  settings: Record<string, unknown> | undefined,
  appType: string,
  currentProviderId: string | undefined,
): CcSwitchProviderRecord[] {
  const candidates = collectLegacyProviderValues(settings, appType);
  return candidates.flatMap(value => {
    if (!isRecord(value)) return [];
    const id = string(value.id) ?? string(value.providerId) ?? string(value.provider_id);
    const name = string(value.name) ?? id;
    if (!id || !name) return [];
    const rawConfig = value.settings_config ?? value.settingsConfig ?? value;
    const settingsConfig = typeof rawConfig === 'string'
      ? parseJsonRecord(rawConfig, `${id}.settings_config`)
      : isRecord(rawConfig)
        ? rawConfig
        : {};
    const endpointUrls = [
      string(value.endpoint),
      string(value.baseUrl),
      ...(Array.isArray(value.endpoints)
        ? value.endpoints.map(item => isRecord(item) ? string(item.url) : string(item))
        : []),
    ].filter((item): item is string => Boolean(item));
    const isCurrent = value.is_current === true ||
      value.isCurrent === true ||
      id === currentProviderId;
    return [{
      id,
      appType: string(value.app_type) ?? string(value.appType) ?? appType,
      name,
      current: isCurrent,
      ...(string(value.provider_type) ? { providerType: string(value.provider_type)! } : {}),
      ...(string(value.category) ? { category: string(value.category)! } : {}),
      source: 'legacy-json' as const,
      settingsConfig,
      endpointUrls,
    }];
  });
}

function collectLegacyProviderValues(
  settings: Record<string, unknown> | undefined,
  appType: string,
): unknown[] {
  if (!settings) return [];
  const values: unknown[] = [];
  const add = (value: unknown): void => {
    if (Array.isArray(value)) values.push(...value);
    else if (isRecord(value)) {
      for (const entry of Object.values(value)) add(entry);
    }
  };
  add(settings.providers);
  if (isRecord(settings.apps)) {
    const app = settings.apps[appType];
    if (isRecord(app)) add(app.providers);
  }
  if (isRecord(settings[appType])) {
    add((settings[appType] as Record<string, unknown>).providers);
    add(settings[appType]);
  }
  add(settings[`${appType}Providers`]);
  return values.filter(value => {
    if (!isRecord(value)) return false;
    const type = string(value.app_type) ?? string(value.appType);
    return !type || type === appType;
  });
}

function parseSelectedConfig(
  record: CcSwitchProviderRecord,
  codexHome: string | undefined,
): { config: CodexConfigSummary; activeConfig?: CodexConfigSummary } {
  const configText = settingsConfigText(record.settingsConfig);
  if (!configText) {
    throw new CcSwitchProviderError(
      'config-invalid',
      `cc-switch provider ${record.id} 缺少 settings_config.config TOML`,
    );
  }
  const config = parseCodexConfigSummary(configText);
  const activeConfig = codexHome
    ? parseCodexConfigSummary(readConfigTextSync(join(codexHome, 'config.toml')))
    : undefined;
  return { config, ...(activeConfig ? { activeConfig } : {}) };
}

function resolveCredential(
  providerId: string,
  provider: CodexProviderEntry,
  settingsConfig: Record<string, unknown>,
  configText: string | undefined,
): {
  envKey: string;
  value?: string;
  status: CcSwitchProviderSummary['credential']['status'];
  sourcePath: string | null;
  credentials: Record<string, string>;
  envHttpHeaders: Record<string, string>;
} {
  const envKey = provider.envKey?.trim() || DEFAULT_CODEX_ENV_KEY;
  const candidates = [
    ...credentialCandidates(settingsConfig),
    {
      path: `model_providers.${providerId}.experimental_bearer_token`,
      value: provider.bearerToken,
    },
    {
      path: `config.model_providers.${providerId}.experimental_bearer_token`,
      value: configText ? extractConfigBearerToken(configText, providerId) : undefined,
    },
  ];
  const exact = candidates.find(item =>
    item.value?.trim() &&
    (item.path.endsWith(`.${envKey}`) ||
      item.path.endsWith('.OPENAI_API_KEY') ||
      item.path.includes('experimental_bearer_token'))
  );
  const generic = exact ?? candidates.find(item =>
    item.value?.trim() &&
    /(?:api[_-]?key|bearer|auth[_-]?token|access[_-]?token)$/iu.test(item.path)
  );
  if (generic?.value?.trim()) {
    return {
      envKey,
      value: generic.value.trim(),
      status: 'present',
      sourcePath: generic.path,
      credentials: { [envKey]: generic.value.trim() },
      envHttpHeaders: { ...(provider.envHttpHeaders ?? {}) },
    };
  }
  const auth = isRecord(settingsConfig.auth) ? settingsConfig.auth : {};
  const oauthTokenNames = isRecord(auth.tokens) ? Object.keys(auth.tokens) : [];
  const oauthOnly = oauthTokenNames.length > 0 &&
    oauthTokenNames.some(name => /(?:access|refresh|id)_?token/iu.test(name)) &&
    (auth.auth_mode === 'chatgpt' ||
      auth.authMode === 'chatgpt' ||
      auth.auth_mode === undefined &&
      auth.authMode === undefined);
  return {
    envKey,
    status: oauthOnly ? 'oauth-only' : 'missing',
    sourcePath: oauthOnly ? 'settings_config.auth.tokens' : null,
    credentials: {},
    envHttpHeaders: { ...(provider.envHttpHeaders ?? {}) },
  };
}

function credentialCandidates(
  settingsConfig: Record<string, unknown>,
): Array<{ path: string; value?: string }> {
  const result: Array<{ path: string; value?: string }> = [];
  const walk = (value: unknown, path: string, depth: number): void => {
    if (depth > 4 || !isRecord(value)) return;
    for (const [key, child] of Object.entries(value)) {
      const childPath = `${path}.${key}`;
      if (typeof child === 'string') {
        if (/(?:api[_-]?key|bearer|auth[_-]?token)$/iu.test(key) ||
            /^(?:OPENAI|ANTHROPIC)_API_KEY$/u.test(key) ||
            key === 'OPENAI_API_KEY') {
          result.push({ path: childPath, value: child });
        }
      } else if (isRecord(child)) {
        walk(child, childPath, depth + 1);
      }
    }
  };
  walk(settingsConfig.auth, 'settings_config.auth', 0);
  walk(settingsConfig.env, 'settings_config.env', 0);
  return result;
}

function findCredentialValue(
  settingsConfig: Record<string, unknown>,
  names: string[],
): { value: string; path: string } | undefined {
  for (const candidate of credentialCandidates(settingsConfig)) {
    const key = candidate.path.split('.').at(-1);
    if (key && names.includes(key) && candidate.value?.trim()) {
      return { value: candidate.value.trim(), path: candidate.path };
    }
  }
  return undefined;
}

function settingsConfigText(settingsConfig: Record<string, unknown>): string | undefined {
  const config = settingsConfig.config;
  if (typeof config === 'string') return config;
  return undefined;
}

function extractConfigBearerToken(configText: string, providerId: string): string | undefined {
  const summary = parseCodexConfigSummary(configText);
  return summary.providers.get(providerId)?.bearerToken;
}

function normalizeBaseUrl(
  value: string | undefined,
  providerId: string,
  requiresOpenAiAuth: boolean | undefined,
): string {
  const candidate = value?.trim() ||
    (['openai', 'codex'].includes(providerId.toLowerCase()) ||
      requiresOpenAiAuth === true
      ? 'https://api.openai.com/v1'
      : undefined);
  if (!candidate) {
    throw new CcSwitchProviderError(
      'base-url-missing',
      `cc-switch provider ${providerId} 缺少 base_url，且没有可用的 provider_endpoints`,
    );
  }
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new CcSwitchProviderError('endpoint-invalid', 'cc-switch provider base_url 无效');
  }
  if (url.username || url.password) {
    throw new CcSwitchProviderError(
      'endpoint-invalid',
      'cc-switch provider base_url 不能包含用户名或密码',
    );
  }
  if (url.search || url.hash) {
    throw new CcSwitchProviderError(
      'endpoint-invalid',
      'cc-switch provider base_url 不能包含查询参数或片段，避免把凭据写入 Broker 配置',
    );
  }
  const localHttp = url.protocol === 'http:' &&
    ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !localHttp) {
    throw new CcSwitchProviderError(
      'endpoint-invalid',
      'cc-switch provider base_url 必须使用 HTTPS（回环测试地址除外）',
    );
  }
  return url.toString().replace(/\/$/u, '');
}

function chooseEndpoint(urls: string[]): string | undefined {
  const unique = [...new Set(urls.map(url => url.trim()).filter(Boolean))];
  return unique.length === 1 ? unique[0] : undefined;
}

function configMismatches(
  selected: CodexConfigSummary,
  active: CodexConfigSummary | undefined,
  providerId: string,
): string[] {
  if (!active) return ['active-codex-config-unavailable'];
  const mismatches: string[] = [];
  if (selected.model && active.model && selected.model !== active.model) {
    mismatches.push(`model:${active.model}->${selected.model}`);
  }
  if (selected.modelProvider && active.modelProvider && selected.modelProvider !== active.modelProvider) {
    mismatches.push(`provider:${active.modelProvider}->${selected.modelProvider}`);
  }
  const selectedBase = selected.providers.get(providerId)?.baseUrl;
  const activeProviderId = active.modelProvider ?? providerId;
  const activeBase = active.providers.get(activeProviderId)?.baseUrl;
  if (selectedBase && activeBase && selectedBase !== activeBase) {
    mismatches.push('base_url');
  }
  return mismatches;
}

function ccSwitchRouteId(summary: CcSwitchProviderSummary): string {
  const id = summary.id.replace(/[^A-Za-z0-9_-]/gu, '-').slice(0, 30);
  return `ccswitch-${id}-${summary.configFingerprint.slice(0, 10)}`.slice(0, 64);
}

function normalizeReasoningEffort(value: string): string | undefined {
  return ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(value)
    ? value
    : undefined;
}

function safeHostname(value: string): string | null {
  try {
    return new URL(value).hostname;
  } catch {
    return null;
  }
}

async function readSettingsJson(
  path: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    return parseJsonRecord(await readFile(path, 'utf8'), path);
  } catch {
    return undefined;
  }
}

function readConfigTextSync(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

function parseJsonRecord(raw: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CcSwitchProviderError(
      'config-invalid',
      `${label} 不是有效 JSON`,
    );
  }
  if (!isRecord(parsed)) {
    throw new CcSwitchProviderError('config-invalid', `${label} 必须是 JSON object`);
  }
  return parsed;
}

function safeCcSwitchError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/sk-[A-Za-z0-9_-]{8,}/gu, 'sk-[REDACTED]')
    .replace(/Bearer\s+\S+/giu, 'Bearer [REDACTED]');
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

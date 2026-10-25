import type {
  AppCredentials,
  AppPreferences,
  MessageReplyMode,
  SecretsConfig,
} from './schema';
import {
  normalizePermissions,
  permissionsToLegacySandbox,
  type AccessMode,
  type CodexSandboxMode,
  type PermissionConfig,
  type PermissionSource,
} from './permissions';

export type AgentKind = 'claude' | 'codex';
export type SandboxMode = CodexSandboxMode;
export type { AccessMode, PermissionConfig, PermissionSource };

export interface ProfileAccess {
  allowedUsers: string[];
  allowedChats: string[];
  admins: string[];
  requireMentionInGroup: boolean;
}

export interface SandboxConfig {
  default?: SandboxMode;
  max?: SandboxMode;
  defaultMode: SandboxMode;
  maxMode: SandboxMode;
}

export interface CodexConfig {
  binaryPath: string;
  realpath?: string;
  version?: string;
  sha256?: string;
  owner?: number;
  mode?: number;
  codexHome?: string;
  inheritCodexHome?: boolean;
  ignoreUserConfig?: boolean;
  ignoreRules?: boolean;
}

export interface AttachmentConfig {
  maxCount: number;
  maxBytes: number;
  maxFileBytes: number;
  imageMaxBytes: number;
  cacheTtlMs: number;
  cacheMaxBytes: number;
}

export interface OutboundConfig {
  allowedFileDirs: string[];
}

export type NetworkMode = 'direct' | 'proxy' | 'inherit';

/**
 * Per-profile network policy for agent child processes. `direct` strips every
 * inherited proxy variable; `proxy` applies one explicit proxy and verifies it
 * before an agent is allowed to start; `inherit` keeps the host environment
 * (still dropping a loopback proxy that is provably dead).
 */
export interface NetworkConfig {
  mode: NetworkMode;
  proxyUrl?: string;
  noProxy?: string;
}

export type SubagentMode = 'off' | 'auto' | 'broker' | 'fork';
export type SubagentRouteMode = 'follow-cc-switch' | 'manual';
export type SubagentAccess = 'read-only' | 'workspace-write';

export interface SubagentMixAgentsConfig {
  /**
   * Stable MCP server command. Until MixAgents publishes a public package this
   * must be configured explicitly (or supplied through
   * ARG_BRIDGE_MIXAGENTS_MCP); arg-bridge never reaches into a plugin cache.
   */
  mcpCommand?: string;
  mcpArgs?: string[];
  mcpCwd?: string;
  /**
   * `inherit-env` checks credential variable *names* in the MCP process
   * environment. `mixagents-managed` delegates secret lookup to MixAgents or
   * its trusted helper and passes only an opaque provider reference.
   */
  credentialMode?: 'inherit-env' | 'mixagents-managed';
  credentialProvider?: string;
  /** Environment variable names that must be present for the MCP server. */
  credentialEnvKeys?: string[];
}

export interface SubagentConfig {
  enabled: boolean;
  mode: SubagentMode;
  routeMode: SubagentRouteMode;
  readRoute: string | null;
  writeRoute: string | null;
  includeProgressSnapshot: boolean;
  reuse: 'scope-cwd';
  allowForkFallback: boolean;
  mixagents?: SubagentMixAgentsConfig;
}

export interface RsiConfig {
  mode: 'off' | 'auto';
  projectRoot: string | null;
  reviewerRouteMode: SubagentRouteMode;
  reviewerRoute: string | null;
  /** Optional explicit upstream runner entry; task text is passed by file. */
  runnerCommand?: string;
  runnerArgs?: string[];
  /** Optional explicit validator entry; the upstream validator is never copied. */
  validatorCommand?: string;
  validatorArgs?: string[];
}

export type CommentConfig = Record<string, never>;

export type LarkCliIdentityPreset = 'bot-only' | 'user-default';

export type LarkCliUserImportStatus =
  | 'not-needed'
  | 'imported'
  | 'skipped-existing-private-user'
  | 'skipped-no-local-user'
  | 'failed';

export interface LarkCliConfig {
  identityPreset: LarkCliIdentityPreset;
  localUserImport?: {
    status: LarkCliUserImportStatus;
    attemptedAt?: string;
    importedAt?: string;
    reason?: string;
  };
}

export interface ProfileConfig {
  schemaVersion: 2;
  agentKind: AgentKind;
  accounts: {
    app: AppCredentials;
  };
  secrets?: SecretsConfig;
  preferences: Omit<AppPreferences, 'access' | 'requireMentionInGroup'>;
  access: ProfileAccess;
  workspaces: {
    default?: string;
  };
  sandbox: SandboxConfig;
  permissions: PermissionConfig;
  permissionSource?: PermissionSource;
  network?: NetworkConfig;
  subagents?: SubagentConfig;
  rsi?: RsiConfig;
  codex?: CodexConfig;
  attachments: AttachmentConfig;
  outbound: OutboundConfig;
  comments: CommentConfig;
  larkCli: LarkCliConfig;
}

export interface RootConfig {
  schemaVersion: 2;
  activeProfile: string;
  preferences: Record<string, never>;
  secrets?: SecretsConfig;
  migrations?: {
    permissionDefaultsV1?: string[];
  };
  profiles: Record<string, ProfileConfig>;
}

export interface CreateDefaultProfileConfigInput {
  agentKind: AgentKind;
  accounts: {
    app: AppCredentials;
  };
  preferences?: AppPreferences;
  access?: Partial<ProfileAccess>;
  sandbox?: Partial<SandboxConfig>;
  permissions?: Partial<PermissionConfig>;
  codex?: CodexConfig;
  secrets?: SecretsConfig;
}

export function createDefaultProfileConfig(
  input: CreateDefaultProfileConfigInput,
): ProfileConfig {
  return normalizeProfileConfig({
    schemaVersion: 2,
    ...input,
  });
}

export function normalizeProfileConfig(input: unknown): ProfileConfig {
  if (!input || typeof input !== 'object') {
    throw new Error('profile config must be an object');
  }
  const raw = input as {
    schemaVersion?: unknown;
    agentKind?: unknown;
    accounts?: unknown;
    secrets?: SecretsConfig;
    preferences?: (AppPreferences & { access?: Partial<ProfileAccess> }) | undefined;
    access?: Partial<ProfileAccess>;
    workspaces?: {
      default?: unknown;
      // Legacy workspace authorization fields are accepted for config
      // compatibility only; normalizeWorkspaces drops them.
      trusted?: unknown;
      trustedRoots?: unknown;
      riskFlags?: unknown;
    };
    sandbox?: Partial<SandboxConfig>;
    permissions?: Partial<PermissionConfig>;
    network?: Partial<NetworkConfig>;
    subagents?: unknown;
    rsi?: unknown;
    codex?: CodexConfig & { flags?: unknown };
    attachments?: Partial<AttachmentConfig>;
    outbound?: {
      allowedFileDirs?: unknown;
    };
    comments?: unknown;
    larkCli?: unknown;
  };

  if (raw.schemaVersion !== 2) {
    throw new Error('profile schemaVersion must be 2');
  }
  if (raw.agentKind !== 'claude' && raw.agentKind !== 'codex') {
    throw new Error('agentKind must be claude or codex');
  }
  const accounts = normalizeAccounts(raw.accounts);
  if (raw.agentKind === 'codex' && !raw.codex) {
    throw new Error('codex profile requires codex configuration');
  }

  const preferences = normalizePreferences(raw.preferences);
  const access = normalizeAccess(
    raw.access ?? raw.preferences?.access,
    raw.preferences?.requireMentionInGroup,
  );
  const { permissions, source: permissionSource } = normalizePermissions({
    permissions: raw.permissions,
    sandbox: raw.sandbox,
  });
  const sandbox = permissionsToLegacySandbox(permissions);
  const workspaces = normalizeWorkspaces(raw.workspaces);
  const comments = normalizeComments(raw.comments);
  const larkCli = normalizeLarkCli(raw.larkCli);

  return {
    schemaVersion: 2,
    agentKind: raw.agentKind,
    accounts,
    ...(raw.secrets ? { secrets: raw.secrets } : {}),
    preferences,
    access,
    workspaces,
    sandbox,
    permissions,
    permissionSource,
    network: normalizeNetwork(raw.network),
    subagents: normalizeSubagents(raw.subagents),
    rsi: normalizeRsi(raw.rsi),
    ...(raw.codex ? { codex: normalizeCodex(raw.codex) } : {}),
    attachments: {
      maxCount: numberOr(raw.attachments?.maxCount, 10),
      maxBytes: numberOr(raw.attachments?.maxBytes, 100 * 1024 * 1024),
      maxFileBytes: numberOr(raw.attachments?.maxFileBytes, 25 * 1024 * 1024),
      imageMaxBytes: numberOr(raw.attachments?.imageMaxBytes, 25 * 1024 * 1024),
      cacheTtlMs: numberOr(raw.attachments?.cacheTtlMs, 24 * 60 * 60 * 1000),
      cacheMaxBytes: numberOr(raw.attachments?.cacheMaxBytes, 512 * 1024 * 1024),
    },
    outbound: {
      allowedFileDirs: stringArray(raw.outbound?.allowedFileDirs),
    },
    comments,
    larkCli,
  };
}

function normalizeAccounts(input: unknown): ProfileConfig['accounts'] {
  if (!input || typeof input !== 'object') {
    throw new Error('accounts.app is required');
  }
  const accounts = input as { app?: Partial<AppCredentials> };
  const app = accounts.app;
  if (!app?.id || !app.secret || (app.tenant !== 'feishu' && app.tenant !== 'lark')) {
    throw new Error('accounts.app is incomplete');
  }
  return {
    app: {
      id: app.id,
      secret: app.secret,
      tenant: app.tenant,
    },
  };
}

function normalizePreferences(
  preferences: AppPreferences | undefined,
): ProfileConfig['preferences'] {
  const {
    access: _access,
    requireMentionInGroup: _mention,
    messageReply,
    ...rest
  } = preferences ?? {};
  if (messageReply !== undefined && isMessageReply(messageReply)) {
    return {
      ...rest,
      messageReply,
    };
  }
  return rest;
}

function isMessageReply(value: unknown): value is MessageReplyMode {
  return value === 'card' || value === 'markdown' || value === 'text';
}

function normalizeAccess(
  access: Partial<ProfileAccess> | undefined,
  legacyRequireMentionInGroup: boolean | undefined,
): ProfileAccess {
  return {
    allowedUsers: stringArray(access?.allowedUsers),
    allowedChats: stringArray(access?.allowedChats),
    admins: stringArray(access?.admins),
    requireMentionInGroup: access?.requireMentionInGroup ?? legacyRequireMentionInGroup ?? true,
  };
}

function normalizeWorkspaces(input: {
  default?: unknown;
  trusted?: unknown;
  trustedRoots?: unknown;
  riskFlags?: unknown;
} | undefined): ProfileConfig['workspaces'] {
  const defaultWorkspace = typeof input?.default === 'string' && input.default.trim()
    ? input.default.trim()
    : undefined;
  return defaultWorkspace ? { default: defaultWorkspace } : {};
}

function normalizeCodex(input: CodexConfig & { flags?: unknown }): CodexConfig {
  const codex: CodexConfig = {
    binaryPath: input.binaryPath,
    ...(typeof input.realpath === 'string' ? { realpath: input.realpath } : {}),
    ...(typeof input.version === 'string' ? { version: input.version } : {}),
    ...(typeof input.sha256 === 'string' ? { sha256: input.sha256 } : {}),
    ...(typeof input.owner === 'number' ? { owner: input.owner } : {}),
    ...(typeof input.mode === 'number' ? { mode: input.mode } : {}),
    ...(typeof input.codexHome === 'string' ? { codexHome: input.codexHome } : {}),
    inheritCodexHome: input.inheritCodexHome !== false,
    ignoreUserConfig: input.ignoreUserConfig === true,
    ignoreRules: input.ignoreRules !== false,
  };
  return codex;
}

function normalizeNetwork(input: Partial<NetworkConfig> | undefined): NetworkConfig {
  const mode: NetworkMode =
    input?.mode === 'direct' || input?.mode === 'proxy' ? input.mode : 'inherit';
  const proxyUrl = typeof input?.proxyUrl === 'string' && input.proxyUrl.trim()
    ? input.proxyUrl.trim()
    : undefined;
  if (mode === 'proxy') {
    if (!proxyUrl) throw new Error('network.proxyUrl is required when network.mode is "proxy"');
    let parsed: URL;
    try {
      parsed = new URL(proxyUrl);
    } catch {
      throw new Error('network.proxyUrl must be a valid URL');
    }
    if (!['http:', 'https:', 'socks:', 'socks5:', 'socks5h:'].includes(parsed.protocol)) {
      throw new Error('network.proxyUrl must use http, https, socks, socks5, or socks5h');
    }
  }
  return {
    mode,
    ...(proxyUrl ? { proxyUrl } : {}),
    ...(typeof input?.noProxy === 'string' && input.noProxy.trim()
      ? { noProxy: input.noProxy.trim() }
      : {}),
  };
}

export const DEFAULT_SUBAGENT_CONFIG: SubagentConfig = {
  enabled: true,
  mode: 'auto',
  routeMode: 'follow-cc-switch',
  readRoute: null,
  writeRoute: null,
  includeProgressSnapshot: true,
  reuse: 'scope-cwd',
  allowForkFallback: true,
};

export const DEFAULT_RSI_CONFIG: RsiConfig = {
  mode: 'auto',
  projectRoot: null,
  reviewerRouteMode: 'follow-cc-switch',
  reviewerRoute: null,
};

function normalizeSubagents(input: unknown): SubagentConfig {
  const raw = isRecord(input) ? input : {};
  const mixagentsRaw = isRecord(raw.mixagents) ? raw.mixagents : undefined;
  const mcpArgs = stringArray(mixagentsRaw?.mcpArgs);
  if (
    mcpArgs.some(value => looksLikeInlineSecret(value)) ||
    (nonEmptyString(mixagentsRaw?.mcpCommand) &&
      looksLikeInlineSecret(nonEmptyString(mixagentsRaw?.mcpCommand)!))
  ) {
    throw new Error('subagents.mixagents command/args must not contain inline credentials; use a trusted credential helper');
  }
  const mode: SubagentMode =
    raw.mode === 'off' || raw.mode === 'broker' || raw.mode === 'fork'
      ? raw.mode
      : 'auto';
  const routeMode: SubagentRouteMode =
    raw.routeMode === 'manual' ? 'manual' : 'follow-cc-switch';
  const mixagents = mixagentsRaw
    ? {
        ...(nonEmptyString(mixagentsRaw.mcpCommand)
          ? { mcpCommand: nonEmptyString(mixagentsRaw.mcpCommand) }
          : {}),
        ...(mcpArgs.length > 0
          ? { mcpArgs }
          : {}),
        ...(nonEmptyString(mixagentsRaw.mcpCwd)
          ? { mcpCwd: nonEmptyString(mixagentsRaw.mcpCwd) }
          : {}),
        ...(mixagentsRaw.credentialMode === 'mixagents-managed'
          ? { credentialMode: 'mixagents-managed' as const }
          : mixagentsRaw.credentialMode === 'inherit-env'
            ? { credentialMode: 'inherit-env' as const }
            : {}),
        ...(credentialReference(mixagentsRaw.credentialProvider)
          ? { credentialProvider: credentialReference(mixagentsRaw.credentialProvider) }
          : {}),
        ...(stringArray(mixagentsRaw.credentialEnvKeys).length > 0
          ? {
              credentialEnvKeys: stringArray(mixagentsRaw.credentialEnvKeys)
                .map(value => value.trim())
                .filter(value => /^[A-Z_][A-Z0-9_]*$/u.test(value)),
            }
          : {}),
      }
    : undefined;
  return {
    enabled: raw.enabled !== false,
    mode,
    routeMode,
    readRoute: nonEmptyString(raw.readRoute) ?? null,
    writeRoute: nonEmptyString(raw.writeRoute) ?? null,
    includeProgressSnapshot: raw.includeProgressSnapshot !== false,
    reuse: 'scope-cwd',
    allowForkFallback: raw.allowForkFallback !== false,
    ...(mixagents && Object.keys(mixagents).length > 0 ? { mixagents } : {}),
  };
}

function normalizeRsi(input: unknown): RsiConfig {
  const raw = isRecord(input) ? input : {};
  const runnerCommand = nonEmptyString(raw.runnerCommand);
  const validatorCommand = nonEmptyString(raw.validatorCommand);
  const runnerArgs = stringArray(raw.runnerArgs);
  const validatorArgs = stringArray(raw.validatorArgs);
  if (
    [runnerCommand, validatorCommand].some(value => value && looksLikeInlineSecret(value)) ||
    [...runnerArgs, ...validatorArgs].some(looksLikeInlineSecret)
  ) {
    throw new Error('rsi command/args must not contain inline credentials; use the trusted project runner environment');
  }
  return {
    mode: raw.mode === 'off' ? 'off' : 'auto',
    projectRoot: nonEmptyString(raw.projectRoot) ?? null,
    reviewerRouteMode: raw.reviewerRouteMode === 'manual' ? 'manual' : 'follow-cc-switch',
    reviewerRoute: nonEmptyString(raw.reviewerRoute) ?? null,
    ...(runnerCommand
      ? { runnerCommand }
      : {}),
    ...(runnerArgs.length > 0
      ? { runnerArgs }
      : {}),
    ...(validatorCommand
      ? { validatorCommand }
      : {}),
    ...(validatorArgs.length > 0
      ? { validatorArgs }
      : {}),
  };
}

function normalizeComments(_input: unknown): CommentConfig {
  return {};
}

function normalizeLarkCli(input: unknown): LarkCliConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { identityPreset: 'bot-only' };
  }
  const raw = input as {
    identityPreset?: unknown;
    localUserImport?: unknown;
  };
  const identityPreset: LarkCliIdentityPreset =
    raw.identityPreset === 'user-default' ? 'user-default' : 'bot-only';
  const localUserImport = normalizeLarkCliUserImport(raw.localUserImport);
  return {
    identityPreset,
    ...(localUserImport ? { localUserImport } : {}),
  };
}

function normalizeLarkCliUserImport(input: unknown): LarkCliConfig['localUserImport'] | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const raw = input as {
    status?: unknown;
    attemptedAt?: unknown;
    importedAt?: unknown;
    reason?: unknown;
  };
  if (!isLarkCliUserImportStatus(raw.status)) return undefined;
  return {
    status: raw.status,
    ...(typeof raw.attemptedAt === 'string' ? { attemptedAt: raw.attemptedAt } : {}),
    ...(typeof raw.importedAt === 'string' ? { importedAt: raw.importedAt } : {}),
    ...(typeof raw.reason === 'string' ? { reason: raw.reason } : {}),
  };
}

function isLarkCliUserImportStatus(value: unknown): value is LarkCliUserImportStatus {
  return (
    value === 'not-needed' ||
    value === 'imported' ||
    value === 'skipped-existing-private-user' ||
    value === 'skipped-no-local-user' ||
    value === 'failed'
  );
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function looksLikeInlineSecret(value: string): boolean {
  return /sk-[A-Za-z0-9_-]{8,}|Bearer\s+\S+|\b(?:api[_-]?key|token|secret|authorization)\s*=\s*\S+/iu.test(value);
}

function credentialReference(value: unknown): string | undefined {
  const text = nonEmptyString(value);
  return text && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(text) ? text : undefined;
}

import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { log } from '../../core/logger';

/**
 * Provider-aware credential injection for Codex children.
 *
 * Codex resolves provider credentials from `$CODEX_HOME/config.toml`
 * (`model_provider` + `[model_providers.<id>]`) and `$CODEX_HOME/auth.json`.
 * A third-party provider that declares `env_key = "OPENAI_API_KEY"` fails with
 * `Missing environment variable: OPENAI_API_KEY` when the inherited value is
 * empty or unset, even though `experimental_bearer_token` is configured. Tools
 * such as `cc-switch` write `export OPENAI_API_KEY="${token:-$OPENAI_API_KEY}"`
 * into shell startup files, so a bridge service or tmux server can start with
 * that variable empty.
 *
 * This module restores the missing credential for third-party providers only:
 * it never touches official providers, so official API keys and ChatGPT OAuth
 * logins keep working exactly as before.
 */

export interface CodexProviderEntry {
  baseUrl?: string;
  envKey?: string;
  bearerToken?: string;
}

export interface CodexConfigSummary {
  modelProvider?: string;
  preferredAuthMethod?: string;
  providers: Map<string, CodexProviderEntry>;
}

export interface CodexCredentialResolution {
  /** Environment variables to add to the Codex child environment. */
  env: NodeJS.ProcessEnv;
  /** Effective provider id; `undefined` means the built-in OpenAI provider. */
  provider?: string;
  /** Environment variable that receives the token. */
  envKey?: string;
  /** Where the injected token came from. */
  source?: 'process-env' | 'config' | 'auth';
  injected: boolean;
  /** Third-party provider was selected but no token could be found. */
  missingToken: boolean;
}

interface CredentialInputs {
  baseEnv: NodeJS.ProcessEnv;
  auth?: Record<string, unknown>;
}

const OFFICIAL_PROVIDER_IDS = new Set(['openai', 'codex']);
const DEFAULT_THIRD_PARTY_ENV_KEY = 'OPENAI_API_KEY';
const OFFICIAL_HOSTS = new Set([
  'api.openai.com',
  'openai.com',
  'chatgpt.com',
  'chat.openai.com',
]);
const INTERESTING_PROVIDER_KEYS = new Set([
  'base_url',
  'env_key',
  'experimental_bearer_token',
]);

export async function resolveCodexCredentialEnv(
  codexHome: string | undefined,
  defaults?: { baseEnv?: NodeJS.ProcessEnv; auth?: Record<string, unknown> },
): Promise<CodexCredentialResolution> {
  const home = codexHome ?? defaultCodexHome();
  if (!home) return emptyResolution();
  const config = parseCodexConfigSummary(await readText(join(home, 'config.toml')) ?? '');
  const auth = defaults?.auth ?? parseJsonObject(await readText(join(home, 'auth.json')));
  return resolveFromConfig(home, config, {
    baseEnv: defaults?.baseEnv ?? process.env,
    ...(auth !== undefined ? { auth } : {}),
  });
}

/**
 * Synchronous twin of {@link resolveCodexCredentialEnv}. Used as a fallback
 * when a caller invokes `run()` without a preceding `prepareRun()`.
 */
export function resolveCodexCredentialEnvSync(
  codexHome: string | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
): CodexCredentialResolution {
  const home = codexHome ?? defaultCodexHome();
  if (!home) return emptyResolution();
  const config = parseCodexConfigSummary(readTextSync(join(home, 'config.toml')) ?? '');
  const auth = parseJsonObject(readTextSync(join(home, 'auth.json')));
  return resolveFromConfig(home, config, {
    baseEnv,
    ...(auth !== undefined ? { auth } : {}),
  });
}

function resolveFromConfig(
  home: string,
  config: CodexConfigSummary,
  inputs: CredentialInputs,
): CodexCredentialResolution {
  const providerId = (config.modelProvider ?? '').trim();
  const provider = providerId ? config.providers.get(providerId) : undefined;

  // Official ChatGPT OAuth logins must keep Codex's own credential store.
  if (config.preferredAuthMethod === 'chatgpt') return emptyResolution(providerId);
  if (!isThirdPartyProvider(providerId, provider)) return emptyResolution(providerId);

  const envKey = (provider?.envKey ?? '').trim() || DEFAULT_THIRD_PARTY_ENV_KEY;
  const inherited = nonEmpty(inputs.baseEnv[envKey]);
  if (inherited) {
    return {
      env: { [envKey]: inherited },
      provider: providerId,
      envKey,
      source: 'process-env',
      injected: false,
      missingToken: false,
    };
  }

  const configToken = nonEmpty(provider?.bearerToken);
  let token = configToken;
  let source: CodexCredentialResolution['source'] = configToken ? 'config' : undefined;
  if (!token) {
    const authToken = inputs.auth
      ? nonEmpty(inputs.auth[envKey]) ?? nonEmpty(inputs.auth.OPENAI_API_KEY)
      : undefined;
    if (authToken) {
      token = authToken;
      source = 'auth';
    }
  }

  if (!token) {
    log.warn('agent', 'codex-credential-missing', {
      provider: providerId,
      envKey,
      codexHome: home,
    });
    return { env: {}, provider: providerId, envKey, injected: false, missingToken: true };
  }

  return {
    env: { [envKey]: token },
    provider: providerId,
    envKey,
    source,
    injected: true,
    missingToken: false,
  };
}

function emptyResolution(provider?: string): CodexCredentialResolution {
  return {
    env: {},
    ...(provider ? { provider } : {}),
    injected: false,
    missingToken: false,
  };
}

/** Merge the resolved credential overrides into a child environment. */
export function applyCodexCredentialEnv(
  resolution: CodexCredentialResolution,
  env: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  for (const [key, value] of Object.entries(resolution.env)) {
    if (value === undefined) continue;
    for (const existing of Object.keys(env)) {
      if (existing.toLowerCase() === key.toLowerCase()) delete env[existing];
    }
    env[key] = value;
  }
  return env;
}

/** `-e KEY=VALUE` pairs for `tmux new-session`. */
export function codexCredentialEnvironmentArgs(env: NodeJS.ProcessEnv): string[] {
  return Object.entries(env).flatMap(([key, value]) =>
    value === undefined ? [] : ['-e', `${key}=${value}`],
  );
}

/** Shell-quoted `KEY=VALUE` pairs that can prefix a command line. */
export function codexCredentialCommandPrefix(env: NodeJS.ProcessEnv): string {
  return Object.entries(env)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${singleQuote(value!)}`)
    .join(' ');
}

export function isThirdPartyProvider(
  providerId: string | undefined,
  provider: CodexProviderEntry | undefined,
): boolean {
  if (!providerId) return false;
  // A declared endpoint decides: an `openai` provider id pointed at a proxy
  // or mirror is still a third-party API path, and a custom provider id can
  // legitimately target the official endpoint.
  if (provider?.baseUrl) return !isOfficialBaseUrl(provider.baseUrl);
  if (OFFICIAL_PROVIDER_IDS.has(providerId.toLowerCase())) return false;
  // A custom provider id without an explicit base_url still relies on a
  // vendor endpoint; treat it as third-party so its env_key can be restored.
  return true;
}

export function isOfficialBaseUrl(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return [...OFFICIAL_HOSTS].some((official) => host === official || host.endsWith(`.${official}`));
  } catch {
    return false;
  }
}

export function defaultCodexHome(env: NodeJS.ProcessEnv = process.env, home = homedir()): string | undefined {
  const configured = nonEmpty(env.CODEX_HOME);
  if (configured) return isAbsolute(configured) ? configured : join(home, configured);
  return home ? join(home, '.codex') : undefined;
}

export async function readCodexConfigSummary(configPath: string): Promise<CodexConfigSummary> {
  try {
    return parseCodexConfigSummary(await readFile(configPath, 'utf8'));
  } catch {
    return { providers: new Map() };
  }
}

export function parseCodexConfigSummary(raw: string): CodexConfigSummary {
  const topLevel = new Map<string, string>();
  const profiles = new Map<string, Map<string, string>>();
  const providers = new Map<string, CodexProviderEntry>();
  let section = '';
  let profileName = '';
  let providerName = '';
  let providerEntry: CodexProviderEntry | undefined;

  const finishProvider = (): void => {
    if (providerName && providerEntry) providers.set(providerName, providerEntry);
    providerName = '';
    providerEntry = undefined;
  };

  for (const rawLine of raw.split(/\r?\n/u)) {
    const line = stripComment(rawLine).trim();
    if (!line) continue;

    const header = /^\[\s*([^\]]+?)\s*\]$/u.exec(line);
    if (header) {
      finishProvider();
      section = header[1]!.trim();
      profileName = /^profiles\.["']?(.+?)["']?$/u.exec(section)?.[1] ?? '';
      const providerHeader = /^model_providers\.(?:["'](.+?)["']|([^\s"']+))$/u.exec(section);
      providerName = providerHeader ? providerHeader[1] ?? providerHeader[2] ?? '' : '';
      providerEntry = providerName ? {} : undefined;
      continue;
    }

    const assignment = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/u.exec(line);
    if (!assignment) continue;
    const key = assignment[1]!;
    const value = parseTomlScalar(assignment[2]!);
    if (value === undefined) continue;

    if (providerName && providerEntry) {
      if (!INTERESTING_PROVIDER_KEYS.has(key)) continue;
      if (key === 'base_url') providerEntry.baseUrl = value;
      else if (key === 'env_key') providerEntry.envKey = value;
      else providerEntry.bearerToken = value;
      continue;
    }
    if (profileName) {
      const profile = profiles.get(profileName) ?? new Map<string, string>();
      profile.set(key, value);
      profiles.set(profileName, profile);
      continue;
    }
    topLevel.set(key, value);
  }
  finishProvider();

  const selectedProfile = nonEmpty(topLevel.get('profile'));
  const profile = selectedProfile ? profiles.get(selectedProfile) : undefined;
  return {
    modelProvider: profile?.get('model_provider') ?? topLevel.get('model_provider'),
    preferredAuthMethod:
      topLevel.get('preferred_auth_method') ?? profile?.get('preferred_auth_method'),
    providers,
  };
}

function readTextSync(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

function parseJsonObject(raw: string | undefined): Record<string, unknown> | undefined {
  if (raw === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function stripComment(line: string): string {
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (quote) {
      if (char === '\\' && quote === '"') index += 1;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '#') return line.slice(0, index);
  }
  return line;
}

function parseTomlScalar(rawValue: string): string | undefined {
  const value = rawValue.trim();
  if (!value) return undefined;
  if (value.startsWith('"')) {
    const end = value.indexOf('"', 1);
    if (end < 0) return undefined;
    return unescapeBasicString(value.slice(1, end));
  }
  if (value.startsWith("'")) {
    const end = value.indexOf("'", 1);
    if (end < 0) return undefined;
    return value.slice(1, end);
  }
  return undefined;
}

function unescapeBasicString(value: string): string {
  return value.replace(/\\(u[0-9A-Fa-f]{4}|.)/gu, (_match, escape: string) => {
    switch (escape) {
      case 'n': return '\n';
      case 't': return '\t';
      case 'r': return '\r';
      case '"': return '"';
      case '\\': return '\\';
      default:
        if (escape.startsWith('u')) {
          const code = Number.parseInt(escape.slice(1), 16);
          return Number.isNaN(code) ? escape : String.fromCodePoint(code);
        }
        return escape;
    }
  });
}

function singleQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

function nonEmpty(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

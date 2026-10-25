import { join } from 'node:path';
import {
  defaultCodexHome,
  isThirdPartyProvider,
  parseCodexConfigSummary,
  readCodexConfigSummary,
  type CodexConfigSummary,
} from './credentials';
import { readFileSync } from 'node:fs';
import { log } from '../../core/logger';

/**
 * Which model provider the active Codex configuration targets, and whether it
 * is an OpenAI-hosted endpoint. The network policy uses this before spawning:
 * a third-party endpoint must not silently inherit a local clash/relay proxy.
 */
export interface CodexProviderSummary {
  providerId?: string;
  /** True for `openai`/`codex` ids and for official base URLs. */
  official: boolean;
  preferredAuthMethod?: string;
}

/**
 * Provider/model pair used only to recover a resume that failed because the
 * thread still references a provider id that no longer exists in the current
 * `config.toml`.
 */
export interface CodexResumeDefaults {
  modelProvider: string;
  model?: string;
}

export interface CodexActiveConfigIdentity {
  codexProviderId: string;
  model?: string;
  official: boolean;
  preferredAuthMethod?: string;
}

export function providerSummaryFromConfig(config: CodexConfigSummary): CodexProviderSummary {
  const providerId = (config.modelProvider ?? '').trim() || undefined;
  const provider = providerId ? config.providers.get(providerId) : undefined;
  const summary: CodexProviderSummary = {
    official: !isThirdPartyProvider(providerId, provider),
    ...(config.preferredAuthMethod ? { preferredAuthMethod: config.preferredAuthMethod } : {}),
  };
  if (providerId) summary.providerId = providerId;
  return summary;
}

export async function resolveCodexProvider(
  codexHome: string | undefined,
): Promise<CodexProviderSummary> {
  const home = codexHome ?? defaultCodexHome();
  if (!home) return { official: true };
  return providerSummaryFromConfig(await readCodexConfigSummary(join(home, 'config.toml')));
}

export async function resolveCodexActiveConfigIdentity(
  codexHome: string | undefined,
): Promise<CodexActiveConfigIdentity | undefined> {
  const home = codexHome ?? defaultCodexHome();
  if (!home) return undefined;
  try {
    const config = await readCodexConfigSummary(join(home, 'config.toml'));
    const provider = providerSummaryFromConfig(config);
    return {
      codexProviderId: provider.providerId ?? 'openai',
      ...(config.model?.trim() ? { model: config.model.trim() } : {}),
      official: provider.official,
      ...(provider.preferredAuthMethod
        ? { preferredAuthMethod: provider.preferredAuthMethod }
        : {}),
    };
  } catch {
    return undefined;
  }
}

/** Synchronous twin for callers that resolve credentials lazily. */
export function resolveCodexProviderSync(codexHome: string | undefined): CodexProviderSummary {
  const home = codexHome ?? defaultCodexHome();
  if (!home) return { official: true };
  try {
    return providerSummaryFromConfig(
      parseCodexConfigSummary(readFileSync(join(home, 'config.toml'), 'utf8')),
    );
  } catch {
    return { official: true };
  }
}

/**
 * Resolve the provider/model to use when rebinding an old thread.
 *
 * This deliberately does **not** fall back to the bridge process's Codex home:
 * the App Server can run with a different `$CODEX_HOME` (profile-local or
 * multiple homes), and guessing would silently bind the thread to the wrong
 * provider. Callers pass the home reported by `initialize`, or a home seeded
 * from the App Server's spawn environment. `undefined` means "do not rebind".
 */
export function resolveCodexResumeDefaults(
  codexHome: string | undefined,
): CodexResumeDefaults | undefined {
  if (!codexHome) {
    log.warn('agent', 'codex-resume-defaults-unavailable', { reason: 'no-home' });
    return undefined;
  }
  let raw: string;
  try {
    raw = readFileSync(join(codexHome, 'config.toml'), 'utf8');
  } catch {
    log.warn('agent', 'codex-resume-defaults-unavailable', {
      reason: 'unreadable',
      codexHome,
    });
    return undefined;
  }
  const config = parseCodexConfigSummary(raw);
  // A readable config without `model_provider` means Codex's built-in
  // provider, which is the one the server itself will use.
  const modelProvider = (config.modelProvider ?? '').trim() || 'openai';
  const model = (config.model ?? '').trim() || undefined;
  return { modelProvider, ...(model ? { model } : {}) };
}

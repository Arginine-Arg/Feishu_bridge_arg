import { join } from 'node:path';
import {
  defaultCodexHome,
  isThirdPartyProvider,
  parseCodexConfigSummary,
  readCodexConfigSummary,
  type CodexConfigSummary,
} from './credentials';
import { readFileSync } from 'node:fs';

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

export interface CodexResumeDefaults {
  modelProvider: string;
  model?: string;
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
 * The provider/model pair a thread should use when it is resumed under the
 * current Codex configuration.
 *
 * Codex persists the provider id in each thread. App Server tries to resolve
 * that historical id before it can apply the current config, so a thread that
 * was created under `deepseek` fails to resume after `cc-switch` switches to
 * the stable third-party id `custom`. `thread/resume` accepts `modelProvider`
 * and `model` overrides; supplying both keeps the existing history while
 * rebinding subsequent turns to the active provider.
 */
export function resolveCodexResumeDefaults(
  codexHome: string | undefined,
): CodexResumeDefaults {
  const home = codexHome ?? defaultCodexHome();
  if (!home) return { modelProvider: 'openai' };
  try {
    const config = parseCodexConfigSummary(readFileSync(join(home, 'config.toml'), 'utf8'));
    const modelProvider = (config.modelProvider ?? '').trim() || 'openai';
    const model = (config.model ?? '').trim() || undefined;
    return { modelProvider, ...(model ? { model } : {}) };
  } catch {
    return { modelProvider: 'openai' };
  }
}

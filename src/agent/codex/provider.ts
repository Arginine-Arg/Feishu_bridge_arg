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

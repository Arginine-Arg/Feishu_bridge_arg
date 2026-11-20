import type { AgentKind } from '../config/profile-schema';
import { readCcSwitchProviderCatalog, resolveCurrentCcSwitchCodexProvider } from '../integrations/cc-switch-provider';
import { readMagpieProviderCatalog } from '../integrations/magpie-provider';
import { discoverProviderModels } from '../integrations/provider-models';
import { DEFAULT_MODEL, supportedModels, type ModelOption } from './models';

export type ModelSource = 'default' | 'cc-switch' | 'magpie' | 'magpie-router';

export interface CatalogModelOption extends ModelOption {
  source: ModelSource;
}

export interface ModelCatalog {
  options: CatalogModelOption[];
  notices: string[];
}

const SOURCE_LABEL: Record<Exclude<ModelSource, 'default'>, string> = {
  'cc-switch': 'cc-switch',
  magpie: 'Magpie',
  'magpie-router': 'Magpie 路由',
};

/**
 * Build the model picker from every configured source.
 *
 * cc-switch and Magpie are best-effort: a broken source contributes a notice
 * instead of hiding the rest of the catalog. Values are the exact strings the
 * agent receives, so Magpie entries keep their `provider/model` or
 * `group/<router>` form.
 */
export async function buildModelCatalog(
  agentKind: AgentKind,
  env: NodeJS.ProcessEnv = process.env,
  options: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<ModelCatalog> {
  const defaults: CatalogModelOption[] = supportedModels(agentKind).map(option => ({
    ...option,
    source: 'default',
  }));
  if (agentKind !== 'codex') return { options: defaults, notices: [] };

  const notices: string[] = [];
  const seen = new Set(defaults.map(option => option.value));
  const add = (option: CatalogModelOption): void => {
    if (seen.has(option.value)) return;
    seen.add(option.value);
    defaults.push(option);
  };
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 4_000);

  const [ccSwitch, magpie] = await Promise.all([
    readCcSwitchProviderCatalog(env).catch(error => {
      notices.push(`cc-switch 模型目录不可读：${message(error)}`);
      return undefined;
    }),
    readMagpieProviderCatalog(env, { ...(options.fetch ? { fetch: options.fetch } : {}) }).catch(error => {
      notices.push(`Magpie 模型目录不可读：${message(error)}`);
      return undefined;
    }),
  ]);

  // Magpie first: cc-switch entries that already point at the Magpie gateway
  // expose the same `provider/model` slugs, and the Magpie label is clearer.
  if (magpie) {
    for (const provider of magpie.providers) {
      const source: ModelSource = provider.router ? 'magpie-router' : 'magpie';
      for (const model of provider.models) {
        add({
          value: model,
          label: provider.router
            ? `[${SOURCE_LABEL[source]}] ${provider.name} · ${model.slice('group/'.length)}`
            : `[${SOURCE_LABEL[source]}] ${provider.name} · ${model.slice(provider.id.length + 1)}`,
          source,
        });
      }
    }
    if (magpie.error) notices.push(magpie.error);
  }

  if (ccSwitch) {
    const discovered = await Promise.all(ccSwitch.providers.map(async provider => {
      try {
        const resolved = await resolveCurrentCcSwitchCodexProvider({ env, providerId: provider.id });
        return { provider, catalog: await discoverProviderModels(resolved, { env, signal: timeout }) };
      } catch (error) {
        return { provider, error };
      }
    }));
    for (const item of discovered) {
      if ('error' in item) {
        notices.push(`cc-switch ${item.provider.name} 模型不可读：${message(item.error)}`);
        continue;
      }
      for (const model of item.catalog.models) {
        add({
          value: model,
          label: `[cc-switch] ${item.provider.name} · ${model}`,
          source: 'cc-switch',
        });
      }
    }
  }

  return { options: defaults, notices };
}

export function catalogHasValue(catalog: ModelCatalog, value: string): boolean {
  return value === DEFAULT_MODEL || catalog.options.some(option => option.value === value);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

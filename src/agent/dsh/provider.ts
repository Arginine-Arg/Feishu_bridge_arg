import type { DshConfig } from '../../config/profile-schema';
import { resolveCurrentCcSwitchCodexProvider, resolveDshWireApi } from '../../integrations/cc-switch-provider';
import { discoverMagpieModels, resolveMagpieProvider } from '../../integrations/magpie-provider';
import { discoverProviderModels } from '../../integrations/provider-models';

const ROUTE = 'arg-bridge-cc-switch';
const KEY_ENV = 'ARG_BRIDGE_DSH_PROVIDER_KEY';

export async function resolveDshProvider(
  config: DshConfig,
  env: NodeJS.ProcessEnv,
  refreshModels = false,
) {
  const provider = config.providerSource === 'magpie'
    ? await resolveMagpieProvider({
        env,
        ...(config.magpieProviderId ? { providerId: config.magpieProviderId } : {}),
      })
    : await resolveCurrentCcSwitchCodexProvider({
        env,
        providerId: config.ccSwitchProviderId,
      });
  const { summary, credentials } = provider;
  const key = summary.envKey ? credentials[summary.envKey] : undefined;
  if (!key || summary.credential.status !== 'present') {
    throw new Error(`provider ${summary.id} 需要为 DeepSeek Harness 配置 API Key。`);
  }
  const endpoint = new URL(summary.baseUrl);
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('provider 的 API 地址格式无效');
  }
  const api = resolveDshWireApi(summary, config.api);
  if (!api) throw new Error(`未知的 API 协议 ${summary.wireApi}，请为 dsh.api 指定协议。`);
  const headerEnv: Record<string, string> = {};
  const headerRefs: Record<string, string> = {};
  for (const [name, variable] of Object.entries(summary.envHttpHeaders)) {
    const value = credentials[variable] ?? env[variable];
    if (!value) throw new Error(`provider ${summary.id} 缺少请求头 ${name} 的配置。`);
    const ref = `ARG_BRIDGE_DSH_HEADER_${Object.keys(headerRefs).length}`;
    headerRefs[name] = ref;
    headerEnv[ref] = value;
  }
  const catalogue = refreshModels
    ? config.providerSource === 'magpie'
      ? { models: await discoverMagpieModels(summary.id, env).catch(() => []) }
      : await discoverProviderModels(provider, { env }).catch(() => undefined)
    : undefined;
  return {
    id: summary.id,
    name: summary.name,
    baseURL: endpoint.href.replace(/\/+$/u, ''),
    api,
    model: summary.model,
    models: [...new Set([summary.model, ...(catalogue?.models ?? summary.configuredModels ?? [])])],
    contextWindow: summary.contextWindow,
    route: ROUTE,
    keyEnv: KEY_ENV,
    headerRefs,
    env: { [KEY_ENV]: key, ...headerEnv },
    thirdParty: summary.thirdParty,
  };
}

export type DshProvider = Awaited<ReturnType<typeof resolveDshProvider>>;

export function dshProfilePatch(provider: DshProvider, model: string, previousModel?: string): string {
  const route = {
    api: provider.api,
    baseURL: provider.baseURL,
    apiKeyEnv: provider.keyEnv,
    displayName: provider.name,
    models: [...new Set([model, ...(previousModel ? [previousModel] : [])])].map(id => ({
      id, ...(provider.contextWindow ? { contextWindow: provider.contextWindow } : {}),
    })),
  };
  // Cordis evaluates this config expression at boot. The patch includes names
  // of environment variables only, including for credential-bearing headers.
  const providers = `({providers:{[${JSON.stringify(provider.route)}]:{` +
    `... ${JSON.stringify(route)}, headers: Object.fromEntries(Object.entries(` +
    `${JSON.stringify(provider.headerRefs)}).map(([name, ref]) => [name, process.env[ref]]))}}})`;
  const selection = { provider: provider.route, model };
  return [
    '- id: llm-pi-ai',
    `  config: !!js ${JSON.stringify(providers)}`,
    `- id: acp\n  config: ${JSON.stringify(selection)}`,
    `- id: agent-default-model\n  config: ${JSON.stringify(selection)}`,
    '',
  ].join('\n');
}

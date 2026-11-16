import type { ResolvedCcSwitchProvider } from './cc-switch-provider';
import { validSubagentModel } from '../config/profile-schema';

export interface ProviderModels {
  models: string[];
  source: 'api' | 'local-config';
  checkedAt: number;
  notice?: string;
}

/** Authenticated catalogue only. This sends no chat/completion request. */
export async function discoverProviderModels(
  provider: ResolvedCcSwitchProvider,
  options: { signal?: AbortSignal; env?: NodeJS.ProcessEnv; fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<ProviderModels> {
  const { summary, credentials } = provider;
  const env = options.env ?? process.env;
  const url = new URL(summary.baseUrl.replace(/\/+$/u, '') + '/models');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Provider 模型列表 URL 无效');
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (summary.envKey) {
    const key = credentials[summary.envKey] ?? env[summary.envKey];
    if (key) headers.Authorization = `Bearer ${key}`;
  }
  for (const [name, variable] of Object.entries(summary.envHttpHeaders)) {
    const value = credentials[variable] ?? env[variable];
    if (value) headers[name] = value;
  }
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 10_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const response = await (options.fetch ?? fetch)(url, { headers, signal, redirect: 'error' });
  if (response.status === 404 || response.status === 405) {
    await response.body?.cancel();
    return { models: summary.configuredModels ?? [summary.model], source: 'local-config', checkedAt: Date.now(),
      notice: '此 provider 未提供模型目录，显示 cc-switch 已配置模型；尚未验证推理可用性。' };
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Provider 模型目录返回 HTTP ${response.status}`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Provider 模型目录为空');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 1024 * 1024) throw new Error('Provider 模型目录超过 1 MiB');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  let parsed: any;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('Provider 模型目录不是有效 JSON'); }
  const data = parsed.data ?? parsed.models;
  if (!Array.isArray(data)) throw new Error('Provider 模型目录缺少模型列表');
  const models = [...new Set(data.map((item: any) => typeof item === 'string' ? item : item?.id ?? item?.name).filter(validSubagentModel))] as string[];
  if (!models.length) throw new Error('Provider 没有返回可选择的模型');
  return { models, source: 'api', checkedAt: Date.now() };
}

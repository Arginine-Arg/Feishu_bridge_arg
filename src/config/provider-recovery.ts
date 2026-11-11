export interface ProviderRecoveryConfig {
  enabled: boolean;
  /** cc-switch provider IDs or Codex model_provider IDs; empty means all. */
  providers: string[];
  maxAttempts: number;
  delaySeconds: number;
  maxDelaySeconds: number;
  /** Maximum silence after an explicit provider-retry notification; 0 disables preemption. */
  retryStallSeconds: number;
}

export function normalizeProviderRecovery(value?: Partial<ProviderRecoveryConfig>): ProviderRecoveryConfig {
  const bounded = (n: unknown, fallback: number, min: number, max: number): number =>
    typeof n === 'number' && Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : fallback;
  return {
    enabled: value?.enabled !== false,
    providers: Array.isArray(value?.providers) ? [...new Set(value.providers.filter((id): id is string => typeof id === 'string' && !!id.trim()).map(id => id.trim()))] : [],
    maxAttempts: bounded(value?.maxAttempts, 3, 0, 5),
    delaySeconds: bounded(value?.delaySeconds, 30, 5, 600),
    maxDelaySeconds: bounded(value?.maxDelaySeconds, 120, 5, 900),
    retryStallSeconds: value?.retryStallSeconds === 0 ? 0 : bounded(value?.retryStallSeconds, 60, 15, 600),
  };
}

/** API failures only. Tool failures and ambiguous transport losses cannot
 * safely be treated as evidence that a turn ended. */
export function isTransientProviderError(error: { codexErrorInfo?: unknown; message?: string } | undefined): boolean {
  if (!error) return false;
  const info = error.codexErrorInfo;
  const kind = typeof info === 'string' ? info : info && typeof info === 'object' ? Object.keys(info)[0] : undefined;
  const detail = info && typeof info === 'object' && kind ? (info as Record<string, unknown>)[kind] : undefined;
  const status = detail && typeof detail === 'object' ? (detail as { httpStatusCode?: number }).httpStatusCode : undefined;
  if (status && status >= 400 && status < 500 && ![408, 429].includes(status)) return false;
  if (kind && ['rateLimitExceeded', 'serverOverloaded', 'internalServerError', 'flexUnavailable',
    'httpConnectionFailed', 'responseStreamConnectionFailed', 'responseStreamDisconnected', 'responseTooManyFailedAttempts'].includes(kind)) return true;
  if (kind && kind !== 'other') return false;
  const text = error.message ?? '';
  if (/unauthori[sz]ed|forbidden|api.?key|insufficient.quota|usage.limit|billing|context.window|budget|permission|sandbox/i.test(text)) return false;
  return /\b(?:429|500|502|503|504)\b|stream disconnected|connection reset|ECONNRESET|ETIMEDOUT|reconnect(?:ion|ing).*\d|temporarily unavailable|server overloaded/i.test(text);
}

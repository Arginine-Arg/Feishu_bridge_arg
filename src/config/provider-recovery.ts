export interface ProviderRecoveryConfig {
  version: 2;
  enabled: boolean;
  /** Legacy field. Recovery is always bounded by budgetSeconds. */
  continuous: boolean;
  /** cc-switch provider IDs or Codex model_provider IDs; empty means all. */
  providers: string[];
  maxAttempts: number;
  delaySeconds: number;
  maxDelaySeconds: number;
  /** State-check interval after explicit provider retry; never interrupts. 0 disables checks. */
  retryStallSeconds: number;
  /** No-progress monitor for a visible Working turn. It only reports and never interrupts. */
  workingStallSeconds: number;
  budgetSeconds: number;
  jitterRatio: number;
  maxStatusChecks: number;
  statusTimeoutSeconds: number;
}

export const PROVIDER_RECOVERY_DEFAULTS = Object.freeze({
  budgetSeconds: 3600, delaySeconds: 30, maxDelaySeconds: 120,
  retryStallSeconds: 60, workingStallSeconds: 300, jitterRatio: 0.2, maxStatusChecks: 8,
  statusTimeoutSeconds: 10,
});

export function normalizeProviderRecovery(value?: Partial<ProviderRecoveryConfig>): ProviderRecoveryConfig {
  const bounded = (n: unknown, fallback: number, min: number, max: number): number =>
    typeof n === 'number' && Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : fallback;
  const current = value?.version === 2;
  return {
    version: 2,
    enabled: value?.enabled !== false,
    providers: Array.isArray(value?.providers) ? [...new Set(value.providers.filter((id): id is string => typeof id === 'string' && !!id.trim()).map(id => id.trim()))] : [],
    // 1.21.x wrote continuous=true/maxAttempts=0 as defaults, not consent to
    // unbounded submissions. Only versioned settings can opt into new limits.
    continuous: false,
    maxAttempts: bounded(current ? value?.maxAttempts : undefined, 0, 0, 1000),
    delaySeconds: bounded(current ? value?.delaySeconds : undefined, PROVIDER_RECOVERY_DEFAULTS.delaySeconds, 5, 600),
    maxDelaySeconds: bounded(value?.maxDelaySeconds, PROVIDER_RECOVERY_DEFAULTS.maxDelaySeconds, 5, 900),
    retryStallSeconds: value?.retryStallSeconds === 0 ? 0 : bounded(current ? value?.retryStallSeconds : undefined, PROVIDER_RECOVERY_DEFAULTS.retryStallSeconds, 30, 600),
    workingStallSeconds: bounded(current ? value?.workingStallSeconds : undefined, PROVIDER_RECOVERY_DEFAULTS.workingStallSeconds, 60, 3600),
    budgetSeconds: bounded(value?.budgetSeconds, PROVIDER_RECOVERY_DEFAULTS.budgetSeconds, 60, 86400),
    jitterRatio: typeof value?.jitterRatio === 'number' && Number.isFinite(value.jitterRatio) ? Math.max(0, Math.min(0.5, value.jitterRatio)) : PROVIDER_RECOVERY_DEFAULTS.jitterRatio,
    maxStatusChecks: bounded(value?.maxStatusChecks, PROVIDER_RECOVERY_DEFAULTS.maxStatusChecks, 0, 20),
    statusTimeoutSeconds: bounded(value?.statusTimeoutSeconds, PROVIDER_RECOVERY_DEFAULTS.statusTimeoutSeconds, 1, 60),
  };
}

/** Retry-After seconds/date, if actually supplied by the authoritative error. */
export function providerRetryAfterMs(error: Record<string, any> | undefined, now = Date.now()): number {
  if (!error) return 0;
  const detail = error.codexErrorInfo && typeof error.codexErrorInfo === 'object'
    ? Object.values(error.codexErrorInfo)[0] as Record<string, any> | undefined : undefined;
  const seconds = error.retryAfterSeconds ?? detail?.retryAfterSeconds;
  if (typeof seconds === 'number' && Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const value = error.retryAfter ?? error.headers?.['retry-after'] ?? detail?.headers?.['retry-after'];
  if (typeof value !== 'string' && typeof value !== 'number') return 0;
  const n = Number(value);
  if (Number.isFinite(n)) return Math.max(0, n * 1000);
  const time = Date.parse(String(value));
  return Number.isFinite(time) ? Math.max(0, time - now) : 0;
}

export function providerRecoveryDelayMs(policy: ProviderRecoveryConfig, attempt: number, error?: Record<string, any>, now = Date.now(), random = Math.random): number {
  const base = Math.min(policy.maxDelaySeconds, policy.delaySeconds * 2 ** Math.min(20, Math.max(0, attempt - 1))) * 1000;
  const jittered = base * (1 + policy.jitterRatio * (random() * 2 - 1));
  return Math.max(Math.round(jittered), providerRetryAfterMs(error, now));
}

/** API failures only. Tool failures and ambiguous transport losses cannot
 * safely be treated as evidence that a turn ended. */
export function isTransientProviderError(error: { codexErrorInfo?: unknown; message?: string } | undefined): boolean {
  if (!error) return false;
  const text = error.message ?? '';
  if (/unauthori[sz]ed|forbidden|api.?key|quota|usage.limit|billing|balance|credit|insufficient|context.window|context.length|token.limit|budget|permission|sandbox|余额|额度|鉴权|上下文.*(?:超|限)/i.test(text)) return false;
  const info = error.codexErrorInfo;
  const kind = typeof info === 'string' ? info : info && typeof info === 'object' ? Object.keys(info)[0] : undefined;
  const detail = info && typeof info === 'object' && kind ? (info as Record<string, unknown>)[kind] : undefined;
  const status = detail && typeof detail === 'object' ? (detail as { httpStatusCode?: number }).httpStatusCode : undefined;
  if (status && status >= 400 && status < 500 && ![408, 429].includes(status)) return false;
  if (kind && ['rateLimitExceeded', 'serverOverloaded', 'internalServerError', 'flexUnavailable',
    'httpConnectionFailed', 'responseStreamConnectionFailed', 'responseStreamDisconnected', 'responseTooManyFailedAttempts'].includes(kind)) return true;
  if (kind && kind !== 'other') return false;
  return /\b(?:408|429|500|502|503|504)\b|stream disconnected|connection reset|ECONNRESET|ETIMEDOUT|reconnect(?:ion|ing).*\d|waiting for network|network error|error decoding response body|temporarily unavailable|server overloaded/i.test(text);
}

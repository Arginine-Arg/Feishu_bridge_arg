import type { CodexSandboxMode } from '../../config/permissions';
import { resolveCodexResumeDefaults } from '../codex/provider';
import { log } from '../../core/logger';
import type { RpcClient, Wire } from './rpc';

export type CodexApprovalPolicy = 'never' | 'on-request';

export interface CodexPermissionCliOptions {
  yolo?: boolean;
  dangerouslyBypassApprovalsAndSandbox?: boolean;
  sandbox?: string;
  askForApproval?: string;
}

export interface CodexPermissionSettings {
  sandbox: CodexSandboxMode;
  approvalPolicy: CodexApprovalPolicy;
  explicit: boolean;
}

export interface CodexResumeOptions {
  /**
   * Reattach/cold-resume must keep the provider and model recorded by the
   * thread. Explicit caller fields still win; this only disables automatic
   * config-derived switching.
   */
  preserveProviderModel?: boolean;
}

/**
 * Parse native CLI permission aliases once so a new local TUI, a Bridge-owned
 * thread and a resumed remote TUI all use the same model. `--yolo` is the
 * legacy alias for Codex's long bypass flag.
 */
export function resolveCodexPermissionSettings(
  profileSandbox: CodexSandboxMode,
  options: CodexPermissionCliOptions,
): CodexPermissionSettings {
  const bypass = Boolean(options.yolo || options.dangerouslyBypassApprovalsAndSandbox);
  const explicit = bypass || options.sandbox !== undefined || options.askForApproval !== undefined;
  if (options.sandbox !== undefined && !isCodexSandboxMode(options.sandbox)) {
    throw new Error(`Invalid --sandbox value: ${options.sandbox}`);
  }
  if (options.askForApproval !== undefined && !isCodexApprovalPolicy(options.askForApproval)) {
    throw new Error(`Invalid --ask-for-approval value: ${options.askForApproval}`);
  }
  if (bypass && options.sandbox !== undefined && options.sandbox !== 'danger-full-access') {
    throw new Error('--yolo/--dangerously-bypass-approvals-and-sandbox cannot be combined with a lower --sandbox');
  }
  const sandbox = bypass ? 'danger-full-access' : options.sandbox ?? profileSandbox;
  const approvalPolicy = bypass ? 'never' : options.askForApproval ?? 'never';
  return { sandbox, approvalPolicy, explicit };
}

/**
 * The terminal backend has always used Codex's non-interactive permission
 * contract: the selected sandbox is authoritative and approval prompts are
 * disabled.  Keep the structured backend identical.  App Server uses the
 * legacy kebab-case sandbox value on thread start/resume and the structured
 * policy object on turn/start.
 */
export function codexThreadPermissionOverrides(
  sandbox: CodexSandboxMode | undefined,
  approvalPolicy: CodexApprovalPolicy = 'never',
): { sandbox?: CodexSandboxMode; approvalPolicy?: CodexApprovalPolicy } {
  return sandbox ? { sandbox, approvalPolicy } : {};
}

export function codexTurnPermissionOverrides(
  sandbox: CodexSandboxMode | undefined,
  cwd: string | undefined,
  approvalPolicy: CodexApprovalPolicy = 'never',
): { sandboxPolicy?: Record<string, unknown>; approvalPolicy?: CodexApprovalPolicy } {
  if (!sandbox) return {};
  switch (sandbox) {
    case 'danger-full-access':
      return { sandboxPolicy: { type: 'dangerFullAccess' }, approvalPolicy };
    case 'workspace-write':
      return {
        sandboxPolicy: {
          type: 'workspaceWrite',
          ...(cwd ? { writableRoots: [cwd] } : {}),
        },
        approvalPolicy,
      };
    case 'read-only':
      return { sandboxPolicy: { type: 'readOnly' }, approvalPolicy };
  }
}

/**
 * Build permission flags for a brand-new local Codex TUI. These flags are
 * only valid when the CLI owns the session it starts; they must never be
 * appended to `--remote ... resume`.
 */
export function codexRemotePermissionArgs(
  sandbox: CodexSandboxMode | undefined,
  approvalPolicy: CodexApprovalPolicy = 'never',
): string[] {
  if (!sandbox) return [];
  if (sandbox === 'danger-full-access' && approvalPolicy === 'never') {
    return ['--dangerously-bypass-approvals-and-sandbox'];
  }
  return ['--sandbox', sandbox, '--ask-for-approval', approvalPolicy];
}

/**
 * Build argv for attaching a TUI to an existing App Server task.
 *
 * Codex CLI 0.154.0 introduced a hard security rule: resuming a task that is
 * owned by a remote App Server rejects any permission override on the CLI
 * (`--dangerously-bypass-approvals-and-sandbox`, `--sandbox`,
 * `--ask-for-approval`). The task's frozen permissions are authoritative.
 * Passing the old flags made the TUI exit during bootstrap with
 * "Permission overrides are not supported when resuming a remote task".
 */
export function codexRemoteResumeArgs(endpoint: string, threadId: string): string[] {
  return [
    '-c', 'check_for_update_on_startup=false',
    '--remote', endpoint,
    'resume', threadId,
    '--no-alt-screen',
  ];
}

/**
 * True for the deterministic rejection above. The App Server rejected the
 * request before applying it, so retrying once without the override cannot
 * duplicate a mutation.
 */
export function isRemotePermissionOverrideError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /permission overrides are not supported/i.test(message);
}

function isCodexSandboxMode(value: string): value is CodexSandboxMode {
  return value === 'read-only' || value === 'workspace-write' || value === 'danger-full-access';
}

function isCodexApprovalPolicy(value: string): value is CodexApprovalPolicy {
  return value === 'never' || value === 'on-request';
}

const REMOTE_RESUME_PERMISSION_KEYS = new Set([
  'sandbox',
  'sandboxPolicy',
  'approvalPolicy',
  'approvalsReviewer',
  'permissions',
  'dangerouslyBypassApprovalsAndSandbox',
  'dangerously_bypass_approvals_and_sandbox',
  'yolo',
]);

/**
 * Codex freezes permissions when a thread is created. `thread/resume` must
 * inherit those permissions, even when a caller accidentally merges a CLI
 * permission override into the resume params or retry defaults.
 */
export function stripCodexPermissionOverrides(params: Wire): Wire {
  return Object.fromEntries(
    Object.entries(params).filter(([key]) => !REMOTE_RESUME_PERMISSION_KEYS.has(key)),
  );
}

/**
 * Release the caller's writer subscription without stopping the App Server.
 * `thread/unsubscribe` is what lets a later native TUI resume the same thread;
 * closing the WebSocket alone may leave the server-side writer held.
 */
export async function releaseCodexThreadWriter(
  rpc: RpcClient,
  threadId: string | undefined,
): Promise<void> {
  if (!threadId || rpc.closed) return;
  await rpc.request('thread/unsubscribe', { threadId }, 10_000).catch(() => {
    // The TUI may already have released it; never turn cleanup into a task
    // interruption.
  });
}

/**
 * True only for the deterministic "the thread persists a provider id that the
 * current config no longer defines" failure. The server rejects the resume
 * before loading the thread, so a single retry with the current config cannot
 * duplicate a turn or rewrite history.
 */
export function isModelProviderMissingError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /model provider\s+.*?\s+not found/i.test(message);
}

/**
 * Resume a thread while applying local permission policy when the server
 * still allows it. Newer servers reject overrides for remote-owned tasks;
 * in that case attach with the task's frozen permissions instead of failing.
 */
export async function resumeCodexThread(
  rpc: RpcClient,
  params: Wire,
  overrides: Wire,
  timeoutMs = 30_000,
  options: CodexResumeOptions = {},
): Promise<Wire> {
  const boundaryDefaults = options.preserveProviderModel
    ? undefined
    : await providerDefaultsAtIdleBoundary(rpc, params);
  // Explicit caller params remain authoritative. Configuration defaults are
  // applied only when the read-only thread snapshot proves the previous turn
  // is idle, so a running request is never switched to another provider.
  let effectiveParams: Wire = stripCodexPermissionOverrides({
    ...(boundaryDefaults ?? {}),
    ...params,
  });
  let safeOverrides = stripCodexPermissionOverrides(overrides);
  let includeOverrides = Object.keys(safeOverrides).length > 0;
  let permissionRetried = false;
  let providerRetried = false;
  let lastError: unknown;

  // Apply the current cc-switch provider/model at an idle resume boundary.
  // If the thread snapshot is unavailable, preserve the legacy deterministic
  // retry: rebind only after the server proves the historical provider is
  // gone.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const request = includeOverrides
      ? { ...effectiveParams, ...safeOverrides }
      : effectiveParams;
    try {
      return await rpc.request('thread/resume', request, timeoutMs);
    } catch (error) {
      lastError = error;
      if (includeOverrides && !permissionRetried && isRemotePermissionOverrideError(error)) {
        permissionRetried = true;
        includeOverrides = false;
        log.info('agent', 'codex-resume-permission-retry', {
          threadId: params.threadId ?? null,
        });
        continue;
      }
      if (!providerRetried && isModelProviderMissingError(error)) {
        if (options.preserveProviderModel) throw error;
        providerRetried = true;
        const defaults = resolveCodexResumeDefaults(rpc.codexHome);
        if (!defaults) {
          log.warn('agent', 'codex-provider-rebind-unavailable', {
            threadId: params.threadId ?? null,
            codexHome: rpc.codexHome ?? null,
            reason: rpc.codexHome ? 'config-unavailable' : 'home-unknown',
          });
          throw error;
        }
        // Explicit caller params win over the configuration defaults.
        effectiveParams = stripCodexPermissionOverrides({ ...defaults, ...params });
        log.info('agent', 'codex-provider-rebind', {
          threadId: params.threadId ?? null,
          codexHome: rpc.codexHome ?? null,
          modelProvider: defaults.modelProvider,
          model: defaults.model ?? null,
        });
        continue;
      }
      throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Codex thread resume retry limit reached');
}

async function providerDefaultsAtIdleBoundary(
  rpc: RpcClient,
  params: Wire,
): Promise<Wire | undefined> {
  if (params.modelProvider !== undefined) return undefined;
  let thread: Wire;
  try {
    const result = await rpc.request('thread/read', {
      threadId: params.threadId,
      includeTurns: false,
    });
    thread = result.thread ?? result;
  } catch {
    return undefined;
  }
  if (!thread || typeof thread !== 'object') return undefined;
  const turns: Wire[] = Array.isArray(thread.turns) ? thread.turns : [];
  const active = thread.status?.type === 'active' ||
    turns.some(turn => turn.status === 'inProgress');
  if (active) {
    log.info('agent', 'codex-provider-switch-deferred', {
      threadId: params.threadId ?? null,
      reason: 'active-turn',
    });
    return undefined;
  }
  const statusType = thread.status?.type;
  if (statusType === undefined && turns.length === 0) {
    // Older App Servers may omit status on an empty read. Do not guess an idle
    // boundary from an incomplete response.
    return undefined;
  }
  const defaults = resolveCodexResumeDefaults(rpc.codexHome);
  if (!defaults) return undefined;
  const threadProvider = typeof thread.modelProvider === 'string'
    ? thread.modelProvider.trim()
    : undefined;
  const threadModel = typeof thread.model === 'string' ? thread.model.trim() : undefined;
  const providerChanged = Boolean(threadProvider && threadProvider !== defaults.modelProvider);
  const modelChanged = Boolean(defaults.model && threadModel && threadModel !== defaults.model);
  if (!providerChanged && !modelChanged && threadProvider) return undefined;
  log.info('agent', 'codex-provider-switch-at-boundary', {
    threadId: params.threadId ?? null,
    fromProvider: threadProvider ?? null,
    toProvider: defaults.modelProvider,
    fromModel: threadModel ?? null,
    toModel: defaults.model ?? null,
  });
  return defaults;
}

/**
 * Only proxy-related variables are copied from an existing pane.  In
 * particular, never persist or forward arbitrary pane environment variables:
 * they can contain API keys and Bridge secrets.  This lets a user run
 * `clash on` in the legacy shell before migration without leaking unrelated
 * environment state into the candidate file.
 */
export function proxyEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  const names = [
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
    'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
    'SOCKS_PROXY', 'SOCKS5_PROXY', 'socks_proxy', 'socks5_proxy',
  ];
  return Object.fromEntries(
    names.flatMap(name => {
      const value = env[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );
}

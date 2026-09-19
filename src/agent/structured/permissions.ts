import type { CodexSandboxMode } from '../../config/permissions';
import type { RpcClient, Wire } from './rpc';

/**
 * The terminal backend has always used Codex's non-interactive permission
 * contract: the selected sandbox is authoritative and approval prompts are
 * disabled.  Keep the structured backend identical.  App Server uses the
 * legacy kebab-case sandbox value on thread start/resume and the structured
 * policy object on turn/start.
 */
export function codexThreadPermissionOverrides(
  sandbox: CodexSandboxMode | undefined,
): { sandbox?: CodexSandboxMode; approvalPolicy?: 'never' } {
  return sandbox ? { sandbox, approvalPolicy: 'never' } : {};
}

export function codexTurnPermissionOverrides(
  sandbox: CodexSandboxMode | undefined,
  cwd: string | undefined,
): { sandboxPolicy?: Record<string, unknown>; approvalPolicy?: 'never' } {
  if (!sandbox) return {};
  switch (sandbox) {
    case 'danger-full-access':
      return { sandboxPolicy: { type: 'dangerFullAccess' }, approvalPolicy: 'never' };
    case 'workspace-write':
      return {
        sandboxPolicy: {
          type: 'workspaceWrite',
          ...(cwd ? { writableRoots: [cwd] } : {}),
        },
        approvalPolicy: 'never',
      };
    case 'read-only':
      return { sandboxPolicy: { type: 'readOnly' }, approvalPolicy: 'never' };
  }
}

/**
 * Build permission flags for a brand-new local Codex TUI. These flags are
 * only valid when the CLI owns the session it starts; they must never be
 * appended to `--remote ... resume`.
 */
export function codexRemotePermissionArgs(sandbox: CodexSandboxMode | undefined): string[] {
  if (!sandbox) return [];
  if (sandbox === 'danger-full-access') return ['--dangerously-bypass-approvals-and-sandbox'];
  return ['--sandbox', sandbox, '--ask-for-approval', 'never'];
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
): Promise<Wire> {
  if (Object.keys(overrides).length === 0) {
    return rpc.request('thread/resume', params, timeoutMs);
  }
  try {
    return await rpc.request('thread/resume', { ...params, ...overrides }, timeoutMs);
  } catch (error) {
    if (!isRemotePermissionOverrideError(error)) throw error;
    return rpc.request('thread/resume', params, timeoutMs);
  }
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

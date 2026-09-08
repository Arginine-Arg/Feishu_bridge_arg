import type { CodexSandboxMode } from '../../config/permissions';

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

/** Build flags for a Codex TUI connected to an App Server. */
export function codexRemotePermissionArgs(sandbox: CodexSandboxMode | undefined): string[] {
  if (!sandbox) return [];
  if (sandbox === 'danger-full-access') return ['--dangerously-bypass-approvals-and-sandbox'];
  return ['--sandbox', sandbox, '--ask-for-approval', 'never'];
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


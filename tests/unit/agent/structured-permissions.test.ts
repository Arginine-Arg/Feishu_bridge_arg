import { describe, expect, it, vi } from 'vitest';
import {
  codexRemotePermissionArgs,
  codexRemoteResumeArgs,
  codexThreadPermissionOverrides,
  codexTurnPermissionOverrides,
  isRemotePermissionOverrideError,
  proxyEnvironment,
  resumeCodexThread,
} from '../../../src/agent/structured/permissions';
import type { RpcClient } from '../../../src/agent/structured/rpc';

describe('structured Codex permissions', () => {
  it('maps full access to the App Server YOLO contract', () => {
    expect(codexThreadPermissionOverrides('danger-full-access')).toEqual({
      sandbox: 'danger-full-access', approvalPolicy: 'never',
    });
    expect(codexTurnPermissionOverrides('danger-full-access', '/repo')).toEqual({
      sandboxPolicy: { type: 'dangerFullAccess' }, approvalPolicy: 'never',
    });
    expect(codexRemotePermissionArgs('danger-full-access')).toEqual([
      '--dangerously-bypass-approvals-and-sandbox',
    ]);
  });

  it('keeps lower sandbox modes explicit and never forwards unrelated secrets', () => {
    expect(codexThreadPermissionOverrides('workspace-write')).toEqual({
      sandbox: 'workspace-write', approvalPolicy: 'never',
    });
    expect(codexTurnPermissionOverrides('workspace-write', '/repo')).toEqual({
      sandboxPolicy: { type: 'workspaceWrite', writableRoots: ['/repo'] }, approvalPolicy: 'never',
    });
    expect(codexRemotePermissionArgs('read-only')).toEqual([
      '--sandbox', 'read-only', '--ask-for-approval', 'never',
    ]);
    expect(proxyEnvironment({ HTTP_PROXY: 'http://127.0.0.1:7890', SECRET_TOKEN: 'do-not-copy' })).toEqual({
      HTTP_PROXY: 'http://127.0.0.1:7890',
    });
  });

  it('never sends permission flags when the TUI resumes a remote task', () => {
    const args = codexRemoteResumeArgs('unix:///tmp/server.sock', 'thread-1');
    expect(args).toEqual([
      '-c', 'check_for_update_on_startup=false',
      '--remote', 'unix:///tmp/server.sock',
      'resume', 'thread-1',
      '--no-alt-screen',
    ]);
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(args).not.toContain('--sandbox');
    expect(args).not.toContain('--ask-for-approval');
  });

  it('recognizes the deterministic remote permission rejection', () => {
    expect(isRemotePermissionOverrideError(
      new Error('Permission overrides are not supported when resuming a remote task.'),
    )).toBe(true);
    expect(isRemotePermissionOverrideError(new Error('network timeout'))).toBe(false);
  });

  it('retries a rejected remote resume once without permission overrides', async () => {
    const request = vi.fn()
      .mockRejectedValueOnce(new Error('Permission overrides are not supported when resuming a remote task.'))
      .mockResolvedValueOnce({ thread: { id: 'thread-1' } });
    const rpc = { request } as unknown as RpcClient;
    const result = await resumeCodexThread(
      rpc,
      { threadId: 'thread-1', cwd: '/repo' },
      { sandbox: 'danger-full-access', approvalPolicy: 'never' },
      12_345,
    );
    expect(result.thread.id).toBe('thread-1');
    expect(request).toHaveBeenNthCalledWith(1, 'thread/resume', {
      threadId: 'thread-1', cwd: '/repo', sandbox: 'danger-full-access', approvalPolicy: 'never',
    }, 12_345);
    expect(request).toHaveBeenNthCalledWith(2, 'thread/resume', {
      threadId: 'thread-1', cwd: '/repo',
    }, 12_345);
  });

  it('does not retry an unrelated resume failure', async () => {
    const request = vi.fn().mockRejectedValue(new Error('connection reset'));
    const rpc = { request } as unknown as RpcClient;
    await expect(resumeCodexThread(
      rpc,
      { threadId: 'thread-1' },
      { sandbox: 'danger-full-access' },
    )).rejects.toThrow('connection reset');
    expect(request).toHaveBeenCalledTimes(1);
  });
});

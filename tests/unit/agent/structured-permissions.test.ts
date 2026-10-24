import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

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
    const home = await writeCodexHome();
    const request = vi.fn()
      .mockRejectedValueOnce(new Error('Permission overrides are not supported when resuming a remote task.'))
      .mockResolvedValueOnce({ thread: { id: 'thread-1' } });
    const rpc = { request, codexHome: home } as unknown as RpcClient;
    const result = await resumeCodexThread(
      rpc,
      { threadId: 'thread-1', cwd: '/repo' },
      { sandbox: 'danger-full-access', approvalPolicy: 'never' },
      12_345,
    );
    expect(result.thread.id).toBe('thread-1');
    expect(request).toHaveBeenNthCalledWith(1, 'thread/resume', {
      threadId: 'thread-1', cwd: '/repo', modelProvider: 'custom', model: 'gpt-current',
      sandbox: 'danger-full-access', approvalPolicy: 'never',
    }, 12_345);
    expect(request).toHaveBeenNthCalledWith(2, 'thread/resume', {
      threadId: 'thread-1', cwd: '/repo', modelProvider: 'custom', model: 'gpt-current',
    }, 12_345);
  });

  it('uses the active provider and model when a historical thread id is unavailable', async () => {
    const home = await writeCodexHome();
    const request = vi.fn().mockResolvedValue({ thread: { id: 'thread-old' } });
    const rpc = { request, codexHome: home } as unknown as RpcClient;

    await resumeCodexThread(rpc, { threadId: 'thread-old', cwd: '/repo' }, {});

    expect(request).toHaveBeenCalledWith('thread/resume', {
      threadId: 'thread-old',
      cwd: '/repo',
      modelProvider: 'custom',
      model: 'gpt-current',
    }, 30_000);
  });

  it('preserves explicit provider and model overrides', async () => {
    const home = await writeCodexHome();
    const request = vi.fn().mockResolvedValue({ thread: { id: 'thread-old' } });
    const rpc = { request, codexHome: home } as unknown as RpcClient;

    await resumeCodexThread(rpc, {
      threadId: 'thread-old',
      modelProvider: 'openai',
      model: 'gpt-explicit',
    }, {});

    expect(request).toHaveBeenCalledWith('thread/resume', {
      threadId: 'thread-old',
      modelProvider: 'openai',
      model: 'gpt-explicit',
    }, 30_000);
  });

  it('does not retry an unrelated resume failure', async () => {
    const request = vi.fn().mockRejectedValue(new Error('connection reset'));
    const rpc = { request, codexHome: '/nonexistent-codex-home' } as unknown as RpcClient;
    await expect(resumeCodexThread(
      rpc,
      { threadId: 'thread-1' },
      { sandbox: 'danger-full-access' },
    )).rejects.toThrow('connection reset');
    expect(request).toHaveBeenCalledTimes(1);
  });
});

async function writeCodexHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'structured-provider-resume-'));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(home, 'config.toml'), `
model = "gpt-current"
model_provider = "custom"

[model_providers.custom]
base_url = "https://vendor.example.com/v1"
`.trimStart(), 'utf8');
  return home;
}

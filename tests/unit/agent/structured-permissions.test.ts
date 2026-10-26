import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  codexRemotePermissionArgs,
  codexRemoteResumeArgs,
  codexThreadPermissionOverrides,
  codexTurnPermissionOverrides,
  isModelProviderMissingError,
  isRemotePermissionOverrideError,
  proxyEnvironment,
  releaseCodexThreadWriter,
  resolveCodexPermissionSettings,
  resumeCodexThread,
  stripCodexPermissionOverrides,
} from '../../../src/agent/structured/permissions';
import type { RpcClient } from '../../../src/agent/structured/rpc';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  vi.restoreAllMocks();
});

const permissionError = 'Permission overrides are not supported when resuming a remote task.';
const providerError = 'failed to load configuration: Model provider `deepseek` not found';

describe('structured Codex permissions', () => {
  it('treats --yolo and the long bypass flag identically for new and resumed sessions', () => {
    expect(resolveCodexPermissionSettings('read-only', { yolo: true })).toEqual({
      sandbox: 'danger-full-access',
      approvalPolicy: 'never',
      explicit: true,
    });
    expect(resolveCodexPermissionSettings('read-only', {
      dangerouslyBypassApprovalsAndSandbox: true,
    })).toEqual({
      sandbox: 'danger-full-access',
      approvalPolicy: 'never',
      explicit: true,
    });
    expect(resolveCodexPermissionSettings('read-only', {
      sandbox: 'workspace-write',
      askForApproval: 'on-request',
    })).toEqual({
      sandbox: 'workspace-write',
      approvalPolicy: 'on-request',
      explicit: true,
    });
    expect(resolveCodexPermissionSettings('read-only', {})).toEqual({
      sandbox: 'read-only',
      approvalPolicy: 'never',
      explicit: false,
    });
  });

  it('rejects unsafe or unsupported native permission combinations', () => {
    expect(() => resolveCodexPermissionSettings('read-only', {
      yolo: true,
      sandbox: 'workspace-write',
    })).toThrow(/lower --sandbox/u);
    expect(() => resolveCodexPermissionSettings('read-only', {
      sandbox: 'full-access',
    })).toThrow(/Invalid --sandbox/u);
    expect(() => resolveCodexPermissionSettings('read-only', {
      askForApproval: 'sometimes',
    })).toThrow(/Invalid --ask-for-approval/u);
  });

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
    expect(codexRemotePermissionArgs('workspace-write', 'on-request')).toEqual([
      '--sandbox', 'workspace-write', '--ask-for-approval', 'on-request',
    ]);
    expect(codexRemotePermissionArgs('danger-full-access', 'on-request')).toEqual([
      '--sandbox', 'danger-full-access', '--ask-for-approval', 'on-request',
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

  it('recognizes the deterministic permission and provider failures', () => {
    expect(isRemotePermissionOverrideError(new Error(permissionError))).toBe(true);
    expect(isRemotePermissionOverrideError(new Error('network timeout'))).toBe(false);
    expect(isModelProviderMissingError(new Error(providerError))).toBe(true);
    expect(isModelProviderMissingError(new Error('Model provider `custom` not found'))).toBe(true);
    expect(isModelProviderMissingError(new Error('network timeout'))).toBe(false);
  });

  it('strips any permission fields merged into remote resume params', async () => {
    const request = requestWithoutIdleSnapshot();
    const rpc = { request, codexHome: await writeCodexHome() } as unknown as RpcClient;

    await resumeCodexThread(rpc, {
      threadId: 'thread-1',
      cwd: '/repo',
      sandbox: 'danger-full-access',
      approvalPolicy: 'never',
      permissions: { type: 'dangerFullAccess' },
      yolo: true,
    }, {});

    const resume = request.mock.calls.find(call => call[0] === 'thread/resume');
    expect(resume?.[1]).toEqual({ threadId: 'thread-1', cwd: '/repo' });
    expect(stripCodexPermissionOverrides({
      threadId: 'thread-1',
      sandboxPolicy: { type: 'dangerFullAccess' },
      approvalsReviewer: 'user',
      yolo: true,
    })).toEqual({ threadId: 'thread-1' });
  });

  it('releases a writer by unsubscribing without stopping the host', async () => {
    const request = vi.fn(async () => ({}));
    const rpc = { request, closed: false } as unknown as RpcClient;
    await releaseCodexThreadWriter(rpc, 'thread-1');
    expect(request).toHaveBeenCalledWith(
      'thread/unsubscribe',
      { threadId: 'thread-1' },
      10_000,
    );
  });

  it('resumes normally without touching provider or model', async () => {
    const request = requestWithoutIdleSnapshot();
    const rpc = { request, codexHome: await writeCodexHome() } as unknown as RpcClient;

    await resumeCodexThread(rpc, { threadId: 'thread-1', cwd: '/repo' }, {});

    // The thread's own settings are authoritative on a normal resume,
    // including a model the user selected through /model.
    expect(request.mock.calls.filter(call => call[0] === 'thread/resume')).toEqual([[
      'thread/resume', {
      threadId: 'thread-1',
      cwd: '/repo',
      }, 30_000,
    ]]);
  });

  it('preserves the loaded provider/model when reconnecting instead of applying current config', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === 'thread/read') {
        return {
          thread: {
            id: 'thread-1',
            status: { type: 'idle' },
            modelProvider: 'old-provider',
            model: 'old-model',
            turns: [],
          },
        };
      }
      return { thread: { id: 'thread-1' } };
    });
    const rpc = { request, codexHome: await writeCodexHome() } as unknown as RpcClient;

    await resumeCodexThread(
      rpc,
      { threadId: 'thread-1', cwd: '/repo' },
      {},
      30_000,
      { preserveProviderModel: true },
    );

    expect(request.mock.calls.filter(call => call[0] === 'thread/resume')).toEqual([[
      'thread/resume',
      { threadId: 'thread-1', cwd: '/repo' },
      30_000,
    ]]);
  });

  it('rebinds only after the server reports a missing historical provider', async () => {
    let resumeAttempts = 0;
    const request = vi.fn(async (method: string) => {
      if (method === 'thread/read') return {};
      if (method === 'thread/resume' && ++resumeAttempts === 1) throw new Error(providerError);
      if (method === 'thread/resume') return { thread: { id: 'thread-old' } };
      return {};
    });
    const rpc = { request, codexHome: await writeCodexHome() } as unknown as RpcClient;

    const result = await resumeCodexThread(rpc, { threadId: 'thread-old', cwd: '/repo' }, {});

    expect(result.thread.id).toBe('thread-old');
    const resumes = request.mock.calls.filter(call => call[0] === 'thread/resume');
    expect(resumes[0]).toEqual(['thread/resume', {
      threadId: 'thread-old', cwd: '/repo',
    }, 30_000]);
    expect(resumes[1]).toEqual(['thread/resume', {
      threadId: 'thread-old',
      cwd: '/repo',
      modelProvider: 'custom',
      model: 'gpt-current',
    }, 30_000]);
  });

  it('does not silently rebind when reconnect policy requires preserving the route', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === 'thread/read') return {};
      if (method === 'thread/resume') throw new Error(providerError);
      return {};
    });
    const rpc = { request, codexHome: await writeCodexHome() } as unknown as RpcClient;

    await expect(resumeCodexThread(
      rpc,
      { threadId: 'thread-old', cwd: '/repo' },
      {},
      30_000,
      { preserveProviderModel: true },
    )).rejects.toThrow(providerError);

    expect(request.mock.calls.filter(call => call[0] === 'thread/resume')).toHaveLength(1);
  });

  it('keeps explicit caller provider/model overrides during the rebind retry', async () => {
    const request = vi.fn()
      .mockRejectedValueOnce(new Error(providerError))
      .mockResolvedValueOnce({ thread: { id: 'thread-old' } });
    const rpc = { request, codexHome: await writeCodexHome() } as unknown as RpcClient;

    await resumeCodexThread(rpc, {
      threadId: 'thread-old',
      modelProvider: 'explicit-provider',
      model: 'explicit-model',
    }, {});

    expect(request).toHaveBeenNthCalledWith(2, 'thread/resume', {
      threadId: 'thread-old',
      modelProvider: 'explicit-provider',
      model: 'explicit-model',
    }, 30_000);
  });

  it('does not send permission overrides on a remote resume', async () => {
    const request = requestWithoutIdleSnapshot();
    const rpc = { request, codexHome: await writeCodexHome() } as unknown as RpcClient;

    const result = await resumeCodexThread(
      rpc,
      { threadId: 'thread-1', cwd: '/repo' },
      { sandbox: 'danger-full-access', approvalPolicy: 'never' },
      12_345,
    );

    expect(result.thread.id).toBe('thread-1');
    const resumes = request.mock.calls.filter(call => call[0] === 'thread/resume');
    expect(resumes).toEqual([['thread/resume', {
      threadId: 'thread-1', cwd: '/repo',
    }, 12_345]]);
  });

  it('combines safe resume and provider retries without exceeding three attempts', async () => {
    let resumeAttempts = 0;
    const request = vi.fn(async (method: string) => {
      if (method === 'thread/read') return {};
      if (method === 'thread/resume' && ++resumeAttempts === 1) throw new Error(providerError);
      if (method === 'thread/resume') return { thread: { id: 'thread-1' } };
      return {};
    });
    const rpc = { request, codexHome: await writeCodexHome() } as unknown as RpcClient;

    await resumeCodexThread(
      rpc,
      { threadId: 'thread-1' },
      { sandbox: 'danger-full-access', approvalPolicy: 'never' },
    );

    const resumes = request.mock.calls.filter(call => call[0] === 'thread/resume');
    expect(resumes[0]).toEqual(['thread/resume', {
      threadId: 'thread-1',
    }, 30_000]);
    expect(resumes[1]).toEqual(['thread/resume', {
      threadId: 'thread-1',
      modelProvider: 'custom',
      model: 'gpt-current',
    }, 30_000]);
  });

  it('does not retry a provider failure when the home or config is unavailable', async () => {
    const missingHome = vi.fn(async (method: string) => {
      if (method === 'thread/read') return {};
      throw new Error(providerError);
    });
    await expect(resumeCodexThread(
      { request: missingHome } as unknown as RpcClient,
      { threadId: 'thread-1' },
      {},
    )).rejects.toThrow(providerError);
    expect(missingHome.mock.calls.filter(call => call[0] === 'thread/resume')).toHaveLength(1);

    const home = await mkdtemp(join(tmpdir(), 'structured-provider-unreadable-'));
    cleanups.push(() => rm(home, { recursive: true, force: true }));
    const unreadable = vi.fn(async (method: string) => {
      if (method === 'thread/read') return {};
      throw new Error(providerError);
    });
    await expect(resumeCodexThread(
      { request: unreadable, codexHome: home } as unknown as RpcClient,
      { threadId: 'thread-1' },
      {},
    )).rejects.toThrow(providerError);
    expect(unreadable.mock.calls.filter(call => call[0] === 'thread/resume')).toHaveLength(1);
  });

  it('does not retry an unrelated resume failure', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === 'thread/read') return {};
      throw new Error('connection reset');
    });
    const rpc = { request, codexHome: '/nonexistent-codex-home' } as unknown as RpcClient;
    await expect(resumeCodexThread(
      rpc,
      { threadId: 'thread-1' },
      { sandbox: 'danger-full-access' },
    )).rejects.toThrow('connection reset');
    expect(request.mock.calls.filter(call => call[0] === 'thread/resume')).toHaveLength(1);
  });
});

function requestWithoutIdleSnapshot() {
  return vi.fn(async (method: string, ..._args: unknown[]) => {
    if (method === 'thread/read') return {};
    return { thread: { id: 'thread-1' } };
  });
}

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

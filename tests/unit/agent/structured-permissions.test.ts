import { describe, expect, it } from 'vitest';
import {
  codexRemotePermissionArgs,
  codexThreadPermissionOverrides,
  codexTurnPermissionOverrides,
  proxyEnvironment,
} from '../../../src/agent/structured/permissions';

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
});


import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  recoverArtifactDelivery,
  resolveAgentArtifactDelivery,
} from '../../../src/cli/commands/agent-sendfile.js';

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('resolveAgentArtifactDelivery', () => {
  it('uses the process-scoped bridge capability when both values are present', () => {
    const readTmux = () => {
      throw new Error('tmux fallback should not run');
    };

    expect(resolveAgentArtifactDelivery({
      ARG_BRIDGE_ARTIFACT_SOCKET: '/run/bridge.sock',
      ARG_BRIDGE_ARTIFACT_TOKEN: 'process-token',
    }, readTmux)).toEqual({
      socketPath: '/run/bridge.sock',
      token: 'process-token',
    });
  });

  it('recovers a capability only from the current managed tmux session handoff', () => {
    const calls: string[] = [];
    const readTmux = (name: string) => {
      calls.push(name);
      if (name === 'ARG_BRIDGE_ARTIFACT_SCOPE') return 'managed-scope';
      return name === 'ARG_BRIDGE_ARTIFACT_SOCKET'
        ? '/run/managed-bridge.sock'
        : 'managed-session-token';
    };

    expect(resolveAgentArtifactDelivery({ TMUX: '/tmp/tmux.sock,1,0', TMUX_PANE: '%4' }, readTmux)).toEqual({
      scope: 'managed-scope',
      socketPath: '/run/managed-bridge.sock',
      token: 'managed-session-token',
    });
    expect(calls).toEqual([
      'ARG_BRIDGE_ARTIFACT_SCOPE',
      'ARG_BRIDGE_ARTIFACT_SOCKET',
      'ARG_BRIDGE_ARTIFACT_TOKEN',
    ]);
  });

  it('prefers the refreshed tmux capability over a stale inherited process token', () => {
    const readTmux = (name: string) => {
      if (name === 'ARG_BRIDGE_ARTIFACT_SCOPE') return 'managed-scope';
      return name === 'ARG_BRIDGE_ARTIFACT_SOCKET'
        ? '/run/managed-bridge.sock'
        : 'managed-session-token';
    };

    expect(resolveAgentArtifactDelivery({
      ARG_BRIDGE_ARTIFACT_SOCKET: '/run/managed-bridge.sock',
      ARG_BRIDGE_ARTIFACT_TOKEN: 'stale-inherited-token',
      ARG_BRIDGE_ARTIFACT_SCOPE: 'stale-scope',
      TMUX: '/tmp/tmux.sock,1,0',
      TMUX_PANE: '%4',
    }, readTmux)).toEqual({
      scope: 'managed-scope',
      socketPath: '/run/managed-bridge.sock',
      token: 'managed-session-token',
    });
  });

  it('rejects an incomplete process capability instead of mixing it with another source', () => {
    expect(resolveAgentArtifactDelivery({
      ARG_BRIDGE_ARTIFACT_SOCKET: '/run/partial.sock',
      TMUX: '/tmp/tmux.sock,1,0',
      TMUX_PANE: '%4',
    }, () => undefined)).toBeUndefined();
  });

  it('recovers the newest persistent grant whose roots contain the current cwd', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-sendfile-recovery-'));
    temporary.push(root);
    const workspace = join(root, 'workspace');
    const socketPath = join(root, 'artifact-broker.sock');
    await writeFile(join(root, 'artifact-grants.json'), JSON.stringify({
      version: 1,
      grants: [
        {
          token: 'old-workspace-token-123456',
          persistent: true,
          scope: 'chat-a',
          allowedRoots: ['/definitely/not/current'],
          updatedAt: 100,
        },
        {
          token: 'newer-token-1234567890',
          persistent: true,
          scope: 'chat-a',
          allowedRoots: [workspace],
          updatedAt: 200,
        },
        {
          token: 'older-matching-token-1234',
          persistent: true,
          scope: 'chat-a',
          allowedRoots: [workspace],
          updatedAt: 50,
        },
        {
          token: 'wrong-chat-token-1234567890',
          persistent: true,
          scope: 'chat-b',
          allowedRoots: [workspace],
          updatedAt: 300,
        },
      ],
    }));

    await expect(recoverArtifactDelivery(
      { scope: 'chat-a', socketPath, token: 'expired-token' },
      workspace,
    )).resolves.toEqual({
      scope: 'chat-a',
      socketPath,
      token: 'newer-token-1234567890',
    });
  });
});

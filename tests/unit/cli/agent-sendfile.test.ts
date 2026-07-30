import { describe, expect, it } from 'vitest';
import { resolveAgentArtifactDelivery } from '../../../src/cli/commands/agent-sendfile.js';

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
      return name === 'ARG_BRIDGE_ARTIFACT_SOCKET'
        ? '/run/managed-bridge.sock'
        : 'managed-session-token';
    };

    expect(resolveAgentArtifactDelivery({ TMUX: '/tmp/tmux.sock,1,0', TMUX_PANE: '%4' }, readTmux)).toEqual({
      socketPath: '/run/managed-bridge.sock',
      token: 'managed-session-token',
    });
    expect(calls).toEqual(['ARG_BRIDGE_ARTIFACT_SOCKET', 'ARG_BRIDGE_ARTIFACT_TOKEN']);
  });

  it('rejects an incomplete process capability instead of mixing it with another source', () => {
    expect(resolveAgentArtifactDelivery({
      ARG_BRIDGE_ARTIFACT_SOCKET: '/run/partial.sock',
      TMUX: '/tmp/tmux.sock,1,0',
      TMUX_PANE: '%4',
    }, () => undefined)).toBeUndefined();
  });
});

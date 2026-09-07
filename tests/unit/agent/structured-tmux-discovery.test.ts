import { describe, expect, it } from 'vitest';
import { parseStructuredAgentArgv } from '../../../src/agent/structured/tmux-discovery';

describe('structured tmux process discovery', () => {
  it('extracts the shared App Server endpoint and resumed Codex thread', () => {
    expect(parseStructuredAgentArgv([
      'node', '/home/user/.local/bin/codex', 'app', '--remote', 'unix:///run/user/1000/codex.sock',
      'resume', 'thread-123', '--no-alt-screen',
    ], 'codex')).toEqual({ endpoint: 'unix:///run/user/1000/codex.sock', threadId: 'thread-123' });
  });

  it('accepts equals-form remote options and marks a legacy Codex resume for Bridge migration', () => {
    expect(parseStructuredAgentArgv(['codex', '--remote=unix:///tmp/codex.sock', 'resume', 'thread-1'], 'codex')).toEqual({
      endpoint: 'unix:///tmp/codex.sock', threadId: 'thread-1',
    });
    expect(parseStructuredAgentArgv(['codex', 'resume', 'thread-1'], 'codex')).toEqual({ threadId: 'thread-1', legacy: true });
  });

  it('recognizes Claude resume for listing but leaves endpoint-less attach policy to the adapter', () => {
    expect(parseStructuredAgentArgv(['claude', '--resume', 'session-abc'], 'claude')).toEqual({ threadId: 'session-abc' });
  });

  it('does not confuse an unrelated executable or a missing resume id for a session', () => {
    expect(parseStructuredAgentArgv(['codex-helper', 'resume', 'thread-1'], 'codex')).toBeUndefined();
    expect(parseStructuredAgentArgv(['codex', '--remote', 'unix:///tmp/codex.sock', 'resume'], 'codex')).toBeUndefined();
  });
});

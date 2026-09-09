import { mkdir, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseStructuredAgentArgv } from '../../../src/agent/structured/tmux-discovery';
import { StructuredAdapter } from '../../../src/agent/structured/adapter';

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
    expect(parseStructuredAgentArgv(['codex', 'resume', '-m', 'gpt-5.6-luna'], 'codex')).toBeUndefined();
    expect(parseStructuredAgentArgv(['bash', '-c', 'codex'], 'codex')).toBeUndefined();
    expect(parseStructuredAgentArgv(['bash', '-lc', 'codex', '--remote', 'unix:///current.sock', 'resume', 'new'], 'codex')).toEqual({ endpoint: 'unix:///current.sock', threadId: 'new' });
    expect(parseStructuredAgentArgv(['node', '/usr/bin/codex', '--remote', 'unix:///current.sock', 'resume', 'new'], 'codex')).toEqual({ endpoint: 'unix:///current.sock', threadId: 'new' });
  });

  it('retains a discovered thread candidate after its Codex process exits', async () => {
    const profileDir = await mkdtemp(join(tmpdir(), 'structured-candidates-'));
    const socketPath = join(profileDir, 'missing-tmux.sock');
    const target = {
      socketPath, sessionName: 'argbridge-codex-project', windowIndex: '0', paneIndex: '1', paneId: '%99', panePid: 99999,
      paneCurrentCommand: 'bash', paneCurrentPath: '/workspace', agentKind: 'codex', ownership: 'managed', attachCommand: 'tmux attach',
      structured: { threadId: 'thread-remembered', legacy: true },
    };
    await mkdir(join(profileDir, 'structured'), { recursive: true });
    await writeFile(join(profileDir, 'structured', 'tmux-candidates.json'), JSON.stringify({ version: 1, candidates: {
      [`${socketPath}\0${target.sessionName}\0thread-remembered`]: { target, endpoint: '', threadId: 'thread-remembered', cwd: '/workspace', updatedAt: Date.now(), savedAt: Date.now() },
    } }));
    const adapter = new StructuredAdapter({ kind: 'codex', binary: '/nonexistent/codex', profileDir });
    const panes = await adapter.tmux.list(socketPath);
    expect(panes).toHaveLength(1);
    expect(panes[0]?.structured).toMatchObject({ threadId: 'thread-remembered', legacy: true, persisted: true });
    await adapter.shutdown();
  });
});

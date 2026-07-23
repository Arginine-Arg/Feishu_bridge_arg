import { chmod, mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  TmuxBindingController,
  captureTmuxPaneTail,
  isSafeTmuxSocket,
  listTmuxAgentPanes,
  discoverTmuxSockets,
  tmuxTargetKey,
} from '../../../src/agent/tmux-control.js';
import { LiveSessionPool } from '../../../src/agent/live-session.js';

const live = process.platform === 'linux' && spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0;
const cleanup: Array<() => Promise<void>> = [];

describe.skipIf(!live)('tmux control', () => {
  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((fn) => fn()));
  });

  it('discovers Codex and Claude panes on an explicit socket and rejects shells', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tmux-control-discovery-'));
    const socket = join(root, 'tmux.sock');
    const codex = join(root, 'codex');
    const claude = join(root, 'claude');
    await symlink('/bin/sleep', codex);
    await symlink('/bin/sleep', claude);
    cleanup.push(async () => {
      spawnSync('tmux', ['-S', socket, 'kill-server'], { stdio: 'ignore' });
      await rm(root, { recursive: true, force: true });
    });

    expect(spawnSync('tmux', ['-S', socket, 'new-session', '-d', '-s', 'codex', '-c', root, codex, '30']).status).toBe(0);
    expect(spawnSync('tmux', ['-S', socket, 'new-session', '-d', '-s', 'claude', '-c', root, claude, '30']).status).toBe(0);
    expect(spawnSync('tmux', ['-S', socket, 'new-session', '-d', '-s', 'shell', '-c', root, 'sleep', '30']).status).toBe(0);

    const panes = listTmuxAgentPanes(socket);
    expect(panes.map((pane) => pane.agentKind).sort()).toEqual(['claude', 'codex']);
    expect(panes.every((pane) => pane.ownership === 'external')).toBe(true);
    expect(panes.every((pane) => pane.attachCommand.includes(`tmux -S ${socket}`))).toBe(true);
  });

  it('captures only the requested trailing lines from a known tmux pane', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tmux-control-tail-'));
    const socket = join(root, 'tmux.sock');
    cleanup.push(async () => {
      spawnSync('tmux', ['-S', socket, 'kill-server'], { stdio: 'ignore' });
      await rm(root, { recursive: true, force: true });
    });
    expect(
      spawnSync('tmux', [
        '-S', socket,
        'new-session',
        '-d',
        '-s',
        'tail',
        '-c',
        root,
        'sh',
        '-c',
        "printf 'one\\ntwo\\nthree\\n'; sleep 30",
      ]).status,
    ).toBe(0);

    const tail = captureTmuxPaneTail(
      {
        socketPath: socket,
        target: 'tail:0.0',
        attachCommand: `tmux -S ${socket} attach -t tail`,
        ownership: 'managed',
      },
      2,
    );

    expect(tail.requestedLines).toBe(2);
    expect(tail.text).toBe('two\nthree');
  });

  it('persists and revalidates one external pane binding without killing it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tmux-control-bind-'));
    const socket = join(root, 'tmux.sock');
    const codex = join(root, 'codex');
    const profile = join(root, 'profile');
    await symlink('/bin/sleep', codex);
    cleanup.push(async () => {
      spawnSync('tmux', ['-S', socket, 'kill-server'], { stdio: 'ignore' });
      await rm(root, { recursive: true, force: true });
    });
    expect(spawnSync('tmux', ['-S', socket, 'new-session', '-d', '-s', 'external', '-c', root, codex, '30']).status).toBe(0);

    const controller = new TmuxBindingController(profile, 'codex-profile', 'codex');
    const pane = (await controller.list(socket))[0]!;
    const bound = await controller.bind('scope-a', tmuxTargetKey(pane));
    expect(bound.paneId).toBe(pane.paneId);
    expect((await controller.status('scope-a')).state).toBe('external');

    const restarted = new TmuxBindingController(profile, 'codex-profile', 'codex');
    expect((await restarted.status('scope-a')).state).toBe('external');
    await expect(restarted.bind('scope-b', tmuxTargetKey(pane))).rejects.toThrow(/已绑定/);

    const livePool = new LiveSessionPool();
    const liveSession = livePool.getOrCreate('external-pane-scope', {
      command: 'true',
      args: [],
      cwd: root,
      signature: 'external-pane',
      backend: 'tmux',
      tmuxTarget: pane,
      idleMs: 100,
      startupTimeoutMs: 300,
    });
    for await (const _event of liveSession.run('external-pane-run', 'ignored', root).events) {
      // The target is sleep in this lifecycle test; relay output is irrelevant.
    }
    await livePool.closeAll();
    expect(spawnSync('tmux', ['-S', socket, 'has-session', '-t', 'external'], { stdio: 'ignore' }).status).toBe(0);

    expect(await restarted.unbind('scope-a')).toBe(true);
    expect((await restarted.status('scope-a')).state).toBe('none');
    expect(spawnSync('tmux', ['-S', socket, 'has-session', '-t', 'external'], { stdio: 'ignore' }).status).toBe(0);
  });

  it('rejects unsafe socket paths and detects a named -L socket', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tmux-control-named-'));
    const name = `argbridge-test-${process.pid}`;
    const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
    const socketPath = join(process.env.TMUX_TMPDIR ?? tmpdir(), `tmux-${uid}`, name);
    const socketDir = join(process.env.TMUX_TMPDIR ?? tmpdir(), `tmux-${uid}`);
    await mkdir(socketDir, { recursive: true });
    await chmod(socketDir, 0o700);
    cleanup.push(async () => {
      spawnSync('tmux', ['-S', socketPath, 'kill-server'], { stdio: 'ignore' });
      await rm(root, { recursive: true, force: true });
    });
    expect(isSafeTmuxSocket(join(root, 'missing'))).toBe(false);
    expect(isSafeTmuxSocket(root)).toBe(false);
    expect(spawnSync('tmux', ['-S', socketPath, 'new-session', '-d', '-s', 'named', '-c', root, 'sleep', '30']).status).toBe(0);
    const panes = listTmuxAgentPanes(name);
    expect(panes).toEqual([]);
  });

  it('removes only inactive bridge-owned socket files during discovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tmux-control-stale-'));
    const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
    const socketDir = join(process.env.TMUX_TMPDIR ?? tmpdir(), `tmux-${uid}`);
    await mkdir(socketDir, { recursive: true });
    await chmod(socketDir, 0o700);
    const stale = join(socketDir, `lark-channel-stale-${process.pid}`);
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(stale, resolve);
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    cleanup.push(async () => {
      await rm(root, { recursive: true, force: true });
      await rm(stale, { force: true });
    });

    discoverTmuxSockets();
    expect(isSafeTmuxSocket(stale)).toBe(false);
  });
});

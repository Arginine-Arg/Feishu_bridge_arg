import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeAdapter } from '../../../src/agent/claude/adapter.js';
import { CodexAdapter } from '../../../src/agent/codex/adapter.js';
import {
  TmuxBindingController,
  captureTmuxPaneTail,
  defaultTmuxSocketPath,
  isSafeTmuxSocket,
  listTmuxAgentPanes,
  discoverTmuxSockets,
  tmuxTargetKey,
} from '../../../src/agent/tmux-control.js';
import { LiveSessionPool, liveTmuxIdentity } from '../../../src/agent/live-session.js';
import type { AgentAdapter, AgentEvent } from '../../../src/agent/types.js';

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

    let tail = captureTmuxPaneTail(
      {
        socketPath: socket,
        target: 'tail:0.0',
        attachCommand: `tmux -S ${socket} attach -t tail`,
        ownership: 'managed',
      },
      2,
    );
    const deadline = Date.now() + 3_000;
    while (tail.text !== 'two\nthree' && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      tail = captureTmuxPaneTail(
        {
          socketPath: socket,
          target: 'tail:0.0',
          attachCommand: `tmux -S ${socket} attach -t tail`,
          ownership: 'managed',
        },
        2,
      );
    }

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

  it('persists and recovers a managed terminal after the controller is recreated', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tmux-control-managed-recovery-'));
    const profile = join(root, 'profile');
    const scope = 'managed-recovery-scope';
    const controller = new TmuxBindingController(profile, 'codex-profile', 'codex');
    const sessionName = controller.managedSessionName(scope);
    const { socketPath } = liveTmuxIdentity(root, scope, 'managed-recovery-signature', sessionName);
    const reporter = join(root, 'reporter.sh');
    cleanup.push(async () => {
      spawnSync('tmux', ['-S', socketPath, 'kill-server'], { stdio: 'ignore' });
      await rm(root, { recursive: true, force: true });
    });

    await writeFile(reporter, "#!/bin/sh\nprintf 'managed-one\\nmanaged-two\\n'\nsleep 30\n", 'utf8');
    await chmod(reporter, 0o755);
    expect(
      spawnSync('tmux', [
        '-S', socketPath,
        '-f', '/dev/null',
        'new-session', '-d', '-s', sessionName, '-c', root,
        reporter,
      ]).status,
    ).toBe(0);
    const metadata: Array<[string, string]> = [
      ['@argbridge_managed', '1'],
      ['@argbridge_profile', 'codex-profile'],
      ['@argbridge_scope', scope],
      ['@argbridge_agent', 'codex'],
      ['@argbridge_cwd', root],
    ];
    for (const [key, value] of metadata) {
      expect(spawnSync('tmux', ['-S', socketPath, 'set-option', '-t', sessionName, key, value]).status).toBe(0);
    }

    await controller.rememberManaged(scope, root, 'managed-recovery-signature', {
      socketPath,
      sessionName,
      attachCommand: `tmux -S ${socketPath} attach -t ${sessionName}`,
    });

    const restarted = new TmuxBindingController(profile, 'codex-profile', 'codex');
    const status = await restarted.managedStatus(scope, root);
    expect(status).toMatchObject({
      state: 'managed',
      terminal: { socketPath, target: sessionName, ownership: 'managed' },
    });
    expect(restarted.managedTerminalFor(scope, root, 'managed-recovery-signature')).toMatchObject({
      socketPath,
      sessionName,
      cwdRealpath: root,
    });
    expect(captureTmuxPaneTail(status.terminal!, 2).text).toBe('managed-one\nmanaged-two');

    // v0.6.41 and earlier did not have a managed-terminals file. A first
    // status call must safely discover an already running tagged session.
    const legacyProfile = join(root, 'legacy-profile');
    const legacy = new TmuxBindingController(legacyProfile, 'codex-profile', 'codex');
    expect((await legacy.managedStatus(scope, root)).state).toBe('managed');
    const legacyRestarted = new TmuxBindingController(legacyProfile, 'codex-profile', 'codex');
    expect((await legacyRestarted.managedStatus(scope, root)).state).toBe('managed');
  });

  it('falls back from stale private state to the managed session on the default server', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tmux-control-default-recovery-'));
    const previousTmuxTmpDir = process.env.TMUX_TMPDIR;
    process.env.TMUX_TMPDIR = join(root, 'tmux-root');
    const socketDir = join(process.env.TMUX_TMPDIR, `tmux-${typeof process.getuid === 'function' ? process.getuid() : 0}`);
    await mkdir(socketDir, { recursive: true });
    await chmod(socketDir, 0o700);
    const defaultSocket = defaultTmuxSocketPath({ ...process.env, TMUX: undefined });
    const privateSocket = join(root, '.ab-live-deadbeefcafe.sock');
    const profileStateDir = join(root, 'profile');
    const profile = 'codex-profile';
    const scope = 'default-recovery-scope';
    const signature = 'default-recovery-signature';
    const controller = new TmuxBindingController(profileStateDir, profile, 'codex');
    const sessionName = controller.managedSessionName(scope);
    cleanup.push(async () => {
      spawnSync('tmux', ['-S', privateSocket, 'kill-server'], { stdio: 'ignore' });
      spawnSync('tmux', ['-S', defaultSocket, 'kill-server'], { stdio: 'ignore' });
      if (previousTmuxTmpDir === undefined) delete process.env.TMUX_TMPDIR;
      else process.env.TMUX_TMPDIR = previousTmuxTmpDir;
      await rm(root, { recursive: true, force: true });
    });

    expect(
      spawnSync('tmux', [
        '-S', privateSocket,
        '-f', '/dev/null',
        'new-session', '-d', '-s', sessionName, '-c', root, 'sleep', '30',
      ]).status,
    ).toBe(0);
    await controller.rememberManaged(scope, root, signature, {
      socketPath: privateSocket,
      sessionName,
      attachCommand: `tmux -S ${privateSocket} attach -t ${sessionName}`,
    });
    expect(spawnSync('tmux', ['-S', privateSocket, 'kill-server']).status).toBe(0);

    expect(
      spawnSync('tmux', [
        '-S', defaultSocket,
        '-f', '/dev/null',
        'new-session', '-d', '-s', sessionName, '-c', root,
        'sh', '-c', "printf 'default-session-tail\\n'; sleep 30",
      ]).status,
    ).toBe(0);
    expect(
      spawnSync('tmux', [
        '-S', defaultSocket,
        'new-session', '-d', '-s', 'unrelated', '-c', root, 'sleep', '30',
      ]).status,
    ).toBe(0);
    for (const [key, value] of [
      ['@argbridge_managed', '1'],
      ['@argbridge_profile', profile],
      ['@argbridge_scope', scope],
      ['@argbridge_agent', 'codex'],
      ['@argbridge_cwd', root],
    ] as const) {
      expect(spawnSync('tmux', ['-S', defaultSocket, 'set-option', '-t', sessionName, key, value]).status).toBe(0);
    }

    const restarted = new TmuxBindingController(profileStateDir, profile, 'codex');
    const status = await restarted.managedStatus(scope, root);
    expect(status).toMatchObject({
      state: 'managed',
      terminal: { socketPath: defaultSocket, target: sessionName, ownership: 'managed' },
    });
    expect(restarted.managedTerminalFor(scope, root, signature)).toMatchObject({
      socketPath: defaultSocket,
      sessionName,
    });
    expect(captureTmuxPaneTail(status.terminal!, 27).text).toContain('default-session-tail');
    expect(
      spawnSync('tmux', ['-S', defaultSocket, 'has-session', '-t', 'unrelated'], { stdio: 'ignore' }).status,
    ).toBe(0);
    expect(JSON.parse(await readFile(join(profileStateDir, 'tmux-managed-terminals.json'), 'utf8'))).toMatchObject({
      terminals: { [scope]: { socketPath: defaultSocket } },
    });
  });

  it('restores Codex and Claude managed terminals after bridge recreation', async () => {
    for (const agent of ['codex', 'claude'] as const) {
      const root = await mkdtemp(join(tmpdir(), `managed-tmux-${agent}-recovery-`));
      const previousTmuxTmpDir = process.env.TMUX_TMPDIR;
      process.env.TMUX_TMPDIR = join(root, 'tmux-root');
      await mkdir(process.env.TMUX_TMPDIR, { recursive: true });
      await chmod(process.env.TMUX_TMPDIR, 0o700);
      const expectedDefaultSocket = defaultTmuxSocketPath({ ...process.env, TMUX: undefined });
      const profileStateDir = join(root, 'profile');
      const binary = join(root, 'fake-agent.mjs');
      await writeFile(
        binary,
        `#!/usr/bin/env node
process.stdin.setEncoding('utf8');
process.stdin.on('data', () => process.stdout.write('\\x1b[2J\\x1b[Hpersistent ${agent} reply\\n›\\n'));
setInterval(() => {}, 1000);
`,
        'utf8',
      );
      await chmod(binary, 0o755);

      const first = createManagedRecoveryAdapter(agent, binary, profileStateDir);
      const scope = `${agent}-scope`;
      let socketPath: string | undefined;
      try {
        await collectAgentEvents(first.run({
          runId: `${agent}-first`,
          scopeId: scope,
          sessionMode: 'live',
          prompt: 'hello',
          cwd: root,
        }).events);
        const firstStatus = await first.tmux!.status(scope, root);
        expect(firstStatus).toMatchObject({ state: 'managed', terminal: { ownership: 'managed' } });
        socketPath = firstStatus.terminal?.socketPath;
        expect(socketPath).toBe(expectedDefaultSocket);
        expect(JSON.parse(await readFile(join(profileStateDir, 'tmux-managed-terminals.json'), 'utf8'))).toMatchObject({
          terminals: { [scope]: { socketPath, agentKind: agent } },
        });
        expect(
          spawnSync(
            'tmux',
            [
              '-S', socketPath!, 'display-message', '-p', '-t', firstStatus.terminal!.target,
              '#{@argbridge_managed}\t#{@argbridge_agent}',
            ],
            { encoding: 'utf8' },
          ).stdout.trim(),
        ).toBe(`1\t${agent}`);
        await first.shutdown?.();

        const restarted = createManagedRecoveryAdapter(agent, binary, profileStateDir);
        try {
          const status = await restarted.tmux!.status(scope, root);
          expect(status).toMatchObject({ state: 'managed', terminal: { ownership: 'managed' } });
          const tail = await restarted.tmux!.tail!(scope, 27, root);
          expect(tail.text).toContain(`persistent ${agent} reply`);
        } finally {
          await restarted.shutdown?.();
        }
      } finally {
        spawnSync('tmux', ['-S', socketPath ?? expectedDefaultSocket, 'kill-server'], { stdio: 'ignore' });
        if (previousTmuxTmpDir === undefined) delete process.env.TMUX_TMPDIR;
        else process.env.TMUX_TMPDIR = previousTmuxTmpDir;
        await rm(root, { recursive: true, force: true });
      }
    }
  }, 30_000);

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

function createManagedRecoveryAdapter(
  agent: 'codex' | 'claude',
  binary: string,
  profileStateDir: string,
): AgentAdapter {
  if (agent === 'codex') {
    return new CodexAdapter({
      binary,
      profileStateDir,
      sessionMode: 'live',
      liveTerminalBackend: 'tmux',
      liveUsePty: true,
      liveIdleMs: 200,
    });
  }
  return new ClaudeAdapter({
    binary,
    profileStateDir,
    sessionMode: 'live',
    liveTerminalBackend: 'tmux',
    liveUsePty: true,
    liveIdleMs: 200,
  });
}

async function collectAgentEvents(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}
